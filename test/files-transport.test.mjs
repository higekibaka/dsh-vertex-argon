import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, appendFile, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  GEMINI_FILES_MAX_BYTES,
  GEMINI_FILES_CHUNK_BYTES,
  geminiApiPrincipalHash,
  filesBaseEndpoint,
  uploadGeminiFile,
  getGeminiFile,
  waitForGeminiFileActive,
  deleteGeminiFile,
  createGeminiFilesClient,
} from '../files-transport.js'

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

test('constants and geminiApiPrincipalHash match google-connection.js verbatim', () => {
  assert.equal(GEMINI_FILES_MAX_BYTES, 2 * 1024 * 1024 * 1024)
  assert.equal(GEMINI_FILES_CHUNK_BYTES, 8 * 1024 * 1024)
  const expected = createHash('sha256')
    .update(JSON.stringify(['google-generative-ai', 'AIza-demo-key', undefined, 'global']))
    .digest('hex')
  assert.equal(geminiApiPrincipalHash('AIza-demo-key'), expected)
  assert.equal(geminiApiPrincipalHash(''), undefined)
  assert.equal(geminiApiPrincipalHash(null), undefined)
})

test('filesBaseEndpoint normalizes paths and enforces URL safety', () => {
  assert.equal(filesBaseEndpoint(), 'https://generativelanguage.googleapis.com')
  assert.equal(filesBaseEndpoint({ baseURL: '' }), 'https://generativelanguage.googleapis.com')
  assert.equal(filesBaseEndpoint({ baseURL: 'https://generativelanguage.googleapis.com/' }), 'https://generativelanguage.googleapis.com')
  assert.equal(filesBaseEndpoint({ baseURL: 'https://generativelanguage.googleapis.com/v1beta/' }), 'https://generativelanguage.googleapis.com')
  assert.equal(filesBaseEndpoint({ baseURL: 'https://generativelanguage.googleapis.com/v1beta/interactions' }), 'https://generativelanguage.googleapis.com')
  assert.equal(filesBaseEndpoint({ baseURL: 'https://generativelanguage.googleapis.com/v1beta1/files/' }), 'https://generativelanguage.googleapis.com')
  assert.equal(filesBaseEndpoint({ baseURL: 'https://proxy.example.com/gemini/v1/interactions/' }), 'https://proxy.example.com/gemini')
  const idempotentOnce = filesBaseEndpoint({ baseURL: 'https://proxy.example.com/tenant/files/v1beta' })
  assert.equal(idempotentOnce, 'https://proxy.example.com/tenant')
  assert.equal(filesBaseEndpoint({ baseURL: idempotentOnce }), idempotentOnce)
  assert.equal(filesBaseEndpoint({ baseURL: 'http://127.0.0.1:18080/v1beta/files' }), 'http://127.0.0.1:18080')
  assert.equal(filesBaseEndpoint({ baseURL: 'http://localhost:9000/v1' }), 'http://localhost:9000')
  assert.equal(filesBaseEndpoint({ baseURL: 'http://[::1]:8080/v1beta' }), 'http://[::1]:8080')

  assert.throws(() => filesBaseEndpoint({ baseURL: 'http://example.com/v1beta' }), /HTTPS/i)
  assert.throws(() => filesBaseEndpoint({ baseURL: 'https://user:pass@generativelanguage.googleapis.com' }), /credentials/i)
  assert.throws(() => filesBaseEndpoint({ baseURL: 'https://generativelanguage.googleapis.com?key=secret' }), /query/i)
  assert.throws(() => filesBaseEndpoint({ baseURL: 'https://generativelanguage.googleapis.com#frag' }), /fragment/i)
})

