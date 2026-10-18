import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createArgonDiagnosticTracker} from '../diagnostics.js'
import {createDiagnosticHub,ArgonDiagnosticsService} from '../diagnostic-store.js'
import {createResponseHub} from '../response-store.js'
import {inspectorInvocations,createInspectorOperations} from '../inspector-service.js'
import {shared} from '../runtime.js'
const locator={version:1,sessionId:'one',settlementSeq:9,eventType:'assistant/message',turn:1,step:2,messageId:'answer',provider:'argon',model:'model'}
const historical={session:{id:'one'},target:{seq:9,type:'assistant/message',data:{turn:1,step:2,message:{id:'answer',source:{provider:'argon',model:'model'}}}}}
const {Context}=await shared('@deepseek-ai/cordis')
const {remoteMethods}=await shared('@deepseek-ai/dsh-typert-protocol')
function setup(query=async()=>({identity:{route:'google-generative-ai',credentialBinding:'current-configuration'},interaction:{id:'fixture-id',status:'requires_action',outputs:[{type:'function_call',name:'do_not_execute'}]}})){
 const ctx=new Context(),hub=createDiagnosticHub(),responseHub=createResponseHub()
 const service=new ArgonDiagnosticsService(ctx,hub,undefined,{responseHub,query})
 const add=sessionId=>{let record;const tracker=createArgonDiagnosticTracker({sessionId,route:'google-generative-ai',protocol:'generate-content',model:'gemini-4-argon-google'},r=>{record=r;hub.record(r)},{responseHub,retainRawResponses:true});tracker.observeResponse('gc-chunk',1,{privateValue:sessionId});tracker.finishStream({outcome:'done'});return record}
 return {ctx,service,hub,responseHub,add,close:async()=>{await service.inspector.close();await responseHub.close();await ctx.fiber.dispose()}}
}
test('session list is bounded metadata only, never another session or raw response',async()=>{
 const f=setup();try{const a=f.add('one');f.add('two');const r=await f.service.listRequests({sessionId:'one'});assert.equal(r.ok,true);assert.deepEqual(r.records.map(r=>r.id),[a.id]);assert.equal(r.records[0].association,'unassociated');assert.ok(!JSON.stringify(r).includes('privateValue'));assert.equal(r.records[0].usageDetails,undefined)}finally{await f.close()}
})
test('request and raw page lookups re-check actual ownership instead of trusting sessionId',async()=>{
 const f=setup();try{const a=f.add('one');const request={sessionId:'two',requestId:a.id};assert.deepEqual(await f.service.getRequest(request),{ok:true,status:'not-found'});assert.deepEqual(await f.service.readResponse(request),{ok:true,page:{status:'not-retained'}});const own={...request,sessionId:'one'};assert.equal((await f.service.getRequest(own)).record.id,a.id);const raw=await f.service.readResponse({...own,length:5});assert.equal(raw.page.frame.text.length,5);assert.equal(raw.page.frame.complete,false)}finally{await f.close()}
})
test('detail exposes unknown costs as unknown rather than zero',async()=>{
 const f=setup();try{const a=f.add('one'),r=await f.service.getRequest({sessionId:'one',requestId:a.id});assert.equal(r.cost.estimatedUsd,null);assert.equal(r.cost.billingVerified,false)}finally{await f.close()}
})
test('query returns a locator only; separately paged response is inert and memory-only',async()=>{
 const f=setup();try{const result=await f.service.queryInteraction({route:'google-generative-ai',id:'fixture-id'});assert.equal(result.ok,true);assert.equal(result.readOnly,true);assert.equal(result.remoteStatus,'requires_action');assert.ok(!JSON.stringify(result).includes('do_not_execute'));const page=(await f.service.readQueryResponse({queryId:result.queryId})).page;assert.equal(page.persistence,'memory-only');assert.ok(page.frame.text.includes('do_not_execute'));assert.equal(f.hub.listRecent().length,0)}finally{await f.close()}
})
test('query cancellation forwards the exact signal and never retains a late result',async()=>{
 let seen;const c=new AbortController();const f=setup(async(_request,signal)=>{seen=signal;c.abort();return {identity:{},interaction:{id:'fixture-id'}}})
 try{const r=await f.service.queryInteraction({route:'google-generative-ai',id:'fixture-id'},c.signal);assert.equal(seen,c.signal);assert.equal(r.ok,false);assert.equal(r.code,'ARGON_QUERY_CANCELLED')}finally{await f.close()}
})
test('invalid identifiers, unknown fields and oversized page lengths fail before lookup',async()=>{
 const f=setup();try{for(const [method,request]of [['listRequests',{sessionId:'one',limit:101}],['getRequest',{sessionId:'one',requestId:'not-a-uuid'}],['readResponse',{sessionId:'one',requestId:'00000000-0000-4000-8000-000000000000',length:65537}],['queryInteraction',{route:'google-generative-ai',id:'fixture-id',sessionId:'one'}],['readQueryResponse',{queryId:'wrong'}]])assert.equal((await f.service[method](request)).ok,false)}finally{await f.close()}
})
test('query errors do not serialize provider text, credential material or arbitrary error codes',async()=>{
 const f=setup(async()=>{throw Object.assign(new Error('SECRET_PROVIDER'),{code:'SECRET_CODE',status:403})});try{const r=await f.service.queryInteraction({route:'google-generative-ai',id:'fixture-id'});assert.equal(r.ok,false);assert.equal(r.status,403);assert.doesNotMatch(JSON.stringify(r),/SECRET/)}finally{await f.close()}
})
test('remote markers expose exact session ownership and no session-only route into arbitrary-ID reads',async()=>{
 const f=setup();try{const markers=remoteMethods(f.service)
 for(const method of ['listRequests','getOverview','getRequest','readResponse'])assert.equal(markers.find(m=>m.method===method).resources.session({sessionId:'one'}),'one')
 for(const method of ['queryInteraction','readQueryResponse'])assert.equal(markers.find(m=>m.method===method).resources,undefined)
 }finally{await f.close()}
})
test('new descriptors declare cancellation only for querying and keep query access global',()=>{
 const ds=inspectorInvocations();assert.equal(ds.length,6)
 const q=ds.find(d=>d.method==='queryInteraction');assert.deepEqual(q.cancellation,{parameter:'signal'});assert.equal(q.parameters.length,1)
 assert.throws(()=>q.parameters[0].codec.schema.parse({route:'google-generative-ai',id:'fixture-id',sessionId:'one'}))
 for(const method of ['listRequests','getOverview','getRequest','readResponse'])assert.throws(()=>ds.find(d=>d.method===method).parameters[0].codec.schema.parse({}))
})

