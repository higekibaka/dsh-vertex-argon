import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createInteractionStateHub, durableInteractionTransport, interactionStateDomain } from '../interaction-state.js'
import { createInteractionsTransport } from '../interaction-transport.js'
import { streamInteractions } from '../interactions.js'
import { createServer } from 'node:http'
function fixture() {
  const rows = new Map()
  const domain = { table: () => ({ get: k => rows.get(k), get size() { return rows.size }, entries: () => rows.entries(), put: async (k,v) => { interactionStateDomain.tables.tasks.valueSchema.parse(v); rows.set(k,v) }, delete: async k => rows.delete(k) }), close: async () => {} }
  const hub = createInteractionStateHub(); hub.attach(domain)
  const identity = hub.identity({ sessionId: 'session', endpoint: 'https://example.test/interactions', principalHash: '1'.repeat(64), body: { input: 'PRIVATE_PROMPT' } })
  return { rows, domain, hub, identity }
}
const events = list => (async function* () { for (const item of list) yield item })()
const collect = async stream => { const out=[]; for await (const e of stream) out.push(e); return out }
test('writes intent and ID durably before consuming background output', async () => {
  const { rows, hub, identity } = fixture(); let created = 0, gets = 0, postClosed = false
  const base = {
    create: async body => { created++; assert.equal(rows.get(identity.key).stage, 'creating'); assert.equal(body.stream, true); return (async function* () { try { yield {event_type:'interaction.created',interaction:{id:'remote',status:'in_progress'}}; assert.fail('creation deltas must not be consumed') } finally { postClosed=true } })() },
    get: async (id, options) => { gets++; assert.equal(postClosed,true); assert.equal(rows.get(identity.key).interactionId,id); assert.equal(options.last_event_id,undefined); return events([{event_type:'step.delta',event_id:'e1'},{event_type:'interaction.completed',interaction:{id,status:'completed'}}]) },
  }
  const t = durableInteractionTransport(base, hub, identity)
  await collect(await t.create({ stream:true }))
  assert.equal(rows.get(identity.key).lastEventId, 'e1')
  assert.ok(!JSON.stringify([...rows.values()]).includes('PRIVATE_PROMPT'))
  await t.finish({ complete: true, reason: 'completed' })
  assert.equal(rows.size, 0); assert.equal(created, 1); assert.equal(gets, 1)
})
test('cold resume uses saved ID, replays all events, and never repeats POST', async () => {
  const { hub, identity, rows } = fixture()
  await hub.put(identity, { stage:'accepted', interactionId:'old', lastEventId:'e17' })
  const base = { create: async () => assert.fail('duplicate POST'), get: async (id, options) => { assert.equal(id,'old'); assert.equal(options.last_event_id,undefined); return events([{event_id:'e18',event_type:'interaction.completed',interaction:{id,status:'completed'}}]) } }
  const t = durableInteractionTransport(base, hub, identity)
  const out = await collect(await t.create({stream:true}))
  assert.equal(out[0].interaction.id,'old')
  await t.finish({ complete: true, reason: 'completed' }); assert.equal(rows.size,0)
})
test('unknown create outcome blocks automatic resubmission across restarts', async () => {
  const { hub, identity, rows } = fixture(); let count = 0
  const base = { create: async () => {count++; throw new Error('lost ack')} }
  await assert.rejects(durableInteractionTransport(base,hub,identity).create({}), /lost ack/)
  assert.equal(rows.get(identity.key).stage,'unknown')
  await assert.rejects(durableInteractionTransport(base,hub,identity).create({}), /duplicate billable POST/)
  assert.equal(count,1)
})
test('local pre-dispatch authentication failure clears the intent safely', async () => {
  const {hub,identity,rows}=fixture()
  await assert.rejects(durableInteractionTransport({create:async()=>{throw Object.assign(new Error('auth unavailable'),{requestSubmitted:false})}},hub,identity).create({}),/auth unavailable/)
  assert.equal(rows.size,0)
})
test('known API rejection clears intent', async () => {
  const { hub, identity, rows } = fixture()
  await assert.rejects(durableInteractionTransport({create:async()=>{throw Object.assign(new Error('bad request'),{status:400})}},hub,identity).create({}))
  assert.equal(rows.size,0)
})
test('Stop during create still captures ID and cancels without aborted signal', async () => {
  const { hub, identity, rows } = fixture(); const c = new AbortController(); let cancelled = 0
  const base = { create:async()=>{c.abort();return events([{event_type:'interaction.created',interaction:{id:'remote'}}])}, cancel:async(id,options)=>{assert.equal(id,'remote');assert.equal(options.signal.aborted,false);cancelled++;return {status:'cancelled'}} }
  const t = durableInteractionTransport(base,hub,identity,{signal:c.signal})
  await assert.rejects(t.create({}),{name:'AbortError'})
  assert.equal(cancelled,1);assert.equal(rows.size,0)
})
test('failed cancellation is attempted once per unwind and confirmation uses a bounded fresh signal', async () => {
  const {hub,identity}=fixture();await hub.put(identity,{stage:'accepted',interactionId:'remote'})
  let posts=0,gets=0,signal
  const t=durableInteractionTransport({cancel:async(_id,o)=>{posts++;signal=o.signal;return {status:'in_progress'}},get:async(_id,o)=>{gets++;assert.equal(o.signal,signal);throw new Error('offline')}},hub,identity)
  await assert.rejects(t.cancel('remote'),/offline/)
  await assert.rejects(t.finish({ complete: false, reason: 'user-stop' }),/offline/)
  assert.equal(posts,1);assert.equal(gets,1);assert.equal(signal.aborted,false)
})
test('failed cancellation remains recoverable rather than silently forgotten', async () => {
  const { hub, identity, rows } = fixture()
  await hub.put(identity,{stage:'accepted',interactionId:'remote'})
  const t = durableInteractionTransport({cancel:async()=>{throw new Error('network')}},hub,identity)
  await assert.rejects(t.finish({ complete: false, reason: 'user-stop' }),/network/)
  assert.equal(rows.get(identity.key).stage,'cancel-failed')
})
test('terminal remote results survive an incomplete local replay', async () => {
  const {hub,identity,rows}=fixture()
  await hub.put(identity,{stage:'accepted',interactionId:'remote'})
  const t=durableInteractionTransport({get:async()=>events([{event_type:'interaction.status_update',status:'completed',event_id:'done'}])},hub,identity)
  await collect(await t.create({}))
  await t.finish({ complete: false, reason: 'user-stop' })
  assert.equal(rows.get(identity.key).interactionId,'remote')
})
test('changing a prompt cannot evade an unknown-create marker', async () => {
  const {hub,identity}=fixture()
  await hub.put(identity,{stage:'unknown'})
  const changed=hub.identity({sessionId:'session',endpoint:'https://example.test/interactions',principalHash:'1'.repeat(64),body:{input:'changed'}})
  const t=durableInteractionTransport({create:async()=>assert.fail('duplicate paid creation')},hub,changed)
  await assert.rejects(t.create({}),/unknown-outcome/)
})
test('history, principal, endpoint and session changes cannot reuse old handles', () => {
  const { hub, identity } = fixture()
  const base = {sessionId:'session',endpoint:'https://example.test/interactions',principalHash:'1'.repeat(64),body:{input:'PRIVATE_PROMPT'}}
  for(const changes of [{sessionId:'fork'}, {body:{input:'compacted'}}, {principalHash:'2'.repeat(64)}, {endpoint:'https://other.test/interactions'}]) assert.notEqual(hub.identity({...base,...changes}).key,identity.key)
})
test('background requires ready durable storage and prevents concurrent consumers', async () => {
  assert.throws(()=>createInteractionStateHub().requireReady(),/unavailable/)
  const {hub,identity}=fixture();const lock=hub.claim(identity.key)
  assert.throws(()=>hub.claim(identity.key),/already/)
  lock.release();await hub.close()
})

