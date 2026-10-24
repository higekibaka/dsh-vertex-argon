import assert from 'node:assert/strict'
import { test } from 'node:test'
import { continueArgonRequestStream, MAX_CONTINUATION_HOPS, STREAM_READ_TIMEOUT_MS, waitWithAbort } from '../generate-content.js'
import { createArgonDiagnosticTracker } from '../diagnostics.js'

const row = (text, { token, finish, output = 1, thought = false, cache, prompt = 100 } = {}) => ({
  candidates: [{ content: { role: 'model', parts: [{ text, ...(thought ? { thought: true } : {}) }] }, ...(token ? { continuationToken: token } : {}), ...(finish ? { finishReason: finish } : {}) }],
  usageMetadata: { promptTokenCount: prompt, candidatesTokenCount: thought ? 0 : output, thoughtsTokenCount: thought ? output : 0, totalTokenCount: prompt + output, ...(cache === undefined ? {} : { cachedContentTokenCount: cache }) },
})
const apiError = status => Object.assign(new Error('fixture rejection'), { status, name: 'ApiError' })
async function run(hops, options = {}) {
  const requests = [], chunks = [], records = []
  const base = { contents: [{ role: 'user', parts: [{ text: 'fixture' }] }], systemInstruction: { parts: [{ text: 'system' }] }, tools: [{ functionDeclarations: [{ name: 'add' }] }], generationConfig: { maxOutputTokens: 262144, thinkingConfig: { thinkingLevel: 'HIGH' } } }
  const request = { body: JSON.stringify(base), abortSignal: options.signal, httpOptions: options.httpOptions }
  const client = { isVertexAI: () => options.vertex !== false, clientOptions: { httpOptions: { apiVersion: options.vertex === false ? 'v1beta' : 'v1' } } }
  async function original(req) {
    requests.push(req)
    const events = typeof hops === 'function' ? hops(requests.length, req) : hops[requests.length - 1]
    if (events instanceof Error) throw events
    assert.ok(events, 'unexpected request')
    return (async function* () {
      for (const item of events) {
        if (item instanceof Error) throw item
        if (typeof item === 'function') { item(); continue }
        yield { headers: {}, json: async () => item }
      }
    })()
  }
  let error
  try {
    const stream = await continueArgonRequestStream(client, original, request, { enabled: options.enabled ?? true, reconnectBackoff: { initialDelayMs: 0 }, tracker: options.tracker ?? { setApiVersion() {}, beginHop: () => ({ onChunk() {}, finish() {} }), recordTokenUsage: v => records.push(v) } })
    for await (const chunk of stream) chunks.push(await chunk.json())
  } catch (e) { error = e }
  const text = chunks.flatMap(x => x.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? '').join('')
  return { requests, chunks, text, error, records, base, usage: chunks.filter(x => x.usageMetadata).at(-1)?.usageMetadata }
}

test('observed usage of a dropped hop is retained separately from committed output accounting',async()=>{
 let diagnostic
 const tracker=createArgonDiagnosticTracker({route:'google-vertex',requestedServiceTier:'priority'},r=>diagnostic=r)
 const first=row('A',{token:'cp',output:10});first.usageMetadata.trafficType='ON_DEMAND_PRIORITY'
 const dropped=row('B',{output:15});dropped.usageMetadata.promptTokensDetails=[{modality:'TEXT',tokenCount:100}]
 const last=row('B',{finish:'STOP',output:5});last.usageMetadata.trafficType='ON_DEMAND'
 const out=await run([[first,dropped,new Error('drop')],[last]],{tracker})
 assert.equal(out.text,'AB');assert.equal(out.usage.candidatesTokenCount,15)
 tracker.finishStream({outcome:'done'})
 const rows=diagnostic.hops
 assert.equal(rows.length,2);assert.equal(rows[0].outputTokens,15);assert.equal(rows[1].outputTokens,5)
 assert.equal(rows[0].outcome,'dropped');assert.equal(rows[1].outcome,'done')
 assert.equal(diagnostic.tokenUsage.outputTokens,15)
 assert.equal(diagnostic.tokenUsage.billedOutputTokens,20)
 assert.equal(diagnostic.tokenUsage.billedTotalTokens,220)
 assert.equal(diagnostic.usageDetails,undefined)
 assert.equal(diagnostic.serviceTier.observed,'mixed')
})