test('stored locators require exact historical validation for message filtering and detail',async()=>{
 const f=setup();let reads=0;const ops=createInspectorOperations(f.hub,{readEvent:async request=>{reads++;assert.deepEqual(request,{sessionId:'one',seq:9});return historical}})
 try{const a=f.add('one');f.hub.link(a.id,locator)
  assert.equal((await ops.listRequests({sessionId:'one'})).records[0].association,'unverified');assert.equal(reads,0)
  const filtered=await ops.listRequests({sessionId:'one',messageId:'answer'});assert.equal(filtered.records[0].association,'linked');assert.equal(filtered.records[0].locator.settlementSeq,9)
  assert.deepEqual((await ops.listRequests({sessionId:'one',messageId:'not-this-answer'})).records,[])
  const detail=await ops.getRequest({sessionId:'one',requestId:a.id});assert.equal(detail.association,'linked');assert.equal(detail.record.association,undefined)
  assert.equal((await f.service.listRecent({limit:20})).records[0].association,undefined)
 }finally{await ops.close();await f.close()}
})
test('missing or unavailable historical readers keep candidates unverified and out of answer filters',async()=>{
 for(const readEvent of [undefined,async()=>undefined,async()=>{throw new Error('offline')}]){
  const f=setup(),ops=createInspectorOperations(f.hub,{readEvent});try{const a=f.add('one');f.hub.link(a.id,locator);assert.equal((await ops.getRequest({sessionId:'one',requestId:a.id})).association,'unverified');assert.deepEqual((await ops.listRequests({sessionId:'one',messageId:'answer'})).records,[])}finally{await ops.close();await f.close()}
 }
})
test('wrong historical session, seq, turn, message or source never becomes a linked answer',async()=>{
 const wrongs=[{...historical,session:{id:'two'}},...[
  {seq:10},{type:'assistant/attempt'},{data:{...historical.target.data,turn:3}},
  {data:{...historical.target.data,message:{...historical.target.data.message,id:'different'}}},
  {data:{...historical.target.data,message:{...historical.target.data.message,source:{provider:'argon',model:'other'}}}},
 ].map(change=>({...historical,target:{...historical.target,...change}}))]
 for(const wrong of wrongs){const f=setup(),ops=createInspectorOperations(f.hub,{readEvent:async()=>wrong});try{const a=f.add('one');f.hub.link(a.id,locator);const r=await ops.getRequest({sessionId:'one',requestId:a.id});assert.equal(r.association,'unassociated');assert.equal(r.locator,undefined);assert.deepEqual((await ops.listRequests({sessionId:'one',messageId:'answer'})).records,[])}finally{await ops.close();await f.close()}}
})
test('a fork or another session cannot inherit a diagnostic association by matching message ID',async()=>{
 const f=setup(),ops=createInspectorOperations(f.hub,{readEvent:async()=>historical});try{const a=f.add('one');f.hub.link(a.id,{...locator,sessionId:'two'});assert.equal(f.hub.listRecent()[0].association,undefined);f.hub.link(a.id,locator);assert.deepEqual((await ops.listRequests({sessionId:'two',messageId:'answer'})).records,[])}finally{await ops.close();await f.close()}
})

