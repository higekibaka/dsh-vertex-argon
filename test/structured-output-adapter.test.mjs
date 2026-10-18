import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createArgonAdapter,PROVIDER,MODEL,GOOGLE_API_MODEL} from '../adapter.js'
import {prepareStructuredOutput} from '../structured-output.js'
const schema={type:'object',properties:{answer:{type:'string'}},required:['answer'],additionalProperties:false}
const policy=prepareStructuredOutput(JSON.stringify(schema))
const ctx={get:key=>key==='launchEnvironment'?{get:name=>['GOOGLE_API_KEY','GOOGLE_CLOUD_API_KEY'].includes(name)?{value:'offline-fixture'}:undefined}:undefined}
const config=protocol=>({maxTokens:65536,reasoning:'medium',longDecode:true,googleProtocol:protocol,vertexProtocol:protocol,routes:{hasGoogle:true,hasVertex:true}})
const request=model=>({provider:PROVIDER,model,maxTokens:512,sessionId:'json-fixture',messages:[{role:'user',content:[{type:'text',text:'Explicit JSON result fixture.'}]}],tools:[]})
const collect=async stream=>{const chunks=[];for await(const chunk of stream)chunks.push(chunk);return chunks}
const sse=events=>new Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}})
const ia=text=>[{event_type:'interaction.created',interaction:{id:'json',status:'in_progress'}},{event_type:'step.start',index:0,step:{type:'model_output'}},{event_type:'step.delta',index:0,delta:{type:'text',text}},{event_type:'step.stop',index:0},{event_type:'interaction.completed',interaction:{id:'json',status:'completed'}}]
const gc=(text,finishReason='STOP',continuationToken)=>({candidates:[{content:{role:'model',parts:[{text}]},finishReason,...(continuationToken?{continuationToken}:{})}],usageMetadata:{promptTokenCount:30,candidatesTokenCount:4,totalTokenCount:34}})
for(const model of [GOOGLE_API_MODEL,MODEL])for(const protocol of ['generate-content','interactions']){
 test(model+'/'+protocol+': immutable JSON policy reaches real wire; normal adapter stays unchanged',async()=>{
  const original=globalThis.fetch,wire=[]
  globalThis.fetch=async(_url,init)=>{wire.push(JSON.parse(init.body));return sse(protocol==='interactions'?ia('{"answer":"ok"}'):[gc('{"answer":"ok"}')])}
  try{
   const cfg=config(protocol),adapter=createArgonAdapter(ctx,cfg,undefined,undefined,undefined,undefined,undefined,policy)
   const prepared=await adapter.prepareCall(PROVIDER,model)
   const out=await collect(prepared.stream(request(model)))
   assert.equal(out.at(-1).reason.kind,'stop')
   const text=out.filter(c=>c.type==='block-end'&&c.block.type==='text').map(c=>c.block.text).join('')
   assert.equal(policy.checkResult(text,{finishReason:'stop'}).status,'valid')
   assert.deepEqual(protocol==='interactions'?wire[0].response_format:wire[0].generationConfig.responseFormat,protocol==='interactions'?{type:'text',mime_type:'application/json',schema}:{text:{mimeType:'application/json',schema}})
   assert.equal(protocol==='interactions'?wire[0].generation_config.max_output_tokens:wire[0].generationConfig.maxOutputTokens,512)
   assert.equal(wire[0].tools,undefined)
   await collect(createArgonAdapter(ctx,cfg).stream(request(model)))
   assert.equal(protocol==='interactions'?wire[1].response_format:wire[1].generationConfig.responseFormat,undefined)
  }finally{globalThis.fetch=original}
 })
 test(model+'/'+protocol+': JSON plus tools refuses before a generation request',async()=>{
  const original=globalThis.fetch;let calls=0
  globalThis.fetch=async()=>{calls++;throw new Error('No dispatch expected')}
  try{
   const adapter=createArgonAdapter(ctx,config(protocol),undefined,undefined,undefined,undefined,undefined,policy)
   const req=request(model);req.tools=[{name:'not_allowed',parameters:{type:'object'}}]
   const out=await collect(adapter.stream(req))
   assert.equal(out.at(-1).reason.kind,'error');assert.equal(calls,0)
  }finally{globalThis.fetch=original}
 })
}
for(const model of [GOOGLE_API_MODEL,MODEL])test(model+': GC JSON continuation preserves original full request except latest token',async()=>{
 const original=globalThis.fetch,wire=[]
 globalThis.fetch=async(_url,init)=>{wire.push(JSON.parse(init.body));return sse([wire.length===1?gc('{"answer":','CONTINUATION','json-checkpoint'):gc('"ok"}')])}
 try{
  const adapter=createArgonAdapter(ctx,config('generate-content'),undefined,undefined,undefined,undefined,undefined,policy)
  const out=await collect(adapter.stream(request(model)))
  assert.equal(out.at(-1).reason.kind,'stop');assert.equal(wire.length,2)
  const {continuationToken,...rest}=wire[1]
  assert.equal(continuationToken,'json-checkpoint');assert.deepEqual(rest,wire[0])
  assert.deepEqual(wire[1].generationConfig.responseFormat,{text:{mimeType:'application/json',schema}})
  const text=out.filter(c=>c.type==='block-end'&&c.block.type==='text').map(c=>c.block.text).join('')
  assert.equal(policy.checkResult(text,{finishReason:'stop'}).status,'valid')
 }finally{globalThis.fetch=original}
})
for(const model of [GOOGLE_API_MODEL,MODEL])for(const protocol of ['generate-content','interactions'])test(model+'/'+protocol+': JSON credential-store failure never falls back to ambient keys',async()=>{
 const original=globalThis.fetch;let calls=0
 globalThis.fetch=async()=>{calls++;throw Error('must not dispatch')}
 const failure=new Error('credential store fixture failure')
 const strictCtx={get:key=>key==='credentials'?{resolve:async()=>{throw failure}}:ctx.get(key)}
 try{
  const adapter=createArgonAdapter(strictCtx,config(protocol),undefined,undefined,undefined,undefined,undefined,policy)
  const prepared=await adapter.prepareCall(PROVIDER,model)
  assert.equal((await collect(prepared.stream(request(model)))).at(-1).reason.kind,'error')
  assert.equal(calls,0)
 }finally{globalThis.fetch=original}
})

test('constructor rejects unvalidated format objects',()=>{
 assert.throws(()=>createArgonAdapter(ctx,config('generate-content'),undefined,undefined,undefined,undefined,undefined,{schema}),{code:'ARGON_JSON_SCHEMA_INVALID'})
})
