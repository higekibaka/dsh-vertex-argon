import assert from 'node:assert/strict'
import {test} from 'node:test'
import {shared} from '../runtime.js'
import {createRequestAssociationHub,captureRequestAssociation} from '../request-association.js'
import {createArgonDiagnosticTracker} from '../diagnostics.js'
import {createDiagnosticHub,diagnosticWriter} from '../diagnostic-store.js'
const {markAgentLoopRequest}=await shared('@deepseek-ai/dsh-llm')
const agent=id=>({id})
const options=(sessionId,extra={})=>Object.freeze(markAgentLoopRequest({provider:'argon',model:'model',sessionId,messages:[],...extra}))
const event=(seq=9,id='answer',extra={})=>({type:'assistant/message',seq,data:{turn:1,step:2,message:{id,source:{provider:'argon',model:'model'}},...extra}})
function fixture(){
 const links=[],hub=createRequestAssociationHub((id,locator)=>links.push({id,locator})),a=agent('one')
 const start=(who=a,id='attempt:1',extra={})=>hub.frame({agent:who,frame:{type:'start',attemptId:id,turn:1,step:2,revision:1,...extra}})
 const end=(who=a,id='attempt:1',outcome={kind:'committed',eventType:'assistant/message',seq:9})=>hub.frame({agent:who,frame:{type:'end',attemptId:id,revision:5,index:1,outcome}})
 const run=(request=options('one'),id='request')=>hub.stream(request,async function*(){const track=captureRequestAssociation(request.sessionId);await Promise.resolve();track?.(id);yield 'unchanged'})
 const consume=async stream=>{const result=[];for await(const chunk of stream)result.push(chunk);return result}
 return{hub,links,a,start,end,run,consume,commit:(e=event(),id='one')=>hub.event({id},e)}
}
test('missing diagnostic session metadata has no association context',()=>{assert.equal(captureRequestAssociation(undefined),undefined);assert.equal(captureRequestAssociation(null),undefined)})
test('eager middleware waits for start at first iteration and joins only the committed seq',async()=>{
 const f=fixture(),stream=f.run();assert.equal(f.links.length,0);f.start();assert.deepEqual(await f.consume(stream),['unchanged'])
 f.commit(event(8,'unrelated'));assert.equal(f.links.length,0);f.commit();f.end()
 assert.deepEqual(f.links,[{id:'request',locator:{version:1,sessionId:'one',settlementSeq:9,eventType:'assistant/message',turn:1,step:2,messageId:'answer',provider:'argon',model:'model'}}]);f.hub.close()
})
test('interleaved sessions keep async contexts separate across awaits and adapter clones',async()=>{
 const f=fixture(),b=agent('two');f.start();f.start(b)
 await Promise.all([f.consume(f.run()),f.consume(f.run(options('two'),'request-two'))]);f.commit();f.end();f.commit(event(9,'answer-two'),'two');f.end(b)
 assert.deepEqual(f.links.map(x=>[x.id,x.locator.sessionId,x.locator.messageId]),[['request','one','answer'],['request-two','two','answer-two']]);assert.equal(captureRequestAssociation('one'),undefined);f.hub.close()
})
test('unmarked and auxiliary nested streams clear the inherited request context',async()=>{
 const f=fixture();f.start();let inner,outer
 await f.consume(f.hub.stream(options('one'),async function*(){outer=captureRequestAssociation('one');for await(const x of f.hub.stream({sessionId:'one',purpose:'compaction'},async function*(){inner=captureRequestAssociation('one');yield 1}))yield x;outer?.('outer')}))
 assert.equal(inner,undefined);f.commit();f.end();assert.deepEqual(f.links.map(x=>x.id),['outer']);f.hub.close()
})
test('missing start, purpose-tagged and wrong-session trackers remain unassociated',async()=>{
 const f=fixture();await f.consume(f.run());f.start();await f.consume(f.run(options('one',{purpose:'session-title'}),'title'))
 await f.consume(f.hub.stream(options('one'),async function*(){assert.equal(captureRequestAssociation('other'),undefined);yield 1}));f.commit();f.end();assert.deepEqual(f.links,[]);f.hub.close()
})
test('retries at the same step and lifecycle-local attempt ID reuse do not cross-associate',async()=>{
 const f=fixture();f.start();await f.consume(f.run());f.hub.event({id:'one'},{type:'assistant/attempt',seq:7,data:{turn:1,step:2}});f.end(f.a,'attempt:1',{kind:'committed',eventType:'assistant/attempt',seq:7})
 f.hub.dispose(f.a);const newer=agent('one');f.start(newer);await f.consume(f.run(options('one'),'second'));f.commit();f.end(newer)
 assert.deepEqual(f.links.map(x=>[x.id,x.locator.settlementSeq,x.locator.messageId]),[['request',7,undefined],['second',9,'answer']]);f.hub.close()
})
test('abandoned, mismatched source/turn and ambiguous agents never publish a locator',async()=>{
 for(const kind of ['abandoned','turn','source','ambiguous']){
  const f=fixture();f.start();if(kind==='ambiguous')f.start(agent('one'));await f.consume(f.run())
  f.commit(kind==='turn'?event(9,'answer',{turn:99}):kind==='source'?event(9,'answer',{message:{id:'answer',source:{provider:'different',model:'model'}}}):event())
  f.end(f.a,'attempt:1',kind==='abandoned'?{kind:'abandoned'}:undefined);assert.deepEqual(f.links,[],kind);f.hub.close()
 }
})
test('a delayed post-commit observer can join an already ended exact attempt',async()=>{
 const f=fixture();f.start();await f.consume(f.run());f.end();assert.deepEqual(f.links,[]);f.commit();assert.equal(f.links[0].locator.messageId,'answer');f.hub.close()
})
test('iterator return runs in the request context and preserves cleanup without fake completion',async()=>{
 const f=fixture();f.start();let cleaned=false;const iterator=f.hub.stream(options('one'),async function*(){try{yield 1}finally{cleaned=true;captureRequestAssociation('one')?.('cleanup')}})[Symbol.asyncIterator]()
 await iterator.next();await iterator.return();assert.equal(cleaned,true);f.end(f.a,'attempt:1',{kind:'abandoned'});assert.deepEqual(f.links,[]);f.hub.close()
})
test('tracker captures context once and updates the same diagnostic only after formal settlement',async()=>{
 const f=fixture(),records=createDiagnosticHub();f.hub.close();const hub=createRequestAssociationHub((id,locator)=>records.link(id,locator));let saved
 hub.frame({agent:f.a,frame:{type:'start',attemptId:'a',turn:1,step:2,revision:1}})
 await f.consume(hub.stream(options('one'),async function*(){const t=createArgonDiagnosticTracker({sessionId:'one',route:'google-generative-ai',model:'model'},r=>{saved=r;records.record(r)});t.finishStream({outcome:'done'});yield 1}))
 assert.equal(records.listRecent()[0].association,undefined);hub.event({id:'one'},event());hub.frame({agent:f.a,frame:{type:'end',attemptId:'a',revision:2,outcome:{kind:'committed',eventType:'assistant/message',seq:9}}})
 assert.equal(records.listRecent()[0].id,saved.id);assert.equal(records.listRecent()[0].association.messageId,'answer');hub.close()
})
test('association updates retain newest memory and do not evict another diagnostic at disk capacity',async()=>{
 const table=new Map(),domain={table:()=>({entries:()=>table.entries(),put:async(id,v)=>{table.set(id,structuredClone(v))},delete:async id=>table.delete(id)}),close:async()=>{}}
 const writer=diagnosticWriter(domain,()=>{},2),hub=createDiagnosticHub(2);hub.attachWriter(writer)
 for(const sessionId of ['one','two']){const t=createArgonDiagnosticTracker({sessionId,route:'google-generative-ai'},r=>hub.record(r));t.finishStream({outcome:'done'})}
 await writer.flush();const first=hub.listRecent().find(r=>r.sessionHash===Array.from(table.values())[0].sessionHash)
 hub.link(first.id,{version:1,sessionId:'one',settlementSeq:9,eventType:'assistant/message',turn:1,step:2,messageId:'answer',provider:'argon',model:'model'})
 assert.equal(hub.listRecent().find(r=>r.id===first.id).association.messageId,'answer');await writer.flush();assert.equal(table.size,2);assert.equal(table.get(first.id).association.messageId,'answer');await writer.close()
})