test('explicit release preserves unknown audit evidence and creates no remote request', async () => {
  const {hub,identity,rows}=fixture()
  const original=await hub.put(identity,{stage:'unknown'})
  const input={key:identity.key,expectedUpdatedAt:original.updatedAt}
  await assert.rejects(hub.releaseUnknown({...input,acknowledgeRisk:false}),/acknowledgement/)
  await assert.rejects(hub.releaseUnknown({...input,expectedUpdatedAt:'2000-01-01T00:00:00.000Z',acknowledgeRisk:true}),/changed/)
  assert.deepEqual(rows.get(identity.key),original)
  const claim=hub.claim(identity.key,new AbortController(),identity.sessionHash)
  await assert.rejects(hub.releaseUnknown({...input,acknowledgeRisk:true}),/already/)
  claim.release()
  const released=await hub.releaseUnknown({...input,acknowledgeRisk:true})
  assert.equal(released.stage,'unknown');assert.equal(released.interactionId,null)
  assert.equal(released.uncertainAt,original.updatedAt);assert.ok(released.releasedAt)
  assert.equal(rows.size,1)
  const next=hub.identity({sessionId:'session',endpoint:'https://example.test/interactions',principalHash:'1'.repeat(64),body:{input:'PRIVATE_PROMPT'}})
  assert.notEqual(next.key,identity.key);assert.equal(next.requestKey,identity.key)
  let posts=0
  const transport=durableInteractionTransport({create:async()=>{posts++;return events([{event_type:'interaction.created',interaction:{id:'next'}}])},get:async()=>events([{event_type:'interaction.completed',interaction:{id:'next',status:'completed'}}])},hub,next)
  assert.equal(posts,0)
  await collect(await transport.create({}));await transport.finish({ complete: true, reason: 'completed' })
  assert.equal(posts,1);assert.equal(rows.size,1);assert.deepEqual(rows.get(identity.key),released)
})

