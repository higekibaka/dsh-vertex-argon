import assert from 'node:assert/strict'
import {test} from 'node:test'
import {streamInteractions,buildInteractionRequest} from '../interactions.js'
const event=(type,fields={})=>({event_type:type,...fields})
const created=event('interaction.created',{interaction:{id:'remote-1',status:'in_progress'}})
const start=(index,type,extra={})=>event('step.start',{index,step:{type,...extra}})
const delta=(index,type,extra={})=>event('step.delta',{index,delta:{type,...extra}})
const stop=index=>event('step.stop',{index})
const done=(status='completed',usage={total_input_tokens:100,total_cached_tokens:20,total_output_tokens:5,total_thought_tokens:7,total_tokens:112})=>event('interaction.completed',{interaction:{id:'remote-1',status,usage}})
const stream=list=>(async function*(){for(const item of list){if(item instanceof Error)throw item;if(typeof item==='function'){item();continue}yield item}})()
const options=()=>({provider:'google-vertex-argon',model:'gemini-4-argon-google',maxTokens:1024,messages:[{role:'user',content:[{type:'text',text:'Call add.'}]}],tools:[{name:'add',description:'sum',parameters:{type:'object',properties:{a:{type:'number'}},required:['a']}}]})
async function run(list,{opts=options(),settings={},reconnect=[]}={}){
 const calls=[],chunks=[]
 const transport={create:async(body,request)=>{calls.push({method:'create',body,request});return stream(list)},get:async(id,request)=>{calls.push({method:'get',id,request});return stream(reconnect)},cancel:async(id,request)=>{calls.push({method:'cancel',id,request});return{status:'cancelled'}}}
 for await(const c of streamInteractions(opts,{route:'google-generative-ai',reasoning:'medium',store:false,background:false,transport,reconnectBackoff:{initialDelayMs:0},...settings}))chunks.push(c)
 return{calls,chunks,finish:chunks.at(-1),blocks:chunks.filter(c=>c.type==='block-end').map(c=>c.block),text:chunks.filter(c=>c.type==='text-delta').map(c=>c.text).join('')}
}
test('renders text, preserves signature-only thoughts, and maps latest usage',async()=>{
 const out=await run([created,start(0,'thought'),delta(0,'thought_signature',{signature:'signed'}),stop(0),start(1,'model_output'),delta(1,'text',{text:'OK'}),stop(1),done()])
 assert.equal(out.text,'OK');assert.equal(out.blocks.length,1);assert.equal(out.finish.reason.kind,'stop')
 assert.equal(out.finish.replayState.response.steps[0].signature,'signed')
 assert.deepEqual(out.chunks.find(c=>c.type==='usage').usage,{inputTokens:80,cacheReadTokens:20,outputTokens:12,reasoningTokens:7,totalTokens:112})
 const body=out.calls[0].body
 assert.equal(body.store,false);assert.equal(body.background,false);assert.equal(body.previous_interaction_id,undefined)
 assert.equal(body.generation_config.thinking_summaries,'auto');assert.equal(body.tools[0].type,'function')
})
test('requires_action emits only fully validated tool calls and replays signed steps statelessly',async()=>{
 const out=await run([created,start(0,'thought'),delta(0,'thought_summary',{content:{type:'text',text:'Plan'}}),delta(0,'thought_signature',{signature:'signed'}),stop(0),start(1,'function_call',{id:'call-1',name:'add'}),delta(1,'arguments_delta',{arguments:'{"a":'}),delta(1,'arguments_delta',{arguments:'17}'}),stop(1),done('requires_action')])
 assert.equal(out.finish.reason.kind,'tool-calls')
 const tool=out.blocks.find(b=>b.type==='tool-call');assert.equal(tool.arguments,'{"a":17}')
 const next=options();next.messages.push({role:'assistant',source:{provider:next.provider,model:next.model,replayState:out.finish.replayState},content:out.blocks},{role:'tool',toolCallId:'call-1',content:[{type:'text',text:'42'}]})
 const body=await buildInteractionRequest(next,{route:'google-generative-ai'})
 assert.equal(body.input.find(s=>s.type==='thought').signature,'signed')
 assert.deepEqual(body.input.find(s=>s.type==='function_result'),{type:'function_result',call_id:'call-1',name:'add',is_error:false,result:[{type:'text',text:'42'}]})
 assert.equal(body.previous_interaction_id,undefined)
})
test('supports documented Vertex partial_arguments field',async()=>{
 const out=await run([created,start(0,'function_call',{id:'c',name:'add'}),delta(0,'arguments_delta',{partial_arguments:'{"a":1}'}),stop(0),done('requires_action')],{settings:{route:'google-vertex'}})
 assert.equal(out.finish.reason.kind,'tool-calls');assert.equal(out.blocks[0].arguments,'{"a":1}')
})
test('incomplete budget never executes a truncated tool JSON',async()=>{
 const out=await run([created,start(0,'function_call',{id:'c',name:'add'}),delta(0,'arguments_delta',{arguments:'{"a":'}),done('incomplete')])
 assert.equal(out.finish.reason.kind,'max-tokens');assert.equal(out.blocks.length,0)
 assert.ok(!out.chunks.some(c=>c.type==='tool-call-delta'))
})
test('completed but invalid tool arguments fail closed',async()=>{
 const out=await run([created,start(0,'function_call',{id:'c',name:'add'}),delta(0,'arguments_delta',{arguments:'{"a":'}),stop(0),done('requires_action')])
 assert.equal(out.finish.reason.kind,'error');assert.equal(out.blocks.length,0)
})
test('validates all tools before emitting any of a malformed batch',async()=>{
 const out=await run([created,start(0,'function_call',{id:'a',name:'add',arguments:{a:1}}),stop(0),start(1,'function_call',{id:'b',name:'add'}),done('requires_action')])
 assert.equal(out.finish.reason.kind,'error');assert.equal(out.blocks.length,0)
})
test('cursor on status events is saved; reconnect deduplicates and keeps text accumulator',async()=>{
 const a=[{...created,event_id:'e1'},{...start(0,'model_output'),event_id:'e2'},{...delta(0,'text',{text:'A'}),event_id:'e3'},event('interaction.status_update',{interaction_id:'remote-1',status:'in_progress',event_id:'e4'}),new Error('drop')]
 const b=[event('interaction.status_update',{interaction_id:'remote-1',status:'in_progress',event_id:'e4'}),{...delta(0,'text',{text:'B'}),event_id:'e5'},{...stop(0),event_id:'e6'},{...done(),event_id:'e7'}]
 const out=await run(a,{settings:{store:true},reconnect:b})
 assert.equal(out.text,'AB');assert.equal(out.finish.reason.kind,'stop');assert.equal(out.calls[1].request.last_event_id,'e4')
 assert.equal(out.calls.filter(c=>c.method==='create').length,1)
})
test('drains replay after early completed status instead of losing missed output',async()=>{
 const out=await run([{...created,event_id:'e1'},new Error('drop')],{settings:{store:true},reconnect:[event('interaction.status_update',{status:'completed',event_id:'e2'}),start(0,'model_output'),delta(0,'text',{text:'missed'}),stop(0),done()]})
 assert.equal(out.text,'missed');assert.equal(out.finish.reason.kind,'stop')
})
test('early completed status plus EOF resumes until the actual completion event',async()=>{
 const out=await run([{...created,event_id:'e1'},event('interaction.status_update',{status:'completed',event_id:'e2'}),{...start(0,'model_output'),event_id:'e3'},{...delta(0,'text',{text:'A'}),event_id:'e4'}],{settings:{store:true},reconnect:[{...delta(0,'text',{text:'B'}),event_id:'e5'},{...stop(0),event_id:'e6'},{...done(),event_id:'e7'}]})
 assert.equal(out.text,'AB');assert.equal(out.finish.reason.kind,'stop');assert.equal(out.calls.filter(c=>c.method==='get').length,1)
})
test('completed event cannot turn an unclosed model step into successful output',async()=>{
 const out=await run([created,start(0,'model_output'),delta(0,'text',{text:'partial'}),done()])
 assert.equal(out.finish.reason.kind,'error')
})
test('in-band authentication error reconnects existing stored task without a new POST',async()=>{
 const out=await run([{...created,event_id:'e1'},{...start(0,'model_output'),event_id:'e2'},{...delta(0,'text',{text:'A'}),event_id:'e3'},event('error',{event_id:'e4',error:{code:'authentication',message:'not logged'}})],{settings:{store:true,background:true},reconnect:[{...delta(0,'text',{text:'B'}),event_id:'e5'},{...stop(0),event_id:'e6'},{...done(),event_id:'e7'}]})
 assert.equal(out.text,'AB');assert.equal(out.finish.reason.kind,'stop')
 assert.equal(out.calls.filter(c=>c.method==='create').length,1);assert.equal(out.calls.filter(c=>c.method==='cancel').length,0)
})
test('documented text annotations do not break text generation',async()=>{
 const out=await run([created,start(0,'model_output'),delta(0,'text',{text:'answer'}),delta(0,'text_annotation_delta',{annotation:{}}),stop(0),done()])
 assert.equal(out.text,'answer');assert.equal(out.finish.reason.kind,'stop')
})
test('no terminal EOF and nonstored streams cannot silently succeed or repeat POST',async()=>{
 const out=await run([created,start(0,'model_output'),delta(0,'text',{text:'partial'})])
 assert.equal(out.finish.reason.kind,'error');assert.equal(out.calls.length,1)
})
test('productive long streams reset consecutive reconnect failures without repeating POST',async()=>{
 let gets=0,creates=0
 const transport={create:async()=>{creates++;return stream([{...created,event_id:'c'},{...start(0,'model_output'),event_id:'s'},{...delta(0,'text',{text:'A'}),event_id:'d0'},new Error('drop')])},get:async()=>{gets++;return gets<5?stream([{...delta(0,'text',{text:'B'}),event_id:'d'+gets},new Error('drop')]):stream([{...delta(0,'text',{text:'C'}),event_id:'d5'},{...stop(0),event_id:'end'},{...done(),event_id:'done'}])}}
 const out=await run([],{settings:{store:true,transport}})
 assert.equal(out.text,'ABBBBC');assert.equal(out.finish.reason.kind,'stop');assert.equal(creates,1);assert.equal(gets,5)
})
test('changing full-object function argument deltas count as reconnect progress',async()=>{
 let gets=0
 const transport={create:async()=>stream([{...created,event_id:'c'},{...start(0,'function_call',{id:'call',name:'add'}),event_id:'s'},delta(0,'function_call',{arguments:{a:0}}),new Error('drop')]),get:async()=>{gets++;return gets<5?stream([delta(0,'function_call',{arguments:{a:gets}}),new Error('drop')]):stream([delta(0,'function_call',{arguments:{a:5}}),stop(0),done('requires_action')])}}
 const out=await run([],{settings:{store:true,transport}})
 assert.equal(out.finish.reason.kind,'tool-calls');assert.equal(gets,5);assert.equal(out.blocks[0].arguments,'{"a":5}')
})
test('stored stream without cursor cannot replay already emitted output safely',async()=>{
 const out=await run([created,start(0,'model_output'),delta(0,'text',{text:'partial'}),new Error('drop')],{settings:{store:true}})
 assert.equal(out.finish.reason.kind,'error');assert.equal(out.calls.length,1)
})
test('user abort explicitly cancels known background task with fresh signal',async()=>{
 const c=new AbortController(),opts=options();opts.signal=c.signal
 const out=await run([created,()=>c.abort(),start(0,'model_output')],{opts,settings:{background:true,store:true}})
 assert.equal(out.finish.reason.kind,'aborted')
 const cancel=out.calls.find(c=>c.method==='cancel');assert.equal(cancel.id,'remote-1');assert.equal(cancel.request.signal.aborted,false)
})
test('large budgets require consent and Vertex remains gated before IO',async()=>{
 for(const settings of [{background:false,store:false},{background:true,store:false},{background:true,store:true,route:'google-vertex'}]){
  const opts=options();opts.maxTokens=131072
  const out=await run([],{opts,settings})
  assert.equal(out.finish.reason.kind,'error');assert.equal(out.calls.length,0)
 }
})
test('string false cannot grant background storage consent',async()=>{
 const out=await run([],{settings:{background:true,store:'false'}})
 assert.equal(out.finish.reason.kind,'error');assert.equal(out.calls.length,0)
})
test('failed and cancelled server statuses map distinctly',async()=>{
 assert.equal((await run([created,done('failed')])).finish.reason.kind,'error')
 assert.equal((await run([created,done('cancelled')])).finish.reason.kind,'aborted')
 assert.equal((await run([created,done('budget_exceeded')])).finish.reason.kind,'max-tokens')
})
test('foreign completed tool history is transcripted, never assigned fake signatures',async()=>{
 const opts=options();opts.messages.push({role:'assistant',content:[{type:'tool-call',id:'foreign',name:'add',arguments:'{"a":1}'}],source:{provider:'other',model:'other'}},{role:'tool',toolCallId:'foreign',content:[{type:'text',text:'result'}]})
 const body=await buildInteractionRequest(opts,{route:'google-generative-ai'})
 assert.ok(!body.input.some(s=>s.type==='function_call'||s.type==='thought'))
 assert.ok(JSON.stringify(body).includes('Previously executed tool'))
})
test('edited visible history invalidates native opaque replay',async()=>{
 const out=await run([created,start(0,'model_output'),delta(0,'text',{text:'original'}),stop(0),done()])
 const opts=options();opts.messages.push({role:'assistant',content:[{type:'text',text:'edited'}],source:{replayState:out.finish.replayState}})
 const body=await buildInteractionRequest(opts,{route:'google-generative-ai'})
 assert.ok(!JSON.stringify(body).includes('original'));assert.ok(JSON.stringify(body).includes('edited'))
})
test('explicit stop sequences use the official generation_config field',async()=>{
 const opts=options();opts.stop=['END']
 const body=await buildInteractionRequest(opts,{route:'google-generative-ai'})
 assert.deepEqual(body.generation_config.stop_sequences,['END'])
 await assert.rejects(buildInteractionRequest({...opts,stop:['']},{route:'google-generative-ai'}),/nonempty/)
})
test('images are explicitly resolved or rejected, not silently dropped',async()=>{
 const opts=options();opts.messages[0].content=[{type:'image',attachment:{attachmentId:'image'}}]
 await assert.rejects(buildInteractionRequest(opts,{route:'google-generative-ai'}),/attachment resolver/)
 const body=await buildInteractionRequest(opts,{route:'google-generative-ai',resolveImage:async()=>({type:'image',mime_type:'image/png',data:'fixture'})})
 assert.equal(body.input[0].content[0].type,'image')
})