test('same-Agent retry retains failed attempt while late diagnostics and auxiliary work interleave',async()=>{
 const f=fixture();let failed,success,auxiliary
 f.start()
 await f.consume(f.hub.stream(options('one'),async function*(){failed=captureRequestAssociation('one');yield 1}))
 f.hub.event({id:'one'},{type:'assistant/attempt',seq:7,data:{turn:1,step:2}})
 f.end(f.a,'attempt:1',{kind:'committed',eventType:'assistant/attempt',seq:7})
 f.start(f.a,'attempt:2')
 await f.consume(f.hub.stream(options('one'),async function*(){
  success=captureRequestAssociation('one')
  for await(const value of f.hub.stream(options('one',{purpose:'session-title'}),async function*(){auxiliary=captureRequestAssociation('one');yield 1}))yield value
  failed('late-failed');success('successful')
 }))
 assert.equal(auxiliary,undefined);f.commit();f.end(f.a,'attempt:2')
 assert.deepEqual(f.links.map(x=>[x.id,x.locator.eventType,x.locator.settlementSeq,x.locator.messageId]),[['late-failed','assistant/attempt',7,undefined],['successful','assistant/message',9,'answer']]);f.hub.close()
})

async function holdBinding(f){let binding;await f.consume(f.hub.stream(options('one'),async function*(){binding=captureRequestAssociation('one');yield 1}));return binding}
for(const operation of ['dispose','close'])test('late diagnostic cannot publish after '+operation,async()=>{
 const f=fixture();f.start();const binding=await holdBinding(f)
 f.hub[operation](f.a);binding('late');f.commit();f.end();assert.deepEqual(f.links,[]);f.hub.close()
})
test('attempt retention evicts in-flight associations beyond sixteen attempts',async()=>{
 const f=fixture();f.start();const binding=await holdBinding(f);f.end()
 for(let i=2;i<=17;i++){f.start(f.a,'attempt:'+i);f.end(f.a,'attempt:'+i,{kind:'committed',eventType:'assistant/message',seq:100+i})}
 binding('evicted');f.commit();assert.deepEqual(f.links,[]);f.hub.close()
})
test('event retention never substitutes another seq for an evicted settlement',async()=>{
 const f=fixture();f.start();const binding=await holdBinding(f);f.commit()
 for(let i=10;i<=41;i++)f.commit(event(i,'unrelated-'+i))
 binding('waiting');f.end();assert.deepEqual(f.links,[])
 f.commit();assert.equal(f.links.length,1);assert.equal(f.links[0].locator.settlementSeq,9);f.hub.close()
})
test('Agent retention invalidates oldest bindings beyond 256 active Agent instances',async()=>{
 const f=fixture();f.start();const binding=await holdBinding(f)
 for(let i=0;i<256;i++)f.start(agent('other-'+i))
 binding('evicted');f.commit();f.end();assert.deepEqual(f.links,[]);f.hub.close()
})
test('attempt ID reuse inside one Agent invalidates both old and replacement bindings',async()=>{
 const f=fixture();f.start();const old=await holdBinding(f);f.end();f.start()
 await f.consume(f.run(options('one'),'replacement'));old('late-old');f.commit();f.end();assert.deepEqual(f.links,[]);f.hub.close()
})
test('pending diagnostic ID overflow fails closed rather than partially associating',async()=>{
 const f=fixture();f.start();const binding=await holdBinding(f)
 for(let i=0;i<65;i++)binding('pending-'+i)
 f.commit();f.end();assert.deepEqual(f.links,[]);f.hub.close()
})

