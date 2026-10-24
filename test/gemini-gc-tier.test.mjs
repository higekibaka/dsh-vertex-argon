import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createArgonAdapter,ensureGemini4ApiClientPatch,PROVIDER,GOOGLE_API_MODEL} from '../adapter.js'
import {createArgonDiagnosticTracker} from '../diagnostics.js'
import {continueArgonRequestStream,LONG_DECODE_SYMBOL} from '../generate-content.js'
import {prepareStructuredOutput} from '../structured-output.js'
import {shared} from '../runtime.js'
const ctx={get:key=>key==='launchEnvironment'?{get:name=>name==='GOOGLE_API_KEY'?{value:'offline-fixture'}:undefined}:undefined}
const input={provider:PROVIDER,model:GOOGLE_API_MODEL,sessionId:'tier-fixture',messages:[{role:'user',content:[{type:'text',text:'offline'}]}],maxTokens:131072}
const row=(finish,token)=>({candidates:[{content:{role:'model',parts:[{text:'ok'}]},finishReason:finish,...(token?{continuationToken:token}:{})}],usageMetadata:{promptTokenCount:100,cachedContentTokenCount:0,candidatesTokenCount:10,thoughtsTokenCount:0,toolUsePromptTokenCount:0,totalTokenCount:110}})
const sse=(value,tier)=>new Response('data: '+JSON.stringify(value)+'\n\n',{headers:{'Content-Type':'text/event-stream',...(tier?{'x-gemini-service-tier':tier}:{})}})
for(const tier of ['flex','priority'])for(const enabled of [true,false])test('real SDK Gemini GC '+tier+' longDecode='+enabled,async()=>{
 const old=globalThis.fetch,wire=[];let diagnostic
 globalThis.fetch=async(url,init)=>{wire.push({url:String(url),body:JSON.parse(init.body),headers:new Headers(init.headers)});return wire.length===1&&enabled?sse(row('CONTINUATION','checkpoint'),'priority'):sse(row('STOP'),'standard')}
 try{
  const cfg={googleProtocol:'generate-content',googleServiceTier:tier,longDecode:enabled,routes:{hasGoogle:true,hasVertex:true}}
  const prepared=await createArgonAdapter(ctx,cfg,undefined,undefined,d=>diagnostic=d).prepareCall(PROVIDER,GOOGLE_API_MODEL)
  cfg.googleServiceTier='standard'
  const out=[];for await(const chunk of prepared.stream(input))out.push(chunk)
  assert.equal(out.at(-1).reason.kind,'stop');assert.equal(wire.length,enabled?2:1)
  for(const r of wire){assert.equal(r.body.service_tier,tier);assert.equal(r.body.generationConfig.service_tier,undefined);assert.equal(r.headers.get('X-Vertex-AI-LLM-Shared-Request-Type'),null)}
  if(enabled)assert.deepEqual(wire[1].body,{...wire[0].body,continuationToken:'checkpoint'})
  assert.equal(diagnostic.serviceTier.requested,tier)
  assert.equal(diagnostic.serviceTier.observed,enabled?'mixed':'standard')
  assert.equal(diagnostic.serviceTier.source,'response-header')
  assert.equal(diagnostic.hopCount,enabled?2:1)
  assert.equal(diagnostic.usageDetails,undefined)
  assert.deepEqual(diagnostic.hops.map(h=>h.totalTokens),enabled?[110,110]:[110])
 }finally{globalThis.fetch=old}
})
for(const status of [429,503])test('Flex '+status+' retries preserve request policy and never escalate',async()=>{
 let diagnostic;const requests=[]
 const tracker=createArgonDiagnosticTracker({route:'google-generative-ai',model:'gemini-4-argon',protocol:'generate-content',requestedServiceTier:'flex'},r=>diagnostic=r)
 const client={isVertexAI:()=>false}
 const original=async req=>{requests.push(JSON.parse(req.body));throw Object.assign(new Error('fixture'),{status})}
 const stream=await continueArgonRequestStream(client,original,{body:JSON.stringify({contents:[],continuationToken:'cp',generationConfig:{maxOutputTokens:131072}})},{serviceTier:'flex',tracker,reconnectBackoff:{initialDelayMs:0}})
 await assert.rejects(async()=>{for await(const chunk of stream){} })
 assert.equal(requests.length,4);for(const req of requests)assert.deepEqual(req,requests[0])
 assert.equal(requests[0].service_tier,'flex');tracker.finishStream({outcome:'error'})
 assert.equal(diagnostic.serviceTier.observed,null)
 assert.equal(diagnostic.tokenUsage.billedTotalTokens,null)
})
test('JSON response format composes with Flex while native SDK and Standard stay unchanged',async()=>{
 const old=globalThis.fetch,wire=[]
 globalThis.fetch=async(url,init)=>{wire.push(JSON.parse(init.body));return sse(row('STOP'),'flex')}
 try{
  const schema={type:'object',properties:{answer:{type:'string'}},required:['answer']}
  const policy=prepareStructuredOutput(JSON.stringify(schema))
  const cfg={googleProtocol:'generate-content',googleServiceTier:'flex',routes:{hasGoogle:true}}
  for await(const _ of createArgonAdapter(ctx,cfg,undefined,undefined,undefined,undefined,undefined,policy).stream({...input,tools:[]})){}
  assert.equal(wire[0].service_tier,'flex')
  assert.deepEqual(wire[0].generationConfig.responseFormat,{text:{mimeType:'application/json',schema}})
  for await(const _ of createArgonAdapter(ctx,{...cfg,googleServiceTier:'standard'}).stream(input)){}
  assert.equal(wire[1].service_tier,undefined);assert.equal(wire[1].generationConfig.responseFormat,undefined)
  const {GoogleGenAI}=await shared('@google/genai')
  const native=new GoogleGenAI({apiKey:'offline-fixture'})
  for await(const _ of await native.models.generateContentStream({model:'gemini-4-argon',contents:'unmarked'})){}
  assert.equal(wire[2].service_tier,undefined)
 }finally{globalThis.fetch=old}
})
test('checkpoint retry retains tier and latest token without replaying uncommitted tail',async()=>{
 const requests=[],chunks=[];let diagnostic
 const tracker=createArgonDiagnosticTracker({route:'google-generative-ai',model:'gemini-4-argon',requestedServiceTier:'priority'},r=>diagnostic=r)
 const original=async req=>{requests.push(JSON.parse(req.body));return(async function*(){
  yield {headers:{'x-gemini-service-tier':requests.length===1?'priority':'standard'},json:async()=>row(requests.length===1?'CONTINUATION':'STOP',requests.length===1?'cp':undefined)}
  if(requests.length===1)throw Object.assign(new Error('dropped'),{status:503})
 })()}
 const stream=await continueArgonRequestStream({isVertexAI:()=>false},original,{body:JSON.stringify({contents:[],generationConfig:{maxOutputTokens:131072}})},{serviceTier:'priority',tracker,reconnectBackoff:{initialDelayMs:0}})
 for await(const c of stream)chunks.push(await c.json())
 assert.equal(requests.length,2);assert.deepEqual(requests[1],{...requests[0],continuationToken:'cp'});assert.equal(requests[0].service_tier,'priority')
 tracker.finishStream({outcome:'done'})
 assert.equal(diagnostic.serviceTier.observed,'mixed')
 assert.deepEqual(diagnostic.hops.map(h=>h.outcome),['api-error','done'])
 assert.equal(diagnostic.tokenUsage.billedTotalTokens,220)
})
for(const header of [undefined,'unknown','PRIORITY'])test('GC response tier header '+header,async()=>{
 let diagnostic;const old=globalThis.fetch
 globalThis.fetch=async()=>sse(row('STOP'),header)
 try{for await(const chunk of createArgonAdapter(ctx,{googleProtocol:'generate-content',googleServiceTier:'priority',routes:{hasGoogle:true}},undefined,undefined,d=>diagnostic=d).stream(input)){}
 assert.equal(diagnostic.serviceTier.observed,header==='PRIORITY'?'priority':null)
 assert.equal(diagnostic.serviceTier.requested,'priority')
 assert.equal(diagnostic.usageDetails,undefined)
 }finally{globalThis.fetch=old}
})
for(const tier of ['standard','flex','priority'])test('SDK extraBody cannot override frozen '+tier+' tier',async()=>{
 const old=globalThis.fetch,wire=[];ensureGemini4ApiClientPatch()
 const extraBody={service_tier:'priority',generationConfig:{responseMimeType:'text/plain'}}
 globalThis.fetch=async(_url,init)=>{wire.push(JSON.parse(init.body));extraBody.service_tier='standard';return sse(row(wire.length===1?'CONTINUATION':'STOP',wire.length===1?'cp':undefined),'standard')}
 try{
  const {GoogleGenAI}=await shared('@google/genai')
  const client=new GoogleGenAI({apiKey:'offline-fixture',httpOptions:{extraBody:{service_tier:'priority'}}})
  const stream=await client.models.generateContentStream({model:'gemini-4-argon',contents:'offline',config:{automaticContinuation:false,httpOptions:{extraBody,[LONG_DECODE_SYMBOL]:{serviceTier:tier}}}})
  for await(const _ of stream){}
  assert.equal(wire.length,2)
  for(const body of wire){assert.equal(body.service_tier,tier==='standard'?undefined:tier);assert.equal(body.generationConfig.responseMimeType,'text/plain')}
  assert.deepEqual(wire[1],{...wire[0],continuationToken:'cp'})
 }finally{globalThis.fetch=old}
})

test('GC invalid per-hop counters stay unknown and never retain arbitrary upstream values',async()=>{
 for(const [field,key,bad]of [['cachedContentTokenCount','cachedTokens','bad'],['thoughtsTokenCount','thoughtsTokens',null],['candidatesTokenCount','outputTokens',-1],['promptTokenCount','promptTokens',-1]]){
  let diagnostic
  const tracker=createArgonDiagnosticTracker({route:'google-generative-ai'},r=>diagnostic=r)
  const metadata={promptTokenCount:100,candidatesTokenCount:10,totalTokenCount:110,[field]:bad}
  const original=async()=> (async function*(){yield {json:async()=>({...row('STOP'),usageMetadata:metadata})}})()
  for await(const _ of await continueArgonRequestStream({isVertexAI:()=>false},original,{body:JSON.stringify({contents:[]})},{enabled:false,tracker})){}
  tracker.finishStream({outcome:'done'})
  assert.equal(diagnostic.hops[0][key],null)
  assert.equal(diagnostic.usageDetails,undefined)
  assert.doesNotMatch(JSON.stringify(diagnostic),/"bad"/)
 }
})
