import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { PROVIDER } from '../adapter.js'
import { GEMINI_FILES_MAX_BYTES, geminiApiPrincipalHash } from '../files-transport.js'
import { SLICE_TOOL_NAME, createFileSliceHub } from '../file-slicing.js'
import { createFileSlicingTool } from '../file-slicing-tool.js'

async function makeTempDir(prefix) {
  const base = join(import.meta.dirname, '..', '.tmp')
  await mkdir(base, { recursive: true })
  return mkdtemp(join(base, prefix))
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

const failFetch = async () => {
  throw new Error('Unexpected fetch invocation in test')
}

function makeExec({
  sessionId = 'sess-1',
  callId = 'call-1',
  provider = PROVIDER,
  model = 'gemini-4-neon-google',
  useOptions = false,
  signal,
} = {}) {
  const agent = { id: sessionId }
  if (useOptions) {
    agent.options = { provider, model }
  } else if (provider !== undefined || model !== undefined) {
    agent.modelSelection = { current: () => ({ provider, model }) }
  }
  return { agent, callId, signal }
}

test('createFileSlicingTool exposes expected tool metadata and strict schema', () => {
  const tool = createFileSlicingTool({ fileSliceHub: createFileSliceHub(), fetchImpl: failFetch })
  assert.equal(tool.name, SLICE_TOOL_NAME)
  assert.equal(tool.deferLoading, true)
  assert.equal(tool.timeoutMs, 180_000)
  assert.equal(tool.isConcurrencySafe(), true)
  assert.equal(tool.parameters.additionalProperties, false)
  assert.deepEqual(tool.parameters.required, ['path'])
  assert.deepEqual(tool.output.render({}, { ok: true }), [{ type: 'text', text: '{"ok":true}' }])
})

test('pre-flight gates enforce abort, consent, authoritative modelSelection, /v1/interactions gate, fail-closed fs path, and invalid args with zero I/O', async () => {
  let secretCalls = 0
  let statCalls = 0
  let openCalls = 0
  const hub = createFileSliceHub()
  hub.observeSessionRoute('sess-auth', { provider: PROVIDER, model: 'gemini-4-neon-google' })

  let cfg = { allowGeminiFilesApi: false, googleProtocol: 'generate-content' }
  let routes = { googleApiKeyEnv: 'GOOGLE_API_KEY' }
  const tool = createFileSlicingTool({
    getConfig: () => cfg,
    getRoutes: () => routes,
    resolveSecret: async () => { secretCalls++; return 'k' },
    fileSliceHub: hub,
    fetchImpl: failFetch,
    statImpl: async () => { statCalls++; throw new Error('unexpected stat') },
    openImpl: async () => { openCalls++; throw new Error('unexpected open') },
  })

  // 1. Aborted signal
  const ac = new AbortController()
  ac.abort()
  const aborted = await tool.execute({ path: '/tmp/a.pdf' }, makeExec({ signal: ac.signal }))
  assert.equal(aborted.ok, false)
  assert.equal(aborted.code, 'ARGON_SLICE_CANCELLED')

  // 2. Disabled consent
  const disabled = await tool.execute({ path: '/tmp/a.pdf' }, makeExec())
  assert.equal(disabled.ok, false)
  assert.equal(disabled.code, 'ARGON_FILE_SLICING_DISABLED')

  cfg = { allowGeminiFilesApi: true, googleProtocol: 'generate-content' }

  // 3. Missing session / callId
  const noSession = await tool.execute({ path: '/tmp/a.pdf' }, { agent: {}, callId: '' })
  assert.equal(noSession.ok, false)
  assert.equal(noSession.code, 'ARGON_SLICE_SESSION')

  // 4. Authoritative modelSelection.current(): throw or empty MUST NOT fall back to agent.options / observedRoute!
  const throwSelection = await tool.execute(
    { path: '/tmp/a.pdf' },
    {
      agent: {
        id: 'sess-auth',
        options: { provider: PROVIDER, model: 'gemini-4-neon-google' },
        modelSelection: { current: () => { throw new Error('boom') } },
      },
      callId: 'c1',
    },
  )
  assert.equal(throwSelection.ok, false)
  assert.equal(throwSelection.code, 'ARGON_FILE_SLICING_UNSUPPORTED_ROUTE')

  const emptySelection = await tool.execute(
    { path: '/tmp/a.pdf' },
    {
      agent: {
        id: 'sess-auth',
        options: { provider: PROVIDER, model: 'gemini-4-neon-google' },
        modelSelection: { current: () => ({}) },
      },
      callId: 'c2',
    },
  )
  assert.equal(emptySelection.ok, false)
  assert.equal(emptySelection.code, 'ARGON_FILE_SLICING_UNSUPPORTED_ROUTE')

  // 5. Vertex AI model on Argon provider & non-Argon provider
  const vertex = await tool.execute({ path: '/tmp/a.pdf' }, makeExec({ provider: PROVIDER, model: 'gemini-4-argon' }))
  assert.equal(vertex.ok, false)
  assert.equal(vertex.code, 'ARGON_FILE_SLICING_VERTEX_UNSUPPORTED')
  assert.match(vertex.error, /Vertex AI/i)

  const otherProvider = await tool.execute({ path: '/tmp/a.pdf' }, makeExec({ provider: 'openai', model: 'gpt-5' }))
  assert.equal(otherProvider.ok, false)
  assert.equal(otherProvider.code, 'ARGON_FILE_SLICING_UNSUPPORTED_ROUTE')

  // 6. Explicit /v1/interactions rejected pre-I/O
  cfg = { allowGeminiFilesApi: true, googleProtocol: 'interactions' }
  routes = { googleApiKeyEnv: 'GOOGLE_API_KEY', googleBaseUrl: 'https://proxy.example.com/v1/interactions' }
  const v1Blocked = await tool.execute({ path: '/tmp/a.pdf' }, makeExec())
  assert.equal(v1Blocked.ok, false)
  assert.equal(v1Blocked.code, 'ARGON_FILE_SLICING_API_VERSION_UNSUPPORTED')

  cfg = { allowGeminiFilesApi: true, googleProtocol: 'generate-content' }
  routes = { googleApiKeyEnv: 'GOOGLE_API_KEY' }

  // 7. Invalid args
  for (const badArgs of [
    { path: '/tmp/a.pdf', unexpected: true },
    { path: '/tmp/a\0.pdf' },
    { path: '/tmp/a.txt' },
    { path: '/tmp/a.pdf', sheetIndex: 1 },
  ]) {
    const res = await tool.execute(badArgs, makeExec())
    assert.equal(res.ok, false)
    assert.equal(res.code, 'ARGON_SLICE_INVALID')
  }

  // 8. Fail-closed hostPathFromProcessPath (throw or empty MUST NOT fall back to path.resolve)
  const fsDenyThrow = createFileSlicingTool({
    ctx: { get: name => (name === 'fs' ? { hostPathFromProcessPath: () => { throw new Error('outside sandbox') } } : undefined) },
    getConfig: () => ({ allowGeminiFilesApi: true }),
    getRoutes: () => ({ googleApiKeyEnv: 'GOOGLE_API_KEY' }),
    resolveSecret: async () => { secretCalls++; return 'k' },
    fileSliceHub: hub,
    fetchImpl: failFetch,
    openImpl: async () => { openCalls++; throw new Error('should not open') },
  })
  const denyThrowRes = await fsDenyThrow.execute({ path: '/etc/secret.pdf' }, makeExec())
  assert.equal(denyThrowRes.ok, false)
  assert.equal(denyThrowRes.code, 'ARGON_SLICE_PATH_DENIED')

  const fsDenyEmpty = createFileSlicingTool({
    ctx: { get: name => (name === 'fs' ? { hostPathFromProcessPath: () => '' } : undefined) },
    getConfig: () => ({ allowGeminiFilesApi: true }),
    getRoutes: () => ({ googleApiKeyEnv: 'GOOGLE_API_KEY' }),
    resolveSecret: async () => { secretCalls++; return 'k' },
    fileSliceHub: hub,
    fetchImpl: failFetch,
    openImpl: async () => { openCalls++; throw new Error('should not open') },
  })
  const denyEmptyRes = await fsDenyEmpty.execute({ path: '/etc/secret.pdf' }, makeExec())
  assert.equal(denyEmptyRes.ok, false)
  assert.equal(denyEmptyRes.code, 'ARGON_SLICE_PATH_DENIED')

  assert.equal(secretCalls, 0)
  assert.equal(statCalls, 0)
  assert.equal(openCalls, 0)
})

test('rejects missing, directory, empty, and oversize (>2 GiB) files before any upload', async () => {
  const dir = await makeTempDir('argon-slice-tool-files-')
  try {
    const emptyFile = join(dir, 'empty.pdf')
    await writeFile(emptyFile, Buffer.alloc(0))
    const subDir = join(dir, 'folder.pdf')
    await mkdir(subDir)

    const hub = createFileSliceHub()
    const tool = createFileSlicingTool({
      getConfig: () => ({ allowGeminiFilesApi: true }),
      getRoutes: () => ({ googleApiKeyEnv: 'GOOGLE_API_KEY' }),
      resolveSecret: async () => 'gemini-key',
      fileSliceHub: hub,
      fetchImpl: failFetch,
    })

    const missingRes = await tool.execute({ path: join(dir, 'does-not-exist.pdf') }, makeExec())
    assert.equal(missingRes.ok, false)
    assert.equal(missingRes.code, 'ARGON_SLICE_FILE_NOT_FOUND')

    const dirRes = await tool.execute({ path: subDir }, makeExec())
    assert.equal(dirRes.ok, false)
    assert.equal(dirRes.code, 'ARGON_SLICE_NOT_A_FILE')

    const emptyRes = await tool.execute({ path: emptyFile }, makeExec())
    assert.equal(emptyRes.ok, false)
    assert.equal(emptyRes.code, 'ARGON_SLICE_EMPTY_FILE')

    let closedOversize = false
    const oversizeTool = createFileSlicingTool({
      getConfig: () => ({ allowGeminiFilesApi: true }),
      getRoutes: () => ({ googleApiKeyEnv: 'GOOGLE_API_KEY' }),
      resolveSecret: async () => 'gemini-key',
      fileSliceHub: hub,
      fetchImpl: failFetch,
      openImpl: async () => ({
        stat: async () => ({ isFile: () => true, size: GEMINI_FILES_MAX_BYTES + 1 }),
        close: async () => { closedOversize = true },
      }),
    })
    const oversizeRes = await oversizeTool.execute({ path: emptyFile }, makeExec())
    assert.equal(oversizeRes.ok, false)
    assert.equal(oversizeRes.code, 'ARGON_SLICE_FILE_TOO_LARGE')
    assert.equal(closedOversize, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('parallel calls on same PDF share one upload yet produce distinct displayName and sliceId', async () => {
  const dir = await makeTempDir('argon-slice-tool-ok-')
  try {
    const pdfPath = join(dir, 'quarterly report (Q4).pdf')
    await writeFile(pdfPath, Buffer.from('%PDF-1.7\nQuarterly report body\n'))

    const fixedNow = 1_750_000_000_000
    const clampedExpiryIso = new Date(fixedNow + 48 * 3600_000).toISOString()
    // Upstream claims 100h expiration; hub must clamp to 48h and tool must return the clamped expiresAt!
    const upstreamOverlongExpIso = new Date(fixedNow + 100 * 3600_000).toISOString()
    const hub = createFileSliceHub({ now: () => fixedNow })
    hub.observeSessionRoute('sess-42', { provider: PROVIDER, model: 'gemini-4-carbon-google' })

    const calls = []
    const fetchImpl = async (url, init) => {
      calls.push({ url, method: init.method })
      if (init.method === 'POST' && url.endsWith('/upload/v1beta/files')) {
        return new Response(null, {
          status: 200,
          headers: { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=u1' },
        })
      }
      if (init.method === 'POST' && url.includes('upload_id=u1')) {
        return jsonResponse({
          file: {
            name: 'files/report_01',
            uri: 'https://generativelanguage.googleapis.com/v1beta/files/report_01',
            mimeType: 'application/pdf',
            sizeBytes: '31',
            state: 'PROCESSING',
            expirationTime: upstreamOverlongExpIso,
          },
        })
      }
      if (init.method === 'GET' && url.endsWith('/v1beta/files/report_01')) {
        return jsonResponse({
          name: 'files/report_01',
          uri: 'https://generativelanguage.googleapis.com/v1beta/files/report_01',
          mimeType: 'application/pdf',
          sizeBytes: '31',
          state: 'ACTIVE',
          expirationTime: upstreamOverlongExpIso,
        })
      }
      throw new Error(`Unexpected fetch ${init.method} ${url}`)
    }

    const tool = createFileSlicingTool({
      ctx: {
        get: name => (name === 'fs' ? { hostPathFromProcessPath: p => (p === '/workspace/report.pdf' ? pdfPath : p) } : undefined),
      },
      getConfig: () => ({ allowGeminiFilesApi: true }),
      getRoutes: () => ({ googleApiKeyEnv: 'GOOGLE_API_KEY', googleBaseUrl: 'https://generativelanguage.googleapis.com/v1beta' }),
      resolveSecret: async key => (key === 'GOOGLE_API_KEY' ? 'gemini-live-key' : undefined),
      fileSliceHub: hub,
      fetchImpl,
      sleepImpl: async () => {},
    })

    const [res1, res2] = await Promise.all([
      tool.execute(
        { path: '/workspace/report.pdf', startPage: 1, endPage: 3, contentLayers: ['page_text', 'page_image'], resolution: 'high' },
        { agent: { id: 'sess-42', options: {} }, callId: 'call:1' },
      ),
      tool.execute(
        { path: '/workspace/report.pdf', startPage: 4, endPage: 6 },
        { agent: { id: 'sess-42', options: {} }, callId: 'call:2' },
      ),
    ])

    assert.equal(res1.ok, true)
    assert.equal(res2.ok, true)
    assert.equal(res1.expiresAt, clampedExpiryIso)
    assert.equal(res2.expiresAt, clampedExpiryIso)
    assert.ok(typeof res1.sliceId === 'string' && /^sl_[a-f0-9]{12}$/.test(res1.sliceId))
    assert.ok(typeof res2.sliceId === 'string' && /^sl_[a-f0-9]{12}$/.test(res2.sliceId))
    assert.notEqual(res1.sliceId, res2.sliceId)
    assert.equal(res1.reusedUpload || res2.reusedUpload, true)
    assert.equal(res1.reusedUpload && res2.reusedUpload, false)
    assert.equal(calls.length, 3) // start + finalize + poll GET only ONCE!

    const principalHash = geminiApiPrincipalHash('gemini-live-key')
    const gcResolved = hub.resolveForRequest({
      sessionId: 'sess-42',
      route: 'google-generative-ai',
      principalHash,
      endpointBase: 'https://generativelanguage.googleapis.com',
      allowGeminiFilesApi: true,
      protocol: 'generate-content',
      entries: [
        { key: '0', callId: 'call_1', sliceId: res1.sliceId },
        { key: '1', callId: 'call_2', sliceId: res2.sliceId },
      ],
    })
    assert.equal(gcResolved.get('0').status, 'active')
    assert.equal(gcResolved.get('1').status, 'active')
    assert.notEqual(gcResolved.get('0').displayName, gcResolved.get('1').displayName)
    assert.match(gcResolved.get('0').displayName, /^slice_[a-f0-9]{8}_[a-f0-9]{8}_quarterly_report_Q4_\.pdf$/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('tool rejects reserved GOOGLE_CLOUD_API_KEY env, halts mid-flight consent revocation, never leaks secrets, and handles processing failure/abort', async () => {
  const dir = await makeTempDir('argon-slice-tool-err-')
  try {
    const filePath = join(dir, 'clip.mp4')
    await writeFile(filePath, Buffer.from('fake-mp4-bytes'))

    // 1. GOOGLE_CLOUD_API_KEY configured as googleApiKeyEnv -> rejected with zero secret reads
    let secretQueried = false
    const reservedEnvTool = createFileSlicingTool({
      getConfig: () => ({ allowGeminiFilesApi: true }),
      getRoutes: () => ({ googleApiKeyEnv: 'GOOGLE_CLOUD_API_KEY' }),
      resolveSecret: async () => { secretQueried = true; return 'vertex-key' },
      fileSliceHub: createFileSliceHub(),
      fetchImpl: failFetch,
    })
    const reservedRes = await reservedEnvTool.execute({ path: filePath }, makeExec())
    assert.equal(reservedRes.ok, false)
    assert.equal(reservedRes.code, 'ARGON_SLICE_CONFIG_ERROR')
    assert.equal(secretQueried, false)

    // 2. Missing Gemini API credentials (only Vertex key exists)
    const noCredTool = createFileSlicingTool({
      getConfig: () => ({ allowGeminiFilesApi: true }),
      getRoutes: () => ({ googleApiKeyEnv: 'GOOGLE_API_KEY' }),
      resolveSecret: async key => (key === 'GOOGLE_CLOUD_API_KEY' ? 'vertex-only-secret' : undefined),
      fileSliceHub: createFileSliceHub(),
      fetchImpl: failFetch,
    })
    const credRes = await noCredTool.execute({ path: filePath }, makeExec())
    assert.equal(credRes.ok, false)
    assert.equal(credRes.code, 'ARGON_SLICE_CREDENTIAL_MISSING')
    assert.ok(!credRes.error.includes('vertex-only-secret'))

    // 3. Mid-flight consent revocation aborts upload and does NOT register slice
    const revokeHub = createFileSliceHub()
    let consent = true
    const revokeTool = createFileSlicingTool({
      getConfig: () => ({ allowGeminiFilesApi: consent }),
      getRoutes: () => ({ googleApiKeyEnv: 'GOOGLE_API_KEY' }),
      resolveSecret: async () => 'gemini-key',
      fileSliceHub: revokeHub,
      fetchImpl: async (_url, init) => {
        const cmd = new Headers(init.headers).get('x-goog-upload-command')
        if (cmd === 'start') {
          consent = false
          revokeHub.revokeConsent()
          return new Response(null, {
            status: 200,
            headers: { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=rev1' },
          })
        }
        throw new Error('Should never send chunk after consent revoked')
      },
    })
    const revokeRes = await revokeTool.execute({ path: filePath }, makeExec({ sessionId: 'sess-rev', callId: 'c-rev' }))
    assert.equal(revokeRes.ok, false)
    assert.equal(revokeRes.code, 'ARGON_FILE_SLICING_DISABLED')
    assert.equal(
      revokeHub.resolveForRequest({
        sessionId: 'sess-rev',
        route: 'google-generative-ai',
        principalHash: geminiApiPrincipalHash('gemini-key'),
        allowGeminiFilesApi: true,
        protocol: 'interactions',
        toolCallIds: ['c-rev'],
      }).size,
      0,
    )

    // 4. Upstream HTTP 429 error with secret in upstream error.message
    const secretInUpstream = 'AIzaSySUPERSECRET_UPSTREAM_LEAK'
    const upstreamErrTool = createFileSlicingTool({
      getConfig: () => ({ allowGeminiFilesApi: true }),
      getRoutes: () => ({ googleApiKeyEnv: 'GOOGLE_API_KEY' }),
      resolveSecret: async () => 'AIzaSyCLIENT_KEY_123',
      fileSliceHub: createFileSliceHub(),
      fetchImpl: async () => jsonResponse(
        { error: { status: 'RESOURCE_EXHAUSTED', message: `Rate limited key=${secretInUpstream}` } },
        { status: 429 },
      ),
    })
    const errRes = await upstreamErrTool.execute({ path: filePath }, makeExec())
    assert.equal(errRes.ok, false)
    assert.equal(errRes.code, 'ARGON_SLICE_UPLOAD_FAILED')
    assert.ok(errRes.error.includes('429'))
    assert.ok(errRes.error.includes('RESOURCE_EXHAUSTED'))
    assert.ok(!errRes.error.includes(secretInUpstream))
    assert.ok(!errRes.error.includes('AIzaSyCLIENT_KEY_123'))

    // 5. Processing FAILED
    const failedProcTool = createFileSlicingTool({
      getConfig: () => ({ allowGeminiFilesApi: true }),
      getRoutes: () => ({ googleApiKeyEnv: 'GOOGLE_API_KEY' }),
      resolveSecret: async () => 'gemini-key',
      fileSliceHub: createFileSliceHub(),
      sleepImpl: async () => {},
      fetchImpl: async (url, init) => {
        if (init.method === 'POST' && url.endsWith('/upload/v1beta/files')) {
          return new Response(null, {
            status: 200,
            headers: { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=f' },
          })
        }
        return jsonResponse({
          file: {
            name: 'files/badvid',
            uri: 'https://generativelanguage.googleapis.com/v1beta/files/badvid',
            mimeType: 'video/mp4',
            state: 'FAILED',
          },
        })
      },
    })
    const failedRes = await failedProcTool.execute({ path: filePath }, makeExec())
    assert.equal(failedRes.ok, false)
    assert.equal(failedRes.code, 'ARGON_SLICE_PROCESSING_FAILED')

    // 6. Abort mid-upload does not register slice
    const abortHub = createFileSliceHub()
    const ac = new AbortController()
    const abortTool = createFileSlicingTool({
      getConfig: () => ({ allowGeminiFilesApi: true }),
      getRoutes: () => ({ googleApiKeyEnv: 'GOOGLE_API_KEY' }),
      resolveSecret: async () => 'gemini-key',
      fileSliceHub: abortHub,
      fetchImpl: async (_url, init) => {
        ac.abort()
        init.signal?.throwIfAborted()
        throw new Error('should have aborted')
      },
    })
    const abortRes = await abortTool.execute({ path: filePath }, makeExec({ sessionId: 'sess-abort', callId: 'c-abort', signal: ac.signal }))
    assert.equal(abortRes.ok, false)
    assert.equal(abortRes.code, 'ARGON_SLICE_CANCELLED')
    assert.equal(
      abortHub.resolveForRequest({
        sessionId: 'sess-abort',
        route: 'google-generative-ai',
        principalHash: geminiApiPrincipalHash('gemini-key'),
        allowGeminiFilesApi: true,
        protocol: 'interactions',
        toolCallIds: ['c-abort'],
      }).size,
      0,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