test('records with an addressable remote task cannot use unknown-release acknowledgement',async()=>{
  const {hub,identity}=fixture()
  const row=await hub.put(identity,{stage:'accepted',interactionId:'remote'})
  await assert.rejects(hub.releaseUnknown({key:row.key,expectedUpdatedAt:row.updatedAt,acknowledgeRisk:true}),/without a remote ID/)
})

test('session claim excludes different request bodies before asynchronous persistence',async()=>{
  const {hub,identity}=fixture()
  const claim=hub.claim(identity.key,new AbortController(),identity.sessionHash)
  assert.throws(()=>hub.claim('a'.repeat(64),new AbortController(),identity.sessionHash),/already/)
  claim.release()
  hub.claim('a'.repeat(64),new AbortController(),identity.sessionHash).release()
})

test('Stop during pending authentication never sends a background POST or leaves an unknown record',async()=>{
  const {hub,identity,rows}=fixture(), c=new AbortController()
  let authStarted,posts=0
  const started=new Promise(resolve=>{authStarted=resolve})
  const base=createInteractionsTransport({endpoint:'https://example.test/interactions',getHeaders:()=>{authStarted();return new Promise(()=>{})},fetchImpl:async()=>{posts++;assert.fail('must not send')}})
  const pending=durableInteractionTransport(base,hub,identity,{signal:c.signal}).create({})
  await started;c.abort()
  await assert.rejects(pending,e=>e.name==='AbortError'&&e.requestSubmitted===false)
  assert.equal(posts,0);assert.equal(rows.size,0)
})

test('connection lost before created remains unknown and is not repeated by a fresh hub',async()=>{
  const {hub,identity,rows,domain}=fixture();let posts=0
  const base=createInteractionsTransport({endpoint:'https://example.test/interactions',getHeaders:async()=>({}),fetchImpl:async()=>{posts++;throw Object.assign(new Error('lost'),{code:'ECONNRESET'})}})
  await assert.rejects(durableInteractionTransport(base,hub,identity).create({}),e=>e.code==='ARGON_BACKGROUND_UNKNOWN')
  assert.equal(rows.get(identity.key).stage,'unknown')
  const fresh=createInteractionStateHub();fresh.attach(domain)
  await assert.rejects(durableInteractionTransport(base,fresh,identity).create({}),/duplicate billable POST/)
  const changed=fresh.identity({sessionId:'session',endpoint:'https://example.test/interactions',principalHash:'1'.repeat(64),body:{input:'changed'}})
  await assert.rejects(durableInteractionTransport(base,fresh,changed).create({}),/unknown-outcome/)
  assert.equal(posts,1)
})

test('EOF before the first created event remains unknown',async()=>{
  const {hub,identity,rows}=fixture()
  await assert.rejects(durableInteractionTransport({create:async()=>events([])},hub,identity).create({}),e=>e.code==='ARGON_BACKGROUND_UNKNOWN')
  assert.equal(rows.get(identity.key).interactionId,null);assert.equal(rows.get(identity.key).stage,'unknown')
})

test('ambiguous HTTP statuses retain the intent; explicit request rejections clear it',async()=>{
  for(const status of [400,401,402,403,404,405,413,415,422,429,408,409,499,500,503]){
    const {hub,identity,rows}=fixture()
    await assert.rejects(durableInteractionTransport({create:async()=>{throw Object.assign(new Error('rejected'),{status})}},hub,identity).create({}))
    assert.equal(rows.size,[408,409,499,500,503].includes(status)?1:0,String(status))
  }
})

