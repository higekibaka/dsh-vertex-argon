import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { createArgonAdapter, PROVIDER, MODEL, GOOGLE_API_MODEL } from '../adapter.js'
import { recordSchema } from '../diagnostic-store.js'

const ctx = { get: key => key === 'launchEnvironment' ? { get: name => ['GOOGLE_API_KEY', 'GOOGLE_CLOUD_API_KEY'].includes(name) ? { value: 'fixture' } : undefined } : undefined }
const request = model => ({ provider: PROVIDER, model, maxTokens: 512, sessionId: 'inband-fixture', messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }] })
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks }
const config = (extra = {}) => ({ maxTokens: 65536, reasoning: 'medium', longDecode: true, googleProtocol: 'generate-content', vertexProtocol: 'generate-content', routes: { hasGoogle: true, hasVertex: true }, ...extra })
const sse = events => new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } })
const originalFetch = globalThis.fetch
let responder
const wire = []
globalThis.fetch = async (input, init) => {
  const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
  assert.ok(url.includes('streamGenerateContent'), 'only mock GenerateContent may be called')
  const row = { url, headers: new Headers(init?.headers), body: JSON.parse(init.body) }
  wire.push(row)
  assert.ok(responder, 'no mock responder configured')
  return responder(row)
}
after(() => { globalThis.fetch = originalFetch })

for (const model of [MODEL, GOOGLE_API_MODEL]) {
  for (const longDecode of [true, false]) test(model + ': SDK forwards in-band rejection to the host (longDecode=' + longDecode + ')', async () => {
    const before = wire.length
    let diagnostic
    responder = () => sse([{ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'PRIVATE_ERROR_DETAIL' } }])
    const adapter = createArgonAdapter(ctx, config({ longDecode }), undefined, undefined, record => diagnostic = record)
    const chunks = await collect(adapter.stream(request(model)))
    assert.equal(chunks.at(-1).reason.kind, 'error')
    assert.match(chunks.at(-1).reason.failure.message, /in-band.*400.*INVALID_ARGUMENT/)
    assert.ok(!JSON.stringify(chunks).includes('PRIVATE_ERROR_DETAIL'))
    assert.equal(wire.length - before, 1)
    assert.equal(diagnostic.hops[0].status, 200)
    assert.equal(diagnostic.hops[0].streamErrorStatus, 400)
    assert.deepEqual(diagnostic.hops[0].errorCodes, ['ARGON_STREAM_ERROR'])
    assert.equal(diagnostic.hops[0].errorPhase, 'stream')
    assert.equal(recordSchema.parse(diagnostic).hops[0].streamErrorStatus, 400)
    const legacy = structuredClone(diagnostic)
    delete legacy.hops[0].streamErrorStatus
    legacy.hops[0].errorCodes = []
    assert.equal(recordSchema.parse(legacy).hops[0].streamErrorStatus, undefined)
  })
  test(model + ': SDK preserves proxy-shaped 503 after bounded post-checkpoint retries without committing tail content', async () => {
    const before = wire.length
    let diagnostic
    responder = () => sse([
      ...(wire.length - before === 1 ? [{ candidates: [{ content: { role: 'model', parts: [{ text: 'COMMITTED_CHECKPOINT' }] }, continuationToken: 'cp' }] }] : []),
      { candidates: [{ content: { role: 'model', parts: [{ text: 'UNCOMMITTED_OUTPUT' }] } }] },
      { error: { code: 503, status: 'UNAVAILABLE', message: 'PRIVATE_ERROR_DETAIL', meta: { cause: 'read-error', upstreamStatus: 200 } } },
    ])
    const chunks = await collect(createArgonAdapter(ctx, config(), undefined, undefined, record => diagnostic = record).stream(request(model)))
    assert.equal(wire.length - before, 5)
    assert.equal(chunks.at(-1).reason.kind, 'error')
    assert.match(chunks.at(-1).reason.failure.message, /in-band.*503.*UNAVAILABLE/)
    assert.ok(!JSON.stringify(chunks).includes('UNCOMMITTED_OUTPUT'))
    assert.ok(!JSON.stringify({ chunks, diagnostic }).includes('PRIVATE_ERROR_DETAIL'))
    assert.ok(diagnostic.hops.every(hop => hop.status === 200 && hop.streamErrorStatus === 503))
    assert.equal(recordSchema.parse(diagnostic).hops.length, 5)
  })
}

