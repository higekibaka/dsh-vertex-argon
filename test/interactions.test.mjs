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