test('cursor-free unexposed partial steps are reset before GET replay',async()=>{
 const initial=[created,start(0,'thought'),delta(0,'thought_signature',{signature:'signed'}),stop(0),start(1,'function_call',{id:'call',name:'add'}),delta(1,'arguments_delta',{arguments:'{"a":'}),new Error('drop')]
 const replay=[created,start(0,'thought'),delta(0,'thought_signature',{signature:'signed'}),stop(0),start(1,'function_call',{id:'call',name:'add',arguments:{a:17}}),stop(1),done('requires_action')]
 const out=await run(initial,{settings:{store:true},reconnect:replay})
 assert.equal(out.finish.reason.kind,'tool-calls');assert.equal(out.calls.filter(c=>c.method==='create').length,1)
 assert.equal(out.blocks.filter(b=>b.type==='tool-call').length,1)
 assert.equal(out.blocks.find(b=>b.type==='tool-call').arguments,'{"a":17}')
 assert.equal(out.finish.replayState.response.steps[0].signature,'signed')
 assert.equal(out.calls.find(c=>c.method==='get').request.last_event_id,undefined)
})

test('repeated cursor-free partial replay cannot reset the bounded recovery limit',async()=>{
 const partial=[created,start(0,'thought'),delta(0,'thought_signature',{signature:'same'}),new Error('drop')]
 const out=await run(partial,{settings:{store:true},reconnect:partial})
 assert.equal(out.finish.reason.kind,'error')
 assert.equal(out.calls.filter(c=>c.method==='create').length,1)
 assert.equal(out.calls.filter(c=>c.method==='get').length,3)
 assert.equal(out.blocks.length,0)
})

test('2026-05-20 lifecycle events finalize the stream on their own',async()=>{
 const out=await run([
  event('interaction.created',{interaction:{id:'remote-1',status:'in_progress'}}),
  event('interaction.in_progress',{interaction:{id:'remote-1'}}),
  start(0,'model_output'),delta(0,'text',{text:'OK'}),stop(0),
  start(1,'function_call',{id:'call-1',name:'add'}),delta(1,'arguments_delta',{arguments:'{"a":1}'}),stop(1),
  event('interaction.requires_action',{interaction:{id:'remote-1',usage:{total_input_tokens:100,total_cached_tokens:20,total_output_tokens:5,total_thought_tokens:7,total_tokens:112}}}),
 ])
 assert.equal(out.text,'OK');assert.equal(out.finish.reason.kind,'tool-calls')
 assert.equal(out.blocks.find(b=>b.type==='tool-call').arguments,'{"a":1}')
 assert.equal(out.calls.filter(c=>c.method==='create').length,1)
 assert.equal(out.calls.filter(c=>c.method==='cancel').length,0)
 // A lifecycle event that carries usage still reaches the host exactly once.
 assert.deepEqual(out.chunks.find(c=>c.type==='usage').usage,{inputTokens:80,cacheReadTokens:20,outputTokens:12,reasoningTokens:7,totalTokens:112})
})

test('unknown lifecycle notices never abort a paid task',async()=>{
 let exit
 const out=await run([
  created,
  event('interaction.custom_future_event',{interaction:{id:'remote-1',status:'in_progress'}}),
  start(0,'model_output'),delta(0,'text',{text:'OK'}),stop(0),done(),
 ],{settings:{store:true,background:true,onExit:reason=>{exit=reason}}})
 assert.equal(out.text,'OK');assert.equal(out.finish.reason.kind,'stop');assert.equal(exit,'completed')
 assert.equal(out.calls.filter(c=>c.method==='cancel').length,0)
})

test('an unrecoverable provider error event is terminal and never cancels the cloud task',async()=>{
 let exit
 const out=await run([
  {...created,event_id:'e1'},{...start(0,'model_output'),event_id:'e2'},{...delta(0,'text',{text:'A'}),event_id:'e3'},
  event('error',{event_id:'e4',error:{code:'UNAUTHENTICATED'}}),
 ],{settings:{store:true,background:true,onExit:reason=>{exit=reason}}})
 assert.equal(exit,'remote-error');assert.equal(out.finish.reason.kind,'error')
 assert.match(out.finish.reason.failure.message,/UNAUTHENTICATED/)
 assert.equal(out.calls.filter(c=>c.method==='get').length,0)
 assert.equal(out.calls.filter(c=>c.method==='cancel').length,0)
})

