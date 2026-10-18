import assert from 'node:assert/strict'
import {test} from 'node:test'
import {shared} from '../runtime.js'
import * as plugin from '../index.js'
import {PROVIDER,MODEL,resolveConfigValues} from '../adapter.js'
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