test('real LlmRuntime clone and Session append settle the exact original marked request',async()=>{
 const {Context}=await shared('@deepseek-ai/cordis')
 const {default:LlmRuntime,LlmAdapter,isAgentLoopRequest,createAssistantMessage,createUserMessage}=await shared('@deepseek-ai/dsh-llm')
 const {default:SessionStore}=await shared('@deepseek-ai/dsh-session')
 const {pathToFileURL}=await import('node:url')
 const {AssistantStreamAttempt}=await import(pathToFileURL(process.env.DSH_TEST_HOST_ROOT+'/packages/core/agent-loop/src/assistant-stream.ts').href)
 const ctx=new Context(),records=createDiagnosticHub(),hub=createRequestAssociationHub((id,locator)=>records.link(id,locator))
 let request,seen,revision=0
 class Adapter extends LlmAdapter {
  async *stream(value){
   seen=value;assert.notEqual(value,request);assert.equal(isAgentLoopRequest(value),false)
   const t=createArgonDiagnosticTracker({sessionId:value.sessionId},r=>records.record(r))
   yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:'answer'};yield {type:'block-end',index:0,block:{type:'text',text:'answer'}}
   t.finishStream({outcome:'done'});yield {type:'finish',reason:{kind:'stop'}}
  }
 }
 try{
  await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore)
  ctx.llm.registerAdapter(['argon'],new Adapter())
  ctx.on('llm/stream',(value,next)=>hub.stream(value,next));ctx.on('session/event',(s,e)=>hub.event(s,e));ctx.on('agent/assistant-stream',payload=>hub.frame(payload))
  const session=ctx.sessions.create('real-association'),a=agent(session.id)
  session.append('turn/start',{turn:1})
  session.append('user/message',createUserMessage({content:[{type:'text',text:'fixture'}],source:{kind:'user'}}),{surfaceOp:'append'})
  // A foreign replay envelope forces the Host to clone options before dispatch.
  session.append('assistant/message',{turn:1,step:1,stream:[],message:createAssistantMessage({content:[{type:'text',text:'history'}],source:{provider:'foreign',model:'other',replayState:{response:{kind:'fixture',version:1},blocks:[null]}}})},{surfaceOp:'append'})
  const prepared=await ctx.llm.prepareCall({provider:'argon',model:'model'})
  request=Object.freeze(markAgentLoopRequest({...prepared.config,sessionId:session.id,messages:session.deriveMessages()}))
  const stream=prepared.stream(request)
  const live=new AssistantStreamAttempt(session.id,1,()=>++revision,1,2,frame=>ctx.emit('agent/assistant-stream',{agent:a,frame}))
  live.start();for await(const chunk of stream)live.push(chunk)
  assert.equal(seen.sessionId,session.id);assert.equal(records.listRecent()[0].association,undefined)
  const message=createAssistantMessage({content:live.blocks(),source:{provider:'argon',model:'model'}})
  let committed
  live.settle('assistant/message',()=>{committed=session.append('assistant/message',{turn:1,step:2,message,stream:live.stream},{surfaceOp:'append'});return committed.seq})
  const locator=records.listRecent()[0].association
  assert.equal(locator.sessionId,session.id);assert.equal(locator.messageId,message.id);assert.equal(locator.settlementSeq,committed.seq)
 }finally{hub.close();await ctx.fiber.dispose()}
})