test('replayed user_input steps are structural and never rendered or replayed',async()=>{
 const out=await run([created,start(0,'user_input'),stop(0),start(1,'model_output'),delta(1,'text',{text:'OK'}),stop(1),done()])
 assert.equal(out.text,'OK');assert.equal(out.finish.reason.kind,'stop');assert.equal(out.blocks.length,1)
 assert.deepEqual(out.finish.replayState.response.steps.map(s=>s.type),['model_output'])
 assert.equal(out.calls.filter(c=>c.method==='cancel').length,0)
})

test('server retry hints drive the reconnect wait and long hints fail fast',async()=>{
 const delays=[]
 const makeTransport=extra=>{
  const calls=[]
  return{calls,transport:{
   create:async()=>stream([{...created,event_id:'e1'},{...start(0,'model_output'),event_id:'e2'},{...delta(0,'text',{text:'A'}),event_id:'e3'},Object.assign(new Error('drop'),{status:503,phase:'fetch',...extra})]),
   get:async(id,request)=>{calls.push({id,request});return stream([{...delta(0,'text',{text:'B'}),event_id:'e4'},{...stop(0),event_id:'e5'},{...done(),event_id:'e6'}])},
   cancel:async()=>{calls.push({method:'cancel'});return{status:'cancelled'}},
  }}
 }
 const short=makeTransport({retryDelayMs:30})
 const out=await run([],{settings:{store:true,transport:short.transport,onReconnectDelay:ms=>delays.push(ms)}})
 assert.equal(out.text,'AB');assert.equal(out.finish.reason.kind,'stop')
 assert.deepEqual(delays,[30])
 assert.deepEqual(Object.keys(short.calls[0].request).sort(),['last_event_id','signal','stream'])
 assert.equal(short.calls[0].request.last_event_id,'e3')
 const long=makeTransport({retryDelayMs:61000})
 const stopped=await run([],{settings:{store:true,transport:long.transport,onReconnectDelay:ms=>delays.push(ms)}})
 assert.equal(stopped.finish.reason.kind,'error');assert.equal(long.calls.length,0)
 assert.deepEqual(delays,[30])
})


for (const [status, kind] of [['failed', 'error'], ['cancelled', 'aborted'], ['budget_exceeded', 'max-tokens']]) {
 test('a status_update carrying ' + status + ' finalizes the stream at EOF', async () => {
  const out = await run([
   created,
   start(0, 'model_output'), delta(0, 'text', { text: 'partial' }), stop(0),
   event('interaction.status_update', { interaction_id: 'remote-1', status }),
  ])
  assert.equal(out.finish.reason.kind, kind)
  // The terminal status_update is itself the end of the stream: no reconnect,
  // no protocol interruption and no remote cancellation.
  assert.equal(out.calls.filter(c => c.method === 'get').length, 0)
  assert.equal(out.calls.filter(c => c.method === 'cancel').length, 0)
  assert.equal(out.finish.reason.failure?.code, kind === 'error' ? 'ARGON_INTERACTIONS_FAILED' : kind === 'aborted' ? 'ABORTED' : undefined)
 })
}
test('a status_update carrying completed still waits for the dedicated completion event', async () => {
 const out = await run([{ ...created, event_id: 'e1' }, { ...start(0, 'model_output'), event_id: 'e2' }, event('interaction.status_update', { status: 'completed', event_id: 'e3' }), new Error('drop')], { settings: { store: true }, reconnect: [{ ...delta(0, 'text', { text: 'late' }), event_id: 'e4' }, { ...stop(0), event_id: 'e5' }, { ...done(), event_id: 'e6' }] })
 assert.equal(out.text, 'late'); assert.equal(out.finish.reason.kind, 'stop')
 assert.equal(out.calls.filter(c => c.method === 'get').length, 1)
})
test('an unknown interaction event cannot roll back a confirmed completed status', async () => {
 const out = await run([created, start(0, 'model_output'), delta(0, 'text', { text: 'OK' }), stop(0), done(), event('interaction.custom_event', { interaction: { id: 'remote-1', status: 'in_progress' } })])
 assert.equal(out.text, 'OK'); assert.equal(out.finish.reason.kind, 'stop')
 assert.equal(out.calls.filter(c => c.method === 'cancel').length, 0)
})
test('a lifecycle notice cannot roll back a confirmed completed status', async () => {
 const out = await run([created, start(0, 'model_output'), delta(0, 'text', { text: 'OK' }), stop(0), done(), event('interaction.in_progress', { interaction: { id: 'remote-1', status: 'in_progress' } })])
 assert.equal(out.text, 'OK'); assert.equal(out.finish.reason.kind, 'stop')
 assert.equal(out.calls.filter(c => c.method === 'cancel').length, 0)
})
test('a dedicated budget_exceeded lifecycle event finalizes as max-tokens', async () => {
 const out = await run([created, start(0, 'model_output'), delta(0, 'text', { text: 'partial' }), stop(0), event('interaction.budget_exceeded', { interaction: { id: 'remote-1' } })])
 assert.equal(out.finish.reason.kind, 'max-tokens')
 assert.equal(out.calls.filter(c => c.method === 'cancel').length, 0)
 assert.equal(out.calls.filter(c => c.method === 'get').length, 0)
})
test('a delta after a closed user_input step is a protocol error', async () => {
 const out = await run([created, start(0, 'user_input'), stop(0), delta(0, 'text', { text: 'late' }), done()])
 assert.equal(out.finish.reason.kind, 'error')
 assert.match(out.finish.reason.failure.message, /already closed/)
 assert.equal(out.calls.filter(c => c.method === 'cancel').length, 0)
})

test('round8 interactions fix (R7-P1-6): unindexed visible frame after an earlier event_id refuses replay until a newer cursor advances', async () => {
 const blocked = await run([
  { ...created, event_id: 'e1' },
  { ...start(0, 'model_output'), event_id: 'e2' },
  delta(0, 'text', { text: 'unindexed-visible' }),
  new Error('drop'),
 ], {
  settings: { store: true },
  reconnect: [{ ...delta(0, 'text', { text: 'should-not-replay' }), event_id: 'e3' }, { ...stop(0), event_id: 'e4' }, { ...done(), event_id: 'e5' }],
 })
 assert.equal(blocked.finish.reason.kind, 'error')
 assert.match(blocked.finish.reason.failure.message, /omitted event_id on a visible output frame/)
 assert.equal(blocked.calls.filter(c => c.method === 'get').length, 0)

 const recovered = await run([
  { ...created, event_id: 'e1' },
  { ...start(0, 'model_output'), event_id: 'e2' },
  delta(0, 'text', { text: 'Part1' }),
  { ...delta(0, 'text', { text: 'Part2' }), event_id: 'e3' },
  new Error('drop'),
 ], {
  settings: { store: true },
  reconnect: [{ ...delta(0, 'text', { text: 'Part3' }), event_id: 'e4' }, { ...stop(0), event_id: 'e5' }, { ...done(), event_id: 'e6' }],
 })
 assert.equal(recovered.finish.reason.kind, 'stop')
 assert.equal(recovered.text, 'Part1Part2Part3')
 assert.equal(recovered.calls.filter(c => c.method === 'get').length, 1)
})

test('round9 interactions fix (R8-P1-4): unindexed function_call argument deltas roll back to last indexed snapshot before cursor replay', async () => {
 let gets = 0
 const out = await run([], {
  settings: {
   store: true,
   transport: {
    create: async () => stream([
     { ...created, event_id: 'e1' },
     { ...start(0, 'function_call', { id: 'c1', name: 'write' }), event_id: 'e2' },
     { ...delta(0, 'arguments_delta', { partial_arguments: '{"n":' }), event_id: 'e3' },
     delta(0, 'arguments_delta', { partial_arguments: '1' }),
     new Error('drop'),
    ]),
    get: async (_id, req) => {
     gets++
     assert.equal(req.last_event_id, 'e3')
     return stream([
      { ...delta(0, 'arguments_delta', { partial_arguments: '1' }), event_id: 'e4' },
      { ...delta(0, 'arguments_delta', { partial_arguments: '}' }), event_id: 'e5' },
      { ...stop(0), event_id: 'e6' },
      { ...done('requires_action'), event_id: 'e7' },
     ])
    },
    cancel: async () => ({ status: 'cancelled' }),
   },
  },
 })
 assert.equal(out.finish.reason.kind, 'tool-calls')
 assert.equal(gets, 1)
 assert.equal(out.blocks[0].arguments, '{"n":1}')

 // Identical un-indexed argument delta repeats cannot loop past the retry bound.
 let loopedGets = 0
 const looped = await run([], {
  settings: {
   store: true,
   transport: {
    create: async () => stream([
     { ...created, event_id: 'e1' },
     { ...start(0, 'function_call', { id: 'c1', name: 'write' }), event_id: 'e2' },
     delta(0, 'arguments_delta', { partial_arguments: '{"n":1' }),
     new Error('drop'),
    ]),
    get: async () => {
     loopedGets++
     return stream([
      delta(0, 'arguments_delta', { partial_arguments: '{"n":1' }),
      new Error('drop'),
     ])
    },
    cancel: async () => ({ status: 'cancelled' }),
   },
  },
 })
 assert.equal(looped.finish.reason.kind, 'error')
 assert.equal(loopedGets, 3)
})

