import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inspect } from 'node:util'
import { interactionsEndpoint, createInteractionsTransport } from '../interaction-transport.js'
const google = 'google-generative-ai', vertex = 'google-vertex'
test('optional tier observer failure does not replace the real response',async()=>{
 let observations=0
 const transport=createInteractionsTransport({endpoint:'https://example.test/interactions',getHeaders:async()=>({}),onResponse:()=>{observations++;throw new Error('observer-only')},fetchImpl:async()=>new Response(JSON.stringify({id:'fixture'}),{headers:{'x-gemini-service-tier':'standard','Content-Type':'application/json'}})})
 assert.deepEqual(await transport.create({stream:false}),{id:'fixture'});assert.equal(observations,1)
})

test('uses the documented endpoint for each route and auth mode', () => {
  assert.equal(interactionsEndpoint({ route: google }), 'https://generativelanguage.googleapis.com/v1beta/interactions')
  assert.equal(interactionsEndpoint({ route: google, baseURL: 'https://proxy.example/google/v1beta/' }), 'https://proxy.example/google/v1beta/interactions')
  assert.equal(interactionsEndpoint({ route: vertex, project: 'test-p' }), 'https://aiplatform.googleapis.com/v1beta1/projects/test-p/locations/global/interactions')
  assert.equal(interactionsEndpoint({ route: vertex, apiKey: true }), 'https://aiplatform.googleapis.com/v1beta1/locations/global/interactions')
  assert.equal(interactionsEndpoint({ route: vertex, project: 'p', location: 'us' }), 'https://aiplatform.us.rep.googleapis.com/v1beta1/projects/p/locations/us/interactions')
  assert.equal(interactionsEndpoint({ route: vertex, project: 'p', baseURL: 'https://proxy.example/v1beta1/projects/p/locations/global/interactions' }), 'https://proxy.example/v1beta1/projects/p/locations/global/interactions')
})
test('refuses ambiguous or unsafe endpoint configuration', () => {
  for (const baseURL of ['https://user:secret@example.com', 'https://example.com/?key=secret', 'http://example.com', 'file:///tmp/file']) assert.throws(() => interactionsEndpoint({ route: google, baseURL }))
  assert.throws(() => interactionsEndpoint({ route: vertex }))
  assert.throws(() => interactionsEndpoint({ route: vertex, project: 'p', location: 'us-central1' }))
  assert.throws(() => interactionsEndpoint({ route: 'unknown' }))
  assert.throws(() => interactionsEndpoint({ route: vertex, project: 'p', baseURL: 'https://us-central1-aiplatform.googleapis.com' }), /regional/)
})
function fixture(fetchImpl, extra = {}) {
  return createInteractionsTransport({ endpoint: interactionsEndpoint({ route: google }), getHeaders: async () => ({ 'x-goog-api-key': 'fixture-only' }), fetchImpl, ...extra })
}
test('preserves raw event objects across arbitrary byte splits and CRLF framing', async () => {
  const source = ': ping\r\nid: event-1\r\nevent: step.delta\r\ndata: {"index":0,"delta":{"type":"text","text":"你好"}}\r\n\r\ndata: {"event_type":"interaction.completed",\r\ndata: "event_id":"event-2","interaction":{"status":"completed"}}\r\n\r\n'
  const bytes = new TextEncoder().encode(source)
  const stream = new ReadableStream({ start(c) { for (const b of bytes) c.enqueue(new Uint8Array([b])); c.close() } })
  const seen = []
  const t = fixture(async (url, init) => {
    assert.equal(init.headers.get('Api-Revision'), '2026-05-20')
    assert.equal(init.redirect, 'error')
    assert.equal(init.headers.get('x-goog-api-key'), 'fixture-only')
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
  })
  for await (const e of await t.create({ stream: true })) seen.push(e)
  assert.equal(seen[0].delta.text, '你好')
  assert.equal(seen[0].event_id, 'event-1')
  assert.equal(seen[0].event_type, 'step.delta')
  assert.equal(seen[1].interaction.status, 'completed')
})
test('GET encodes resource IDs/cursors and refreshes auth; cancellation uses its own signal', async () => {
  const calls = []; let auth = 0
  const t = fixture(async (url, init) => { calls.push({ url: String(url), init }); return new Response('{"status":"cancelled"}', { headers: { 'Content-Type': 'application/json' } }) }, { getHeaders: async () => ({ Authorization: 'Bearer fixture-' + (++auth) }), revision: null })
  await t.get('a/b', { last_event_id: 'event? x' })
  const abort = new AbortController(); abort.abort()
  await assert.rejects(t.get('a', { signal: abort.signal }), { name: 'AbortError' })
  await t.cancel('a/b')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/interactions/a%2Fb?last_event_id=event%3F+x')
  assert.equal(calls[1].url.endsWith('/a%2Fb/cancel'), true)
  assert.equal(calls[1].init.signal.aborted, false)
  assert.equal(calls[1].init.headers.has('Api-Revision'), false)
  assert.equal(auth, 2)
})
test('aborting authentication cannot hang cleanup or create an ambiguous remote task', async () => {
  const c=new AbortController();let sent=0
  const t=fixture(async()=>{sent++;return new Response('{}')},{getHeaders:()=>new Promise(()=>{})})
  const result=t.create({input:'fixture'},{signal:c.signal})
  queueMicrotask(()=>c.abort())
  await assert.rejects(result,e=>e.name==='AbortError'&&e.requestSubmitted===false)
  assert.equal(sent,0)
})
test('does not retry POST or leak provider error bodies', async () => {
  let calls = 0
  const t = fixture(async () => { calls++; return new Response('SECRET_PROMPT_AND_KEY', { status: 503 }) })
  await assert.rejects(t.create({ input: 'synthetic' }), e => e.status === 503 && !e.message.includes('SECRET'))
  assert.equal(calls, 1)
})
test('HTTP 402 uses safe billing guidance without reading provider bodies or retrying POST', async () => {
  for (const stream of [false, true]) {
    let calls = 0, bodyReads = 0, cancellations = 0
    const t = fixture(async (_url, init) => {
      calls++
      assert.equal(init.method, 'POST')
      return new Response(new ReadableStream({
        pull(controller) {
          bodyReads++
          controller.enqueue(new TextEncoder().encode('SECRET_PROVIDER SECRET_KEY SECRET_REQUEST fixture-only'))
          controller.close()
        },
        cancel() { cancellations++ },
      }, { highWaterMark: 0 }), { status: 402, statusText: 'SECRET_PROVIDER SECRET_KEY SECRET_REQUEST' })
    })
    await assert.rejects(t.create({ input: 'SECRET_REQUEST', stream }), error => {
      assert.equal(error.name, 'ApiError')
      assert.equal(error.code, 'PAYMENT_REQUIRED')
      assert.equal(error.cause.code, 'PAYMENT_REQUIRED')
      assert.equal(error.message, 'Google Interactions request rejected for billing (HTTP 402 Payment Required). Check your Google prepaid credit balance and add credits if depleted. Do not retry automatically; requests cannot succeed until credits are added.')
      return safeFailure(error, 'fetch', 402)
    })
    assert.equal(calls, 1)
    assert.equal(bodyReads, 0)
    assert.equal(cancellations, 1)
  }
})
test('non-402 HTTP failures retain existing codes, messages, and status without POST retries', async () => {
  for (const [status, code] of [[400, 'INVALID_REQUEST'], [401, 'INVALID_REQUEST'], [403, 'INVALID_REQUEST'], [404, 'INVALID_REQUEST'], [409, 'INVALID_REQUEST'], [429, 'RATE_LIMIT'], [500, 'SERVER'], [503, 'SERVER'], [504, 'SERVER']]) {
    let calls = 0
    const t = fixture(async (_url, init) => {
      calls++
      assert.equal(init.method, 'POST')
      return new Response('SECRET_PROVIDER SECRET_KEY SECRET_REQUEST', { status })
    })
    await assert.rejects(t.create({ input: 'SECRET_REQUEST' }), error => {
      assert.equal(error.name, 'ApiError')
      assert.equal(error.code, code)
      assert.equal(error.message, 'Google Interactions request failed (HTTP ' + status + ').')
      return safeFailure(error, 'fetch', status)
    })
    assert.equal(calls, 1)
  }
})
test('rejects malformed JSON and wrong stream content types', async () => {
  const t = fixture(async () => new Response('data: {broken}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }))
  await assert.rejects(async () => { for await (const e of await t.create({ stream: true })) void e }, /invalid SSE JSON/)
  const json = fixture(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }))
  await assert.rejects(json.create({ stream: true }), /non-SSE/)
})

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function resetError() {
  const cause = Object.assign(new Error('SECRET_KEY SECRET_REQUEST SECRET_PROVIDER'), { code: 'ECONNRESET' })
  return Object.assign(new TypeError('SECRET_KEY SECRET_REQUEST SECRET_PROVIDER', { cause }), { code: 'ECONNRESET', requestSubmitted: false })
}
function safeFailure(error, phase, status) {
  assert.equal(error.phase, phase)
  assert.equal(error.status, status)
  assert.equal(error.requestSubmitted, phase === 'pre-dispatch' ? false : undefined)
  assert.doesNotMatch(inspect(error, { depth: 20 }), /SECRET_KEY|SECRET_REQUEST|SECRET_PROVIDER|fixture-only/)
  assert.doesNotMatch(JSON.stringify(error), /SECRET_KEY|SECRET_REQUEST|SECRET_PROVIDER|fixture-only/)
  return true
}

