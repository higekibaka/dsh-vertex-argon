import assert from 'node:assert/strict'
import {test} from 'node:test'
import {shared} from '../runtime.js'
import * as plugin from '../index.js'
import {PROVIDER,MODEL,resolveConfigValues,ensureGemini4ApiClientPatch,installGemini4PiAiPatch} from '../adapter.js'
import {LONG_DECODE_SYMBOL} from '../generate-content.js'
const {Context}=await shared('@deepseek-ai/cordis')
const {default:LlmRuntime}=await shared('@deepseek-ai/dsh-llm')
const {PiAiAdapter}=await shared('@deepseek-ai/dsh-llm-pi-ai')
const {GoogleGenAI}=await shared('@google/genai')
const {default:ToolRuntime}=await shared('@deepseek-ai/dsh-tools')
const {default:SystemPrompt}=await shared('@deepseek-ai/dsh-system-prompt')
const {estimateToolsTokens}=await shared('@deepseek-ai/dsh-token-meter/estimate')
test('real Cordis activation/disposal preserves host services and removes adapter patches',async()=>{
 const current=PiAiAdapter.prototype.current
 const clientProto=Object.getPrototypeOf(new GoogleGenAI({apiKey:'fixture'}).apiClient)
 const requestStream=clientProto.requestStream
 const ctx=new Context()
 await ctx.plugin(LlmRuntime)
 try{
  for(let i=0;i<2;i++){
   const fiber=ctx.plugin(plugin,{maxTokens:1048576});await fiber
   assert.ok(ctx.llm.listProviders().some(x=>x.id===PROVIDER))
   assert.equal(typeof ctx.get('vertexArgonDiagnostics')?.queryInteraction,'function')
   assert.equal((await ctx.get('vertexArgonDiagnostics').listRequests({sessionId:'fixture-session'})).ok,true)
   const models=await ctx.llm.listModels(PROVIDER);assert.ok(models.some(x=>x.id===MODEL))
   const prepared=await ctx.llm.prepareCall({provider:PROVIDER,model:MODEL})
   assert.equal(prepared.config.maxTokens,917504)
   await fiber.dispose()
   assert.ok(!ctx.llm.listProviders().some(x=>x.id===PROVIDER))
   assert.equal(PiAiAdapter.prototype.current,current)
   assert.equal(clientProto.requestStream,requestStream)
  }
 }finally{await ctx.fiber.dispose()}
})
test('inspection tool mounts, executes through real policy pipeline and disposes with its dependencies',async t=>{
 const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt)
 let registry=ctx.plugin(ToolRuntime);await registry
 const baseline=await ctx.systemPrompt.assemble()
 try{
  for(let i=0;i<2;i++){
   const fiber=ctx.plugin(plugin,{});await fiber
   try{
    const schema=ctx.tools.schemas().find(tool=>tool.name==='argon_inspect')
    assert.equal(schema.deferLoading,true)
    if(i===0){
     const after=await ctx.systemPrompt.assemble()
     assert.deepEqual(after.sections,baseline.sections);assert.deepEqual(after.contexts,baseline.contexts)
     const beforeTokens=estimateToolsTokens({tools:baseline.tools}),afterTokens=estimateToolsTokens({tools:after.tools})
     assert.ok(afterTokens>beforeTokens)
     t.diagnostic(JSON.stringify({fixture:'isolated first-turn Host assembly, no tool-search projection',method:'Host fixed heuristic, not Google CountTokens',beforeTokens,afterTokens,delta:afterTokens-beforeTokens,deferred:schema.deferLoading}))
    }
    const result=await ctx.tools.execute({callId:'inspect-fixture',name:'argon_inspect',arguments:{action:'list'},agent:{id:'fixture-session'},signal:new AbortController().signal})
    assert.equal(result.isError,false);assert.deepEqual(result.value,{ok:true,records:[]})
    const denied=ctx.tools.guard(()=> 'fixture policy denial')
    const refused=await ctx.tools.execute({callId:'inspect-denied',name:'argon_inspect',arguments:{action:'query',route:'google-generative-ai',id:'never-dispatched'},agent:{id:'fixture-session'},signal:new AbortController().signal})
    assert.equal(refused.isError,true);denied()
    if(i===0){await registry.dispose();registry=ctx.plugin(ToolRuntime);await registry;assert.ok(ctx.tools.get('argon_inspect'))}
   }finally{await fiber.dispose()}
   assert.equal(ctx.tools.get('argon_inspect'),undefined)
  }
 }finally{await ctx.fiber.dispose()}
})
test('removed paid JSON command stays absent across plugin and command-runtime reloads',async()=>{
 const {default:SessionStore}=await shared('@deepseek-ai/dsh-session')
 const {default:CommandRuntime}=await shared('@deepseek-ai/dsh-commands')
 const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime)
 let runtime=ctx.plugin(CommandRuntime);await runtime
 try{
  for(let i=0;i<2;i++){
   const fiber=ctx.plugin(plugin,{});await fiber
   try{
    const agent={id:'command-registration-'+i,ctx,session:ctx.sessions.create('command-registration-'+i)}
    assert.equal(ctx.commands.view(agent).get('argon-json'),undefined);assert.equal(ctx.tools.get('argon-json'),undefined)
    assert.ok(ctx.tools.get('argon_inspect'))
    if(i===0){await runtime.dispose();runtime=ctx.plugin(CommandRuntime);await runtime;assert.equal(ctx.commands.view(agent).get('argon-json'),undefined)}
   }finally{await fiber.dispose()}
   assert.equal(ctx.commands.view({ctx}).get('argon-json'),undefined)
  }
 }finally{await ctx.fiber.dispose()}
})
test('new configuration preserves legacy defaults and validates protocol enum',()=>{
 const cfg=plugin.Config({})
 assert.equal(cfg.googleProtocol.get(),'generate-content')
 assert.equal(cfg.vertexProtocol.get(),'generate-content')
 assert.equal(cfg.interactionsBackground.get(),false)
 assert.equal(cfg.allowInteractionStorage.get(),false)
 assert.equal(cfg.maxTokens.get(),65536)
 assert.throws(()=>plugin.Config({googleProtocol:'auto-fallback'}))
 assert.throws(()=>resolveConfigValues({allowInteractionStorage:'false'}),/explicit booleans/)
})
test('raw storage attach failure closes its newly opened domain reservation',async()=>{
 const rootDisposers=[],storageInitializers=[],childDisposers=[];let closed=0
 const ctx={get:()=>undefined,llm:{registerAdapter:()=>()=>{}},effect:fn=>{const d=fn();if(typeof d==='function')rootDisposers.push(d)},inject:(keys,fn)=>{if(keys.includes('storageDomain'))storageInitializers.push(fn)}}
 try{
  plugin.apply(ctx,{})
  await storageInitializers[0]({effect:fn=>childDisposers.push(fn()),storageDomain:{open:async spec=>{assert.equal(spec.name,'vertex_argon_responses');return {table(){throw Error('broken table')},close:async()=>{closed++}}}},logger:{warn:()=>{}}})
  assert.equal(closed,1)
  for(const dispose of childDisposers)await dispose()
  assert.equal(closed,1)
 }finally{for(const dispose of rootDisposers.reverse())await dispose()}
})