test('shutdown keeps storage open beyond 35 seconds while a submitted create obtains its ID',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']})
  const {hub,identity,rows,domain}=fixture(), c=new AbortController()
  let resolveCreate,startedResolve,closed=false,cancels=0
  const started=new Promise(resolve=>{startedResolve=resolve})
  domain.close=async()=>{closed=true}
  const claim=hub.claim(identity.key,c,identity.sessionHash)
  const transport=durableInteractionTransport({create:async()=>{startedResolve();return new Promise(resolve=>{resolveCreate=resolve})},cancel:async()=>{cancels++;return{status:'cancelled'}}},hub,identity,{signal:c.signal})
  const pending=transport.create({}).catch(error=>error).finally(()=>claim.release())
  await started
  const closing=hub.close()
  t.mock.timers.tick(35001);await Promise.resolve();await Promise.resolve()
  assert.equal(closed,false)
  resolveCreate(events([{event_type:'interaction.created',interaction:{id:'late-id'}}]))
  assert.equal((await pending).name,'AbortError')
  t.mock.timers.tick(20);await closing
  assert.equal(closed,true);assert.equal(cancels,0);assert.equal(rows.size,1);assert.equal(rows.get(identity.key).interactionId,'late-id')
})

test('real loopback socket reset after server receives POST never creates a duplicate',async()=>{
  const {hub,identity,rows}=fixture();let posts=0
  const server=createServer((request,response)=>{request.resume();request.on('end',()=>{posts++;request.socket.destroy()})})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  try{
    const base=createInteractionsTransport({endpoint:'http://127.0.0.1:'+server.address().port+'/interactions',getHeaders:async()=>({})})
    await assert.rejects(durableInteractionTransport(base,hub,identity).create({input:'fixture'}),e=>e.code==='ARGON_BACKGROUND_UNKNOWN')
    await assert.rejects(durableInteractionTransport(base,hub,identity).create({input:'fixture'}),/duplicate billable POST/)
    assert.equal(posts,1);assert.equal(rows.get(identity.key).stage,'unknown')
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})

test('background output is read through GET after ID discovery, preserving thought summaries',async()=>{
  const {hub,identity,rows}=fixture();let posts=0,gets=0
  const created={event_type:'interaction.created',event_id:'e0',interaction:{id:'remote',status:'in_progress'}}
  const base={create:async()=>{posts++;return events([created])},get:async(id,options)=>{gets++;assert.equal(id,'remote');assert.equal(options.last_event_id,undefined);assert.equal(rows.get(identity.key).interactionId,id);return events([
    {event_type:'step.start',index:0,step:{type:'thought'}},{event_type:'step.delta',index:0,delta:{type:'thought_summary',content:{type:'text',text:'Summary'}}},{event_type:'step.stop',index:0},
    {event_type:'step.start',index:1,step:{type:'model_output'}},{event_type:'step.delta',index:1,delta:{type:'text',text:'Recovered'}},{event_type:'step.stop',index:1},{event_type:'interaction.completed',interaction:{id,status:'completed'}}])}}
  const durable=durableInteractionTransport(base,hub,identity)
  const chunks=await collect(streamInteractions({provider:'p',model:'gemini-4-argon-google',maxTokens:64,messages:[{role:'user',content:[{type:'text',text:'fixture'}]}]},{route:'google-generative-ai',background:true,store:true,transport:durable,reconnectBackoff:{initialDelayMs:0}}))
  assert.equal(chunks.at(-1).reason.kind,'stop');assert.equal(posts,1);assert.equal(gets,1)
  assert.equal(chunks.find(c=>c.type==='reasoning-delta').text,'Summary')
  assert.equal(chunks.find(c=>c.type==='text-delta').text,'Recovered')
  await durable.finish({ complete: true, reason: 'completed' });assert.equal(rows.size,0)
})


test('HTTP 200 GET stream reset after ID resumes through another GET, never another POST',async()=>{
  const {hub,identity,rows}=fixture();let posts=0,gets=0,responseToDrop
  const originalPut=hub.put.bind(hub)
  hub.put=async(...args)=>{const row=await originalPut(...args);if(row.lastEventId==='e2'&&responseToDrop){const res=responseToDrop;responseToDrop=undefined;setImmediate(()=>res.socket?.destroy())}return row}
  const created={event_type:'interaction.created',interaction:{id:'socket-task',status:'in_progress'}}
  const encode=event=>'data: '+JSON.stringify(event)+'\n\n'
  const server=createServer((request,response)=>{
    request.resume();request.on('end',()=>{
      response.writeHead(200,{'Content-Type':'text/event-stream'})
      if(request.method==='POST'){
        posts++
        response.write(encode(created)+encode({event_type:'step.start',index:99,step:{type:'model_output',content:[{type:'text',text:'NEVER_RENDER_CREATE_BODY'}]}}))
        return
      }
      gets++
      if(gets===1){
        assert.ok(!request.url.includes('last_event_id'))
        responseToDrop=response
        response.write([{...created,event_id:'e0'},{event_type:'step.start',event_id:'e1',index:0,step:{type:'model_output'}},{event_type:'step.delta',event_id:'e2',index:0,delta:{type:'text',text:'A'}}].map(encode).join(''))
        return
      }
      assert.ok(request.url.includes('last_event_id=e2'))
      response.end([{event_type:'step.delta',event_id:'e3',index:0,delta:{type:'text',text:'B'}},{event_type:'step.stop',event_id:'e4',index:0},{event_type:'interaction.completed',event_id:'e5',interaction:{id:'socket-task',status:'completed'}}].map(encode).join(''))
    })
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  try{
    const base=createInteractionsTransport({endpoint:'http://127.0.0.1:'+server.address().port+'/interactions',getHeaders:async()=>({})})
    const durable=durableInteractionTransport(base,hub,identity)
    const chunks=await collect(streamInteractions({provider:'p',model:'gemini-4-argon-google',maxTokens:64,messages:[{role:'user',content:[{type:'text',text:'fixture'}]}]},{route:'google-generative-ai',background:true,store:true,transport:durable,reconnectBackoff:{initialDelayMs:0}}))
    assert.equal(chunks.at(-1).reason.kind,'stop');assert.equal(posts,1);assert.equal(gets,2)
    assert.equal(chunks.filter(c=>c.type==='text-delta').map(c=>c.text).join(''),'AB')
    await durable.finish({ complete: true, reason: 'completed' });assert.equal(rows.size,0)
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})

test('bounded audit retention evicts only explicitly released attempts, never unresolved ones',async()=>{
  const {hub,identity,rows}=fixture()
  for(let i=1;i<=200;i++)await hub.put({...identity,key:i.toString(16).padStart(64,'0')},{stage:'unknown'})
  const next={...identity,key:'f'.repeat(64)}
  await assert.rejects(hub.put(next,{stage:'creating'}),/full/)
  const old=rows.values().next().value
  await hub.releaseUnknown({key:old.key,expectedUpdatedAt:old.updatedAt,acknowledgeRisk:true})
  await hub.put(next,{stage:'creating'})
  assert.equal(rows.size,200);assert.equal(rows.has(old.key),false)
  assert.equal([...rows.values()].filter(row=>row.stage==='unknown').length,199)
})


test('cursor-bearing GET recovery keeps thought signatures, tool arguments and usage exactly once',async()=>{
 const {hub,identity,rows}=fixture();let posts=0,gets=0,cancels=0,closed=false
 const created={event_type:'interaction.created',interaction:{id:'remote',status:'in_progress'}}
 const prefix=[{...created,event_id:'e0'},{event_type:'step.start',event_id:'e1',index:0,step:{type:'thought'}},{event_type:'step.delta',event_id:'e2',index:0,delta:{type:'thought_summary',content:{type:'text',text:'Summary'}}},{event_type:'step.delta',event_id:'e3',index:0,delta:{type:'thought_signature',signature:'signed'}},{event_type:'step.stop',event_id:'e4',index:0},{event_type:'step.start',event_id:'e5',index:1,step:{type:'function_call',id:'call',name:'add'}},{event_type:'step.delta',event_id:'e6',index:1,delta:{type:'arguments_delta',arguments:'{"a":'}}]
 const base={create:async()=>{posts++;return(async function*(){try{yield created;assert.fail('POST output must not be consumed')}finally{closed=true}})()},get:async(id,options)=>{
   assert.equal(closed,true);assert.equal(id,'remote');gets++
   if(gets===1){assert.equal(options.last_event_id,undefined);return(async function*(){yield*prefix;throw Object.assign(new Error('socket'),{status:200,phase:'stream',code:'UND_ERR_SOCKET'})})()}
   assert.equal(options.last_event_id,'e6')
   return events([prefix.at(-1),{event_type:'step.delta',event_id:'e7',index:1,delta:{type:'arguments_delta',arguments:'17}'}},{event_type:'step.stop',event_id:'e8',index:1},{event_type:'interaction.completed',event_id:'e9',interaction:{id,status:'requires_action',usage:{total_input_tokens:12,total_output_tokens:5,total_thought_tokens:7,total_tokens:24}}}])
 },cancel:async()=>{cancels++;return{status:'cancelled'}}}
 const durable=durableInteractionTransport(base,hub,identity)
 const opts={provider:'p',model:'gemini-4-argon-google',maxTokens:64,messages:[{role:'user',content:[{type:'text',text:'fixture'}]}],tools:[{name:'add',description:'fixture',parameters:{type:'object',properties:{a:{type:'number'}}}}]}
 const chunks=await collect(streamInteractions(opts,{route:'google-generative-ai',background:true,store:true,transport:durable,reconnectBackoff:{initialDelayMs:0}}))
 assert.equal(posts,1);assert.equal(gets,2);assert.equal(cancels,0)
 assert.equal(chunks.at(-1).reason.kind,'tool-calls')
 assert.equal(chunks.filter(c=>c.type==='reasoning-delta').map(c=>c.text).join(''),'Summary')
 const tools=chunks.filter(c=>c.type==='block-end'&&c.block.type==='tool-call')
 assert.equal(tools.length,1);assert.equal(tools[0].block.arguments,'{"a":17}')
 assert.equal(chunks.at(-1).replayState.response.steps[0].signature,'signed')
 assert.deepEqual(chunks.filter(c=>c.type==='usage').map(c=>c.usage.totalTokens),[24])
 await durable.finish({ complete: true, reason: 'completed' });assert.equal(rows.size,0)
})

test('an already failed cloud task releases the session lock for a new prompt', async () => {
  const { hub, identity, rows } = fixture()
  await hub.put(identity, { stage: 'accepted', interactionId: 'remote-old', lastEventId: 'e1' })
  const changed = hub.identity({ sessionId: 'session', endpoint: 'https://example.test/interactions', principalHash: '1'.repeat(64), body: { input: 'changed' } })
  let posts = 0, probes = 0
  const base = {
    get: async (id, options) => {
      if (options.stream) { assert.equal(id, 'remote-new'); return events([{ event_type: 'interaction.completed', interaction: { id, status: 'completed' } }]) }
      probes++; assert.equal(id, 'remote-old'); return { id, status: 'failed' }
    },
    create: async () => { posts++; assert.equal(rows.has(identity.key), false); return events([{ event_type: 'interaction.created', interaction: { id: 'remote-new', status: 'in_progress' } }]) },
  }
  const durable = durableInteractionTransport(base, hub, changed)
  await collect(await durable.create({ input: 'changed' }))
  assert.equal(posts, 1); assert.equal(probes, 1)
  assert.equal(rows.has(identity.key), false); assert.equal(rows.size, 1)
  await durable.finish({ complete: true, reason: 'completed' })
  assert.equal(rows.size, 0)
})

test('a zombie lock whose remote task is still live still blocks a new prompt', async () => {
  const { hub, identity, rows } = fixture()
  await hub.put(identity, { stage: 'accepted', interactionId: 'remote-live' })
  const changed = hub.identity({ sessionId: 'session', endpoint: 'https://example.test/interactions', principalHash: '1'.repeat(64), body: { input: 'other' } })
  const base = { get: async (id, options) => options.stream ? events([]) : { id, status: 'in_progress' }, create: async () => assert.fail('no duplicate paid creation') }
  await assert.rejects(durableInteractionTransport(base, hub, changed).create({ input: 'other' }), /outstanding remote task/)
  assert.equal(rows.size, 1)
})

test('a remote failure status releases the background lock without a duplicate cancel', async () => {
  const { hub, identity, rows } = fixture(); let cancels = 0, exit
  const base = {
    create: async () => events([{ event_type: 'interaction.created', interaction: { id: 'remote', status: 'in_progress' } }]),
    get: async () => events([{ event_type: 'interaction.failed', interaction: { id: 'remote', status: 'failed' } }]),
    cancel: async () => { cancels++; return { status: 'cancelled' } },
  }
  const durable = durableInteractionTransport(base, hub, identity)
  const chunks = await collect(streamInteractions({ provider: 'p', model: 'gemini-4-argon-google', maxTokens: 64, messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }] }, { route: 'google-generative-ai', background: true, store: true, transport: durable, reconnectBackoff: { initialDelayMs: 0 }, onExit: reason => { exit = reason } }))
  assert.equal(chunks.at(-1).reason.kind, 'error')
  await durable.finish({ complete: false, reason: exit })
  assert.equal(rows.size, 0); assert.equal(cancels, 0)
})

test('a dedicated budget_exceeded event is a terminal state for the durable handle', async () => {
  const { hub, identity, rows } = fixture(); let cancels = 0, exit
  const base = {
    create: async () => events([{ event_type: 'interaction.created', interaction: { id: 'remote', status: 'in_progress' } }]),
    get: async () => events([{ event_type: 'interaction.budget_exceeded', interaction: { id: 'remote' } }]),
    cancel: async () => { cancels++; return { status: 'cancelled' } },
  }
  const durable = durableInteractionTransport(base, hub, identity)
  const chunks = await collect(streamInteractions({ provider: 'p', model: 'gemini-4-argon-google', maxTokens: 64, messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }] }, { route: 'google-generative-ai', background: true, store: true, transport: durable, reconnectBackoff: { initialDelayMs: 0 }, onExit: reason => { exit = reason } }))
  assert.equal(chunks.at(-1).reason.kind, 'max-tokens')
  await durable.finish({ complete: true, reason: exit })
  assert.equal(rows.size, 0); assert.equal(cancels, 0)
})