test('already-aborted network and preparation signals cannot authenticate or fetch', async () => {
  for (const key of ['signal', 'preDispatchSignal']) {
    const controller = new AbortController()
    controller.abort()
    let auth = 0, sent = 0
    const t = fixture(async () => { sent++; return new Response('{}') }, { getHeaders: () => { auth++; return {} } })
    await assert.rejects(t.create({}, { [key]: controller.signal }), error => {
      assert.equal(error.name, 'AbortError')
      assert.equal(error.cause.name, 'AbortError')
      return safeFailure(error, 'pre-dispatch', undefined)
    })
    assert.equal(auth, 0)
    assert.equal(sent, 0)
  }
})

test('pre-dispatch Stop interrupts pending auth and late auth cannot submit', async () => {
  const stop = new AbortController(), started = deferred(), auth = deferred()
  let sent = 0
  const t = fixture(async () => { sent++; return new Response('{}') }, {
    getHeaders: () => { started.resolve(); return auth.promise },
  })
  const result = t.create({}, { preDispatchSignal: stop.signal })
  await started.promise
  stop.abort()
  await assert.rejects(result, error => safeFailure(error, 'pre-dispatch', undefined))
  auth.resolve({ 'x-goog-api-key': 'fixture-only' })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(sent, 0)
})