test('repeated API-client ensure disposers preserve newer wrappers and cannot release a later patch', async () => {
 const proto=Object.getPrototypeOf(new GoogleGenAI({apiKey:'fixture'}).apiClient)
 const original=proto.requestStream
 try {
  for(const releaseDuplicate of [false,true]) {
   const seen=[],sentinel={fixture:true}
   function baseline(request){seen.push({receiver:this,request});return sentinel}
   proto.requestStream=baseline
   const first=ensureGemini4ApiClientPatch(),patched=proto.requestStream
   const duplicate=ensureGemini4ApiClientPatch()
   assert.equal(proto.requestStream,patched)
   function later(request){return patched.call(this,request)}
   proto.requestStream=later
   ;(releaseDuplicate?duplicate:first)()
   assert.equal(proto.requestStream,later)
   const receiver={},request={httpOptions:{[LONG_DECODE_SYMBOL]:{enabled:true}}}
   assert.equal(proto.requestStream.call(receiver,request),sentinel)
   assert.deepEqual(seen,[{receiver,request}])
   const next=ensureGemini4ApiClientPatch(),nextWrapper=proto.requestStream
   assert.notEqual(nextWrapper,later)
   first();duplicate()
   assert.equal(proto.requestStream,nextWrapper)
   next();assert.equal(proto.requestStream,later)
  }
 } finally {ensureGemini4ApiClientPatch()();proto.requestStream=original}
})