// A local error frame is never proof of a remote terminal state: the cloud task
// is probed once before its recovery handle is dropped.
async function streamErrorRun(probe) {
  const { hub, identity, rows } = fixture()
  let cancels = 0, gets = 0, probes = 0, exit
  const base = {
    create: async () => events([{ event_type: 'interaction.created', interaction: { id: 'remote', status: 'in_progress' } }]),
    get: async (id, options) => {
      if (!options?.stream) { probes++; return probe(id) }
      gets++
      return events([
        { event_type: 'step.start', event_id: 'e1', index: 0, step: { type: 'model_output' } },
        { event_type: 'step.delta', event_id: 'e2', index: 0, delta: { type: 'text', text: 'partial' } },
        { event_type: 'error', event_id: 'e3', error: { code: 'UNAUTHENTICATED' } },
      ])
    },
    cancel: async () => { cancels++; return { status: 'cancelled' } },
  }
  const durable = durableInteractionTransport(base, hub, identity)
  const chunks = await collect(streamInteractions({ provider: 'p', model: 'gemini-4-argon-google', maxTokens: 64, messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }] }, { route: 'google-generative-ai', background: true, store: true, transport: durable, reconnectBackoff: { initialDelayMs: 0 }, onExit: reason => { exit = reason } }))
  await durable.finish({ complete: false, reason: exit })
  return { hub, identity, rows, chunks, exit, cancels, gets, probes }
}
test('an unrecoverable in-stream error event releases the background lock instead of cancelling', async () => {
  const { rows, chunks, exit, cancels, gets, probes } = await streamErrorRun(id => ({ id, status: 'failed' }))
  assert.equal(exit, 'remote-error'); assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(rows.size, 0); assert.equal(cancels, 0); assert.equal(gets, 1); assert.equal(probes, 1)
})
test('an unrecoverable stream error keeps the handle while the cloud task still runs', async () => {
  const { identity, rows, exit, cancels, probes } = await streamErrorRun(id => ({ id, status: 'in_progress' }))
  assert.equal(exit, 'remote-error'); assert.equal(probes, 1); assert.equal(cancels, 0)
  assert.equal(rows.size, 1); assert.equal(rows.get(identity.key).interactionId, 'remote')
  assert.notEqual(rows.get(identity.key).stage, 'cancel-failed')
})
test('an unrecoverable stream error keeps the handle of an already finished cloud task', async () => {
  const { identity, rows, exit, cancels, probes } = await streamErrorRun(id => ({ id, status: 'completed' }))
  assert.equal(exit, 'remote-error'); assert.equal(probes, 1); assert.equal(cancels, 0)
  // A completed task still owns un-replayed output: a local error frame must
  // never discard its handle.
  assert.equal(rows.size, 1); assert.equal(rows.get(identity.key).interactionId, 'remote')
})
test('an unrecoverable stream error keeps the handle for a streamed probe', async () => {
  const { identity, rows, exit, cancels } = await streamErrorRun(id => events([{ event_type: 'interaction.completed', interaction: { id, status: 'completed' } }]))
  assert.equal(exit, 'remote-error'); assert.equal(cancels, 0)
  assert.equal(rows.size, 1); assert.equal(rows.get(identity.key).interactionId, 'remote')
})
test('an unrecoverable stream error keeps the handle for a non-object probe', async () => {
  const { identity, rows, exit, cancels } = await streamErrorRun(() => undefined)
  assert.equal(exit, 'remote-error'); assert.equal(cancels, 0)
  assert.equal(rows.size, 1); assert.equal(rows.get(identity.key).interactionId, 'remote')
})
test('a 404 from the recovery probe releases the handle of a vanished cloud task', async () => {
  const { rows, exit, cancels, probes } = await streamErrorRun(() => { throw Object.assign(new Error('gone'), { status: 404 }) })
  assert.equal(exit, 'remote-error'); assert.equal(probes, 1); assert.equal(cancels, 0)
  assert.equal(rows.size, 0)
})
test('a failed recovery probe keeps the handle instead of guessing the remote state', async () => {
  const { identity, rows, exit, cancels } = await streamErrorRun(() => { throw Object.assign(new Error('offline'), { status: 503 }) })
  assert.equal(exit, 'remote-error'); assert.equal(cancels, 0)
  assert.equal(rows.size, 1); assert.equal(rows.get(identity.key).interactionId, 'remote')
})


