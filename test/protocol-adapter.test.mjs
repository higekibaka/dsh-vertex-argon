import assert from 'node:assert/strict'
import {test as nodeTest} from 'node:test'
import {createArgonAdapter,PROVIDER,MODEL,GOOGLE_API_MODEL,CARBON_MODEL,GOOGLE_API_CARBON_MODEL,HYDROGEN_MODEL,GOOGLE_API_HYDROGEN_MODEL,NEON_MODEL,GOOGLE_API_NEON_MODEL,officialUpstreamModel} from '../adapter.js'
import {contentHash,historyHash,buildInteractionRequest,INTERACTIONS_REPLAY_API,generateContentHistory} from '../interactions-input.js'
import {assertInteractionOptions} from '../interaction-adapter.js'
import {createInteractionStateHub} from '../interaction-state.js'
import {createResponseHub} from '../response-store.js'
import {recordSchema} from '../diagnostic-store.js'
const ctx={get:k=>k==='launchEnvironment'?{get:n=>['GOOGLE_API_KEY','GOOGLE_CLOUD_API_KEY'].includes(n)?{value:'fixture'}:undefined}:undefined}
const cfg=()=>({maxTokens:65536,reasoning:'medium',longDecode:true,googleProtocol:'interactions',vertexProtocol:'generate-content',routes:{hasGoogle:true,hasVertex:true,hasGoogleCarbon:true,hasVertexCarbon:true,hasVertexHydrogen:true,hasGoogleHydrogen:true,hasVertexNeon:true,hasGoogleNeon:true}})
const req=model=>({provider:PROVIDER,model,maxTokens:512,sessionId:'fixture-session',messages:[{role:'user',content:[{type:'text',text:'hello'}]}]})
const collect=async stream=>{const out=[];for await(const c of stream)out.push(c);return out}
const wire=[]
const sse=events=>new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}})
const interactionEvents=[{event_type:'interaction.created',event_id:'e1',interaction:{id:'remote',status:'in_progress'}},{event_type:'step.start',event_id:'e2',index:0,step:{type:'model_output'}},{event_type:'step.delta',event_id:'e3',index:0,delta:{type:'text',text:'hello'}},{event_type:'step.stop',event_id:'e4',index:0},{event_type:'interaction.completed',event_id:'e5',interaction:{id:'remote',status:'completed',usage:{total_input_tokens:30,total_output_tokens:1,total_thought_tokens:0,total_tokens:31}}}]
// 只在单个测试内替换 fetch：--test-isolation=none 下模块级全局替身会污染其它测试文件。
const hostFetch=globalThis.fetch
let responder
const stubFetch=async(input,init)=>{
 const url=String(typeof input==='string'?input:input instanceof URL?input.href:input.url)
 const entry={url,method:init?.method??'GET',body:init?.body?JSON.parse(init.body):undefined};wire.push(entry)
 if(responder)return responder(entry)
 if(url.includes('streamGenerateContent'))return sse([{candidates:[{content:{role:'model',parts:[{text:'hello'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:30,candidatesTokenCount:1,totalTokenCount:31}}])
 return sse(interactionEvents)
}
const test=(name,fn)=>nodeTest(name,async(...args)=>{globalThis.fetch=stubFetch;try{return await fn(...args)}finally{globalThis.fetch=hostFetch}})
for(const [model,route,expectedUpstream]of [[GOOGLE_API_MODEL,'google-generative-ai','gemini-4-argon'],[MODEL,'google-vertex','gemini-4-argon'],[GOOGLE_API_CARBON_MODEL,'google-generative-ai','gemini-4-carbon'],[CARBON_MODEL,'google-vertex','gemini-4-carbon'],[GOOGLE_API_HYDROGEN_MODEL,'google-generative-ai','gemini-4-hydrogen'],[HYDROGEN_MODEL,'google-vertex','gemini-4-hydrogen'],[GOOGLE_API_NEON_MODEL,'google-generative-ai','gemini-4-neon'],[NEON_MODEL,'google-vertex','gemini-4-neon']])test(route+' ('+model+'): selected Interactions reaches its exact endpoint through prepared DSH calls',async()=>{
 const config=cfg();config.googleProtocol='interactions';config.vertexProtocol='interactions';let diagnostic
 const adapter=createArgonAdapter(ctx,config,undefined,undefined,d=>diagnostic=d)
 const prepared=await adapter.prepareCall(PROVIDER,model)
 const out=await collect(prepared.stream(req(model)))
 assert.equal(out.at(-1).reason.kind,'stop');assert.equal(diagnostic.protocol,'interactions');assert.equal('regionClass' in diagnostic,false)
 const last=wire.at(-1);assert.ok(last.url.endsWith(route==='google-vertex'?'/v1beta1/locations/global/interactions':'/v1beta/interactions'))
 assert.equal(last.body.model,expectedUpstream)
 assert.equal(last.body.store,false);assert.equal(last.body.background,false)
 assert.equal(out.find(c=>c.type==='usage').usage.totalTokens,31)
})
test('Interactions keeps Hydrogen native replay on the same model and degrades Argon/Carbon history to text',async()=>{
 const config=cfg();config.googleProtocol='interactions';config.vertexProtocol='interactions'
 config.routes={...config.routes,hasVertexHydrogen:true,hasGoogleHydrogen:true}
 const tools=[{name:'echo',description:'offline fixture only',parameters:{type:'object',properties:{value:{type:'string'}},required:['value']}}]
 const user={role:'user',content:[{type:'text',text:'hello'}]}
 const tool={role:'tool',toolCallId:'h1',toolName:'echo',content:[{type:'text',text:'ok'}],isError:false}
 const encodedSig=Buffer.from('hydrogen-signature').toString('base64')
 const content=[{type:'text',text:'thinking',textSignature:encodedSig},{type:'tool-call',id:'h1',name:'echo',arguments:{value:'x'}}]
 const steps=[{type:'thought',signature:encodedSig,content:[{type:'text',text:'thinking'}]},{type:'function_call',call_id:'h1',name:'echo',arguments:{value:'x'}}]
 const historyOf=model=>[user,{role:'assistant',content,source:{provider:PROVIDER,model,replayState:{response:{api:'google-interactions-v1',provider:PROVIDER,model,route:'google-vertex',contentHash:contentHash(content),historyHash:historyHash([user]),steps}}}},tool]
 const adapter=createArgonAdapter(ctx,config)
 const same=await collect(adapter.stream({...req(HYDROGEN_MODEL),messages:historyOf(HYDROGEN_MODEL),tools}))
 assert.equal(same.at(-1).reason.kind,'stop')
 const native=wire.at(-1).body.input
 assert.ok(native.some(row=>row&&row.type==='function_call'&&row.call_id==='h1'))
 assert.ok(native.some(row=>row&&row.type==='thought'&&row.signature===encodedSig))
 assert.equal(JSON.stringify(native).includes('[Previously executed tool'),false)
 for(const from of [MODEL,GOOGLE_API_CARBON_MODEL]){
  const crossed=await collect(adapter.stream({...req(HYDROGEN_MODEL),messages:historyOf(from),tools}))
  assert.equal(crossed.at(-1).reason.kind,'stop')
  const degraded=wire.at(-1).body.input
  assert.equal(degraded.some(row=>row&&(row.type==='function_call'||row.type==='function_result')),false)
  assert.equal(JSON.stringify(degraded).includes(encodedSig),false)
  assert.ok(JSON.stringify(degraded).includes('[Previously executed tool echo; call h1]'))
  assert.ok(JSON.stringify(degraded).includes('[Result of previously executed tool call h1]'))
 }
})
test('Interactions keeps Neon native replay on the same model and degrades Hydrogen/Carbon/Argon history to text',async()=>{
 const config=cfg();config.googleProtocol='interactions';config.vertexProtocol='interactions'
 const tools=[{name:'echo',description:'offline fixture only',parameters:{type:'object',properties:{value:{type:'string'}},required:['value']}}]
 const user={role:'user',content:[{type:'text',text:'hello'}]}
 const tool={role:'tool',toolCallId:'n1',toolName:'echo',content:[{type:'text',text:'ok'}],isError:false}
 const encodedSig=Buffer.from('neon-signature').toString('base64')
 const content=[{type:'text',text:'thinking',textSignature:encodedSig},{type:'tool-call',id:'n1',name:'echo',arguments:{value:'x'}}]
 const steps=[{type:'thought',signature:encodedSig,content:[{type:'text',text:'thinking'}]},{type:'function_call',call_id:'n1',name:'echo',arguments:{value:'x'}}]
 const historyOf=model=>[user,{role:'assistant',content,source:{provider:PROVIDER,model,replayState:{response:{api:'google-interactions-v1',provider:PROVIDER,model,route:'google-vertex',contentHash:contentHash(content),historyHash:historyHash([user]),steps}}}},tool]
 const adapter=createArgonAdapter(ctx,config)
 const same=await collect(adapter.stream({...req(NEON_MODEL),messages:historyOf(NEON_MODEL),tools}))
 assert.equal(same.at(-1).reason.kind,'stop')
 const native=wire.at(-1).body.input
 assert.ok(native.some(row=>row&&row.type==='function_call'&&row.call_id==='n1'))
 assert.ok(native.some(row=>row&&row.type==='thought'&&row.signature===encodedSig))
 assert.equal(JSON.stringify(native).includes('[Previously executed tool'),false)
 for(const from of [HYDROGEN_MODEL,GOOGLE_API_CARBON_MODEL,MODEL]){
  const crossed=await collect(adapter.stream({...req(NEON_MODEL),messages:historyOf(from),tools}))
  assert.equal(crossed.at(-1).reason.kind,'stop')
  const degraded=wire.at(-1).body.input
  assert.equal(degraded.some(row=>row&&(row.type==='function_call'||row.type==='function_result')),false)
  assert.equal(JSON.stringify(degraded).includes(encodedSig),false)
  assert.ok(JSON.stringify(degraded).includes('[Previously executed tool echo; call n1]'))
  assert.ok(JSON.stringify(degraded).includes('[Result of previously executed tool call n1]'))
 }
})
test('one route can use Interactions while the other retains GenerateContent',async()=>{
 const adapter=createArgonAdapter(ctx,cfg())
 await collect(adapter.stream(req(GOOGLE_API_MODEL)));assert.ok(wire.at(-1).url.endsWith('/interactions'))
 await collect(adapter.stream(req(MODEL)));assert.ok(wire.at(-1).url.includes('streamGenerateContent'))
})
test('Interactions narrows max to high on both Carbon routes regardless of the configured default level',async()=>{
 for(const model of [GOOGLE_API_CARBON_MODEL,CARBON_MODEL]){
  const config={...cfg(),reasoning:'low'};config.googleProtocol='interactions';config.vertexProtocol='interactions'
  const adapter=createArgonAdapter(ctx,config)
  const viaEffort=await collect(adapter.stream({...req(model),reasoningEffort:'max'}))
  assert.equal(viaEffort.at(-1).reason.kind,'stop')
  assert.equal(wire.at(-1).body.generation_config.thinking_level,'high')
  assert.equal(wire.at(-1).body.model,'gemini-4-carbon')
  const prepared=await adapter.prepareCall(PROVIDER,model)
  const viaReasoning=await collect(prepared.stream({...req(model),reasoning:'max'}))
  assert.equal(viaReasoning.at(-1).reason.kind,'stop')
  assert.equal(wire.at(-1).body.generation_config.thinking_level,'high')
  for(const bad of ['minimal','off','xhigh']){
   const before=wire.length
   const out=await collect(adapter.stream({...req(model),reasoningEffort:bad}))
   assert.equal(out.at(-1).reason.kind,'error')
   assert.match(JSON.stringify(out.at(-1).reason),/requires low, medium, or high thinking/)
   assert.equal(wire.length,before)
  }
 }
})
test('Interactions allows xhigh and narrows max to xhigh on all Hydrogen and Neon routes regardless of default level',async()=>{
 for(const model of [HYDROGEN_MODEL,GOOGLE_API_HYDROGEN_MODEL,NEON_MODEL,GOOGLE_API_NEON_MODEL]){
  const expectedUpstream=officialUpstreamModel(model)
  const route=model.endsWith('-google')?'google-generative-ai':'google-vertex'
  const config={...cfg(),reasoning:'low'};config.googleProtocol='interactions';config.vertexProtocol='interactions'
  assert.deepEqual(assertInteractionOptions({model,reasoningEffort:'xhigh',maxTokens:512},config,route),{maxTokens:512,reasoning:'xhigh'})
  assert.deepEqual(assertInteractionOptions({model,reasoningEffort:'max',maxTokens:512},config,route),{maxTokens:512,reasoning:'xhigh'})
  assert.throws(()=>assertInteractionOptions({model,reasoningEffort:'minimal',maxTokens:512},config,route),/requires low, medium, high, or xhigh thinking/)
  const directBuilt=await buildInteractionRequest({...req(model),reasoningEffort:'xhigh'},{route,upstreamModel:expectedUpstream})
  assert.equal(directBuilt.generation_config.thinking_level,'xhigh')
  const directMax=await buildInteractionRequest({...req(model),reasoningEffort:'max'},{route,upstreamModel:expectedUpstream})
  assert.equal(directMax.generation_config.thinking_level,'xhigh')

  const adapter=createArgonAdapter(ctx,config)
  const viaXhigh=await collect(adapter.stream({...req(model),reasoningEffort:'xhigh'}))
  assert.equal(viaXhigh.at(-1).reason.kind,'stop')
  assert.equal(wire.at(-1).body.generation_config.thinking_level,'xhigh')
  assert.equal(wire.at(-1).body.model,expectedUpstream)

  const viaMax=await collect(adapter.stream({...req(model),reasoningEffort:'max'}))
  assert.equal(viaMax.at(-1).reason.kind,'stop')
  assert.equal(wire.at(-1).body.generation_config.thinking_level,'xhigh')
  assert.equal(wire.at(-1).body.model,expectedUpstream)

  const prepared=await adapter.prepareCall(PROVIDER,model)
  const preparedXhigh=await collect(prepared.stream({...req(model),reasoningEffort:'xhigh'}))
  assert.equal(preparedXhigh.at(-1).reason.kind,'stop')
  assert.equal(wire.at(-1).body.generation_config.thinking_level,'xhigh')

  const preparedMax=await collect(prepared.stream({...req(model),reasoning:'max'}))
  assert.equal(preparedMax.at(-1).reason.kind,'stop')
  assert.equal(wire.at(-1).body.generation_config.thinking_level,'xhigh')

  for(const bad of ['minimal','off']){
   const before=wire.length
   const out=await collect(adapter.stream({...req(model),reasoningEffort:bad}))
   assert.equal(out.at(-1).reason.kind,'error')
   assert.match(JSON.stringify(out.at(-1).reason),/requires low, medium, high, or xhigh thinking/)
   assert.equal(wire.length,before)
  }
 }
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
const toolRequest = model => ({ ...req(model), tools: [{ name: 'add', description: 'sum', parameters: { type: 'object', properties: { a: { type: 'number' } } } }] })
test('a single-hop tool call keeps its one and only usage through the whole adapter',async()=>{
 let diagnostic
 const events=[
  {event_type:'interaction.created',event_id:'t1',interaction:{id:'remote',status:'in_progress'}},
  {event_type:'step.start',event_id:'t2',index:0,step:{type:'model_output'}},
  {event_type:'step.delta',event_id:'t3',index:0,delta:{type:'text',text:'checking'}},
  {event_type:'step.stop',event_id:'t4',index:0},
  {event_type:'step.start',event_id:'t5',index:1,step:{type:'function_call',id:'call-1',name:'add'}},
  {event_type:'step.delta',event_id:'t6',index:1,delta:{type:'arguments_delta',arguments:'{"a":1}'}},
  {event_type:'step.stop',event_id:'t7',index:1},
  {event_type:'interaction.requires_action',event_id:'t8',interaction:{id:'remote',usage:{total_input_tokens:40,total_cached_tokens:10,total_output_tokens:5,total_thought_tokens:2,total_tokens:47}}},
 ]
 responder=()=>sse(events)
 try{
  const out=await collect(createArgonAdapter(ctx,cfg(),undefined,undefined,d=>diagnostic=d).stream(toolRequest(GOOGLE_API_MODEL)))
  assert.equal(out.at(-1).reason.kind,'tool-calls')
  // The function_call step of the same hop must not close the first-hop
  // watermark, or requires_action's single usage chunk would be dropped.
  const usageChunks=out.filter(c=>c.type==='usage')
  assert.equal(usageChunks.length,1)
  assert.deepEqual(usageChunks[0].usage,{inputTokens:30,cacheReadTokens:10,outputTokens:7,reasoningTokens:2,totalTokens:47})
  assert.equal(diagnostic.tokenUsage.reportedInputTokens,40)
  assert.equal(diagnostic.tokenUsage.reportedCacheTokens,10)
  assert.equal(diagnostic.tokenUsage.billedPromptTokens,40)
 }finally{responder=undefined}
})
test('a single-hop output-only usage never fabricates a zero input watermark',async()=>{
 let diagnostic
 const events=[
  {event_type:'interaction.created',event_id:'u1',interaction:{id:'remote',status:'in_progress'}},
  {event_type:'step.start',event_id:'u2',index:0,step:{type:'function_call',id:'call-1',name:'add'}},
  {event_type:'step.delta',event_id:'u3',index:0,delta:{type:'arguments_delta',arguments:'{"a":1}'}},
  {event_type:'step.stop',event_id:'u4',index:0},
  {event_type:'interaction.requires_action',event_id:'u5',interaction:{id:'remote',usage:{total_output_tokens:5,total_thought_tokens:2}}},
 ]
 responder=()=>sse(events)
 try{
  const out=await collect(createArgonAdapter(ctx,cfg(),undefined,undefined,d=>diagnostic=d).stream(toolRequest(GOOGLE_API_MODEL)))
  assert.equal(out.at(-1).reason.kind,'tool-calls')
  // An unknown input is not a known zero: no distorted usage chunk escapes.
  assert.equal(out.some(c=>c.type==='usage'),false)
  assert.equal(diagnostic.tokenUsage.reportedInputTokens,null)
  assert.equal(diagnostic.tokenUsage.reportedCacheTokens,null)
  assert.equal(diagnostic.tokenUsage.billedOutputTokens,5)
  assert.equal(diagnostic.tokenUsage.billedThoughtsTokens,2)
 }finally{responder=undefined}
})
test('a later hop cannot overwrite the first-hop input watermark',async()=>{
 const rows=new Map(),hub=createInteractionStateHub()
 hub.attach({table:()=>({get:k=>rows.get(k),get size(){return rows.size},entries:()=>rows.entries(),put:async(k,v)=>rows.set(k,v),delete:async k=>rows.delete(k)}),close:async()=>{}})
 const before=wire.length
 let diagnostic,gets=0
 responder=entry=>{
  if(entry.method==='POST')return sse([{event_type:'interaction.created',event_id:'e0',interaction:{id:'remote',status:'in_progress'}}])
  // The first resume hop drops, so the reconnect hint must reach the next hop.
  if(++gets===1)return new Response('{}',{status:503})
  return sse([{event_type:'step.start',event_id:'e2',index:0,step:{type:'model_output'}},
   {event_type:'step.delta',event_id:'e3',index:0,delta:{type:'text',text:'A'}},
   {event_type:'step.stop',event_id:'e4',index:0},
   {event_type:'step.start',event_id:'e5',index:1,step:{type:'model_output'}},
   {event_type:'step.delta',event_id:'e6',index:1,delta:{type:'text',text:'B'}},
   {event_type:'step.stop',event_id:'e7',index:1,usage:{total_input_tokens:270,total_output_tokens:15,total_thought_tokens:30}},
   {event_type:'interaction.completed',event_id:'e8',interaction:{id:'remote',status:'completed',usage:{total_input_tokens:270,total_output_tokens:15,total_thought_tokens:30,total_tokens:315}}}])
 }
 try{
  const out=await collect(createArgonAdapter(ctx,{...cfg(),interactionsBackground:true,allowInteractionStorage:true},undefined,undefined,d=>diagnostic=d,hub).stream(req(GOOGLE_API_MODEL)))
  assert.equal(out.at(-1).reason.kind,'stop')
  // No first-hop usage was ever observable, so no usage chunk may escape: the
  // cumulative 270 must never be handed to the host as a context watermark, and
  // a fabricated zero is equally forbidden.
  assert.equal(out.some(c=>c.type==='usage'),false)
  assert.equal(diagnostic.tokenUsage.reportedInputTokens,null)
  assert.equal(diagnostic.tokenUsage.billedPromptTokens,270)
  assert.equal(diagnostic.tokenUsage.billedOutputTokens,15)
  assert.equal(diagnostic.tokenUsage.billedThoughtsTokens,30)
  assert.equal(diagnostic.hops.every(h=>h.outcome!=='pending'),true)
  // The background create hop carries the first GET, so its drop is recorded
  // there and the reconnect hint becomes the following resume hop's backoff.
  const create=diagnostic.hops.find(h=>h.trigger==='interaction-create')
  const resumes=diagnostic.hops.filter(h=>h.trigger==='interaction-resume')
  assert.equal(create.backoffDelayMs,0)
  assert.equal(create.status,503)
  assert.equal(create.outcome,'api-error')
  assert.equal(resumes.length,1)
  assert.ok(resumes[0].backoffDelayMs>0,JSON.stringify(diagnostic.hops))
  assert.equal(wire.slice(before).filter(x=>x.method==='POST').length,1)
  assert.equal(rows.size,0)
 }finally{responder=undefined;await hub.close()}
})
test('Interactions model parsing, prepareCall target pinning, and dual-field reasoning validation', async () => {
 const built = await buildInteractionRequest(
  { ...req('models/GEMINI-4-NEON-GOOGLE'), reasoningEffort: 'max' },
  { route: 'google-generative-ai' },
 )
 assert.equal(built.model, 'gemini-4-neon')
 assert.equal(built.generation_config.thinking_level, 'xhigh')

 await assert.rejects(
  buildInteractionRequest({ ...req('gemini-4-neon-preview'), reasoningEffort: 'high' }, { route: 'google-generative-ai' }),
  /Unknown Gemini 4 official model/,
 )
 await assert.rejects(
  buildInteractionRequest({ ...req(NEON_MODEL), reasoningEffort: 'high' }, { route: 'google-vertex', upstreamModel: 'gemini-4-argon' }),
  /Conflicting Gemini 4 models/,
 )
 for (const invalid of [{ reasoning: 'off' }, { reasoning: 'off', reasoningEffort: 'max' }, { reasoning: 'low', reasoningEffort: 'high' }]) {
  await assert.rejects(
   buildInteractionRequest({ ...req(NEON_MODEL), reasoningEffort: undefined, ...invalid }, { route: 'google-vertex' }),
   /requires low, medium, high, or xhigh thinking|Conflicting reasoning/,
  )
 }

 const config = { ...cfg(), reasoning: 'low', googleProtocol: 'interactions', vertexProtocol: 'interactions' }
 const adapter = createArgonAdapter(ctx, config)
 const prepared = await adapter.prepareCall(PROVIDER, NEON_MODEL)
 assert.throws(() => prepared.stream({ ...req(MODEL) }), { code: 'INVALID_REQUEST' })
 assert.throws(() => prepared.stream({ ...req(NEON_MODEL), provider: 'other' }), { code: 'INVALID_REQUEST' })

 const before = wire.length
 const { provider: _p, model: _m, ...omittedTargetReq } = req(NEON_MODEL)
 const pinnedOut = await collect(prepared.stream({ ...omittedTargetReq, reasoningEffort: 'xhigh' }))
 assert.equal(pinnedOut.at(-1).reason.kind, 'stop')
 assert.equal(wire.at(-1).body.model, 'gemini-4-neon')
 assert.equal(wire.at(-1).body.generation_config.thinking_level, 'xhigh')

 const beforeInvalid = wire.length
 for (const invalid of [{ reasoning: 'off' }, { reasoning: 'off', reasoningEffort: 'max' }, { reasoning: 'low', reasoningEffort: 'high' }]) {
  const errOut = await collect(adapter.stream({ ...req(NEON_MODEL), reasoningEffort: undefined, ...invalid }))
  assert.equal(errOut.at(-1).reason.kind, 'error')
  assert.match(JSON.stringify(errOut.at(-1).reason), /requires low, medium, high, or xhigh thinking|Conflicting reasoning/)
 }
 assert.equal(wire.length, beforeInvalid)
 assert.ok(wire.length > before)
})
test('buildInteractionRequest isolates reused toolCallId FIFO queues across foreign and native turns and detects later unfinished calls', async () => {
 const user1 = { role: 'user', content: [{ type: 'text', text: 'first' }] }
 const foreignCallBlocks = [{ type: 'tool-call', id: 'call-reused', name: 'echo', arguments: '{"step":1}' }]
 const carbonAssistant = { role: 'assistant', source: { provider: PROVIDER, model: CARBON_MODEL }, content: foreignCallBlocks }
 const carbonTool = { role: 'tool', toolCallId: 'call-reused', isError: false, content: [{ type: 'text', text: 'carbon-res' }] }
 const user2 = { role: 'user', content: [{ type: 'text', text: 'second' }] }
 const nativeCallBlocks = [{ type: 'tool-call', id: 'call-reused', name: 'echo', arguments: '{"step":2}' }]
 const priorMessages = [user1, carbonAssistant, carbonTool, user2]
 const replaySteps = [
  { type: 'thought', signature: 'sig-neon' },
  { type: 'function_call', id: 'call-reused', name: 'echo', arguments: { step: 2 } },
 ]
 const neonAssistant = {
  role: 'assistant',
  content: nativeCallBlocks,
  source: {
   provider: PROVIDER,
   model: NEON_MODEL,
   replayState: {
    response: {
     api: 'google-interactions-v1',
     provider: PROVIDER,
     model: NEON_MODEL,
     route: 'google-vertex',
     contentHash: contentHash(nativeCallBlocks),
     historyHash: historyHash(priorMessages),
     steps: replaySteps,
    },
   },
  },
 }
 const neonTool = { role: 'tool', toolCallId: 'call-reused', isError: false, content: [{ type: 'text', text: 'neon-res' }] }
 const built = await buildInteractionRequest(
  { provider: PROVIDER, model: NEON_MODEL, messages: [...priorMessages, neonAssistant, neonTool] },
  { route: 'google-vertex', upstreamModel: 'gemini-4-neon' },
 )
 const transcript = built.input.find(item => item.type === 'user_input' && item.content?.some(c => c.text?.includes('Previously executed tool echo; call call-reused')))
 assert.ok(transcript)
 const fnResult = built.input.find(item => item.type === 'function_result')
 assert.deepEqual(fnResult, {
  type: 'function_result',
  call_id: 'call-reused',
  name: 'echo',
  is_error: false,
  result: [{ type: 'text', text: 'neon-res' }],
 })

 await assert.rejects(
  buildInteractionRequest(
   {
    provider: PROVIDER,
    model: NEON_MODEL,
    messages: [
     user1,
     carbonAssistant,
     carbonTool,
     { role: 'assistant', source: { provider: PROVIDER, model: CARBON_MODEL }, content: [{ type: 'tool-call', id: 'call-reused', name: 'echo', arguments: '{"step":3}' }] },
    ],
   },
   { route: 'google-vertex', upstreamModel: 'gemini-4-neon' },
  ),
  /unfinished foreign or edited tool call/,
 )

 // 旧未完成调用 A(id='x') 后紧跟新一轮原生/外来 B(id='x') + 唯一回执：必须按回合边界拒绝 A，不能偷认 B 的回执。
 const interruptedNative = {
  role: 'assistant',
  source: {
   provider: PROVIDER,
   model: NEON_MODEL,
   replayState: {
    response: { api: INTERACTIONS_REPLAY_API, provider: PROVIDER, model: NEON_MODEL, route: 'google-vertex', contentHash: contentHash(nativeCallBlocks), historyHash: historyHash([user1]), steps: replaySteps },
   },
  },
  content: nativeCallBlocks,
 }
 await assert.rejects(
  buildInteractionRequest(
   { provider: PROVIDER, model: NEON_MODEL, messages: [user1, { role: 'assistant', source: { provider: PROVIDER, model: CARBON_MODEL }, content: [{ type: 'tool-call', id: 'call-reused', name: 'echo', arguments: '{"step":"A"}' }] }, interruptedNative, neonTool] },
   { route: 'google-vertex', upstreamModel: 'gemini-4-neon' },
  ),
  /unfinished foreign or edited tool call/,
 )
 assert.throws(
  () => generateContentHistory(
   { provider: PROVIDER, model: NEON_MODEL, messages: [user1, { role: 'assistant', source: { provider: PROVIDER, model: CARBON_MODEL }, content: [{ type: 'tool-call', id: 'call-reused', name: 'echo', arguments: '{"step":"A"}' }] }, interruptedNative, neonTool] },
   NEON_MODEL,
  ),
  /Complete the pending Interactions tool call/,
 )
})

test('Interactions prepared.stream rejects out-of-cap or null maxTokens eagerly and defaults Neon to high', async () => {
  const config = { maxTokens: 32768, longDecode: true, googleProtocol: 'interactions', vertexProtocol: 'interactions', routes: { hasVertexNeon: true, hasGoogleNeon: true } }
  const adapter = createArgonAdapter(ctx, config)
  const prepared = await adapter.prepareCall(PROVIDER, NEON_MODEL)
  const before = wire.length
  assert.throws(() => prepared.stream({ ...req(NEON_MODEL), maxTokens: 40000 }), e => e?.code === 'INVALID_REQUEST')
  assert.throws(() => prepared.stream({ ...req(NEON_MODEL), maxTokens: null }), e => e?.code === 'INVALID_REQUEST')
  await assert.rejects(() => collect(adapter.stream({ ...req(NEON_MODEL), maxTokens: 40000 })), e => e?.code === 'INVALID_REQUEST')
  assert.equal(wire.length, before)

  const neonBuilt = await buildInteractionRequest(req(NEON_MODEL), { route: 'google-vertex', upstreamModel: 'gemini-4-neon' })
  assert.equal(neonBuilt.generation_config.thinking_level, 'high')
  const argonBuilt = await buildInteractionRequest(req(MODEL), { route: 'google-vertex', upstreamModel: 'gemini-4-argon' })
  assert.equal(argonBuilt.generation_config.thinking_level, 'medium')

  // 第 4 轮回归：关闭 longDecode 时，即使配置设 maxTokens: 131072 且开启后台存储授权，Google 后台 Interactions 出站仍钳位到 65536；且 buildInteractionRequest 拒收 maxTokens: null。
  let clampedDiag
  const noLongCfg = {
    maxTokens: 131072,
    longDecode: false,
    googleProtocol: 'interactions',
    vertexProtocol: 'generate-content',
    interactionsBackground: true,
    allowInteractionStorage: true,
    routes: { hasVertexNeon: true, hasGoogleNeon: true },
  }
  const rows = new Map(), stateHub = createInteractionStateHub()
  stateHub.attach({ table: () => ({ get: k => rows.get(k), get size() { return rows.size }, entries: () => rows.entries(), put: async (k, v) => rows.set(k, v), delete: async k => rows.delete(k) }), close: async () => {} })
  try {
    const noLongAdapter = createArgonAdapter(ctx, noLongCfg, undefined, undefined, d => clampedDiag = d, stateHub)
    const out = await collect(noLongAdapter.stream({ ...req(GOOGLE_API_NEON_MODEL), maxTokens: 131072 }))
    assert.equal(out.at(-1).reason.kind, 'stop')
    const createCall = wire.findLast(entry => entry.method === 'POST' && entry.url.endsWith('/v1beta/interactions'))
    assert.equal(createCall.body.generation_config.max_output_tokens, 65536)
    assert.equal(clampedDiag.configuredMaxTokens, 65536)
    assert.equal(clampedDiag.longDecodeEnabled, false)
  } finally {
    await stateHub.close()
  }
  await assert.rejects(
    buildInteractionRequest({ ...req(GOOGLE_API_NEON_MODEL), maxTokens: null }, { route: 'google-generative-ai', upstreamModel: 'gemini-4-neon', background: true, store: true }),
    /Invalid Interactions output token budget/,
  )
})

test('R11-P2-3: Interactions preserves unattributed non-input difference in totalTokens across stream and diagnostics', async () => {
  const prevResponder = responder
  responder = () => sse([
    { event_type: 'interaction.created', event_id: 'r12-e1', interaction: { id: 'remote-r12', status: 'in_progress' } },
    { event_type: 'step.start', event_id: 'r12-e2', index: 0, step: { type: 'model_output' } },
    { event_type: 'step.delta', event_id: 'r12-e3', index: 0, delta: { type: 'text', text: 'ok' } },
    { event_type: 'step.stop', event_id: 'r12-e4', index: 0 },
    { event_type: 'interaction.completed', event_id: 'r12-e5', interaction: { id: 'remote-r12', status: 'completed', usage: { total_input_tokens: 20, total_tokens: 30 } } },
  ])
  try {
    let diagnostic
    const config = { ...cfg(), googleProtocol: 'interactions', vertexProtocol: 'interactions' }
    const adapter = createArgonAdapter(ctx, config, undefined, undefined, d => diagnostic = d)
    const out = await collect(adapter.stream(req(NEON_MODEL)))
    const usageChunk = out.find(c => c.type === 'usage')
    assert.equal(usageChunk.usage.totalTokens, 30)
    assert.equal(diagnostic.tokenUsage.totalTokens, 30)
    assert.equal(diagnostic.tokenUsage.billedTotalTokens, 30)
  } finally {
    responder = prevResponder
  }
})