test('round10 interactions fix (R9-P1-3): indexed recoverable error commits neither cursor nor snapshot before reconnect', async () => {
 const out = await run([
  { ...created, event_id: 'e1' },
  { ...start(0, 'function_call', { id: 'c1', name: 'write' }), event_id: 'e1b' },
  { ...delta(0, 'arguments_delta', { partial_arguments: '{"n":1' }), event_id: 'e2' },
  delta(0, 'arguments_delta', { partial_arguments: '0' }),
  event('error', { event_id: 'e3', error: { code: 'authentication' } }),
 ], {
  settings: { store: true },
  reconnect: [
   { ...delta(0, 'arguments_delta', { partial_arguments: '0' }), event_id: 'e3b' },
   { ...delta(0, 'arguments_delta', { partial_arguments: '}' }), event_id: 'e4' },
   { ...stop(0), event_id: 'e5' },
   { ...done('requires_action'), event_id: 'e6' },
  ],
 })
 assert.equal(out.finish.reason.kind, 'tool-calls')
 assert.equal(out.calls.filter(c => c.method === 'get').length, 1)
 assert.equal(out.calls[1].request.last_event_id, 'e2')
 assert.equal(out.blocks[0].arguments, '{"n":10}')

 // Unindexed visible text followed by an indexed recoverable error still fails closed (unindexedVisibleOutput stays true).
 const blocked = await run([
  { ...created, event_id: 'e1' },
  { ...start(0, 'model_output'), event_id: 'e2' },
  delta(0, 'text', { text: 'unindexed-visible' }),
  event('error', { event_id: 'e3', error: { code: 'authentication' } }),
 ], {
  settings: { store: true },
  reconnect: [{ ...done(), event_id: 'e4' }],
 })
 assert.equal(blocked.finish.reason.kind, 'error')
 assert.match(blocked.finish.reason.failure.message, /omitted event_id on a visible output frame/)
 assert.equal(blocked.calls.filter(c => c.method === 'get').length, 0)
})

test('round11 interactions fix (R10-P1-3): partial step.start validation error never emits partial text or retries as transport', async () => {
 const out = await run([
  { ...created, event_id: 'e1' },
  {
   event_type: 'step.start',
   event_id: 'e2',
   index: 0,
   step: { type: 'model_output', content: [{ type: 'text', text: 'A' }, null] },
  },
 ], {
  settings: { store: true },
  reconnect: [{ ...done(), event_id: 'e3' }],
 })
 assert.equal(out.finish.reason.kind, 'error')
 assert.equal(out.finish.reason.failure.code, 'ARGON_INTERACTIONS_PROTOCOL')
 assert.equal(out.calls.filter(c => c.method === 'get').length, 0)
 assert.deepEqual(out.chunks.filter(e => e.type === 'text-delta'), [])

 // Pre-validated bad thought.summary element before any delta also fails with protocol code without retry.
 const badThought = await run([
  { ...created, event_id: 'e1' },
  {
   event_type: 'step.start',
   event_id: 'e2',
   index: 0,
   step: { type: 'thought', summary: [{ type: 'text', text: 'T' }, null] },
  },
 ], {
  settings: { store: true },
  reconnect: [{ ...done(), event_id: 'e3' }],
 })
 assert.equal(badThought.finish.reason.kind, 'error')
 assert.equal(badThought.finish.reason.failure.code, 'ARGON_INTERACTIONS_PROTOCOL')
 assert.equal(badThought.calls.filter(c => c.method === 'get').length, 0)
 assert.deepEqual(badThought.chunks.filter(e => e.type === 'reasoning-delta'), [])
})

test('P1-乙 & R10-P1-3: captureSnapshot failure prevents replay after delivered text; thought.summary non-text and step id/name bytes are enforced', async () => {
  const origStructuredClone = globalThis.structuredClone
  globalThis.structuredClone = value => {
    if (value && typeof value === 'object' && value.total_output_tokens === 999) {
      throw Object.assign(new Error('Simulated DataCloneError during snapshot'), { name: 'DataCloneError' })
    }
    return origStructuredClone(value)
  }
  let snapFailOut
  try {
    snapFailOut = await run([
      { ...created, event_id: 'e1' },
      { ...start(0, 'model_output'), event_id: 'e2' },
      { ...delta(0, 'text', { text: 'ONCE' }), event_id: 'e3', usage: { total_output_tokens: 999 } },
    ], {
      settings: { store: true },
      reconnect: [
        { ...delta(0, 'text', { text: 'ONCE' }), event_id: 'e3' },
        { ...stop(0), event_id: 'e4' },
        { ...done(), event_id: 'e5' },
      ],
    })
  } finally {
    globalThis.structuredClone = origStructuredClone
  }
  assert.equal(snapFailOut.finish.reason.kind, 'error')
  assert.equal(snapFailOut.finish.reason.failure.code, 'ARGON_INTERACTIONS_PROTOCOL')
  assert.equal(snapFailOut.calls.filter(c => c.method === 'get').length, 0)
  assert.equal(snapFailOut.text, 'ONCE')

  const badSummary = await run([
    { ...created, event_id: 'e1' },
    {
      index: 0,
      event_type: 'step.start',
      event_id: 'e2',
      step: { type: 'thought', summary: [{ type: 'unknown_modality', uri: 'https://example.invalid/t.png' }] },
    },
  ], {
    settings: { store: true },
    reconnect: [{ ...done(), event_id: 'e3' }],
  })
  assert.equal(badSummary.finish.reason.kind, 'error')
  assert.equal(badSummary.finish.reason.failure.code, 'ARGON_INTERACTIONS_PROTOCOL')
  assert.equal(badSummary.calls.filter(c => c.method === 'get').length, 0)

  const malformedImageSummary = await run([
    { ...created, event_id: 'e1' },
    {
      index: 0,
      event_type: 'step.start',
      event_id: 'e2',
      step: { type: 'thought', summary: [{ type: 'image', mime_type: 'image/png' }] },
    },
  ], {
    settings: { store: true },
    reconnect: [{ ...done(), event_id: 'e3' }],
  })
  assert.equal(malformedImageSummary.finish.reason.kind, 'error')
  assert.equal(malformedImageSummary.finish.reason.failure.code, 'ARGON_INTERACTIONS_PROTOCOL')
  assert.equal(malformedImageSummary.calls.filter(c => c.method === 'get').length, 0)

  const hugeMeta = await run([
    { ...created, event_id: 'e1' },
    {
      index: 0,
      event_type: 'step.start',
      event_id: 'e2',
      step: { type: 'function_call', id: 'a'.repeat(40 * 1024 * 1024), name: 'b'.repeat(25 * 1024 * 1024) },
    },
  ], {
    settings: { store: true },
    reconnect: [{ ...done(), event_id: 'e3' }],
  })
  assert.equal(hugeMeta.finish.reason.kind, 'error')
  assert.equal(hugeMeta.finish.reason.failure.code, 'ARGON_INTERACTIONS_PROTOCOL')
  assert.equal(hugeMeta.calls.filter(c => c.method === 'get').length, 0)
})

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('phase watchdog pauses while downstream consumer delays, and rejects stalled streams with STREAM_PHASE_TIMEOUT', async () => {
  // Consumer backpressure must NOT trigger STREAM_PHASE_TIMEOUT.
  const slowConsumerTransport = {
    create: async () => (async function* () {
      yield created
      yield start(0, 'model_output')
      yield delta(0, 'text', { text: 'part-1 ' })
      yield delta(0, 'text', { text: 'part-2' })
      yield stop(0)
      yield done()
    })(),
    get: async () => assert.fail('unexpected get'),
    cancel: async () => ({ status: 'cancelled' }),
  }
  const collected = []
  for await (const chunk of streamInteractions(options(), {
    route: 'google-generative-ai',
    store: false,
    background: false,
    transport: slowConsumerTransport,
    phaseTimeouts: { initialTtft: 40, thinking: 40, transition: 40, streaming: 40 },
    reconnectBackoff: { initialDelayMs: 0 },
  })) {
    collected.push(chunk)
    if (chunk.type === 'text-delta') await sleep(70)
  }
  assert.equal(collected.at(-1).reason.kind, 'stop')
  assert.equal(collected.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'part-1 part-2')

  // Repeated identical signatures / empty heartbeats cannot reset the thinking watchdog.
  let pseudoAttempts = 0
  const pseudoTransport = {
    create: async (_body, { signal }) => {
      pseudoAttempts++
      return (async function* () {
        yield created
        yield start(0, 'thought')
        yield delta(0, 'thought_summary', { content: { type: 'text', text: 'thinking' } })
        yield delta(0, 'thought_signature', { signature: 'sig-1' })
        for (let i = 0; i < 12; i++) {
          await sleep(12)
          if (signal?.aborted) throw signal.reason
          yield delta(0, 'thought_signature', { signature: 'sig-1' })
          yield event('interaction.status_update', { interaction: { id: 'remote-1', status: 'in_progress' } })
        }
        yield stop(0)
        yield done()
      })()
    },
    get: async () => assert.fail('unexpected get'),
    cancel: async () => ({ status: 'cancelled' }),
  }
  const pseudoChunks = []
  for await (const chunk of streamInteractions(options(), {
    route: 'google-generative-ai',
    store: false,
    background: false,
    transport: pseudoTransport,
    phaseTimeouts: { initialTtft: 40, thinking: 40, transition: 40, streaming: 40 },
    reconnectBackoff: { initialDelayMs: 0 },
  })) {
    pseudoChunks.push(chunk)
  }
  assert.equal(pseudoAttempts, 1)
  assert.equal(pseudoChunks.at(-1).reason.kind, 'error')
  assert.equal(pseudoChunks.at(-1).reason.failure.code, 'STREAM_PHASE_TIMEOUT')
})

