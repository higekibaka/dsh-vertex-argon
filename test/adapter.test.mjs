import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createArgonAdapter, argonProvider, installGemini4PiAiPatch, detectPiAiArgonRoutes, PROVIDER, MODEL, GOOGLE_API_MODEL, LEVELS } from '../adapter.js'
import { Config, apply } from '../index.js'
import { shared } from '../runtime.js'
const { PiAiAdapter } = await shared('@deepseek-ai/dsh-llm-pi-ai')
const { resolveRetryPolicy } = await shared('@deepseek-ai/dsh-llm')
const { googleProvider } = await shared('@earendil-works/pi-ai/providers/google')

const config={showInModelPicker:true,contextWindow:1048576,maxTokens:65536,reasoning:'medium'}
const ctx={get:k=>k==='launchEnvironment'?{get:n=>n==='GOOGLE_CLOUD_API_KEY'||n==='GOOGLE_API_KEY'?{value:'fixture-key'}:undefined}:undefined}
const req=(e,m=MODEL)=>({provider:PROVIDER,model:m,reasoningEffort:e,maxTokens:512,messages:[{role:'user',content:[{type:'text',text:'Use add 17 and 25.'}]}],tools:[{name:'add',description:'Add two integers',parameters:{type:'object',properties:{a:{type:'integer'},b:{type:'integer'}},required:['a','b']}}]})
const collect=async stream=>{const chunks=[];for await(const c of stream)chunks.push(c);return chunks}
const wire=[];let mode='tool'
globalThis.fetch=async(input,init)=>{
 wire.push({url:typeof input==='string'?input:input.url,body:JSON.parse(init?.body??await input.text())})
 const parts=mode==='tool'?[{text:'Using the tool.',thought:true,thoughtSignature:'dGhvdWdodA=='},{functionCall:{id:'fixture-id',name:'add',args:{a:17,b:25}},thoughtSignature:'dG9vbA=='}]:[{text:'42',thoughtSignature:'dGV4dA=='}]
 const finishReason=mode==='malformed'?'MALFORMED_RESPONSE':'STOP'
 const data={candidates:[{content:{role:'model',parts},finishReason}],usageMetadata:{promptTokenCount:12,candidatesTokenCount:6,thoughtsTokenCount:4,totalTokenCount:22}}
 return new Response('data: '+JSON.stringify(data)+String.fromCharCode(10,10),{headers:{'Content-Type':'text/event-stream'}})
}
test('auto-detects google & google-vertex Argon configs and exposes both in plugin group',async()=>{
 const mockCtx={
  get:k=>{
   if(k==='launchEnvironment')return {get:n=>n==='GOOGLE_CLOUD_API_KEY'||n==='GOOGLE_API_KEY'?{value:'fixture-key'}:undefined}
   if(k==='configEditor')return {entries:()=>[{options:{id:'llm-pi-ai',config:{providers:{google:{apiKeyEnv:'GOOGLE_API_KEY',models:[{id:'gemini-4-argon'}]},'google-vertex':{models:[{id:'gemini-4-argon'}]}}}}}]}
  }
 }
 const detected=detectPiAiArgonRoutes(mockCtx)
 assert.equal(detected.hasVertex,true);assert.equal(detected.hasGoogle,true)
 const a=createArgonAdapter(mockCtx,config)
 const models=await a.listModels(PROVIDER)
 assert.deepEqual(models.map(m=>({id:m.id,name:m.name})),[
  {id:MODEL,name:'Gemini 4 Argon (Vertex AI)'},
  {id:GOOGLE_API_MODEL,name:'Gemini 4 Argon (Gemini API)'},
 ])
 const mVertex=await a.resolveModel(PROVIDER,MODEL)
 const mGoogle=await a.resolveModel(PROVIDER,GOOGLE_API_MODEL)
 assert.deepEqual(mVertex.reasoning.efforts.map(e=>e.id),['low','medium','high'])
 assert.deepEqual(mGoogle.reasoning.efforts.map(e=>e.id),['low','medium','high'])
 mode='tool'
 const outGoogle=await collect(a.stream(req('high',GOOGLE_API_MODEL)))
 assert.deepEqual(outGoogle.at(-1).reason,{kind:'tool-calls'})
 assert.ok(outGoogle.some(c=>c.type==='reasoning-delta'))
 assert.ok(wire.at(-1).url.includes('generativelanguage.googleapis.com'))
 assert.ok(wire.at(-1).url.includes('models/gemini-4-argon:streamGenerateContent'))
 assert.deepEqual(wire.at(-1).body.generationConfig.thinkingConfig,{thinkingLevel:'HIGH',includeThoughts:true})
 // Multi-turn signed tool replay on Gemini API model
 const blocks=outGoogle.filter(c=>c.type==='block-end').map(c=>c.block),call=blocks.find(b=>b.type==='tool-call'),finish=outGoogle.at(-1)
 assert.equal(finish.replayState.response.model,GOOGLE_API_MODEL)
 mode='text'
 const next=req('medium',GOOGLE_API_MODEL)
 next.messages.push({id:'a-1',role:'assistant',source:{kind:'model',provider:PROVIDER,model:GOOGLE_API_MODEL,replayState:finish.replayState},content:blocks},{id:'t-1',role:'tool',toolCallId:call.id,source:{kind:'tool',callId:call.id},content:[{type:'text',text:'42'}]})
 const second=await collect(a.stream(next))
 assert.deepEqual(second.at(-1).reason,{kind:'stop'})
 const parts=wire.at(-1).body.contents.flatMap(c=>c.parts)
 assert.equal(parts.find(p=>p.functionCall).thoughtSignature,'dG9vbA==')
})
test('all three official levels survive SDK serialization with no thinkingBudget',async()=>{
 mode='tool'
 for(const e of LEVELS){const chunks=await collect(createArgonAdapter(ctx,config).stream(req(e)))
 assert.deepEqual(chunks.at(-1).reason,{kind:'tool-calls'})
 assert.deepEqual(wire.at(-1).body.generationConfig.thinkingConfig,{thinkingLevel:e.toUpperCase(),includeThoughts:true})
 assert.ok(!JSON.stringify(wire.at(-1).body).includes('thinkingBudget'))
 assert.equal(wire.at(-1).body.generationConfig.maxOutputTokens,512)
 assert.equal(wire.at(-1).body.tools[0].functionDeclarations[0].name,'add')}
})
test('max, off, and xhigh refuse before I/O; omitted effort defaults medium',async()=>{
 const a=createArgonAdapter(ctx,config),n=wire.length
 for(const e of ['off','xhigh','max'])await assert.rejects(collect(a.stream(req(e))),/does not support/)
 assert.equal(wire.length,n);await collect(a.stream(req(undefined)))
 assert.equal(wire.at(-1).body.generationConfig.thinkingConfig.thinkingLevel,'MEDIUM')
})
test('installGemini4PiAiPatch also protects direct google/gemini-4-argon calls',async()=>{
 const unpatch=installGemini4PiAiPatch()
 try {
  const baseGoogle=googleProvider()
  const rawModel={id:MODEL,name:'Gemini 4 Argon',provider:'google',api:'google-generative-ai',baseUrl:'https://generativelanguage.googleapis.com/v1beta',reasoning:false,input:['text','image'],contextWindow:1048576,maxTokens:65536,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}
  const customGoogle={...baseGoogle,id:'google',name:'Google',getModels:()=>[rawModel]}
  const profiles=new Map([['google',{provider:'google',displayName:'Google',piProvider:customGoogle,reasoning:'medium',streamIdleTimeoutMs:300000,maxRequestImageBytes:20971520,requestImagePixelBudget:4194304,requestImageMaxBytes:1048576,retryPolicy:resolveRetryPolicy(undefined,'test'),modelErrors:new Map(),configuredMaxTokens:new Map([[MODEL,65536]])}]])
  const piAdapter=new PiAiAdapter({profiles:()=>profiles,resolveApiKey:async()=>'fixture-google-api-key',auth:{authContext:{env:async()=>undefined,fileExists:async()=>false}}})
  const resolved=await piAdapter.resolveModel('google',MODEL)
  assert.deepEqual(resolved.reasoning.efforts.map(e=>e.id),['low','medium','high'])
  mode='tool'
  const out=await collect(piAdapter.stream({...req('high'),provider:'google'}))
  assert.deepEqual(out.at(-1).reason,{kind:'tool-calls'})
  assert.deepEqual(wire.at(-1).body.generationConfig.thinkingConfig,{thinkingLevel:'HIGH',includeThoughts:true})
 } finally {
  unpatch()
 }
})
test('abort, config validation, legacy max listener migration and scoped registration cleanup',async()=>{
 const c=new AbortController();c.abort();const n=wire.length
 const aborted=await collect(createArgonAdapter(ctx,config).stream({...req('low'),signal:c.signal}))
 assert.equal(aborted.at(-1).reason.kind,'aborted')
 assert.equal(wire.length,n);assert.equal(Config({}).reasoning.get(),'medium');assert.equal(Config({}).maxTokens.get(),65536);assert.equal(Config({}).contextWindow.get(),1048576)
 assert.throws(()=>Config({reasoning:'max'}))
 let cleanup,disposed=false,requestListener
 apply({...ctx,effect:f=>cleanup=f(),on:(ev,fn)=>{if(ev==='agent/request')requestListener=fn},llm:{registerAdapter:(ids)=>{assert.deepEqual(ids,[PROVIDER]);return ()=>{disposed=true}}}},Config({}))
 const migrated1=await requestListener({},async()=>({provider:PROVIDER,model:GOOGLE_API_MODEL,reasoningEffort:'max'}))
 assert.equal(migrated1.reasoningEffort,'high')
 cleanup();assert.ok(disposed)
 mode='malformed'
 const malformed=await collect(createArgonAdapter(ctx,config).stream(req('medium')))
 assert.equal(malformed.at(-1).reason.kind,'error')
 assert.equal(malformed.at(-1).reason.failure.code,'SERVER')
 mode='tool'
})