for (const vertex of [true, false]) {
  const route = vertex ? 'Vertex' : 'Gemini API'
  test(route + ': checkpoint tail rolls back text and usage on stream error', async () => {
    const out = await run([[row('A', { token: 'cp', output: 10 }), row('B', { output: 15 }), new Error('drop')], [row('B', { finish: 'STOP', output: 5, prompt: 110, cache: 100 })]], { vertex })
    assert.equal(out.error, undefined)
    assert.equal(out.text, 'AB')
    assert.equal(out.usage.candidatesTokenCount, 15)
    assert.equal(out.usage.cachedContentTokenCount, 0, 'later-hop cache must not replace first-hop cache')
    assert.equal(out.usage.promptTokenCount, 100)
    assert.equal(out.usage.billedPromptTokenCount, 210)
    assert.equal(out.usage.billedTotalTokenCount, 230)
    const { continuationToken, ...rest } = JSON.parse(out.requests[1].body)
    assert.equal(continuationToken, 'cp')
    assert.deepEqual(rest, out.base)
    assert.equal(out.requests[0].httpOptions.timeout, STREAM_READ_TIMEOUT_MS)
    assert.equal(out.requests[0].httpOptions.apiVersion, vertex ? 'v1beta1' : undefined)
  })
  test(route + ': pre-checkpoint chunks stream in real time and silent EOF fails fast on first hop', async () => {
    let secondAllowed = false
    const out = await run([[row('live', { output: 2 }), () => { secondAllowed = true }, row('tail', { finish: 'STOP', output: 6 })]], { vertex })
    assert.equal(secondAllowed, true)
    assert.equal(out.error, undefined)
    assert.equal(out.text, 'livetail')
    assert.equal(out.usage.candidatesTokenCount, 6)
    assert.equal(out.usage.billedPromptTokenCount, 100)
    const eof = await run([[row('partial')]], { vertex })
    assert.equal(eof.requests.length, 1)
    assert.equal(eof.text, 'partial')
    assert.equal(eof.error?.code, 'ARGON_INCOMPLETE_STREAM')
  })
  test(route + ': empty thought-only continuation is real progress', async () => {
    const out = await run([[row('', { token: 'cp', finish: 'CONTINUATION', output: 65536, thought: true })], [row('answer', { finish: 'STOP', output: 2, prompt: 65636 })]], { vertex })
    assert.equal(out.error, undefined)
    assert.equal(out.text, 'answer')
    assert.equal(out.requests.length, 2)
    assert.equal(out.usage.thoughtsTokenCount, 65536)
    assert.ok(!out.chunks.some(x => x.candidates?.[0]?.finishReason === 'CONTINUATION'))
  })
}
test('repeated EOF after checkpoint terminates with error rather than successful truncation', async () => {
  const out = await run(n => n === 1 ? [row('A', { token: 'cp' })] : [row('discard')])
  assert.equal(out.requests.length, 5)
  assert.equal(out.text, 'A')
  assert.equal(out.error.code, 'ARGON_INCOMPLETE_STREAM')
})
test('drop after replaying pending tool content retries same checkpoint safely', async () => {
  const tool = { candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: 'call-1', name: 'add', args: { x: 1 } }, thoughtSignature: 'signed' }] } }] }
  const out = await run([[row('A', { token: 'cp' })], [tool, new Error('drop')], [tool, row('', { finish: 'STOP' })]])
  assert.equal(out.error, undefined)
  assert.equal(out.chunks.flatMap(x => x.candidates?.[0]?.content?.parts ?? []).filter(p => p.functionCall).length, 1)
  assert.deepEqual(out.requests.slice(1).map(r => JSON.parse(r.body).continuationToken), ['cp', 'cp'])
})
test('uses the final original-stream prompt snapshot when token accounting is revised', async () => {
  const out = await run([[row('A', {prompt:150,output:3}),row('B',{prompt:181,cache:20,output:7,finish:'STOP'})]])
  assert.equal(out.usage.promptTokenCount,181)
  assert.equal(out.usage.cachedContentTokenCount,20)
  assert.equal(out.usage.totalTokenCount,188)
})
test('keeps only latest cumulative usage within each hop', async () => {
  const out = await run([[row('A', { output: 3 }), row('B', { token: 'cp', output: 10, finish: 'CONTINUATION' })], [row('C', { output: 5, finish: 'STOP' })]])
  assert.equal(out.error, undefined)
  assert.equal(out.usage.candidatesTokenCount, 15)
  assert.equal(out.records.at(-1).outputTokens, 15)
})
test('fragmented usage metadata merges earlier thought and input fields', async () => {
 const a=row('thought',{thought:true,output:10})
 const out=await run([[a,{usageMetadata:{candidatesTokenCount:5,totalTokenCount:115}},{candidates:[{content:{role:'model',parts:[{text:'answer'}]},finishReason:'STOP'}]}]])
 assert.equal(out.usage.thoughtsTokenCount,10);assert.equal(out.usage.candidatesTokenCount,5);assert.equal(out.usage.totalTokenCount,115)
})
test('metadata-only CONTINUATION tail commits final usage for the same checkpoint', async () => {
 const out=await run([[row('A',{token:'cp',output:1}),{candidates:[{finishReason:'CONTINUATION',continuationToken:'cp'}],usageMetadata:{thoughtsTokenCount:10,totalTokenCount:111}},{usageMetadata:{cachedContentTokenCount:20}}],[row('B',{finish:'STOP',output:2,prompt:111})]])
 assert.equal(out.text,'AB');assert.equal(out.usage.thoughtsTokenCount,10);assert.equal(out.usage.candidatesTokenCount,3);assert.equal(out.usage.cachedContentTokenCount,20)
})
test('consumer return closes the source and the diagnostic hop', async () => {
 let closed=false;const finished=[],usage=[]
 const client={isVertexAI:()=>false}
 const original=async()=> (async function*(){try{yield {json:async()=>row('A',{token:'cp'}),headers:{}};yield {json:async()=>row('B'),headers:{}}}finally{closed=true}})()
 const stream=await continueArgonRequestStream(client,original,{body:'{}'},{enabled:true,tracker:{setApiVersion(){},beginHop:()=>({onChunk(){},finish:v=>finished.push(v)}),recordTokenUsage:v=>usage.push(v)}})
 await stream.next();await stream.return()
 assert.equal(closed,true);assert.equal(finished.length,1);assert.equal(usage.length,1)
})
test('post-terminal usage-only frame is retained', async () => {
  const out = await run([[row('A', { finish: 'STOP' }), { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 7, totalTokenCount: 107 } }]])
  assert.equal(out.error, undefined)
  assert.equal(out.usage.candidatesTokenCount, 7)
})
test('missing CONTINUATION token rejects without leaking the uncommitted answer', async () => {
  const out = await run([[row('partial', { finish: 'CONTINUATION' })]])
  assert.equal(out.error.code, 'ARGON_INVALID_CONTINUATION')
  assert.equal(out.text, '')
  assert.equal(out.requests.length, 1)
})
test('repeated continuation token never loops forever', async () => {
  const out = await run([[row('A', { token: 'cp', finish: 'CONTINUATION' })], [row('B', { token: 'cp', finish: 'CONTINUATION' })]])
  assert.equal(out.text, 'A')
  assert.equal(out.error.code, 'ARGON_INVALID_CONTINUATION')
})
test('MAX_TOKENS never increases the budget or follows its recovery token', async () => {
  const out = await run([[row('A', { token: 'budget-token', finish: 'MAX_TOKENS' })]])
  assert.equal(out.error, undefined)
  assert.equal(out.requests.length, 1)
  assert.equal(out.chunks.at(-1).candidates[0].finishReason, 'MAX_TOKENS')
})
test('empty promptFeedback is not a block and does not suppress continuation', async () => {
  const first = row('A', { token: 'cp', finish: 'CONTINUATION' }); first.promptFeedback = {}
  const out = await run([[first], [row('B', { finish: 'STOP' })]])
  assert.equal(out.text, 'AB')
})
test('real prompt block stops without retry', async () => {
  const out = await run([[{ promptFeedback: { blockReason: 'SAFETY' } }]])
  assert.equal(out.error, undefined)
  assert.equal(out.requests.length, 1)
})
for (const status of [400, 401, 403]) test('does not retry API rejection ' + status, async () => {
  const out = await run([apiError(status)])
  assert.equal(out.error.status, status)
  assert.equal(out.requests.length, 1)
})
for (const status of [429, 503]) test('pre-commit transient ' + status + ' retries both initial and checkpoint hops', async () => {
  const initial = await run([apiError(status), [row('ok', { finish: 'STOP' })]])
  assert.equal(initial.error, undefined)
  assert.equal(initial.text, 'ok')
  assert.equal(initial.requests.length, 2)
  const resumed = await run([[row('A', { token: 'cp', finish: 'CONTINUATION' })], apiError(status), [row('B', { finish: 'STOP' })]])
  assert.equal(resumed.error, undefined)
  assert.equal(resumed.text, 'AB')
  assert.equal(resumed.requests.length, 3)
})
test('pre-abort performs no request and abort does not trigger a retry', async () => {
  const c = new AbortController(); c.abort()
  const out = await run([], { signal: c.signal })
  assert.equal(out.error.name, 'AbortError')
  assert.equal(out.requests.length, 0)
  const mid = new AbortController()
  const interrupted = await run([[row('A', { token: 'cp' }), row('discard'), () => mid.abort(), row('later')]], { signal: mid.signal })
  assert.equal(interrupted.error.name, 'AbortError')
  assert.equal(interrupted.text, 'A')
  assert.equal(interrupted.requests.length, 1)
})
test('backoff is abortable even for a zero delay', async () => {
  const c = new AbortController(); c.abort()
  assert.throws(() => waitWithAbort(0, c.signal), { name: 'AbortError' })
})
test('bounded hop count reports incomplete instead of success', async () => {
  const out = await run(n => [row('A', { token: 'cp-' + n, finish: 'CONTINUATION' })])
  assert.equal(out.requests.length, MAX_CONTINUATION_HOPS)
  assert.equal(out.error.code, 'ARGON_HOP_LIMIT')
})
test('disabled continuation preserves low-latency stream but rejects unterminated EOF', async () => {
  const out = await run([[row('A')]], { enabled: false })
  assert.equal(out.text, 'A')
  assert.equal(out.requests.length, 1)
  assert.equal(out.error.code, 'ARGON_INCOMPLETE_STREAM')
})