test('uploadGeminiFile enforces strict 8 MiB chunk ceiling and performs multi-chunk resumable upload', async () => {
  const dir = await makeTempDir('argon-files-transport-')
  try {
    const filePath = join(dir, 'sample.pdf')
    const payload = Buffer.from('0123456789ABCDEFGHIJKLMNO') // 25 bytes -> 10 + 10 + 5
    await writeFile(filePath, payload)
    const sha256 = createHash('sha256').update(payload).digest('hex')

    // Reject chunkBytes > 8 MiB before any fetch
    await assert.rejects(
      () => uploadGeminiFile({
        filePath,
        mimeType: 'application/pdf',
        sizeBytes: payload.length,
        endpointBase: 'https://generativelanguage.googleapis.com',
        getHeaders: async () => ({ 'x-goog-api-key': 'k' }),
        fetchImpl: failFetch,
        chunkBytes: GEMINI_FILES_CHUNK_BYTES + 1,
      }),
      err => err.code === 'INVALID_REQUEST' && /8 MiB/i.test(err.message),
    )

    const expIso = new Date(Date.now() + 48 * 3600_000).toISOString()
    const createIso = new Date().toISOString()
    const calls = []
    const receivedChunks = []
    const fetchImpl = async (url, init) => {
      calls.push({ url, method: init.method, headers: new Headers(init.headers), body: init.body })
      if (calls.length === 1) {
        return new Response(null, {
          status: 200,
          headers: {
            'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=sess-123',
            'x-goog-upload-status': 'active',
          },
        })
      }
      assert.ok(init.body instanceof Uint8Array)
      receivedChunks.push(Buffer.from(init.body))
      if (calls.length < 4) {
        return new Response(null, { status: 200, headers: { 'x-goog-upload-status': 'active' } })
      }
      return jsonResponse({
        file: {
          name: 'files/abc_123-xyz',
          uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc_123-xyz',
          mimeType: 'application/pdf',
          sizeBytes: '25',
          state: 'PROCESSING',
          expirationTime: expIso,
          createTime: createIso,
        },
      })
    }

    const result = await uploadGeminiFile({
      filePath,
      expectedSha256: sha256,
      mimeType: 'application/pdf',
      displayName: 'slice_demo_sample.pdf',
      sizeBytes: payload.length,
      endpointBase: 'https://generativelanguage.googleapis.com/v1beta',
      getHeaders: async () => ({ 'x-goog-api-key': 'secret-api-key' }),
      fetchImpl,
      chunkBytes: 10,
    })

    assert.equal(calls.length, 4)
    assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/upload/v1beta/files')
    assert.equal(calls[0].headers.get('x-goog-upload-protocol'), 'resumable')
    assert.equal(calls[0].headers.get('x-goog-upload-command'), 'start')
    assert.equal(calls[0].headers.get('x-goog-upload-header-content-length'), '25')
    assert.equal(calls[0].headers.get('x-goog-upload-header-content-type'), 'application/pdf')
    assert.equal(calls[0].headers.get('x-goog-api-key'), 'secret-api-key')
    assert.deepEqual(JSON.parse(calls[0].body), { file: { display_name: 'slice_demo_sample.pdf' } })

    assert.equal(calls[1].headers.get('x-goog-upload-offset'), '0')
    assert.equal(calls[1].headers.get('x-goog-upload-command'), 'upload')
    assert.equal(calls[2].headers.get('x-goog-upload-offset'), '10')
    assert.equal(calls[2].headers.get('x-goog-upload-command'), 'upload')
    assert.equal(calls[3].headers.get('x-goog-upload-offset'), '20')
    assert.equal(calls[3].headers.get('x-goog-upload-command'), 'upload, finalize')

    assert.equal(Buffer.concat(receivedChunks).toString('utf8'), payload.toString('utf8'))
    assert.deepEqual(result, {
      name: 'files/abc_123-xyz',
      uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc_123-xyz',
      mimeType: 'application/pdf',
      sizeBytes: 25,
      state: 'PROCESSING',
      expirationTime: expIso,
      createTime: createIso,
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('uploadGeminiFile rejects TOCTOU file growth, SHA-256 mismatch, and shouldContinue()=false before finalize', async () => {
  const dir = await makeTempDir('argon-files-toctou-')
  try {
    // 1. File grows between chunk 1 and final chunk -> rejected BEFORE sending finalize
    const growPath = join(dir, 'grow.pdf')
    const initial = Buffer.from('0123456789abcdefghij') // 20 bytes
    await writeFile(growPath, initial)
    const initialSha = createHash('sha256').update(initial).digest('hex')
    let sawFinalize = false
    const fhGrow = await open(growPath, 'r')
    try {
      await assert.rejects(
        () => uploadGeminiFile({
          fileHandle: fhGrow,
          expectedSha256: initialSha,
          mimeType: 'application/pdf',
          sizeBytes: 20,
          chunkBytes: 10,
          endpointBase: 'https://generativelanguage.googleapis.com',
          getHeaders: async () => ({ 'x-goog-api-key': 'k' }),
          fetchImpl: async (_url, init) => {
            const cmd = new Headers(init.headers).get('x-goog-upload-command')
            if (cmd === 'start') {
              return new Response(null, {
                status: 200,
                headers: { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=g1' },
              })
            }
            if (cmd === 'upload') {
              await appendFile(growPath, Buffer.from('EXTRA'))
              return new Response(null, { status: 200, headers: { 'x-goog-upload-status': 'active' } })
            }
            sawFinalize = true
            throw new Error('Should never finalize after growth')
          },
        }),
        err => err.code === 'GEMINI_FILE_READ_FAILED',
      )
      assert.equal(sawFinalize, false)
    } finally {
      await fhGrow.close()
    }

    // 2. Same-size SHA-256 mismatch -> rejected BEFORE sending finalize
    const mutatePath = join(dir, 'mutate.pdf')
    await writeFile(mutatePath, Buffer.from('0123456789abcdefghij'))
    let sawMutateFinalize = false
    await assert.rejects(
      () => uploadGeminiFile({
        filePath: mutatePath,
        expectedSha256: '0'.repeat(64),
        mimeType: 'application/pdf',
        sizeBytes: 20,
        chunkBytes: 10,
        endpointBase: 'https://generativelanguage.googleapis.com',
        getHeaders: async () => ({ 'x-goog-api-key': 'k' }),
        fetchImpl: async (_url, init) => {
          const cmd = new Headers(init.headers).get('x-goog-upload-command')
          if (cmd === 'start') {
            return new Response(null, {
              status: 200,
              headers: { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=m1' },
            })
          }
          if (cmd === 'upload') {
            return new Response(null, { status: 200, headers: { 'x-goog-upload-status': 'active' } })
          }
          sawMutateFinalize = true
          throw new Error('Should never finalize on hash mismatch')
        },
      }),
      err => err.code === 'GEMINI_FILE_READ_FAILED',
    )
    assert.equal(sawMutateFinalize, false)

    // 3. shouldContinue() === false halts before next chunk
    let allow = true
    let chunkPosts = 0
    await assert.rejects(
      () => uploadGeminiFile({
        filePath: mutatePath,
        shouldContinue: () => allow,
        mimeType: 'application/pdf',
        sizeBytes: 20,
        chunkBytes: 10,
        endpointBase: 'https://generativelanguage.googleapis.com',
        getHeaders: async () => ({ 'x-goog-api-key': 'k' }),
        fetchImpl: async (_url, init) => {
          const cmd = new Headers(init.headers).get('x-goog-upload-command')
          if (cmd === 'start') {
            return new Response(null, {
              status: 200,
              headers: { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=c1' },
            })
          }
          chunkPosts++
          allow = false // revoke consent after chunk 1
          return new Response(null, { status: 200, headers: { 'x-goog-upload-status': 'active' } })
        },
      }),
      err => err.code === 'ARGON_FILE_SLICING_DISABLED',
    )
    assert.equal(chunkPosts, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('uploadGeminiFile distinguishes internal timeout (ETIMEDOUT) from external abort (AbortError)', async () => {
  const dir = await makeTempDir('argon-files-timeout-')
  try {
    const filePath = join(dir, 'doc.pdf')
    await writeFile(filePath, Buffer.from('%PDF-1.7\n'))

    // Internal timeout -> ETIMEDOUT, NOT AbortError (ref'd keepAlive prevents premature loop exit in isolated runs)
    const keepAlive = setTimeout(() => {}, 5000)
    try {
      await assert.rejects(
        () => uploadGeminiFile({
          filePath,
          mimeType: 'application/pdf',
          sizeBytes: 9,
          endpointBase: 'https://generativelanguage.googleapis.com',
          getHeaders: async () => ({ 'x-goog-api-key': 'k' }),
          timeoutMs: 15,
          fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
          }),
        }),
        err => err.code === 'ETIMEDOUT' && err.name !== 'AbortError',
      )
    } finally {
      clearTimeout(keepAlive)
    }

    // External abort -> AbortError
    const ac = new AbortController()
    await assert.rejects(
      () => uploadGeminiFile({
        filePath,
        mimeType: 'application/pdf',
        sizeBytes: 9,
        endpointBase: 'https://generativelanguage.googleapis.com',
        getHeaders: async () => ({ 'x-goog-api-key': 'k' }),
        signal: ac.signal,
        timeoutMs: 10_000,
        fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
          ac.abort()
        }),
      }),
      err => err.name === 'AbortError' && err.code === 'ABORT_ERR',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('uploadGeminiFile and getGeminiFile reject untrusted origins, mismatched names, and missing upload URL', async () => {
  const dir = await makeTempDir('argon-files-ssrf-')
  try {
    const filePath = join(dir, 'doc.pdf')
    await writeFile(filePath, Buffer.from('%PDF-1.4\n'))

    let fetchCount = 0
    await assert.rejects(
      () => uploadGeminiFile({
        filePath,
        mimeType: 'application/pdf',
        displayName: 'doc.pdf',
        sizeBytes: 9,
        endpointBase: 'https://generativelanguage.googleapis.com',
        getHeaders: async () => ({ 'x-goog-api-key': 'k' }),
        fetchImpl: async () => {
          fetchCount++
          return new Response(null, {
            status: 200,
            headers: { 'x-goog-upload-url': 'https://evil.attacker.example/steal?upload_id=1' },
          })
        },
      }),
      err => err.code === 'GEMINI_FILE_PROTOCOL' && /origin/i.test(err.message),
    )
    assert.equal(fetchCount, 1)

    // Foreign returned file URI origin rejected (including generativelanguage.googleapis.com when custom gateway is configured)
    await assert.rejects(
      () => getGeminiFile({
        name: 'files/f1',
        endpointBase: 'https://proxy.example.com',
        getHeaders: async () => ({ 'x-goog-api-key': 'k' }),
        fetchImpl: async () => jsonResponse({
          name: 'files/f1',
          uri: 'https://generativelanguage.googleapis.com/v1beta/files/f1',
          state: 'ACTIVE',
        }),
      }),
      err => err.code === 'GEMINI_FILE_PROTOCOL' && /origin/i.test(err.message),
    )

    // Mismatched name vs URI path rejected
    await assert.rejects(
      () => getGeminiFile({
        name: 'files/fileA',
        endpointBase: 'https://generativelanguage.googleapis.com',
        getHeaders: async () => ({ 'x-goog-api-key': 'k' }),
        fetchImpl: async () => jsonResponse({
          name: 'files/fileA',
          uri: 'https://generativelanguage.googleapis.com/v1beta/files/fileB',
          state: 'ACTIVE',
        }),
      }),
      err => err.code === 'GEMINI_FILE_PROTOCOL' && /does not match/i.test(err.message),
    )

    // Mismatched returned name in getGeminiFile rejected
    await assert.rejects(
      () => getGeminiFile({
        name: 'files/expected1',
        endpointBase: 'https://generativelanguage.googleapis.com',
        getHeaders: async () => ({ 'x-goog-api-key': 'k' }),
        fetchImpl: async () => jsonResponse({
          name: 'files/other99',
          uri: 'https://generativelanguage.googleapis.com/v1beta/files/other99',
          state: 'ACTIVE',
        }),
      }),
      err => err.code === 'GEMINI_FILE_PROTOCOL' && /mismatched/i.test(err.message),
    )

    // Missing state preserves STATE_UNSPECIFIED (never fabricates ACTIVE)
    const unspecified = await getGeminiFile({
      name: 'files/f2',
      endpointBase: 'https://generativelanguage.googleapis.com',
      getHeaders: async () => ({ 'x-goog-api-key': 'k' }),
      fetchImpl: async () => jsonResponse({
        name: 'files/f2',
        uri: 'https://generativelanguage.googleapis.com/v1beta/files/f2',
      }),
    })
    assert.equal(unspecified.state, 'STATE_UNSPECIFIED')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('non-2xx responses extract only whitelisted error codes and never echo upstream error.message', async () => {
  const secretLeak = 'SENSITIVE_UPSTREAM_PROMPT_OR_KEY_AIzaSyLEAKED999'
  const fetchImpl = async () => jsonResponse(
    { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: `Quota hit for ${secretLeak}` } },
    { status: 429 },
  )

  await assert.rejects(
    () => getGeminiFile({
      name: 'files/file123',
      endpointBase: 'https://generativelanguage.googleapis.com',
      getHeaders: async () => ({ 'x-goog-api-key': 'k' }),
      fetchImpl,
    }),
    err => {
      assert.equal(err.status, 429)
      assert.equal(err.code, 'RATE_LIMIT')
      assert.equal(err.upstreamCode, 'RESOURCE_EXHAUSTED')
      assert.ok(!err.message.includes(secretLeak))
      assert.ok(err.message.includes('429'))
      assert.ok(err.message.includes('RESOURCE_EXHAUSTED'))
      return true
    },
  )

  await assert.rejects(
    () => getGeminiFile({
      name: 'files/file123',
      endpointBase: 'https://generativelanguage.googleapis.com',
      getHeaders: async () => ({ 'x-goog-api-key': 'k' }),
      fetchImpl: async () => jsonResponse(
        { error: { status: 'CUSTOM_SECRET_STATUS', message: secretLeak } },
        { status: 500 },
      ),
    }),
    err => {
      assert.equal(err.status, 500)
      assert.equal(err.upstreamCode, undefined)
      assert.ok(!err.message.includes(secretLeak))
      assert.ok(!err.message.includes('CUSTOM_SECRET_STATUS'))
      return true
    },
  )
})

test('waitForGeminiFileActive handles ACTIVE fast path, STATE_UNSPECIFIED polling, FAILED, sleep-exhausted timeout, and abort', async () => {
  const activeFile = {
    name: 'files/ready1',
    uri: 'https://generativelanguage.googleapis.com/v1beta/files/ready1',
    state: 'ACTIVE',
  }
  // Explicit ACTIVE short-circuits with failFetch proving zero network calls
  assert.equal(await waitForGeminiFileActive({
    file: activeFile,
    endpointBase: 'https://generativelanguage.googleapis.com',
    getHeaders: async () => ({ 'x-goog-api-key': 'k' }),
    fetchImpl: failFetch,
  }), activeFile)

  // Missing / STATE_UNSPECIFIED must poll GET rather than fabricating ACTIVE
  let unspecifiedPolls = 0
  const confirmed = await waitForGeminiFileActive({
    file: { name: 'files/ready1', uri: activeFile.uri, state: 'STATE_UNSPECIFIED' },
    endpointBase: 'https://generativelanguage.googleapis.com',
    getHeaders: async () => ({ 'x-goog-api-key': 'k' }),
    pollIntervalMs: 50,
    maxWaitMs: 500,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      unspecifiedPolls++
      return jsonResponse({ ...activeFile, state: 'ACTIVE' })
    },
  })
  assert.equal(unspecifiedPolls, 1)
  assert.equal(confirmed.state, 'ACTIVE')

  // PROCESSING -> PROCESSING -> ACTIVE
  let polls = 0
  const sleeps = []
  const polled = await waitForGeminiFileActive({
    file: { ...activeFile, state: 'PROCESSING' },
    endpointBase: 'https://generativelanguage.googleapis.com',
    getHeaders: async () => ({ 'x-goog-api-key': 'k' }),
    pollIntervalMs: 250,
    maxWaitMs: 5000,
    sleepImpl: async ms => { sleeps.push(ms) },
    fetchImpl: async () => {
      polls++
      return jsonResponse({
        name: 'files/ready1',
        uri: activeFile.uri,
        mimeType: 'video/mp4',
        sizeBytes: '1024',
        state: polls >= 2 ? 'ACTIVE' : 'PROCESSING',
      })
    },
  })
  assert.equal(polls, 2)
  assert.deepEqual(sleeps, [250, 250])
  assert.equal(polled.state, 'ACTIVE')

  // PROCESSING -> FAILED
  await assert.rejects(
    () => waitForGeminiFileActive({
      file: { ...activeFile, state: 'PROCESSING' },
      endpointBase: 'https://generativelanguage.googleapis.com',
      getHeaders: async () => ({ 'x-goog-api-key': 'k' }),
      pollIntervalMs: 50,
      maxWaitMs: 500,
      sleepImpl: async () => {},
      fetchImpl: async () => jsonResponse({ ...activeFile, state: 'FAILED' }),
    }),
    err => err.code === 'GEMINI_FILE_PROCESSING_FAILED',
  )

  // Sleep-exhausted budget throws GEMINI_FILE_PROCESSING_TIMEOUT BEFORE issuing another GET
  let postExhaustFetches = 0
  await assert.rejects(
    () => waitForGeminiFileActive({
      file: { ...activeFile, state: 'PROCESSING' },
      endpointBase: 'https://generativelanguage.googleapis.com',
      getHeaders: async () => ({ 'x-goog-api-key': 'k' }),
      pollIntervalMs: 300,
      maxWaitMs: 200,
      sleepImpl: async () => {},
      fetchImpl: async () => {
        postExhaustFetches++
        return jsonResponse({ ...activeFile, state: 'PROCESSING' })
      },
    }),
    err => err.code === 'GEMINI_FILE_PROCESSING_TIMEOUT',
  )
  assert.equal(postExhaustFetches, 0)

  // Abort cancels immediately
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(
    () => waitForGeminiFileActive({
      file: { ...activeFile, state: 'PROCESSING' },
      endpointBase: 'https://generativelanguage.googleapis.com',
      getHeaders: async () => ({ 'x-goog-api-key': 'k' }),
      fetchImpl: failFetch,
      signal: ac.signal,
    }),
    err => err.name === 'AbortError' || err.code === 'ABORT_ERR',
  )
})

test('deleteGeminiFile succeeds on 200 and 404, throws sanitized error on 500', async () => {
  const ok = await deleteGeminiFile({
    name: 'files/del1',
    endpointBase: 'https://generativelanguage.googleapis.com',
    getHeaders: async () => ({ 'x-goog-api-key': 'k' }),
    fetchImpl: async () => new Response(null, { status: 200 }),
  })
  assert.equal(ok, true)

  const missing = await deleteGeminiFile({
    name: 'files/del1',
    endpointBase: 'https://generativelanguage.googleapis.com',
    getHeaders: async () => ({ 'x-goog-api-key': 'k' }),
    fetchImpl: async () => jsonResponse({ error: { status: 'NOT_FOUND', message: 'gone' } }, { status: 404 }),
  })
  assert.equal(missing, true)

  await assert.rejects(
    () => deleteGeminiFile({
      name: 'files/del1',
      endpointBase: 'https://generativelanguage.googleapis.com',
      getHeaders: async () => ({ 'x-goog-api-key': 'k' }),
      fetchImpl: async () => jsonResponse({ error: { status: 'INTERNAL', message: 'RAW_SECRET_MSG' } }, { status: 500 }),
    }),
    err => err.status === 500 && err.upstreamCode === 'INTERNAL' && !err.message.includes('RAW_SECRET_MSG'),
  )
})

test('createGeminiFilesClient rejects reserved Vertex env vars and resolves strictly Gemini API credentials', async () => {
  for (const reserved of ['GOOGLE_CLOUD_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION']) {
    let secretRead = false
    await assert.rejects(
      () => createGeminiFilesClient({
        apiKeyEnv: reserved,
        resolveSecret: async () => { secretRead = true; return 'vertex-secret' },
      }),
      err => err.code === 'INVALID_REQUEST',
    )
    assert.equal(secretRead, false)
  }

  const queriedEnvs = []
  const vertexOnlySecrets = {
    GOOGLE_CLOUD_API_KEY: 'vertex-express-key',
    GOOGLE_CLOUD_PROJECT: 'my-gcp-project',
    GOOGLE_APPLICATION_CREDENTIALS: '/path/to/adc.json',
  }
  await assert.rejects(
    () => createGeminiFilesClient({
      resolveSecret: async key => {
        queriedEnvs.push(key)
        return vertexOnlySecrets[key]
      },
    }),
    err => err.code === 'MISSING_CREDENTIAL',
  )
  assert.deepEqual(queriedEnvs, ['GOOGLE_API_KEY', 'GEMINI_API_KEY'])

  const client = await createGeminiFilesClient({
    apiKeyEnv: 'CUSTOM_GEMINI_KEY',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/interactions',
    resolveSecret: async key => (key === 'CUSTOM_GEMINI_KEY' ? 'gemini-dev-key-1' : undefined),
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/files/f1')
      assert.equal(new Headers(init.headers).get('x-goog-api-key'), 'gemini-dev-key-1')
      return jsonResponse({
        name: 'files/f1',
        uri: 'https://generativelanguage.googleapis.com/v1beta/files/f1',
        mimeType: 'application/pdf',
        sizeBytes: '42',
        state: 'ACTIVE',
      })
    },
  })
  assert.equal(client.endpointBase, 'https://generativelanguage.googleapis.com')
  assert.equal(client.principalHash, geminiApiPrincipalHash('gemini-dev-key-1'))
  assert.deepEqual(await client.getHeaders(), { 'x-goog-api-key': 'gemini-dev-key-1' })
  const fetched = await client.getFile({ name: 'files/f1' })
  assert.equal(fetched.name, 'files/f1')
})