test('auth failures retain diagnostic code/name/cause without secret messages', async () => {
  let sent = 0
  const t = fixture(async () => { sent++; return new Response('{}') }, { getHeaders: async () => { throw resetError() } })
  await assert.rejects(t.create({}), error => {
    assert.equal(error.name, 'TypeError')
    assert.equal(error.code, 'ECONNRESET')
    assert.equal(error.cause.cause.code, 'ECONNRESET')
    return safeFailure(error, 'pre-dispatch', undefined)
  })
  assert.equal(sent, 0)
})

test('unserializable JSON never fetches and preserves safe diagnostics', async () => {
  const circular = { input: 'SECRET_REQUEST' }; circular.self = circular
  for (const body of [circular, { input: 1n }, { toJSON() { throw resetError() } }, { toJSON() {} }, () => {}]) {
    let sent = 0
    const t = fixture(async () => { sent++; return new Response('{}') })
    await assert.rejects(t.create(body), error => {
      assert.equal(error.name, 'TypeError')
      assert.equal(error.cause.name, 'TypeError')
      return safeFailure(error, 'pre-dispatch', undefined)
    })
    assert.equal(sent, 0)
  }
})

test('invalid Headers and create metadata failures are known pre-dispatch failures', async () => {
  let sent = 0
  const fetch = async () => { sent++; return new Response('{}') }
  const badHeaders = fixture(fetch, { getHeaders: () => ({ 'x-goog-api-key': 'SECRET_KEY\nSECRET_REQUEST' }) })
  await assert.rejects(badHeaders.create({}), error => safeFailure(error, 'pre-dispatch', undefined))
  const t = fixture(fetch)
  await assert.rejects(t.create({ get stream() { throw resetError() } }), error => safeFailure(error, 'pre-dispatch', undefined))
  assert.equal(sent, 0)
})