// HTTP 200 can carry an error frame from the service or an intermediary.
const errorFrame = (code = 503, status = 'UNAVAILABLE') => ({ error: { code, status, message: 'PRIVATE_PROVIDER_DETAIL', details: [{ secret: 'PRIVATE_PROVIDER_DETAIL' }] } })
for (const vertex of [true, false]) {
  test((vertex ? 'Vertex' : 'Gemini API') + ': in-band errors retain their identity after bounded post-checkpoint retries', async () => {
    let diagnostic
    const tracker = createArgonDiagnosticTracker({ route: vertex ? 'google-vertex' : 'google-generative-ai' }, r => diagnostic = r)
    const out = await run(n => n === 1 ? [row('A', { token: 'cp' }), row('discard'), errorFrame()] : [row('discard'), errorFrame()], { vertex, tracker })
    tracker.finishStream({ outcome: 'error', error: out.error })
    assert.equal(out.error?.code, 'ARGON_STREAM_ERROR')
    assert.equal(out.error.status, 503)
    assert.match(out.error.message, /in-band.*503.*UNAVAILABLE/)
    assert.ok(!JSON.stringify({ message: out.error.message, diagnostic }).includes('PRIVATE_PROVIDER_DETAIL'))
    assert.equal(out.requests.length, 5)
    assert.equal(out.text, 'A')
    for (const hop of diagnostic.hops) {
      assert.equal(hop.status, 200, 'in-band status must not replace HTTP status')
      assert.equal(hop.streamErrorStatus, 503)
      assert.equal(hop.errorPhase, 'stream')
      assert.ok(hop.errorCodes.includes('ARGON_STREAM_ERROR'))
      assert.equal(hop.outcome, 'api-error')
    }
  })
}
for (const status of [400, 401, 403]) test('in-band rejection does not retry ' + status, async () => {
  const out = await run(() => [errorFrame(status, 'INVALID_ARGUMENT')])
  assert.equal(out.error?.code, 'ARGON_STREAM_ERROR')
  assert.equal(out.error.status, status)
  assert.equal(out.requests.length, 1)
})
test('pre-checkpoint transient in-band errors fail fast on first hop without internal retry', async () => {
  const out = await run([[row('live'), errorFrame(429, 'RESOURCE_EXHAUSTED')], [row('answer', { finish: 'STOP' })]])
  assert.equal(out.error?.code, 'ARGON_STREAM_ERROR')
  assert.equal(out.error.status, 429)
  assert.equal(out.text, 'live')
  assert.equal(out.requests.length, 1)
})
test('in-band failure resumes only the last checkpoint and discards pending tools', async () => {
  const tool = { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'add', args: {} } }] } }] }
  const out = await run([[row('A', { token: 'cp' }), tool, errorFrame()], [row('B', { finish: 'STOP' })]])
  assert.equal(out.error, undefined)
  assert.equal(out.text, 'AB')
  assert.equal(JSON.parse(out.requests[1].body).continuationToken, 'cp')
  assert.equal(out.chunks.flatMap(x => x.candidates?.[0]?.content?.parts ?? []).filter(p => p.functionCall).length, 0)
})
for (const error of [null, [], 'PRIVATE_PROVIDER_DETAIL', { code: '503', status: 'PRIVATE_PROVIDER_DETAIL' }, { code: 200 }]) {
  test('malformed in-band error fails closed: ' + JSON.stringify(error), async () => {
    const out = await run(() => [{ error }, row('must not succeed', { finish: 'STOP' })])
    assert.equal(out.error?.code, 'ARGON_STREAM_ERROR')
    assert.equal(out.error.status, undefined)
    assert.equal(out.requests.length, 1)
    assert.equal(out.text, '')
    assert.ok(!out.error.message.includes('PRIVATE_PROVIDER_DETAIL'))
  })
}
test('disabled continuation reports in-band failure without retry or forwarding the error', async () => {
  const out = await run([[row('A'), errorFrame()]], { enabled: false })
  assert.equal(out.error?.code, 'ARGON_STREAM_ERROR')
  assert.equal(out.requests.length, 1)
  assert.equal(out.text, 'A')
  assert.equal(out.chunks.some(x => Object.hasOwn(x, 'error')), false)
})
test('explicit error after STOP is not hidden and never retries committed output', async () => {
  const out = await run([[row('A', { finish: 'STOP' }), errorFrame()]])
  assert.equal(out.error?.code, 'ARGON_STREAM_ERROR')
  assert.equal(out.requests.length, 1)
  assert.equal(out.text, 'A')
})
test('in-band error is not overwritten by missing CONTINUATION token and pre-commit retry is bounded', async () => {
  const out = await run(() => [row('', { finish: 'CONTINUATION' }), errorFrame()])
  assert.equal(out.error?.code, 'ARGON_STREAM_ERROR')
  assert.equal(out.error.status, 503)
  assert.equal(out.requests.length, 4)
})

