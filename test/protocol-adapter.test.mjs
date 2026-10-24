import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createArgonAdapter,PROVIDER,MODEL,GOOGLE_API_MODEL} from '../adapter.js'
import {createInteractionStateHub} from '../interaction-state.js'
import {createResponseHub} from '../response-store.js'
import {recordSchema} from '../diagnostic-store.js'
const ctx={get:k=>k==='launchEnvironment'?{get:n=>['GOOGLE_API_KEY','GOOGLE_CLOUD_API_KEY'].includes(n)?{value:'fixture'}:undefined}:undefined}
const cfg=()=>({maxTokens:65536,reasoning:'medium',longDecode:true,googleProtocol:'interactions',vertexProtocol:'generate-content',routes:{hasGoogle:true,hasVertex:true}})
const req=model=>({provider:PROVIDER,model,maxTokens:512,sessionId:'fixture-session',messages:[{role:'user',content:[{type:'text',text:'hello'}]}]})
const collect=async stream=>{const out=[];for await(const c of stream)out.push(c);return out}
const wire=[]
const sse=events=>new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}})
const interactionEvents=[{event_type:'interaction.created',event_id:'e1',interaction:{id:'remote',status:'in_progress'}},{event_type:'step.start',event_id:'e2',index:0,step:{type:'model_output'}},{event_type:'step.delta',event_id:'e3',index:0,delta:{type:'text',text:'hello'}},{event_type:'step.stop',event_id:'e4',index:0},{event_type:'interaction.completed',event_id:'e5',interaction:{id:'remote',status:'completed',usage:{total_input_tokens:30,total_output_tokens:1,total_thought_tokens:0,total_tokens:31}}}]
const originalFetch=globalThis.fetch
let responder
globalThis.fetch=async(input,init)=>{
 const url=String(typeof input==='string'?input:input instanceof URL?input.href:input.url)
 const entry={url,method:init?.method??'GET',body:init?.body?JSON.parse(init.body):undefined};wire.push(entry)
 if(responder)return responder(entry)
 if(url.includes('streamGenerateContent'))return sse([{candidates:[{content:{role:'model',parts:[{text:'hello'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:30,candidatesTokenCount:1,totalTokenCount:31}}])
 return sse(interactionEvents)
}
for(const [model,route]of [[GOOGLE_API_MODEL,'google-generative-ai'],[MODEL,'google-vertex']])test(route+': selected Interactions reaches its exact endpoint through prepared DSH calls',async()=>{
 const config=cfg();config.googleProtocol='interactions';config.vertexProtocol='interactions';let diagnostic
 const adapter=createArgonAdapter(ctx,config,undefined,undefined,d=>diagnostic=d)
 const prepared=await adapter.prepareCall(PROVIDER,model)
 const out=await collect(prepared.stream(req(model)))
 assert.equal(out.at(-1).reason.kind,'stop');assert.equal(diagnostic.protocol,'interactions');assert.equal('regionClass' in diagnostic,false)
 const last=wire.at(-1);assert.ok(last.url.endsWith(route==='google-vertex'?'/v1beta1/locations/global/interactions':'/v1beta/interactions'))
 assert.equal(last.body.store,false);assert.equal(last.body.background,false)
 assert.equal(out.find(c=>c.type==='usage').usage.totalTokens,31)
})
test('one route can use Interactions while the other retains GenerateContent',async()=>{
 const adapter=createArgonAdapter(ctx,cfg())
 await collect(adapter.stream(req(GOOGLE_API_MODEL)));assert.ok(wire.at(-1).url.endsWith('/interactions'))
 await collect(adapter.stream(req(MODEL)));assert.ok(wire.at(-1).url.includes('streamGenerateContent'))
})
test('prepared Interactions call retains config and endpoint snapshot',async()=>{
 const config=cfg();const adapter=createArgonAdapter(ctx,()=>config)
 const prepared=await adapter.prepareCall(PROVIDER,GOOGLE_API_MODEL)
 config.googleProtocol='generate-content';config.reasoning='high';config.routes.googleBaseUrl='https://changed.invalid'
 const out=await collect(prepared.stream(req(GOOGLE_API_MODEL)))
 assert.equal(out.at(-1).reason.kind,'stop')
 assert.ok(wire.at(-1).url.startsWith('https://generativelanguage.googleapis.com'))
 assert.equal(wire.at(-1).body.generation_config.thinking_level,'medium')
})
test('Vertex large Interactions budget and missing storage consent refuse before network',async()=>{
 for(const config of [{...cfg(),maxTokens:131072,vertexProtocol:'interactions',interactionsBackground:true,allowInteractionStorage:true},{...cfg(),interactionsBackground:true,allowInteractionStorage:false}]){
  const before=wire.length,adapter=createArgonAdapter(ctx,config),request=req(config.vertexProtocol==='interactions'?MODEL:GOOGLE_API_MODEL)
  request.maxTokens=config.maxTokens
  const out=await collect(adapter.stream(request))
  assert.equal(out.at(-1).reason.kind,'error');assert.equal(wire.length,before)
 }
})
test('background creation persists its first ID then consumes resumable output through GET',async()=>{
 const rows=new Map(),hub=createInteractionStateHub()
 hub.attach({table:()=>({get:k=>rows.get(k),get size(){return rows.size},entries:()=>rows.entries(),put:async(k,v)=>rows.set(k,v),delete:async k=>rows.delete(k)}),close:async()=>{}})
 const before=wire.length
 responder=()=>sse(interactionEvents)
 try{
  const adapter=createArgonAdapter(ctx,{...cfg(),interactionsBackground:true,allowInteractionStorage:true},undefined,undefined,undefined,hub)
  const out=await collect(adapter.stream(req(GOOGLE_API_MODEL)))
  assert.equal(out.at(-1).reason.kind,'stop')
  const calls=wire.slice(before);assert.equal(calls.filter(x=>x.method==='POST').length,1);assert.equal(calls[0].body.stream,true)
  assert.equal(calls.length,2);assert.equal(calls[1].method,'GET');assert.ok(calls[1].url.includes('/remote?stream=true'));assert.equal(rows.size,0)
 }finally{responder=undefined;await hub.close()}
})
test('first background GET failure reconnects rather than cancelling the newly created task',async()=>{
 const rows=new Map(),hub=createInteractionStateHub();hub.attach({table:()=>({get:k=>rows.get(k),get size(){return rows.size},entries:()=>rows.entries(),put:async(k,v)=>rows.set(k,v),delete:async k=>rows.delete(k)}),close:async()=>{}})
 const before=wire.length;let gets=0
 responder=entry=>{if(entry.method==='POST')return sse([interactionEvents[0]]);if(++gets===1)return new Response('{}',{status:503});return sse(interactionEvents)}
 try{
  const adapter=createArgonAdapter(ctx,{...cfg(),interactionsBackground:true,allowInteractionStorage:true},undefined,undefined,undefined,hub)
  const out=await collect(adapter.stream(req(GOOGLE_API_MODEL)))
  assert.equal(out.at(-1).reason.kind,'stop');assert.equal(gets,2);assert.equal(wire.slice(before).filter(r=>r.method==='POST').length,1);assert.equal(rows.size,0)
 }finally{responder=undefined;await hub.close()}
})
test('host usage mapping preserves tool-use tokens and never leaves diagnostic hops pending',async()=>{
 let diagnostic
 const events=structuredClone(interactionEvents);Object.assign(events.at(-1).interaction.usage,{total_tool_use_tokens:9,total_tokens:40})
 responder=()=>sse(events)
 try{
  const out=await collect(createArgonAdapter(ctx,cfg(),undefined,undefined,d=>diagnostic=d).stream(req(GOOGLE_API_MODEL)))
  const usage=out.find(c=>c.type==='usage').usage;assert.equal(usage.inputTokens,39);assert.equal(usage.totalTokens,40)
  assert.ok(diagnostic.hops.every(h=>h.outcome!=='pending'))
 }finally{responder=undefined}
})
test('a fully consumed remote failure releases its handle for an explicit new attempt',async()=>{
 const rows=new Map(),hub=createInteractionStateHub();hub.attach({table:()=>({get:k=>rows.get(k),get size(){return rows.size},entries:()=>rows.entries(),put:async(k,v)=>rows.set(k,v),delete:async k=>rows.delete(k)}),close:async()=>{}})
 responder=()=>sse([interactionEvents[0],{event_type:'interaction.completed',interaction:{id:'remote',status:'failed'}}])
 try{
  const out=await collect(createArgonAdapter(ctx,{...cfg(),interactionsBackground:true,allowInteractionStorage:true},undefined,undefined,undefined,hub).stream(req(GOOGLE_API_MODEL)))
  assert.equal(out.at(-1).reason.kind,'error');assert.equal(rows.size,0)
 }finally{responder=undefined;await hub.close()}
})
test('context watermark uses original-generation final usage, not subsequent billed inputs',async()=>{
 let diagnostic
 const events=[{event_type:'interaction.created',interaction:{id:'remote',status:'in_progress'}},{event_type:'step.start',index:0,step:{type:'model_output'}},{event_type:'interaction.status_update',status:'in_progress',usage:{total_input_tokens:100,total_output_tokens:0}},{event_type:'step.delta',index:0,delta:{type:'text',text:'A'}},{event_type:'step.stop',index:0,usage:{total_input_tokens:120,total_output_tokens:10,total_thought_tokens:20}},{event_type:'step.start',index:1,step:{type:'model_output'}},{event_type:'step.delta',index:1,delta:{type:'text',text:'B'}},{event_type:'step.stop',index:1,usage:{total_input_tokens:270,total_output_tokens:15,total_thought_tokens:30}},{event_type:'interaction.completed',interaction:{id:'remote',status:'completed',usage:{total_input_tokens:270,total_output_tokens:15,total_thought_tokens:30,total_tokens:315}}}]
 responder=()=>sse(events)
 try{
  const out=await collect(createArgonAdapter(ctx,cfg(),undefined,undefined,d=>diagnostic=d).stream(req(GOOGLE_API_MODEL)))
  assert.equal(out.at(-1).reason.kind,'stop');const u=out.find(x=>x.type==='usage').usage
  assert.equal(u.inputTokens,120);assert.equal(u.outputTokens,45);assert.equal(u.totalTokens,165)
  assert.equal(diagnostic.tokenUsage.billedPromptTokens,270)
 }finally{responder=undefined}
})
test('background HTTP 402 is explicit billing rejection, with no retry or unknown task lock',async()=>{
 const rows=new Map(),hub=createInteractionStateHub();hub.attach({table:()=>({get:k=>rows.get(k),get size(){return rows.size},entries:()=>rows.entries(),put:async(k,v)=>rows.set(k,v),delete:async k=>rows.delete(k)}),close:async()=>{}})
 const before=wire.length;let diagnostic
 responder=()=>new Response('PRIVATE_PROVIDER_ERROR_BODY',{status:402})
 try{
  const out=await collect(createArgonAdapter(ctx,{...cfg(),interactionsBackground:true,allowInteractionStorage:true},undefined,undefined,d=>diagnostic=d,hub).stream(req(GOOGLE_API_MODEL)))
  assert.equal(out.at(-1).reason.kind,'error');assert.equal(out.at(-1).reason.failure.code,'PAYMENT_REQUIRED')
  assert.equal(out.at(-1).reason.failure.status,402)
  assert.match(out.at(-1).reason.failure.message,/prepaid credit balance/)
  assert.ok(!JSON.stringify(out).includes('PRIVATE_PROVIDER_ERROR_BODY'))
  assert.equal(rows.size,0);assert.equal(wire.length-before,1)
  assert.equal(diagnostic.remoteCancellation,'not-requested');assert.equal(diagnostic.failureCategory,'api-status-error')
  assert.equal(diagnostic.hops[0].status,402);assert.equal(diagnostic.hops[0].errorPhase,'fetch')
 }finally{responder=undefined;await hub.close()}
})
for (const malformed of [false, true]) test('background adapter distinguishes ' + (malformed ? 'invalid SSE' : 'exhausted GET') + ' from ordinary completion', async () => {
 const rows = new Map(), hub = createInteractionStateHub()
 hub.attach({table:()=>({get:k=>rows.get(k),get size(){return rows.size},entries:()=>rows.entries(),put:async(k,v)=>rows.set(k,v),delete:async k=>rows.delete(k)}),close:async()=>{}})
 const before = wire.length
 responder = entry => {
  if (entry.url.endsWith('/cancel')) return new Response(JSON.stringify({status:'cancelled'}), {headers:{'Content-Type':'application/json'}})
  if (entry.method === 'POST') return sse([interactionEvents[0]])
  return malformed ? new Response('data: invalid-json\n\n', {headers:{'Content-Type':'text/event-stream'}}) : new Response('{}', {status:503})
 }
 try {
  const out = await collect(createArgonAdapter(ctx,{...cfg(),interactionsBackground:true,allowInteractionStorage:true},undefined,undefined,undefined,hub).stream(req(GOOGLE_API_MODEL)))
  assert.equal(out.at(-1).reason.kind,'error')
  assert.equal(out.at(-1).reason.failure.code,malformed?'ARGON_INTERACTIONS_PROTOCOL':'ARGON_BACKGROUND_READ_INTERRUPTED')
  const calls=wire.slice(before)
  assert.equal(calls.filter(x=>x.method==='POST'&&!x.url.endsWith('/cancel')).length,1)
  assert.equal(calls.filter(x=>x.url.endsWith('/cancel')).length,malformed?1:0)
  assert.equal(calls.filter(x=>x.method==='GET').length,malformed?1:4)
  assert.equal(rows.size,malformed?0:1)
 } finally {responder=undefined;await hub.close()}
})
test('basic usage excludes per-step modality evidence and retains observed hop tokens',async()=>{
 let diagnostic
 const events=structuredClone(interactionEvents)
 events[3].step_usage={total_input_tokens:10,total_output_tokens:2,total_thought_tokens:1,input_tokens_by_modality:[{modality:'text',tokens:10}]}
 events[3].usage={total_input_tokens:20,total_output_tokens:4,total_thought_tokens:2}
 events.at(-1).interaction.usage={total_input_tokens:30,total_output_tokens:6,total_thought_tokens:3}
 responder=()=>sse(events)
 try {
  await collect(createArgonAdapter(ctx,cfg(),undefined,undefined,d=>diagnostic=d).stream(req(GOOGLE_API_MODEL)))
  assert.equal('usageDetails' in diagnostic,false)
  assert.equal('costEstimate' in diagnostic,false)
  assert.equal(diagnostic.tokenUsage.billedPromptTokens,30)
  assert.equal(diagnostic.tokenUsage.billedOutputTokens,6)
  assert.equal(diagnostic.tokenUsage.billedThoughtsTokens,3)
  assert.equal(diagnostic.hops[0].promptTokens,30)
  assert.equal(diagnostic.hops[0].outputTokens,6)
  assert.equal(diagnostic.hops[0].thoughtsTokens,3)
  assert.equal(JSON.stringify(diagnostic).includes('inputByModality'),false)
 }finally{responder=undefined}
})
for(const protocol of ['generate-content','interactions'])for(const enabled of [false,true])test(protocol+': raw capture is explicit, request-frozen, and separate from diagnostic metadata ('+enabled+')',async()=>{
 const config={...cfg(),googleProtocol:protocol,retainRawResponses:enabled};const hub=createResponseHub();let record
 const adapter=createArgonAdapter(ctx,()=>config,undefined,undefined,d=>record=d,undefined,hub)
 const prepared=await adapter.prepareCall(PROVIDER,GOOGLE_API_MODEL);config.retainRawResponses=!enabled
 const out=await collect(prepared.stream(req(GOOGLE_API_MODEL)))
 assert.equal(out.at(-1).reason.kind,'stop',JSON.stringify(out.at(-1)));recordSchema.parse(record)
 assert.equal(record.responseCapture.status,enabled?'captured':'disabled')
 assert.ok(!JSON.stringify(record).includes('hello'));assert.ok(record.sessionHash)
 const result=hub.read({id:record.id,sessionHash:record.sessionHash})
 assert.equal(result.status,enabled?'available':'not-retained')
 if(enabled){assert.equal(result.frame.kind,protocol==='generate-content'?'gc-chunk':'interaction-event');assert.ok(result.metadata.frames>0)}
 await hub.close()
})
test('partial Interactions usage frames preserve prior counters within the same hop',async()=>{
 const events=structuredClone(interactionEvents)
 events[0].interaction.usage={total_input_tokens:30,total_cached_tokens:4}
 events.at(-1).interaction.usage={total_output_tokens:2,total_thought_tokens:3,total_tokens:35}
 let diagnostic
 responder=()=>sse(events)
 try {
  const out=await collect(createArgonAdapter(ctx,cfg(),undefined,undefined,d=>diagnostic=d).stream(req(GOOGLE_API_MODEL)))
  assert.equal(out.at(-1).reason.kind,'stop')
  assert.equal(diagnostic.hops[0].promptTokens,30)
  assert.equal(diagnostic.hops[0].cachedTokens,4)
  assert.equal(diagnostic.hops[0].outputTokens,2)
  assert.equal(diagnostic.hops[0].thoughtsTokens,3)
  assert.equal(diagnostic.hops[0].totalTokens,35)
 }finally{responder=undefined}
})
test('actual Vertex SDK express request retains debug metadata without pricing fields',async()=>{
 let diagnostic;const adapter=createArgonAdapter(ctx,cfg(),undefined,undefined,d=>diagnostic=d)
 await collect(adapter.stream(req(MODEL)));assert.equal('regionClass' in diagnostic,false);assert.equal('costEstimate' in diagnostic,false);recordSchema.parse(diagnostic)
})
process.on('exit',()=>{globalThis.fetch=originalFetch})