for (const model of [MODEL, GOOGLE_API_MODEL]) {
  for (const useToken of [false, true]) test(model + ': real SDK does not terminate on the thought-only STOP before auto-heal (token=' + useToken + ')', async () => {
    const before = wire.length
    let diagnostic
    const signedThought = { text: 'THOUGHT_FIXTURE', thought: true, thoughtSignature: 'SIGNED_THOUGHT_FIXTURE' }
    responder = () => sse(wire.length - before === 1 ? [{
      candidates: [{ content: { role: 'model', parts: [signedThought] }, finishReason: 'STOP', ...(useToken ? { continuationToken: 'heal-checkpoint' } : {}) }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0, thoughtsTokenCount: 3, totalTokenCount: 13 },
    }] : [{
      candidates: [{ content: { role: 'model', parts: [{ text: 'HEALED_VISIBLE_ANSWER' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 13, candidatesTokenCount: 2, thoughtsTokenCount: 0, totalTokenCount: 15 },
    }])
    const chunks = await collect(createArgonAdapter(ctx, config(), undefined, undefined, record => diagnostic = record).stream(request(model)))
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    assert.equal(wire.length - before, 2)
    assert.ok(JSON.stringify(chunks).includes('HEALED_VISIBLE_ANSWER'))
    const second = wire.at(-1).body
    if (useToken) assert.equal(second.continuationToken, 'heal-checkpoint')
    else {
      assert.deepEqual(second.contents.at(-2), { role: 'model', parts: [signedThought] })
      assert.equal(second.contents.at(-1).parts[0].text, 'Continue and provide the final response or tool call.')
    }
    assert.equal(diagnostic.hops[1].trigger, 'thinking-dropout-heal')
    assert.equal(diagnostic.tokenUsage.reportedInputTokens, 10)
    assert.equal(diagnostic.tokenUsage.billedPromptTokens, 23)
    assert.equal(diagnostic.tokenUsage.billedThoughtsTokens, 3)
    assert.equal(recordSchema.parse(diagnostic).hops.length, 2)
  })
}

for (const traffic of ['ON_DEMAND', 'ON_DEMAND_PRIORITY', undefined]) {
  for (const paygoOnly of [false, true]) test('Priority headers and response evidence remain distinct: ' + traffic + ', paygoOnly=' + paygoOnly, async () => {
    let diagnostic
    const current = config({ vertexServiceTier: 'priority', vertexPaygoOnly: paygoOnly })
    const adapter = createArgonAdapter(ctx, () => current, undefined, undefined, record => diagnostic = record)
    const prepared = await adapter.prepareCall(PROVIDER, MODEL)
    current.vertexServiceTier = 'standard'
    responder = () => sse([{ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 1, ...(traffic ? { trafficType: traffic } : {}) } }])
    const chunks = await collect(prepared.stream(request(MODEL)))
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    const last = wire.at(-1)
    assert.equal(last.headers.get('x-vertex-ai-llm-shared-request-type'), 'priority')
    assert.equal(last.headers.get('x-vertex-ai-llm-request-type'), paygoOnly ? 'shared' : null)
    assert.equal(Object.hasOwn(last.body, 'service_tier'), false)
    assert.equal(diagnostic.serviceTier.requested, 'priority')
    assert.equal(diagnostic.serviceTier.observed, traffic === 'ON_DEMAND_PRIORITY' ? 'priority' : traffic === 'ON_DEMAND' ? 'standard' : null)
    assert.equal(diagnostic.serviceTier.source, traffic ? 'traffic-type' : null)
    assert.equal(recordSchema.parse(diagnostic).serviceTier.requested, 'priority')
  })
}
