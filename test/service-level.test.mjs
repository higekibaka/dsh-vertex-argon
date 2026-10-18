import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createArgonAdapter, resolveConfigValues, PROVIDER, MODEL, GOOGLE_API_MODEL } from '../adapter.js'
import { SERVICE_TIER_CAPABILITIES } from '../service-level.js'

const ctx = { get: key => key === 'launchEnvironment' ? { get: name => ['GOOGLE_API_KEY', 'GOOGLE_CLOUD_API_KEY'].includes(name) ? { value: 'offline-fixture' } : undefined } : undefined }
const sse = events => new Response(events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join(''), { headers: { 'Content-Type': 'text/event-stream', 'X-Gemini-Service-Tier': 'standard' } })
test('the reviewed capability matrix does not silently enable unverified combinations',()=>{
 assert.deepEqual(SERVICE_TIER_CAPABILITIES,{
  'google-generative-ai/generate-content':['standard','flex','priority'],
  'google-generative-ai/interactions':['standard','flex','priority'],
  'google-vertex/generate-content':['standard','priority'],
  'google-vertex/interactions':['standard'],
 })
})
const originalFetch = globalThis.fetch
const request = model => ({ provider: PROVIDER, model, maxTokens: 256, sessionId: 'tier-fixture', messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }] })
const collect = async stream => { const out = []; for await (const chunk of stream) out.push(chunk); return out }
for (const [model, route] of [[GOOGLE_API_MODEL, 'google-generative-ai'], [MODEL, 'google-vertex']]) for (const protocol of ['generate-content', 'interactions']) for (const tier of ['standard', 'flex', 'priority']) {
 test(route + '/' + protocol + '/' + tier + ' maps only its own request fields', async () => {
  const wire = []; let diagnostic
  globalThis.fetch = async (url, init) => {
   wire.push({ url: String(url), body: JSON.parse(init.body), headers: new Headers(init.headers) })
   return protocol === 'generate-content' ? sse([{ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1, thoughtsTokenCount: 0, trafficType: 'ON_DEMAND' } }]) : sse([{ event_type: 'interaction.created', interaction: { id: 'task', status: 'in_progress' } }, { event_type: 'interaction.completed', interaction: { id: 'task', status: 'completed' } }])
  }
  try {
   const config = { googleProtocol: protocol, vertexProtocol: protocol, googleServiceTier: tier, vertexServiceTier: tier, routes: { hasGoogle: true, hasVertex: true } }
   const adapter = createArgonAdapter(ctx, config, undefined, undefined, d => { diagnostic = d })
   if (!SERVICE_TIER_CAPABILITIES[route + '/' + protocol].includes(tier)) {
    await assert.rejects(adapter.prepareCall(PROVIDER, model), { code: 'ARGON_SERVICE_TIER_UNVERIFIED' }); assert.equal(wire.length, 0); return
   }
   const prepared = await adapter.prepareCall(PROVIDER, model)
   config.googleServiceTier = 'standard'; config.vertexServiceTier = 'standard'
   const chunks = await collect(prepared.stream(request(model)))
   assert.equal(chunks.at(-1).reason.kind, 'stop'); assert.equal(wire.length, 1)
   assert.equal(wire[0].body.service_tier, route === 'google-generative-ai' && tier !== 'standard' ? tier : undefined)
   assert.equal(wire[0].headers.get('X-Vertex-AI-LLM-Shared-Request-Type'), route === 'google-vertex' && tier !== 'standard' ? tier : null)
   assert.equal(wire[0].headers.get('X-Vertex-AI-LLM-Request-Type'), null)
   assert.equal(diagnostic.serviceTier.requested, tier)
   assert.equal(diagnostic.serviceTier.observed, route === 'google-generative-ai' || (protocol === 'generate-content' && route === 'google-vertex') ? 'standard' : null)
  } finally { globalThis.fetch = originalFetch }
 })
}
test('Vertex PayGo-only is explicit and Gemini Flex failure never reissues at Standard', async () => {
 const wire=[]
 globalThis.fetch=async(_url,init)=>{wire.push({body:JSON.parse(init.body),headers:new Headers(init.headers)});return new Response('{}',{status:503})}
 try {
  const config={googleProtocol:'interactions',googleServiceTier:'flex',routes:{hasGoogle:true,hasVertex:true}}
  const out=await collect(createArgonAdapter(ctx,config).stream(request(GOOGLE_API_MODEL)))
  assert.equal(out.at(-1).reason.kind,'error');assert.equal(wire.length,1);assert.equal(wire[0].body.service_tier,'flex')
  globalThis.fetch=async(_url,init)=>{wire.push({body:JSON.parse(init.body),headers:new Headers(init.headers)});return sse([{candidates:[{content:{role:'model',parts:[{text:'ok'}]},finishReason:'STOP'}]}])}
  const vertex=createArgonAdapter(ctx,{vertexProtocol:'generate-content',vertexServiceTier:'priority',vertexPaygoOnly:true,routes:{hasGoogle:true,hasVertex:true}})
  await collect(vertex.stream(request(MODEL)))
  assert.equal(wire.at(-1).headers.get('X-Vertex-AI-LLM-Request-Type'),'shared')
  assert.equal(wire.at(-1).headers.get('X-Vertex-AI-LLM-Shared-Request-Type'),'priority')
 } finally {globalThis.fetch=originalFetch}
})
test('service defaults do not activate paid tiers or bypass provisioned throughput', () => {
 const cfg = resolveConfigValues({})
 assert.equal(cfg.googleServiceTier, 'standard'); assert.equal(cfg.vertexServiceTier, 'standard'); assert.equal(cfg.vertexPaygoOnly, false)
 for (const raw of [{googleServiceTier:'auto'}, {vertexServiceTier:'PRIORITY'}, {vertexPaygoOnly:'true'}]) assert.throws(() => resolveConfigValues(raw), /service|PayGo/)
})