test('phase watchdog emits STREAM_PHASE_TIMEOUT distinct from user abort and retries zero-delivered stateless create', async () => {
  // 1) After visible text is emitted on store:false, timeout throws STREAM_PHASE_TIMEOUT without repeating POST.
  let creates = 0
  const stallAfterText = {
    create: async (_body, { signal }) => {
      creates++
      return (async function* () {
        yield created
        yield start(0, 'model_output')
        yield delta(0, 'text', { text: 'started' })
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      })()
    },
    get: async () => assert.fail('unexpected get'),
    cancel: async () => ({ status: 'cancelled' }),
  }
  const timedOut = await run([], {
    settings: {
      store: false,
      background: false,
      transport: stallAfterText,
      phaseTimeouts: { initialTtft: 100, thinking: 100, transition: 100, streaming: 35 },
    },
  })
  assert.equal(creates, 1)
  assert.equal(timedOut.finish.reason.kind, 'error')
  assert.equal(timedOut.finish.reason.failure.code, 'STREAM_PHASE_TIMEOUT')
  assert.equal(timedOut.finish.reason.failure.status, 504)

  // 2) User abort produces kind:'aborted', code:'ABORTED', NOT STREAM_PHASE_TIMEOUT.
  const controller = new AbortController()
  const optsAbort = { ...options(), signal: controller.signal }
  const hanging = {
    create: async (_body, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      setTimeout(() => controller.abort(), 15)
    }),
    get: async () => assert.fail('unexpected get'),
    cancel: async () => ({ status: 'cancelled' }),
  }
  const aborted = await run([], {
    opts: optsAbort,
    settings: {
      store: false,
      background: false,
      transport: hanging,
      phaseTimeouts: { initialTtft: 500 },
    },
  })
  assert.equal(aborted.finish.reason.kind, 'aborted')
  assert.equal(aborted.finish.reason.failure.code, 'ABORTED')
})

