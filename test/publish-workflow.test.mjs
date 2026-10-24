import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { publishPackage, readVersion } from '../.github/scripts/publish.mjs'

const sha = 'a'.repeat(40)
const context = { name: 'dsh-vertex-argon', version: '9.9.9', sha, eventName: 'push', ref: 'refs/tags/v9.9.9' }
const published = {
  name: context.name, version: context.version, gitHead: sha,
  dist: { tarball: 'https://registry.npmjs.org/example.tgz', integrity: 'sha512-example' },
}
const conflict = { status: 1, stderr: 'npm error code E409\nnpm error Cannot publish over previously staged version "9.9.9".' }

// Every side effect is injected: tests cannot spawn npm, upload, sleep or contact npm.
function fixture(versions, result = { status: 0 }) {
  const calls = { lookups: 0, uploads: 0, waits: [], logs: [] }
  return {
    calls,
    deps: {
      lookup: async () => {
        const value = versions[Math.min(calls.lookups++, versions.length - 1)]
        if (value instanceof Error) throw value
        return value
      },
      upload: async () => { calls.uploads++; return result },
      wait: async ms => { calls.waits.push(ms) },
      log: message => calls.logs.push(message),
    },
  }
}

test('workflow has only tag pushes, a shared non-cancelling lock and the tested publisher', () => {
  const workflow = readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8')
  assert.match(workflow, /on:\s*\n  push:\s*\n    tags:\s*\n      - 'v\*'/)
  assert.doesNotMatch(workflow, /^\s+(?:branches|release|workflow_dispatch|pull_request):/m)
  assert.match(workflow, /concurrency:\s*\n  group: npm-publish-\$\{\{ github.repository \}\}\s*\n  cancel-in-progress: false/)
  assert.match(workflow, /timeout-minutes: 15/)
  assert.match(workflow, /run: node \.github\/scripts\/publish\.mjs/)
  assert.doesNotMatch(workflow, /npm publish|2>\/dev\/null|\|\| true/)
  const script = readFileSync(new URL('../.github/scripts/publish.mjs', import.meta.url), 'utf8')
  assert.match(script, /'--fetch-retries=0'/)
  assert.match(script, /'--provenance'/)
})

test('registry accepts only valid public version metadata and bypasses local caching', async () => {
  const metadata = await readVersion(context.name, context.version, async (url, options) => {
    assert.equal(url, 'https://registry.npmjs.org/dsh-vertex-argon/9.9.9')
    assert.equal(options.headers['cache-control'], 'no-cache')
    assert.equal(options.redirect, 'error')
    assert.ok(options.signal instanceof AbortSignal)
    return Response.json(published)
  })
  assert.deepEqual(metadata, published)
  assert.equal(await readVersion(context.name, context.version, async () => new Response('', { status: 404 })), null)
})

for (const status of [401, 403, 429, 500, 502, 503]) {
  test(`registry HTTP ${status} is not interpreted as a missing version`, async () => {
    await assert.rejects(readVersion(context.name, context.version,
      async () => new Response('', { status })), new RegExp(`HTTP ${status}`))
  })
}

test('registry network errors and malformed or mismatched responses fail closed', async () => {
  await assert.rejects(readVersion(context.name, context.version, async () => { throw new Error('ECONNRESET') }), /ECONNRESET/)
  await assert.rejects(readVersion(context.name, context.version, async () => new Response('{')))
  for (const metadata of [{}, { ...published, name: 'wrong' }, { ...published, version: '0.0.0' },
    { ...published, dist: {} }, { ...published, dist: { tarball: published.dist.tarball } }]) {
    await assert.rejects(readVersion(context.name, context.version, async () => Response.json(metadata)), /invalid version metadata/)
  }
})

test('non-tag events, tag/version mismatch and missing commit fail before any I/O', async () => {
  for (const patch of [{ eventName: 'release' }, { eventName: 'workflow_dispatch' },
    { ref: 'refs/heads/main' }, { ref: 'refs/tags/v1.5.3' }, { sha: undefined }]) {
    const { deps, calls } = fixture([null])
    await assert.rejects(publishPackage({ ...context, ...patch }, deps), /version-matching tag push/)
    assert.equal(calls.lookups, 0)
    assert.equal(calls.uploads, 0)
  }
})

test('published versions including 1.5.2 and 1.5.3 are skipped without upload', async () => {
  for (const version of ['1.5.2', '1.5.3', context.version]) {
    const { deps, calls } = fixture([{ ...published, version }])
    assert.equal(await publishPackage({ ...context, version, ref: `refs/tags/v${version}` }, deps), 'skipped')
    assert.equal(calls.uploads, 0)
    assert.equal(calls.waits.length, 0)
  }
})

test('a failed preflight never uploads', async () => {
  const { deps, calls } = fixture([new Error('Registry lookup failed: HTTP 503')])
  await assert.rejects(publishPackage(context, deps), /HTTP 503/)
  assert.equal(calls.uploads, 0)
})

test('accepted upload keeps polling through staging and temporary query errors', async () => {
  const { deps, calls } = fixture([null, null, new Error('ECONNRESET'), null, published])
  assert.equal(await publishPackage(context, deps), 'published')
  assert.equal(calls.uploads, 1)
  assert.deepEqual(calls.waits, [15000, 15000, 15000])
  assert.equal(calls.lookups, 5)
})

test('E409 is reconciled only after the version is public, without another upload', async () => {
  const { deps, calls } = fixture([null, null, null, published], conflict)
  assert.equal(await publishPackage(context, deps), 'already-published')
  assert.equal(calls.uploads, 1)
  assert.equal(calls.waits.length, 2)
})

for (const result of [{ status: 0 }, conflict]) {
  test(`upload status ${result.status} with no visible version times out rather than falsely succeeding or re-uploading`, async () => {
    const { deps, calls } = fixture([null], result)
    await assert.rejects(publishPackage(context, deps), /not confirmed after 21 checks/)
    assert.equal(calls.uploads, 1)
    assert.equal(calls.lookups, 22)
    assert.equal(calls.waits.length, 20)
  })
}

test('non-conflict publish failures and unknown outcomes are not swallowed or retried', async () => {
  for (const result of [{ status: 1, stderr: 'npm error code E403' },
    { status: 1, stderr: 'npm error code ECONNRESET' }, { status: null, error: new Error('ETIMEDOUT') }]) {
    const { deps, calls } = fixture([null, published], result)
    await assert.rejects(publishPackage(context, deps), /Check npm before any manual retry/)
    assert.equal(calls.uploads, 1)
    assert.equal(calls.lookups, 1)
  }
})

test('a different or missing published source commit is never treated as success', async () => {
  for (const gitHead of ['b'.repeat(40), undefined]) {
    for (const versions of [[{ ...published, gitHead }], [null, { ...published, gitHead }]]) {
      const { deps, calls } = fixture(versions, conflict)
      await assert.rejects(publishPackage(context, deps), /different or missing gitHead/)
      assert.equal(calls.uploads, versions.length === 1 ? 0 : 1)
    }
  }
})

test('CLI invocation outside a matching tag fails safely under the offline guard', () => {
  const result = spawnSync(process.execPath, [
    '--import', './test/offline-guard.mjs', '.github/scripts/publish.mjs',
  ], { cwd: new URL('../', import.meta.url), encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /version-matching tag push/)
})