test('Stop during Headers preparation or JSON serialization prevents fetch', async () => {
  for (const stage of ['headers', 'json']) {
    const stop = new AbortController()
    let sent = 0
    const t = fixture(async () => { sent++; return new Response('{}') }, {
      getHeaders: () => stage === 'headers' ? { authorization: { toString() { stop.abort(); return 'SECRET_KEY' } } } : {},
    })
    const body = stage === 'json' ? { toJSON() { stop.abort(); return { input: 'SECRET_REQUEST' } } } : {}
    await assert.rejects(t.create(body, { preDispatchSignal: stop.signal }), error => safeFailure(error, 'pre-dispatch', undefined))
    assert.equal(sent, 0)
  }
})

test('pre-dispatch signal cannot abort fetch or JSON body after dispatch', async () => {
  const stop = new AbortController(), network = new AbortController()
  const dispatched = deferred(), headers = deferred(), body = deferred(), reading = deferred()
  let effective
  const t = fixture((_url, init) => {
    effective = init.signal
    assert.equal(init.method, 'POST')
    assert.equal(init.body, '{"input":"synthetic"}')
    dispatched.resolve()
    return headers.promise
  })
  const result = t.create({ input: 'synthetic' }, { signal: network.signal, preDispatchSignal: stop.signal })
  await dispatched.promise
  stop.abort()
  assert.equal(effective.aborted, false)
  headers.resolve({ status: 200, ok: true, json: () => { reading.resolve(); return body.promise } })
  await reading.promise
  assert.equal(effective.aborted, false)
  body.resolve({ id: 'created' })
  assert.deepEqual(await result, { id: 'created' })
  network.abort()
  assert.equal(effective.aborted, true)
})

test('the network signal still aborts fetch and asynchronous JSON reading', async () => {
  for (const phase of ['fetch', 'response-body']) {
    const network = new AbortController(), waiting = deferred()
    const t = fixture((_url, init) => {
      const blocked = () => new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
        waiting.resolve()
      })
      return phase === 'fetch' ? blocked() : Promise.resolve({ status: 200, ok: true, json: blocked })
    })
    const result = t.create({}, { signal: network.signal, preDispatchSignal: new AbortController().signal })
    await waiting.promise
    network.abort()
    await assert.rejects(result, error => {
      assert.equal(error.name, 'AbortError')
      return safeFailure(error, phase, phase === 'fetch' ? undefined : 200)
    })
  }
})

test('sync and async ECONNRESET after fetch invocation submit only one POST', async () => {
  for (const asyncFailure of [false, true]) {
    let calls = 0
    const t = fixture((_url, init) => {
      calls++
      assert.equal(init.method, 'POST')
      if (asyncFailure) return Promise.reject(resetError())
      throw resetError()
    })
    await assert.rejects(t.create({ input: 'SECRET_REQUEST' }), error => {
      assert.equal(error.name, 'TypeError')
      assert.equal(error.code, 'ECONNRESET')
      assert.equal(error.cause.cause.code, 'ECONNRESET')
      return safeFailure(error, 'fetch', undefined)
    })
    assert.equal(calls, 1)
  }
})

