import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const registry = 'https://registry.npmjs.org/'
const visibilityChecks = 21
const visibilityInterval = 15_000

export async function readVersion(name, version, request = globalThis.fetch) {
  const response = await request(`${registry}${encodeURIComponent(name)}/${encodeURIComponent(version)}`, {
    headers: { 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  })
  if (!response.ok) {
    await response.body?.cancel()
    if (response.status === 404) return null
    throw new Error(`Registry lookup failed: HTTP ${response.status}; not evidence of an unpublished version.`)
  }
  const metadata = await response.json()
  if (metadata.name !== name || metadata.version !== version ||
      !metadata.dist?.tarball || !metadata.dist?.integrity) {
    throw new Error('Registry returned invalid version metadata; refusing to publish.')
  }
  return metadata
}

export async function publishPackage({ name, version, sha, eventName, ref }, {
  lookup, upload, wait = sleep, log = console.log,
}) {
  // Check before any registry or npm operation, including an accidental manual invocation.
  if (eventName !== 'push' || ref !== `refs/tags/v${version}` ||
      !name || !version || !/^[a-f0-9]{40}$/.test(sha ?? '')) {
    throw new Error('Publishing requires a version-matching tag push and a commit SHA.')
  }
  const confirm = metadata => {
    if (metadata.gitHead !== sha) {
      throw new Error(`Existing ${name}@${version} has a different or missing gitHead; investigate without republishing.`)
    }
    log(`Verified ${name}@${version} is public on npm for commit ${sha}.`)
  }

  // Only an explicit 404 permits an upload; network/auth/registry errors fail closed.
  const existing = await lookup()
  if (existing) {
    confirm(existing)
    log('Version already published. Skipping upload.')
    return 'skipped'
  }

  // Exactly one upload attempt. npm's own write retries are also disabled by the CLI below.
  const result = await upload()
  if (result.status !== 0 && !/\bnpm error code E409\b/.test(result.stderr ?? '')) {
    throw new Error(`npm publish failed (${result.status ?? result.error?.message ?? result.signal ?? 'unknown outcome'}). Check npm before any manual retry; no automatic re-upload.`)
  }
  log(result.status === 0
    ? 'Upload accepted. Waiting for the public registry before releasing the concurrency lock.'
    : 'E409: version may be staged. Only checking the registry; not uploading again.')

  // npm can acknowledge an upload before GET sees it. Hold the workflow lock through this window.
  // A conflict is not success until the exact version and source commit become publicly visible.
  for (let attempt = 0; attempt < visibilityChecks; attempt++) {
    let metadata
    try { metadata = await lookup() }
    catch (error) { log(`Visibility check failed: ${error.message}`) }
    if (metadata) {
      confirm(metadata)
      return result.status === 0 ? 'published' : 'already-published'
    }
    if (attempt + 1 < visibilityChecks) await wait(visibilityInterval)
  }
  throw new Error(`Public availability of ${name}@${version} was not confirmed after ${visibilityChecks} checks. It may still be staged; investigate npm before any retry. No re-upload was attempted.`)
}

if (import.meta.main) {
  try {
    const { name, version } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
    await publishPackage({
      name, version, sha: process.env.GITHUB_SHA,
      eventName: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF,
    }, {
      lookup: () => readVersion(name, version),
      upload: () => {
        const result = spawnSync('npm', [
          'publish', '--provenance', '--access', 'public', `--registry=${registry}`,
          '--fetch-retries=0', '--fetch-timeout=60000',
        ], {
          cwd: new URL('../../', import.meta.url), encoding: 'utf8', timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
        })
        if (result.stdout) process.stdout.write(result.stdout)
        if (result.stderr) process.stderr.write(result.stderr)
        return result
      },
    })
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