test('store:false zero-delivered initial create retries up to 3 times on fetch-stage pre-connect/408/429/5xx errors and never retries after HTTP 200 stream or store:true', async () => {
  // Succeeds on 4th attempt (3 retries) after HTTP 503, ECONNREFUSED, and UND_ERR_CONNECT_TIMEOUT during fetch.
  const retryEvents = []
  const delays = []
  let attempts = 0
  const flakyCreate = {
    create: async () => {
      attempts++
      if (attempts === 1) throw Object.assign(new Error('HTTP 503'), { status: 503, phase: 'fetch', retryDelayMs: 5 })
      if (attempts === 2) throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED', phase: 'fetch' })
      if (attempts === 3) throw Object.assign(new Error('connect timeout'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' }, phase: 'fetch' })
      return stream([created, start(0, 'model_output'), delta(0, 'text', { text: 'recovered' }), stop(0), done()])
    },
    get: async () => assert.fail('must not call get when store:false'),
    cancel: async () => ({ status: 'cancelled' }),
  }
  const ok = await run([], {
    settings: {
      store: false,
      background: false,
      transport: flakyCreate,
      phaseTimeouts: { initialTtft: 30, thinking: 30, transition: 30, streaming: 30 },
      onReconnectDelay: ms => delays.push(ms),
      onCreateRetry: info => retryEvents.push(info.trigger),
    },
  })
  assert.equal(ok.finish.reason.kind, 'stop')
  assert.equal(ok.text, 'recovered')
  assert.equal(attempts, 4)
  assert.deepEqual(retryEvents, ['retry-initial', 'retry-initial', 'retry-initial'])
  assert.equal(delays[0], 5)

  // Once transport.create returns an HTTP 200 SSE stream (or throws post-connect ECONNRESET),
  // stateless store:false MUST NOT resubmit POST (even on empty 200 EOF, pre-frame drop, or TTFT stall).
  for (const [label, createFn, expectedCode] of [
    ['200 empty SSE EOF', async () => stream([]), 'ARGON_INTERACTIONS_INTERRUPTED'],
    ['200 pre-frame ECONNRESET', async () => (async function* () { throw Object.assign(new Error('drop'), { code: 'ECONNRESET', phase: 'stream', status: 200 }) })(), 'ECONNRESET'],
    ['200 pre-frame TTFT timeout', async (_body, { signal }) => (async function* () { await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) })(), 'STREAM_PHASE_TIMEOUT'],
    ['fetch-stage post-connect ECONNRESET', async () => { throw Object.assign(new Error('reset'), { code: 'ECONNRESET', phase: 'fetch' }) }, 'ECONNRESET'],
  ]) {
    let postCount = 0
    const res = await run([], {
      settings: {
        store: false,
        background: false,
        phaseTimeouts: { initialTtft: 25, thinking: 25, transition: 25, streaming: 25 },
        transport: {
          create: async (body, optsArg) => { postCount++; return createFn(body, optsArg) },
          get: async () => assert.fail('must not call get when store:false'),
          cancel: async () => ({ status: 'cancelled' }),
        },
      },
    })
    assert.equal(postCount, 1, label)
    assert.equal(res.finish.reason.kind, 'error', label)
    assert.equal(res.finish.reason.failure.code, expectedCode, label)
  }

  // Fails fast when server asks for Retry-After > 60s.
  let longRetryCalls = 0
  const longRetry = await run([], {
    settings: {
      store: false,
      background: false,
      transport: {
        create: async () => { longRetryCalls++; throw Object.assign(new Error('429'), { status: 429, phase: 'fetch', retryDelayMs: 65000 }) },
        get: async () => assert.fail('unexpected get'),
        cancel: async () => ({ status: 'cancelled' }),
      },
    },
  })
  assert.equal(longRetry.finish.reason.kind, 'error')
  assert.equal(longRetryCalls, 1)

  // Never retries create POST when store:true or background:true.
  for (const flags of [{ store: true, background: false }, { store: true, background: true }]) {
    let storedCalls = 0
    const res = await run([], {
      settings: {
        ...flags,
        transport: {
          create: async () => { storedCalls++; throw Object.assign(new Error('503'), { status: 503, phase: 'fetch' }) },
          get: async () => assert.fail('unexpected get'),
          cancel: async () => ({ status: 'cancelled' }),
        },
      },
    })
    assert.equal(res.finish.reason.kind, 'error')
    assert.equal(storedCalls, 1)
  }
})

test('default validated tool_choice falls back once to auto on HTTP 400 fetch error and strips server tool_search/defer_loading', async () => {
  const bodies = []
  const triggers = []
  const opts = {
    ...options(),
    tools: [
      { name: 'bash', description: 'run bash', parameters: { type: 'object', properties: {} } },
      { name: 'argon_inspect', description: 'inspect', shortDescription: 'inspect short', deferLoading: true, parameters: { type: 'object', properties: {} } },
    ],
  }
  const fallbackTransport = {
    create: async body => {
      bodies.push(body)
      if (bodies.length === 1) throw Object.assign(new Error('HTTP 400 INVALID_ARGUMENT'), { status: 400, phase: 'fetch', code: 'INVALID_ARGUMENT' })
      return stream([created, start(0, 'model_output'), delta(0, 'text', { text: 'auto-ok' }), stop(0), done()])
    },
    get: async () => assert.fail('unexpected get'),
    cancel: async () => ({ status: 'cancelled' }),
  }
  const out = await run([], {
    opts,
    settings: {
      route: 'google-generative-ai',
      interactionsToolRetrieval: 'explicit',
      transport: fallbackTransport,
      onCreateRetry: info => triggers.push(info.trigger),
    },
  })
  assert.equal(out.finish.reason.kind, 'stop')
  assert.equal(out.text, 'auto-ok')
  assert.equal(bodies.length, 2)
  assert.deepEqual(triggers, ['retry-original'])
  assert.equal(bodies[0].generation_config.tool_choice, 'validated')
  assert.equal(bodies[0].tools[0].type, 'tool_search')
  assert.equal(bodies[0].tools[2].defer_loading, true)
  assert.equal(bodies[0].tools[2].short_description, 'inspect short')
  assert.equal(bodies[1].generation_config.tool_choice, 'auto')
  assert.equal(bodies[1].tools.some(t => t.type === 'tool_search'), false)
  assert.equal(bodies[1].tools.some(t => 'defer_loading' in t || 'short_description' in t), false)

  // MODEL_NOT_FOUND 400 must NOT trigger validated->auto retry.
  let mnfCalls = 0
  const mnf = await run([], {
    opts,
    settings: {
      transport: {
        create: async () => { mnfCalls++; throw Object.assign(new Error('HTTP 400 MODEL_NOT_FOUND'), { status: 400, phase: 'fetch', code: 'MODEL_NOT_FOUND' }) },
        get: async () => assert.fail('unexpected get'),
        cancel: async () => ({ status: 'cancelled' }),
      },
    },
  })
  assert.equal(mnf.finish.reason.kind, 'error')
  assert.equal(mnfCalls, 1)

  // Explicit options.toolChoice:'validated' must NOT silently downgrade.
  let explicitCalls = 0
  const explicit = await run([], {
    opts: { ...opts, toolChoice: 'validated' },
    settings: {
      transport: {
        create: async () => { explicitCalls++; throw Object.assign(new Error('HTTP 400'), { status: 400, phase: 'fetch', code: 'INVALID_ARGUMENT' }) },
        get: async () => assert.fail('unexpected get'),
        cancel: async () => ({ status: 'cancelled' }),
      },
    },
  })
  assert.equal(explicit.finish.reason.kind, 'error')
  assert.equal(explicitCalls, 1)
})

test('server-side steps (tool_search_*, processing_*) and multimodal content blocks stay silent to host and roundtrip verbatim in replaySteps with cursor rollback', async () => {
  const initial = [
    { ...created, event_id: 's1' },
    { ...start(0, 'thought', { summary: [{ type: 'text', text: 'Need tool ' }, { type: 'image', uri: 'https://example.invalid/thought.png', mime_type: 'image/png' }] }), event_id: 's2' },
    { ...delta(0, 'thought_signature', { signature: 'sig-thought' }), event_id: 's3' },
    { ...stop(0), event_id: 's4' },
    { ...start(1, 'tool_search_call', { id: 'ts-1', arguments: { function_names: ['alpha'] } }), event_id: 's5' },
    delta(1, 'tool_search_call', { arguments: { function_names: ['stale-unindexed'] } }),
    new Error('drop'),
  ]
  const reconnect = [
    { ...delta(1, 'tool_search_call', { arguments: { function_names: ['beta'] }, signature: 'sig-ts-call' }), event_id: 's6' },
    { ...stop(1), event_id: 's7' },
    { ...start(2, 'tool_search_result', { call_id: 'ts-1', result: [{ type: 'function', name: 'alpha' }] }), event_id: 's8' },
    { ...delta(2, 'tool_search_result', { result: [{ type: 'function', name: 'beta' }], signature: 'sig-ts-res' }), event_id: 's9' },
    { ...stop(2), event_id: 's10' },
    { ...start(3, 'processing_call', { id: 'proc-1' }), event_id: 's11' },
    { ...delta(3, 'processing_call', { signature: 'sig-proc-call' }), event_id: 's12' },
    { ...stop(3), event_id: 's13' },
    { ...start(4, 'processing_result', { call_id: 'proc-1', signature: 'sig-proc-res' }), event_id: 's14' },
    { ...stop(4), event_id: 's15' },
    { ...start(5, 'model_output', { content: [{ type: 'text', text: 'Here: ' }, { type: 'image', data: 'AQID', mime_type: 'image/png' }] }), event_id: 's16' },
    { ...delta(5, 'audio', { uri: 'https://example.invalid/a.mp3', mime_type: 'audio/mpeg' }), event_id: 's17' },
    { ...delta(5, 'text', { text: 'done.' }), event_id: 's18' },
    { ...stop(5), event_id: 's19' },
    { ...start(6, 'function_call', { id: 'fn-1', name: 'add', arguments: { a: 7 } }), event_id: 's20' },
    { ...stop(6), event_id: 's21' },
    { ...done('requires_action'), event_id: 's22' },
  ]
  const out = await run(initial, { settings: { store: true }, reconnect })
  assert.equal(out.finish.reason.kind, 'tool-calls')
  assert.equal(out.text, 'Here: done.')
  // Only the local function_call is emitted as a tool-call block; never tool_search_call/processing_call.
  const toolBlocks = out.blocks.filter(b => b.type === 'tool-call')
  assert.equal(toolBlocks.length, 1)
  assert.equal(toolBlocks[0].id, 'fn-1')
  const steps = out.finish.replayState.response.steps
  assert.deepEqual(steps.map(s => s.type), [
    'thought', 'tool_search_call', 'tool_search_result',
    'processing_call', 'processing_result', 'model_output', 'function_call',
  ])
  assert.deepEqual(steps[0].summary, [{ type: 'text', text: 'Need tool ' }, { type: 'image', uri: 'https://example.invalid/thought.png', mime_type: 'image/png' }])
  assert.equal(steps[0].signature, 'sig-thought')
  // Unindexed stale delta ('stale-unindexed') was rolled back on reconnect!
  assert.deepEqual(steps[1], { type: 'tool_search_call', id: 'ts-1', arguments: { function_names: ['alpha', 'beta'] }, signature: 'sig-ts-call' })
  assert.deepEqual(steps[2], { type: 'tool_search_result', call_id: 'ts-1', result: [{ type: 'function', name: 'alpha' }, { type: 'function', name: 'beta' }], signature: 'sig-ts-res' })
  assert.deepEqual(steps[3], { type: 'processing_call', id: 'proc-1', signature: 'sig-proc-call' })
  assert.deepEqual(steps[4], { type: 'processing_result', call_id: 'proc-1', signature: 'sig-proc-res' })
  assert.deepEqual(steps[5], {
    type: 'model_output',
    content: [
      { type: 'text', text: 'Here: ' },
      { type: 'image', data: 'AQID', mime_type: 'image/png' },
      { type: 'audio', uri: 'https://example.invalid/a.mp3', mime_type: 'audio/mpeg' },
      { type: 'text', text: 'done.' },
    ],
  })

  // Missing required id/call_id on server-side steps fails closed.
  const missingId = await run([created, start(0, 'tool_search_call', { arguments: { function_names: ['x'] } }), stop(0), done()])
  assert.equal(missingId.finish.reason.kind, 'error')
  assert.equal(missingId.finish.reason.failure.code, 'ARGON_INTERACTIONS_PROTOCOL')
  const missingCallId = await run([created, start(0, 'processing_result'), stop(0), done()])
  assert.equal(missingCallId.finish.reason.kind, 'error')
  assert.equal(missingCallId.finish.reason.failure.code, 'ARGON_INTERACTIONS_PROTOCOL')
})

test('P1-1 & P1-2: background create waits for durable ID settlement on shutdown, and background GET aborts underlying signal on phase timeout', async () => {
  const { createInteractionStateHub, durableInteractionTransport } = await import('../interaction-state.js')

  // P1-1: host shutdown while background create is in-flight must wait until ID is persisted before releasing claim / closing storage.
  const rows1 = new Map()
  let domainClosed = false
  const hub1 = createInteractionStateHub()
  hub1.attach({
    table: () => ({
      get: k => rows1.get(k),
      get size() { return rows1.size },
      entries: () => rows1.entries(),
      put: async (k, v) => { if (domainClosed) throw new Error('domain already closed'); rows1.set(k, v) },
      delete: async k => rows1.delete(k),
    }),
    close: async () => { domainClosed = true },
  })
  const id1 = hub1.identity({ sessionId: 's-p1-1', endpoint: 'https://example.test/interactions', principalHash: 'a'.repeat(64), body: { input: 'x' } })
  const reqCtrl = new AbortController()
  const claim = hub1.claim(id1.key, reqCtrl, id1.sessionHash)
  let createSettled = false
  const base1 = {
    create: async () => (async function* () {
      await sleep(80)
      createSettled = true
      yield { event_type: 'interaction.created', interaction: { id: 'remote-late', status: 'in_progress' } }
    })(),
    get: async () => stream([]),
    cancel: async () => ({ status: 'cancelled' }),
  }
  const durable1 = durableInteractionTransport(base1, hub1, id1, { signal: reqCtrl.signal })
  const runPromise = (async () => {
    const out = []
    try {
      for await (const c of streamInteractions({ ...options(), signal: reqCtrl.signal }, {
        route: 'google-generative-ai',
        background: true,
        store: true,
        transport: durable1,
        reconnectBackoff: { initialDelayMs: 0 },
      })) out.push(c)
    } finally {
      claim.release()
    }
    return out
  })()
  await sleep(15)
  const closePromise = hub1.close()
  const out1 = await runPromise
  await closePromise
  assert.equal(createSettled, true)
  assert.equal(domainClosed, true)
  assert.equal(rows1.get(id1.key)?.interactionId, 'remote-late')
  assert.equal(rows1.get(id1.key)?.stage, 'accepted')
  assert.equal(out1.at(-1).reason.kind, 'aborted')

  // P1-2: stalled first background GET aborts its underlying AbortSignal on STREAM_PHASE_TIMEOUT and recovers on second GET.
  const rows2 = new Map()
  const hub2 = createInteractionStateHub()
  hub2.attach({
    table: () => ({
      get: k => rows2.get(k),
      get size() { return rows2.size },
      entries: () => rows2.entries(),
      put: async (k, v) => rows2.set(k, v),
      delete: async k => rows2.delete(k),
    }),
    close: async () => {},
  })
  const id2 = hub2.identity({ sessionId: 's-p1-2', endpoint: 'https://example.test/interactions', principalHash: 'b'.repeat(64), body: { input: 'y' } })
  const getSignals = []
  let getCount = 0
  const base2 = {
    create: async () => stream([{ event_type: 'interaction.created', interaction: { id: 'remote-bg', status: 'in_progress' } }]),
    get: async (_id, reqOpts) => {
      getSignals.push(reqOpts?.signal)
      if (++getCount === 1) {
        return (async function* () {
          await new Promise((_, reject) => reqOpts.signal?.addEventListener('abort', () => reject(reqOpts.signal.reason), { once: true }))
        })()
      }
      return stream([
        { ...start(0, 'model_output'), event_id: 'bg-1' },
        { ...delta(0, 'text', { text: 'bg-ok' }), event_id: 'bg-2' },
        { ...stop(0), event_id: 'bg-3' },
        { event_type: 'interaction.completed', event_id: 'bg-4', interaction: { id: 'remote-bg', status: 'completed' } },
      ])
    },
    cancel: async () => ({ status: 'cancelled' }),
  }
  const durable2 = durableInteractionTransport(base2, hub2, id2)
  const out2 = await run([], {
    settings: {
      store: true,
      background: true,
      transport: durable2,
      phaseTimeouts: { initialTtft: 35, thinking: 35, transition: 35, streaming: 35 },
    },
  })
  assert.equal(out2.finish.reason.kind, 'stop')
  assert.equal(out2.text, 'bg-ok')
  assert.equal(getCount, 2)
  assert.ok(getSignals[0] instanceof AbortSignal)
  assert.equal(getSignals[0].aborted, true)
  await durable2.finish({ complete: true, reason: 'completed' })
  await hub2.close()
})

test('P1-3: captureSnapshot stays linear across 4000 indexed deltas and preserves immutable rollback semantics', async () => {
  const count = 4000
  const chunkText = 'a'.repeat(400)
  const events = [
    { ...created, event_id: 'e-init' },
    { ...start(0, 'model_output'), event_id: 'e-start' },
  ]
  for (let i = 0; i < count; i++) {
    events.push({ ...delta(0, 'text', { text: chunkText }), event_id: 'e-' + i })
  }
  events.push({ ...stop(0), event_id: 'e-stop' }, { ...done(), event_id: 'e-done' })
  const startedAt = performance.now()
  const out = await run(events, { settings: { store: true } })
  const elapsedMs = performance.now() - startedAt
  assert.equal(out.finish.reason.kind, 'stop')
  assert.equal(out.text.length, count * chunkText.length)
  assert.equal(out.finish.replayState.response.steps[0].content[0].text.length, count * chunkText.length)
  assert.ok(elapsedMs < 800, `Expected linear snapshot performance (<800ms), got ${elapsedMs.toFixed(1)}ms`)

  // Verify immutable contents snapshot still rolls back an unindexed thought summary text delta cleanly.
  const rolled = await run([
    { ...created, event_id: 'r0' },
    { ...start(0, 'thought'), event_id: 'r1' },
    { ...delta(0, 'thought_summary', { content: { type: 'text', text: 'A' } }), event_id: 'r2' },
    { ...start(1, 'function_call', { id: 'fc1', name: 'add' }), event_id: 'r3' },
    delta(1, 'arguments_delta', { arguments: '{"a":999' }),
    new Error('drop'),
  ], {
    settings: { store: true },
    reconnect: [
      { ...delta(1, 'arguments_delta', { arguments: '{"a":1}' }), event_id: 'r4' },
      { ...stop(1), event_id: 'r5' },
      { ...stop(0), event_id: 'r6' },
      { ...done('requires_action'), event_id: 'r7' },
    ],
  })
  assert.equal(rolled.finish.reason.kind, 'tool-calls')
  assert.equal(rolled.finish.replayState.response.steps[0].summary[0].text, 'A')
  assert.equal(rolled.blocks.find(b => b.type === 'tool-call').arguments, '{"a":1}')
})

test('P1-1: authoritative terminal event (requires_action) finalizes immediately even if stream hangs or drops after it', async () => {
  for (const postTerminal of ['hang', 'drop']) {
    let creates = 0, closed = false
    const transport = {
      create: async () => {
        creates++
        return (async function* () {
          try {
            yield created
            yield start(0, 'function_call', { id: 'fc-term', name: 'add', arguments: { a: 9 } })
            yield stop(0)
            yield event('interaction.requires_action', { interaction: { id: 'remote-1', status: 'requires_action' } })
            if (postTerminal === 'hang') await new Promise(() => {})
            throw Object.assign(new Error('late reset'), { code: 'ECONNRESET', phase: 'stream' })
          } finally {
            closed = true
          }
        })()
      },
      get: async () => assert.fail('must not reconnect after terminal event'),
      cancel: async () => assert.fail('must not cancel after terminal event'),
    }
    const out = await run([], {
      settings: {
        store: false,
        background: false,
        transport,
        phaseTimeouts: { initialTtft: 40, thinking: 40, transition: 40, streaming: 40 },
      },
    })
    assert.equal(creates, 1)
    assert.equal(closed, true)
    assert.equal(out.finish.reason.kind, 'tool-calls')
    assert.equal(out.blocks.find(b => b.type === 'tool-call').arguments, '{"a":9}')
  }
})

test('P1-3, P1-7, P1-8, P1-9: watchdog requires genuine state progress, store:false skips snapshots & never retries after SSE receipt or permanent/pre-dispatch/TLS errors', async () => {
  // P1-3: Repeated identical tool_search_call / function_call deltas do NOT refresh watchdog budget.
  let repeatCreates = 0
  const repeatTransport = {
    create: async (_body, { signal }) => {
      repeatCreates++
      return (async function* () {
        yield created
        yield start(0, 'tool_search_call', { id: 'ts-rep', arguments: { function_names: ['alpha'] } })
        for (let i = 0; i < 12; i++) {
          await sleep(12)
          if (signal?.aborted) throw signal.reason
          yield delta(0, 'tool_search_call', { id: 'ts-rep', arguments: { function_names: ['alpha'] } })
        }
        yield stop(0)
        yield done()
      })()
    },
    get: async () => assert.fail('unexpected get'),
    cancel: async () => ({ status: 'cancelled' }),
  }
  const repOut = await run([], {
    settings: {
      store: false,
      background: false,
      transport: repeatTransport,
      phaseTimeouts: { initialTtft: 40, thinking: 40, transition: 40, streaming: 40 },
    },
  })
  assert.equal(repeatCreates, 1)
  assert.equal(repOut.finish.reason.kind, 'error')
  assert.equal(repOut.finish.reason.failure.code, 'STREAM_PHASE_TIMEOUT')

  // P1-7: store:false never invokes captureSnapshot even when events carry event_id.
  let snapCalls = 0
  const noSnapOut = await run([
    { ...created, event_id: 'ns-1' },
    { ...start(0, 'model_output'), event_id: 'ns-2' },
    { ...delta(0, 'text', { text: 'ok' }), event_id: 'ns-3' },
    { ...stop(0), event_id: 'ns-4' },
    { ...done(), event_id: 'ns-5' },
  ], { settings: { store: false, onCaptureSnapshot: () => { snapCalls++; return {} } } })
  assert.equal(noSnapOut.finish.reason.kind, 'stop')
  assert.equal(snapCalls, 0)

  // P1-9: store:false MUST NOT retry POST once any SSE event (e.g. interaction.created) has arrived.
  let postCreatedAttempts = 0
  const postCreatedDrop = await run([], {
    settings: {
      store: false,
      background: false,
      transport: {
        create: async () => {
          postCreatedAttempts++
          return (async function* () {
            yield created
            throw Object.assign(new Error('mid-stream reset'), { code: 'ECONNRESET', phase: 'stream', status: 200 })
          })()
        },
        get: async () => assert.fail('unexpected get'),
        cancel: async () => ({ status: 'cancelled' }),
      },
    },
  })
  assert.equal(postCreatedAttempts, 1)
  assert.equal(postCreatedDrop.finish.reason.kind, 'error')

  // P1-9: pre-dispatch, requestSubmitted:false, permanent TLS errors, and uncoded errors are NEVER retried.
  for (const permanentErr of [
    Object.assign(new Error('auth failed'), { phase: 'pre-dispatch', requestSubmitted: false, code: 'ECONNRESET' }),
    Object.assign(new Error('cert expired'), { code: 'CERT_HAS_EXPIRED', phase: 'fetch' }),
    Object.assign(new Error('self signed'), { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' }, phase: 'fetch' }),
    Object.assign(new Error('ssl err'), { code: 'ERR_SSL_WRONG_VERSION_NUMBER', phase: 'fetch' }),
    Object.assign(new Error('proxy tls'), { code: 'UND_ERR_PRX_TLS', phase: 'fetch' }),
    new Error('uncoded non-network failure'),
  ]) {
    let tries = 0
    const res = await run([], {
      settings: {
        store: false,
        background: false,
        transport: {
          create: async () => { tries++; throw permanentErr },
          get: async () => assert.fail('unexpected get'),
          cancel: async () => ({ status: 'cancelled' }),
        },
      },
    })
    assert.equal(res.finish.reason.kind, 'error')
    assert.equal(tries, 1, `Should not retry: ${permanentErr.message}`)
  }

  // P1-8: validated->auto 400 fallback ONLY fires on connections === 1 && phase === 'fetch', and checks dual upstreamCodes for MODEL_NOT_FOUND.
  let secondAttempt400Calls = 0
  const afterRetry400 = await run([], {
    settings: {
      store: false,
      background: false,
      transport: {
        create: async () => {
          secondAttempt400Calls++
          if (secondAttempt400Calls === 1) throw Object.assign(new Error('503'), { status: 503, phase: 'fetch' })
          throw Object.assign(new Error('400'), { status: 400, phase: 'fetch', code: 'INVALID_REQUEST' })
        },
        get: async () => assert.fail('unexpected get'),
        cancel: async () => ({ status: 'cancelled' }),
      },
    },
  })
  assert.equal(afterRetry400.finish.reason.kind, 'error')
  assert.equal(secondAttempt400Calls, 2)

  let nonFetch400Calls = 0
  const nonFetch400 = await run([], {
    settings: {
      store: false,
      background: false,
      transport: {
        create: async () => { nonFetch400Calls++; throw Object.assign(new Error('400'), { status: 400, phase: 'response-body' }) },
        get: async () => assert.fail('unexpected get'),
        cancel: async () => ({ status: 'cancelled' }),
      },
    },
  })
  assert.equal(nonFetch400.finish.reason.kind, 'error')
  assert.equal(nonFetch400Calls, 1)

  let dualMnfCalls = 0
  const dualMnf = await run([], {
    settings: {
      store: false,
      background: false,
      transport: {
        create: async () => { dualMnfCalls++; throw Object.assign(new Error('400'), { status: 400, phase: 'fetch', code: 'INVALID_REQUEST', upstreamCode: 'FAILED_PRECONDITION', upstreamCodes: ['FAILED_PRECONDITION', 'MODEL_NOT_FOUND'] }) },
        get: async () => assert.fail('unexpected get'),
        cancel: async () => ({ status: 'cancelled' }),
      },
    },
  })
  assert.equal(dualMnf.finish.reason.kind, 'error')
  assert.equal(dualMnfCalls, 1)
})

test('generator suspended at yield during host shutdown .return() reports host-shutdown without sending /cancel and retains background handle', async () => {
  const { createInteractionStateHub, durableInteractionTransport } = await import('../interaction-state.js')
  const { HOST_SHUTDOWN_CODE } = await import('../interaction-lifecycle.js')
  const rows = new Map()
  const hub = createInteractionStateHub()
  hub.attach({
    table: () => ({
      get: k => rows.get(k),
      get size() { return rows.size },
      entries: () => rows.entries(),
      put: async (k, v) => rows.set(k, v),
      delete: async k => rows.delete(k),
    }),
    close: async () => {},
  })
  const identity = hub.identity({ sessionId: 's-yield-shutdown', endpoint: 'https://example.test/interactions', principalHash: 'c'.repeat(64), body: { input: 'z' } })
  const controller = new AbortController()
  let cancels = 0, exitReason
  const base = {
    create: async () => stream([{ event_type: 'interaction.created', interaction: { id: 'remote-yield', status: 'in_progress' } }]),
    get: async () => stream([
      { ...start(0, 'model_output'), event_id: 'y1' },
      { ...delta(0, 'text', { text: 'part-1' }), event_id: 'y2' },
      { ...delta(0, 'text', { text: 'part-2' }), event_id: 'y3' },
    ]),
    cancel: async () => { cancels++; return { status: 'cancelled' } },
  }
  const durable = durableInteractionTransport(base, hub, identity, { signal: controller.signal })
  const gen = streamInteractions({ ...options(), signal: controller.signal }, {
    route: 'google-generative-ai',
    background: true,
    store: true,
    transport: durable,
    reconnectBackoff: { initialDelayMs: 0 },
    onExit: reason => { exitReason = reason },
  })
  // Advance until the generator is paused right on a yielded chunk (before stream end).
  const first = await gen.next()
  assert.equal(first.done, false)
  // Simulate host shutdown abort followed immediately by consumer .return() while paused at yield.
  controller.abort(Object.assign(new Error('Host shutdown'), { name: 'AbortError', code: HOST_SHUTDOWN_CODE }))
  await gen.return()
  await durable.finish({ complete: false, reason: exitReason })
  assert.equal(exitReason, 'host-shutdown')
  assert.equal(cancels, 0)
  assert.equal(rows.size, 1)
  assert.equal(rows.get(identity.key)?.interactionId, 'remote-yield')
  await hub.close()
})

test('in-stream transient error codes (service_unavailable, too_many_requests, rate_limit_exceeded, quota_exceeded) are classified as recoverable without cancelling remote task', async () => {
  const {
    isRecoverableStreamErrorCode,
    interactionExitReason,
    cancelsRemoteInteraction,
  } = await import('../interaction-lifecycle.js')
  const { createInteractionStateHub, durableInteractionTransport } = await import('../interaction-state.js')

  for (const code of ['service_unavailable', 'SERVICE_UNAVAILABLE', 'too_many_requests', 'rate_limit_exceeded', 'quota_exceeded']) {
    assert.equal(isRecoverableStreamErrorCode(code), true, `${code} must be recoverable`)
  }
  for (const code of ['UNAUTHENTICATED', 'invalid_request', 'model_not_found', 'permission_denied']) {
    assert.equal(isRecoverableStreamErrorCode(code), false, `${code} must remain non-recoverable`)
  }

  const recoverableErr = Object.assign(new Error('Interactions returned an error event (service_unavailable).'), {
    code: 'ARGON_INTERACTIONS_PROTOCOL',
    recoverableStreamError: true,
  })
  assert.equal(recoverableErr.remoteTerminalError, undefined)
  assert.equal(interactionExitReason(recoverableErr), 'read-interrupted')
  assert.equal(cancelsRemoteInteraction(interactionExitReason(recoverableErr)), false)

  // 1) Stored background stream receiving { type: 'error', error: { code: 'service_unavailable' } } reconnects via GET without duplicating POST or cancelling.
  let okExitReason
  const recovered = await run(
    [
      { ...created, event_id: 'su-1' },
      { ...start(0, 'model_output'), event_id: 'su-2' },
      { ...delta(0, 'text', { text: 'part-A' }), event_id: 'su-3' },
      { type: 'error', event_id: 'su-4', error: { code: 'service_unavailable', message: 'backend busy' } },
    ],
    {
      settings: { store: true, background: true, onExit: reason => { okExitReason = reason } },
      reconnect: [
        { ...delta(0, 'text', { text: 'part-B' }), event_id: 'su-5' },
        { ...stop(0), event_id: 'su-6' },
        { ...done(), event_id: 'su-7' },
      ],
    },
  )
  assert.equal(recovered.text, 'part-Apart-B')
  assert.equal(recovered.finish.reason.kind, 'stop')
  assert.equal(okExitReason, 'completed')
  assert.equal(recovered.calls.filter(c => c.method === 'create').length, 1)
  assert.equal(recovered.calls.filter(c => c.method === 'get').length, 1)
  assert.equal(recovered.calls.filter(c => c.method === 'cancel').length, 0)

  // 2) Repeated service_unavailable exhausting retries exits with read-interrupted (not protocol-error or remote-error), never cancels, and retains background handle.
  const rows = new Map()
  const hub = createInteractionStateHub()
  hub.attach({
    table: () => ({
      get: k => rows.get(k),
      get size() { return rows.size },
      entries: () => rows.entries(),
      put: async (k, v) => rows.set(k, v),
      delete: async k => rows.delete(k),
    }),
    close: async () => {},
  })
  try {
    const identity = hub.identity({ sessionId: 's-su-exhaust', endpoint: 'https://example.test/interactions', principalHash: 'd'.repeat(64), body: { input: 'su' } })
    let cancels = 0, probes = 0, gets = 0, exhaustExit
    const base = {
      create: async () => stream([{ ...created, event_id: 'sue-1' }]),
      get: async (_id, reqOpts) => {
        if (!reqOpts?.stream) { probes++; return { id: 'remote-1', status: 'failed' } }
        gets++
        return stream([{ type: 'error', event_id: `sue-r${gets}`, error: { code: 'service_unavailable' } }])
      },
      cancel: async () => { cancels++; return { status: 'cancelled' } },
    }
    const durable = durableInteractionTransport(base, hub, identity)
    const chunks = []
    for await (const chunk of streamInteractions(options(), {
      route: 'google-generative-ai',
      background: true,
      store: true,
      transport: durable,
      reconnectBackoff: { initialDelayMs: 0 },
      onExit: reason => { exhaustExit = reason },
    })) chunks.push(chunk)
    await durable.finish({ complete: false, reason: exhaustExit })
    assert.equal(exhaustExit, 'read-interrupted')
    assert.equal(chunks.at(-1).reason.kind, 'error')
    assert.equal(chunks.at(-1).reason.failure.code, 'ARGON_BACKGROUND_READ_INTERRUPTED')
    assert.equal(cancels, 0)
    assert.equal(probes, 0)
    // 1 initial durable GET stream + 3 reconnect GET attempts before exhaustion
    assert.equal(gets, 4)
    assert.equal(rows.size, 1)
    assert.equal(rows.get(identity.key)?.interactionId, 'remote-1')
  } finally {
    await hub.close()
  }

  // 3) Stateless stream receiving { type: 'error', error: { code: 'service_unavailable' } } exits read-interrupted without repeating POST.
  let statelessExit
  const stateless = await run(
    [
      { ...created, event_id: 'ss-1' },
      { type: 'error', error: { code: 'service_unavailable' } },
    ],
    { settings: { store: false, background: false, onExit: reason => { statelessExit = reason } } },
  )
  assert.equal(stateless.finish.reason.kind, 'error')
  assert.equal(statelessExit, 'read-interrupted')
  assert.equal(stateless.calls.filter(c => c.method === 'create').length, 1)
  assert.equal(stateless.calls.filter(c => c.method === 'cancel').length, 0)

  // 4) Related transient rate/quota codes also reconnect cleanly on stored streams.
  for (const code of ['too_many_requests', 'rate_limit_exceeded', 'quota_exceeded']) {
    const out = await run(
      [
        { ...created, event_id: `${code}-1` },
        { ...start(0, 'model_output'), event_id: `${code}-2` },
        { ...delta(0, 'text', { text: 'X' }), event_id: `${code}-3` },
        { type: 'error', event_id: `${code}-4`, error: { code } },
      ],
      {
        settings: { store: true, background: true },
        reconnect: [
          { ...delta(0, 'text', { text: 'Y' }), event_id: `${code}-5` },
          { ...stop(0), event_id: `${code}-6` },
          { ...done(), event_id: `${code}-7` },
        ],
      },
    )
    assert.equal(out.text, 'XY', `${code} should reconnect and finish`)
    assert.equal(out.finish.reason.kind, 'stop')
    assert.equal(out.calls.filter(c => c.method === 'cancel').length, 0)
  }
})