// A changed prompt never replays the old body, so a zombie lock whose remote task
// already ended must not block this session forever.
async function reconcileRun(probe) {
  const { hub, identity, rows } = fixture()
  await hub.put(identity, { stage: 'accepted', interactionId: 'remote-old', lastEventId: 'e1' })
  const changed = hub.identity({ sessionId: 'session', endpoint: 'https://example.test/interactions', principalHash: '1'.repeat(64), body: { input: 'changed' } })
  let posts = 0
  const base = {
    get: async (id, options) => options.stream
      ? events([{ event_type: 'interaction.completed', interaction: { id, status: 'completed' } }])
      : probe(id),
    create: async () => { posts++; return events([{ event_type: 'interaction.created', interaction: { id: 'remote-new', status: 'in_progress' } }]) },
  }
  const durable = durableInteractionTransport(base, hub, changed)
  let error
  try { await collect(await durable.create({ input: 'changed' })) } catch (caught) { error = caught }
  if (!error) await durable.finish({ complete: true, reason: 'completed' })
  return { rows, posts, error, identity }
}
// A failed or cancelled cloud task has nothing left to recover, so its dead
// record is dropped. A finished-but-unreplayed result keeps its handle for a
// cold resume by its own requestKey while the session-wide lock is released.
for (const status of ['failed', 'cancelled']) {
  test('a zombie lock whose remote task is ' + status + ' drops the dead record for a new prompt', async () => {
    const { rows, posts, error } = await reconcileRun(id => ({ id, status }))
    assert.equal(error, undefined)
    assert.equal(posts, 1)
    assert.equal(rows.size, 0)
  })
}
for (const status of ['completed', 'requires_action', 'incomplete', 'budget_exceeded']) {
  test('a zombie lock whose remote task is ' + status + ' keeps its un-replayed handle but releases the session', async () => {
    const { rows, posts, error, identity } = await reconcileRun(id => ({ id, status }))
    assert.equal(error, undefined)
    assert.equal(posts, 1)
    // The old handle stays addressable by its own requestKey; only the new
    // prompt's record is completed away in the run's finish().
    assert.equal(rows.size, 1)
    assert.equal(rows.has(identity.key), true)
    assert.equal(rows.get(identity.key).interactionId, 'remote-old')
  })
}
test('a 404 reconcile probe releases a zombie lock whose remote task no longer exists', async () => {
  const { rows, posts, error } = await reconcileRun(() => { throw Object.assign(new Error('gone'), { status: 404 }) })
  assert.equal(error, undefined)
  assert.equal(posts, 1)
  assert.equal(rows.size, 0)
})
for (const status of [401, 403, 503]) {
  test('a ' + status + ' reconcile probe keeps the conservative zombie lock', async () => {
    const { rows, posts, error } = await reconcileRun(() => { throw Object.assign(new Error('probe failed'), { status }) })
    assert.match(error.message, /outstanding remote task/)
    assert.equal(posts, 0)
    assert.equal(rows.size, 1)
  })
}
test('a terminal error frame racing a local abort never cancels or leaves cancel-failed', async () => {
  const { hub, identity, rows } = fixture()
  const controller = new AbortController()
  let cancels = 0, exit, probes = 0
  const base = {
    create: async () => events([{ event_type: 'interaction.created', event_id: 'e0', interaction: { id: 'remote', status: 'in_progress' } }]),
    get: async (id, options) => {
      if (!options?.stream) { probes++; return { id, status: 'failed' } }
      return events([
        { event_type: 'step.start', event_id: 'e1', index: 0, step: { type: 'model_output' } },
        { event_type: 'step.delta', event_id: 'e2', index: 0, delta: { type: 'text', text: 'partial' } },
        { event_type: 'error', event_id: 'e3', error: { code: 'UNAUTHENTICATED' } },
      ])
    },
    cancel: async () => { cancels++; return { status: 'cancelled' } },
  }
  const durable = durableInteractionTransport(base, hub, identity, { signal: controller.signal })
  const chunks = await collect(streamInteractions(
    { provider: 'p', model: 'gemini-4-argon-google', maxTokens: 64, messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }], signal: controller.signal },
    { route: 'google-generative-ai', background: true, store: true, transport: durable, reconnectBackoff: { initialDelayMs: 0 },
      onEvent: event => { if ((event.event_type ?? event.type) === 'error') controller.abort() },
      onExit: reason => { exit = reason } }))
  assert.equal(controller.signal.aborted, true)
  // The same frame carries both a terminal error and the local abort: the exit
  // reason stays 'remote-error', so no /cancel is attempted.
  assert.equal(exit, 'remote-error')
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'ARGON_INTERACTIONS_PROTOCOL')
  await durable.finish({ complete: false, reason: exit })
  assert.equal(cancels, 0)
  assert.equal(probes, 1)
  assert.equal(rows.size, 0)
})