test('reused transport failures cannot carry stale submission verdicts across phases', async () => {
  let preflightError, dispatchedError, calls = 0
  const before = fixture(() => assert.fail('preflight must not fetch'), { getHeaders: () => { throw resetError() } })
  await assert.rejects(before.create({}), error => { preflightError = error; return safeFailure(error, 'pre-dispatch', undefined) })
  const after = fixture(() => { calls++; throw preflightError })
  await assert.rejects(after.create({}), error => {
    dispatchedError = error
    assert.equal(error.code, 'ECONNRESET')
    return safeFailure(error, 'fetch', undefined)
  })
  const beforeAgain = fixture(() => assert.fail('preflight must not fetch'), { getHeaders: () => { throw dispatchedError } })
  await assert.rejects(beforeAgain.create({}), error => safeFailure(error, 'pre-dispatch', undefined))
  assert.equal(calls, 1)
})

test('HTTP 200 JSON body reset retains status and phase, never a false submission verdict', async () => {
  let calls = 0
  const t = fixture(async () => {
    calls++
    return { status: 200, ok: true, json: async () => { await Promise.resolve(); throw resetError() } }
  })
  await assert.rejects(t.create({}), error => {
    assert.equal(error.code, 'ECONNRESET')
    return safeFailure(error, 'response-body', 200)
  })
  assert.equal(calls, 1)
})

test('response header failures retain the already received HTTP status', async () => {
  const t = fixture(async () => ({ status: 200, ok: true, get headers() { throw resetError() } }))
  await assert.rejects(t.create({ stream: true }), error => safeFailure(error, 'fetch', 200))
})

test('SSE reset after the first ID retains HTTP 200 and stream phase', async () => {
  let calls = 0, chunks = 0
  const stream = new ReadableStream({
    pull(controller) {
      if (chunks++ === 0) controller.enqueue(new TextEncoder().encode('data: {"interaction":{"id":"created"}}\n\n'))
      else controller.error(resetError())
    },
  }, { highWaterMark: 0 })
  const t = fixture(async () => { calls++; return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }) })
  const events = await t.create({ stream: true })
  assert.equal((await events.next()).value.interaction.id, 'created')
  await assert.rejects(events.next(), error => {
    assert.equal(error.code, 'ECONNRESET')
    return safeFailure(error, 'stream', 200)
  })
  assert.equal(calls, 1)
})

test('SSE ignores Stop after dispatch but remains attached to network cancellation', async () => {
  const stop = new AbortController(), network = new AbortController()
  const t = fixture(async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true })
      controller.enqueue(new TextEncoder().encode('data: {"interaction":{"id":"created"}}\n\n'))
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } }))
  const events = await t.create({ stream: true }, { signal: network.signal, preDispatchSignal: stop.signal })
  stop.abort()
  assert.equal((await events.next()).value.interaction.id, 'created')
  const next = events.next()
  network.abort()
  await assert.rejects(next, error => {
    assert.equal(error.name, 'AbortError')
    return safeFailure(error, 'stream', 200)
  })
})

test('malformed provider JSON and SSE never leak provider text through cause or stack', async () => {
  for (const stream of [false, true]) {
    const text = stream ? 'data: SECRET_PROVIDER SECRET_KEY SECRET_REQUEST\n\n' : 'SECRET_PROVIDER SECRET_KEY SECRET_REQUEST'
    const t = fixture(async () => new Response(text, { headers: { 'Content-Type': stream ? 'text/event-stream' : 'application/json' } }))
    const result = async () => {
      const response = await t.create({ stream })
      if (stream) for await (const event of response) void event
    }
    await assert.rejects(result, error => {
      assert.equal(error.name, 'SyntaxError')
      assert.equal(error.cause.name, 'SyntaxError')
      return safeFailure(error, stream ? 'stream' : 'response-body', 200)
    })
  }
})