test('native patch disposal preserves later current/provider wrappers and makes retained delegates inert', () => {
 const proto=PiAiAdapter.prototype,originalCurrent=proto.current
 const result={fixture:true}
 const provider={id:'google',getModels:()=>[],stream(){throw Error('disposed patch must not stream')},streamSimple(){return result}}
 const snapshot={profiles:new Map([['google',{piProvider:provider,reasoning:'medium'}]])}
 proto.current=function(){return snapshot}
 const baseline=proto.current,baselineStream=provider.streamSimple
 const dispose=installGemini4PiAiPatch()
 try {
  assert.equal(proto.current(),snapshot)
  const current=proto.current,stream=provider.streamSimple
  function laterCurrent(){return current.call(this)}
  function laterStream(...args){return stream.apply(this,args)}
  proto.current=laterCurrent;provider.streamSimple=laterStream
  dispose();dispose()
  assert.equal(proto.current,laterCurrent);assert.equal(provider.streamSimple,laterStream)
  assert.equal(proto.current(),snapshot)
  assert.equal(provider.streamSimple({id:MODEL,api:'google-generative-ai'},{}),result)
  assert.equal(provider.streamSimple,laterStream)
  // Normal disposal must still restore exactly the methods this installation owns.
  proto.current=baseline;provider.streamSimple=baselineStream
  const again=installGemini4PiAiPatch();proto.current();again()
  assert.equal(proto.current,baseline);assert.equal(provider.streamSimple,baselineStream)
 } finally {dispose();proto.current=originalCurrent}
})

test('plugin entry wires live native settings and its response hub into the inspection service', async () => {
 const {googleProvider}=await shared('@earendil-works/pi-ai/providers/google')
 const cfg={longDecode:false,googleServiceTier:'priority',retainRawResponses:false}
 const live=Object.fromEntries(Object.keys(cfg).map(key=>[key,{get:()=>cfg[key]}]))
 const ctx=new Context();await ctx.plugin(LlmRuntime)
 const originalFetch=globalThis.fetch,wire=[]
 const model={id:MODEL,name:MODEL,provider:'google',api:'google-generative-ai',baseUrl:'https://generativelanguage.googleapis.com/v1beta',reasoning:true,input:['text'],contextWindow:1048576,maxTokens:131072,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}
 const provider={...googleProvider(),getModels:()=>[model]}
 const native=new PiAiAdapter({profiles:()=>new Map([['google',{piProvider:provider,reasoning:'medium'}]])})
 globalThis.fetch=async(_url,init)=>{
  wire.push(JSON.parse(init.body))
  return new Response('data: '+JSON.stringify({candidates:[{content:{role:'model',parts:[{text:'retained native fixture'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:2,totalTokenCount:12}})+'\n\n',{headers:{'Content-Type':'text/event-stream'}})
 }
 try {
  const fiber=ctx.plugin({inject:['llm'],apply:child=>plugin.apply(child,live)});await fiber
  try {
   native.current()
   const service=ctx.get('vertexArgonDiagnostics')
   for(const enabled of [false,true,false]) {
    cfg.longDecode=enabled;cfg.googleServiceTier=enabled?'flex':'priority';cfg.retainRawResponses=enabled
    const sessionId='native-wiring-'+wire.length
    const out=[]
    for await(const chunk of provider.streamSimple(model,{messages:[{role:'user',content:'fixture',timestamp:0}]},{apiKey:'fixture',maxTokens:131072,sessionId}))out.push(chunk)
    assert.equal(out.at(-1).type,'done')
    const listed=await service.listRequests({sessionId})
    assert.equal(listed.ok,true);assert.equal(listed.records.length,1)
    const record=listed.records[0]
    assert.equal(record.serviceTier.requested,cfg.googleServiceTier)
    assert.equal(wire.at(-1).service_tier,cfg.googleServiceTier)
    assert.equal(record.responseCapture.status,enabled?'captured':'disabled')
    const details=await service.getRequest({sessionId,requestId:record.id})
    assert.equal(details.record.longDecodeEnabled,enabled)
    assert.equal(details.record.configuredMaxTokens,enabled?131072:65536)
    const raw=await service.readResponse({sessionId,requestId:record.id})
    assert.equal(raw.page.status,enabled?'available':'not-retained')
    if(enabled)assert.match(raw.page.frame.text,/retained native fixture/)
   }
  } finally {await fiber.dispose()}
 } finally {globalThis.fetch=originalFetch;await ctx.fiber.dispose()}
})

