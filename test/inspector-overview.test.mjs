import assert from 'node:assert/strict'
import {test} from 'node:test'
import {summarizeRequestOverview} from '../inspector-overview.js'
import {createInspectorOperations,inspectorInvocations,INSPECTOR_SESSION_METHODS} from '../inspector-service.js'
import {createDiagnosticHub,ArgonDiagnosticsService,DIAGNOSTICS_REMOTE} from '../diagnostic-store.js'
import {createArgonDiagnosticTracker} from '../diagnostics.js'
import {estimateDiagnosticCost} from '../pricing.js'
import {USAGE_COUNT_KEYS,USAGE_DETAIL_KEYS} from '../usage-details.js'
import {shared} from '../runtime.js'

const {Context}=await shared('@deepseek-ai/cordis')
const {remoteMethods}=await shared('@deepseek-ai/dsh-typert-protocol')
const window={limit:20,limited:false}
const counts=change=>({...Object.fromEntries(USAGE_COUNT_KEYS.map(key=>[key,0])),...Object.fromEntries(USAGE_DETAIL_KEYS.map(key=>[key,null])),...change})
const sample=counts({inputTokens:100,cachedTokens:50,outputTokens:20,thoughtTokens:5,toolTokens:2,totalTokens:127})
const hop=(usage=sample,index=1,complete=true)=>({kind:'gc-hop',index,usage:structuredClone(usage),complete,observedServiceTier:'standard'})
function record(change={},sessionId='one'){
 let base
 createArgonDiagnosticTracker({sessionId,route:'google-generative-ai',protocol:'generate-content',model:'gemini-4-argon'},r=>{base=r}).finishStream({outcome:'done'})
 return {...base,startedAt:'2026-10-18T01:00:00.000Z',hopCount:1,serviceTier:{requested:'standard',observed:'standard',source:'response-header'},usageDetails:{aggregate:null,aggregateComplete:false,rows:[hop()],omittedRows:0},...change}
}
const gc=(rows=[hop()],change={})=>record({hopCount:rows.length,usageDetails:{aggregate:null,aggregateComplete:false,rows,omittedRows:0},...change})
const ia=(usage=sample,change={})=>record({protocol:'interactions',usageDetails:{aggregate:structuredClone(usage),aggregateComplete:true,rows:[],omittedRows:0},...change})
const metric=(knownSubtotal,reportedRequests,completeRequests,complete)=>({knownSubtotal,reportedRequests,completeRequests,complete})
const overview=records=>summarizeRequestOverview(records,window)
const locator={version:1,sessionId:'one',settlementSeq:9,eventType:'assistant/message',turn:1,step:2,messageId:'answer',provider:'argon',model:'model'}
const historical={session:{id:'one'},target:{seq:9,type:'assistant/message',data:{turn:1,step:2,message:{id:'answer',source:{provider:'argon',model:'model'}}}}}

function assertMetadata(records){
 const keys=['id','startedAt','route','model','protocol','outcome','serviceTier','responseCapture','association','locator']
 for(const row of records){
  assert.ok(Object.keys(row).every(key=>keys.includes(key)))
  for(const key of ['usageDetails','tokenUsage','cost','sessionHash','rawResponse','remoteStatus'])assert.equal(row[key],undefined)
 }
}

test('mixed GC and IA sum only hop observations and cumulative aggregate, never both',()=>{
 const g=gc([hop(sample,1),hop(sample,2)])
 g.usageDetails.aggregate=counts({inputTokens:999999,totalTokens:999999})
 g.usageDetails.rows.push({...hop(counts({inputTokens:777777}),0),kind:'interaction-step'})
 const i=ia(counts({inputTokens:900,cachedTokens:0,outputTokens:30,thoughtTokens:6,toolTokens:3,totalTokens:939}))
 i.usageDetails.rows=[{...hop(counts({inputTokens:888888}),0),kind:'interaction-step',complete:false}]
 i.usageDetails.omittedRows=20 // step detail omissions cannot alter the IA cumulative aggregate
 const r=overview([g,i])
 assert.deepEqual(Object.keys(r).sort(),['cache','cost','requestCount','tokens','window'])
 assert.equal(r.requestCount,2)
 assert.deepEqual(r.tokens,{inputTokens:metric(1100,2,2,true),cachedTokens:metric(100,2,2,true),outputTokens:metric(70,2,2,true),thoughtTokens:metric(16,2,2,true),toolTokens:metric(7,2,2,true),totalTokens:metric(1193,2,2,true)})
 const costs=[g,i].map(estimateDiagnosticCost)
 assert.equal(r.cost.knownSubtotalUsd,Math.round(costs.reduce((sum,c)=>sum+c.knownSubtotalUsd,0)*1e9)/1e9)
 assert.equal(r.cost.estimatedUsd,r.cost.knownSubtotalUsd)
 assert.deepEqual(r.cost,{knownSubtotalUsd:r.cost.estimatedUsd,estimatedUsd:r.cost.estimatedUsd,reportedRequests:2,completeRequests:2,billingVerified:false})
 assert.equal(r.cache.percent,100/1100*100)
 assert.equal(r.cache.completeRequests,2)
})

test('missing hop fields keep per-field known subtotals and distinguish reported zero from unknown',()=>{
 const r=overview([gc([hop(counts({inputTokens:80,outputTokens:null,totalTokens:null}),1),hop(counts({inputTokens:null,outputTokens:0,totalTokens:null}),2)])])
 assert.deepEqual(r.tokens.inputTokens,metric(80,1,0,false))
 assert.deepEqual(r.tokens.outputTokens,metric(0,1,0,false))
 assert.deepEqual(r.tokens.totalTokens,metric(null,0,0,false))
 assert.deepEqual(r.tokens.cachedTokens,metric(0,1,1,true))
 assert.equal(r.cache.percent,null)
 assert.equal(r.cost.estimatedUsd,null)
 assert.ok(r.cost.knownSubtotalUsd>0)
})

test('missing fields do not derive total tokens or coerce invalid values to zero',()=>{
 for(const invalid of [null,undefined,-1,0.5,NaN,Infinity,'12',Number.MAX_SAFE_INTEGER+1]){
  const r=overview([ia(counts({inputTokens:invalid,totalTokens:null}))])
  assert.deepEqual(r.tokens.inputTokens,metric(null,0,0,false))
  assert.deepEqual(r.tokens.totalTokens,metric(null,0,0,false))
 }
 const r=overview([ia(counts())])
 assert.deepEqual(r.tokens.inputTokens,metric(0,1,1,true))
 assert.equal(r.cache.percent,null)
 assert.equal(r.cost.estimatedUsd,0)
})

test('old records with no details and unknown protocols do not fall back to legacy token totals',()=>{
 for(const change of [{usageDetails:undefined},{protocol:undefined},{protocol:'unsupported'}]){
  const legacy=record(change);legacy.tokenUsage=Object.fromEntries(Object.keys(legacy.tokenUsage).map(key=>[key,500]))
  const r=overview([legacy])
  for(const field of USAGE_COUNT_KEYS)assert.deepEqual(r.tokens[field],metric(null,0,0,false))
  assert.equal(r.cache.percent,null)
  assert.equal(r.cost.estimatedUsd,null)
 }
})

test('error, aborted, incomplete and unknown outcomes retain consumed tokens and costs without completeness',()=>{
 for(const outcome of ['error','aborted','incomplete','unknown']){
  const records=[gc([hop()],{outcome}),ia(sample,{outcome})],r=overview(records)
  for(const field of USAGE_COUNT_KEYS)assert.deepEqual(r.tokens[field],metric(sample[field]*2,2,0,false))
  assert.equal(r.cache.percent,null);assert.equal(r.cache.completeRequests,0)
  assert.equal(r.cost.reportedRequests,2);assert.equal(r.cost.completeRequests,0)
  assert.ok(r.cost.knownSubtotalUsd>0);assert.equal(r.cost.estimatedUsd,null)
 }
})

test('done, max-tokens and tool-calls are the final outcomes eligible for complete totals',()=>{
 for(const outcome of ['done','max-tokens','tool-calls']){
  const r=overview([gc([hop()],{outcome}),ia(sample,{outcome})])
  assert.equal(r.tokens.inputTokens.complete,true)
  assert.equal(r.cache.completeRequests,2)
  assert.notEqual(r.cost.estimatedUsd,null)
 }
})

test('partial, omitted, mismatched, empty and duplicate-index GC ledgers cannot be complete',()=>{
 const cases=[gc([hop(sample,1,false)]),gc([hop()],{hopCount:2}),gc([]),gc([hop(sample,1),hop(sample,1)])]
 const omitted=gc();omitted.usageDetails.omittedRows=1;cases.push(omitted)
 for(const value of cases){
  const r=overview([value])
  for(const field of USAGE_COUNT_KEYS){assert.equal(r.tokens[field].complete,false);assert.equal(r.tokens[field].completeRequests,0)}
  assert.equal(r.cache.percent,null);assert.equal(r.cache.completeRequests,0)
  assert.equal(r.cost.estimatedUsd,null);assert.equal(r.cost.completeRequests,0)
  if(value.usageDetails.rows.length)assert.ok(r.cost.knownSubtotalUsd>0)
 }
})

test('an incomplete IA aggregate stays partial even when step reports look complete',()=>{
 const i=ia();i.usageDetails.aggregateComplete=false;i.usageDetails.rows=[{...hop(),kind:'interaction-step'}]
 const r=overview([i])
 assert.deepEqual(r.tokens.inputTokens,metric(100,1,0,false))
 assert.equal(r.cache.percent,null);assert.equal(r.cost.estimatedUsd,null)
})

test('cache rate is weighted from sums instead of averaged request percentages',()=>{
 const r=overview([ia(counts({inputTokens:100,cachedTokens:100})),ia(counts({inputTokens:900,cachedTokens:0}))])
 assert.deepEqual(r.cache,{percent:10,completeRequests:2})
})

test('invalid cache subsets never cancel out across hops or requests',()=>{
 const bad=counts({inputTokens:10,cachedTokens:20}),good=counts({inputTokens:100,cachedTokens:0})
 for(const records of [[gc([hop(bad,1),hop(good,2)])],[ia(bad),ia(good)]]){
  const r=overview(records)
  assert.equal(r.tokens.inputTokens.complete,true)
  assert.equal(r.cache.percent,null)
  assert.equal(r.cache.completeRequests,records.length===1?0:1)
  assert.equal(r.cost.estimatedUsd,null)
 }
})

test('safe integer overflow within one request or across requests nulls the sum rather than dropping known values',()=>{
 const huge=counts({inputTokens:Number.MAX_SAFE_INTEGER}),one=counts({inputTokens:1})
 for(const records of [[gc([hop(huge,1),hop(one,2)]),ia(one)],[ia(huge),ia(one)]]){
  const r=overview(records)
  assert.equal(r.tokens.inputTokens.knownSubtotal,null)
  assert.equal(r.tokens.inputTokens.reportedRequests,records.length)
  assert.equal(r.tokens.inputTokens.complete,false)
  assert.equal(r.cache.percent,null)
  assert.equal(r.tokens.outputTokens.knownSubtotal,0)
 }
})

test('cost totals reuse each request estimate and retain partial/unknown-request coverage',()=>{
 const known=ia(),failed=gc([hop()],{outcome:'error'}),unknown=record({usageDetails:undefined})
 const r=overview([known,failed,unknown])
 assert.equal(r.cost.knownSubtotalUsd,Math.round((estimateDiagnosticCost(known).knownSubtotalUsd+estimateDiagnosticCost(failed).knownSubtotalUsd)*1e9)/1e9)
 assert.deepEqual(r.cost,{knownSubtotalUsd:r.cost.knownSubtotalUsd,estimatedUsd:null,reportedRequests:2,completeRequests:1,billingVerified:false})
 assert.equal(r.tokens.inputTokens.reportedRequests,2)
 assert.equal(r.tokens.inputTokens.completeRequests,1)
 assert.equal(r.tokens.inputTokens.complete,false)
})

test('empty collections expose zero coverage counts but null consumption and estimate',()=>{
 const r=overview([])
 assert.equal(r.requestCount,0)
 assert.deepEqual(r.window,{limit:20,retainedWindowLimit:200,limited:false,oldestAt:null,newestAt:null})
 for(const field of USAGE_COUNT_KEYS)assert.deepEqual(r.tokens[field],metric(null,0,0,false))
 assert.deepEqual(r.cache,{percent:null,completeRequests:0})
 assert.deepEqual(r.cost,{knownSubtotalUsd:null,estimatedUsd:null,reportedRequests:0,completeRequests:0,billingVerified:false})
})

test('overview dates are selected request starts and window includes only the declared bounds',()=>{
 const early=ia(sample,{startedAt:'2026-10-18T00:00:00.000Z'}),late=gc([hop()],{startedAt:'2026-10-18T04:00:00.000Z'})
 const r=summarizeRequestOverview([late,early],{limit:2,limited:true,secret:'not-returned'})
 assert.deepEqual(r.window,{limit:2,retainedWindowLimit:200,limited:true,oldestAt:early.startedAt,newestAt:late.startedAt})
})

test('non-string starts never enter the date window and never coerce into one',()=>{
 for(const startedAt of [undefined,null,0,1700000000000,{iso:'2026-10-18T00:00:00.000Z'},['2026-10-18T00:00:00.000Z'],true]){
  const r=overview([record({startedAt})])
  assert.deepEqual(r.window,{limit:20,retainedWindowLimit:200,limited:false,oldestAt:null,newestAt:null},String(startedAt))
  assert.equal(r.requestCount,1)
 }
 const mixed=overview([record({startedAt:undefined}),record({startedAt:'2026-10-18T03:00:00.000Z'})])
 assert.equal(mixed.window.oldestAt,'2026-10-18T03:00:00.000Z')
 assert.equal(mixed.window.newestAt,'2026-10-18T03:00:00.000Z')
})

test('one retained request resolves both date bounds to its own start',()=>{
 const only=record({startedAt:'2026-10-18T07:30:00.000Z'}),r=overview([only])
 assert.equal(r.window.oldestAt,only.startedAt)
 assert.equal(r.window.newestAt,r.window.oldestAt)
})

test('duplicate, out-of-order and empty start values keep their exact lexical extremes',()=>{
 const early='2026-10-18T00:00:00.000Z',middle='2026-10-18T02:00:00.000Z',late='2026-10-18T04:00:00.000Z'
 const shuffled=overview([record({startedAt:late}),record({startedAt:middle}),record({startedAt:early}),record({startedAt:late}),record({startedAt:early})])
 assert.equal(shuffled.window.oldestAt,early)
 assert.equal(shuffled.window.newestAt,late)
 // An empty string orders before every timestamp, exactly as the previous sort copy did.
 const blank=overview([record({startedAt:late}),record({startedAt:''})])
 assert.equal(blank.window.oldestAt,'')
 assert.equal(blank.window.newestAt,late)
})

test('getOverview is session isolated, metadata only, with no raw capture or cloud query reads',async()=>{
 const hub=createDiagnosticHub(),a=record(),b=record({},'two');hub.record(a);hub.record(b)
 let rawReads=0,cloudReads=0
 const ops=createInspectorOperations(hub,{responseHub:{read(){rawReads++;throw new Error('raw')}},query:async()=>{cloudReads++;throw new Error('cloud')}})
 try{
  const r=await ops.getOverview({sessionId:'one'})
  assert.deepEqual(Object.keys(r).sort(),['ok','overview','records'])
  assert.equal(r.ok,true);assert.deepEqual(r.records.map(r=>r.id),[a.id]);assertMetadata(r.records)
  assert.deepEqual(r.overview,overview([a]))
  assert.deepEqual(await ops.listRequests({sessionId:'one'}),{ok:true,records:r.records})
  const empty=await ops.getOverview({sessionId:'other'})
  assert.deepEqual(empty.records,[]);assert.deepEqual(empty.overview,overview([]))
  assert.equal(rawReads,0);assert.equal(cloudReads,0)
 }finally{await ops.close()}
})

test('answer filtering verifies historical linked ownership after slicing and never backfills rejected candidates',async()=>{
 const rows=[record({association:{...locator,settlementSeq:10}}),record({association:locator}),record({association:locator})]
 const reads=[],ops=createInspectorOperations({listRecent(limit){assert.equal(limit,200);return rows}},{readEvent:async request=>{reads.push(request);return historical}})
 try{
  const request={sessionId:'one',messageId:'answer',limit:2},r=await ops.getOverview(request)
  assert.deepEqual(r.records.map(row=>row.id),[rows[1].id]);assert.equal(r.records[0].association,'linked')
  assert.equal(r.overview.requestCount,1);assert.equal(r.overview.window.limited,true)
  assert.deepEqual(r.overview.tokens.inputTokens,metric(100,1,1,true))
  assert.deepEqual(reads,[{sessionId:'one',seq:10},{sessionId:'one',seq:9}])
  assert.deepEqual((await ops.listRequests(request)).records,r.records)
  assert.deepEqual((await ops.getOverview({...request,sessionId:'two'})).records,[])
  assert.deepEqual((await ops.getOverview({...request,messageId:'other-answer'})).records,[])
 }finally{await ops.close()}
})

test('unavailable or mismatched historical evidence excludes answer candidates from both records and overview',async()=>{
 const wrongs=[undefined,{...historical,session:{id:'two'}},{...historical,target:{...historical.target,seq:8}},{...historical,target:{...historical.target,data:{...historical.target.data,message:{id:'other',source:{provider:'argon',model:'model'}}}}}]
 const readers=[undefined,async()=>{throw new Error('offline')},...wrongs.map(value=>async()=>value)]
 for(const readEvent of readers){
  const ops=createInspectorOperations({listRecent:()=>[record({association:locator})]},{readEvent})
  try{const r=await ops.getOverview({sessionId:'one',messageId:'answer'});assert.deepEqual(r.records,[]);assert.deepEqual(r.overview,overview([]))}finally{await ops.close()}
 }
})

test('records and overview use one cloned snapshot even if history validation changes hub rows',async()=>{
 const original=record({association:locator}),before=structuredClone(original)
 let lists=0
 const ops=createInspectorOperations({listRecent(){lists++;return [original]}},{readEvent:async()=>{
  original.usageDetails.rows[0].usage.inputTokens=999
  original.outcome='error';original.serviceTier.observed='priority'
  return historical
 }})
 try{
  const r=await ops.getOverview({sessionId:'one',messageId:'answer'})
  assert.equal(lists,1);assert.equal(r.records[0].outcome,'done');assert.equal(r.records[0].serviceTier.observed,'standard')
  assert.deepEqual(r.overview,overview([before]))
 }finally{await ops.close()}
})

test('retained 200 window precedes session filter; default20/max100 and limited reflect candidate truncation only',async()=>{
 const hub=createDiagnosticHub()
 for(let n=0;n<205;n++)hub.record(record({startedAt:new Date(Date.UTC(2026,9,18,0,0,n)).toISOString()},n<5?'evicted':'one'))
 const ops=createInspectorOperations(hub)
 try{
  const empty=await ops.getOverview({sessionId:'evicted'});assert.equal(empty.overview.requestCount,0);assert.equal(empty.overview.window.limited,false)
  for(const limit of [undefined,1,100]){
   const r=await ops.getOverview({sessionId:'one',...(limit===undefined?{}:{limit})})
   assert.equal(r.records.length,limit??20);assert.equal(r.overview.requestCount,limit??20)
   assert.equal(r.overview.window.limit,limit??20);assert.equal(r.overview.window.retainedWindowLimit,200);assert.equal(r.overview.window.limited,true)
  }
 }finally{await ops.close()}
 const filteredRows=[...Array.from({length:80},()=>record({},'other')),record(),record()]
 const narrow=createInspectorOperations({listRecent:()=>filteredRows})
 try{const r=await narrow.getOverview({sessionId:'one',limit:2});assert.equal(r.overview.requestCount,2);assert.equal(r.overview.window.limited,false)}finally{await narrow.close()}
})

test('getOverview rejects invalid bounds and scope before touching the hub, and rejects after close',async()=>{
 let reads=0;const ops=createInspectorOperations({listRecent(){reads++;return []}})
 try{
  for(const request of [{},null,{sessionId:''},{sessionId:'one',messageId:''},{sessionId:'one',raw:true},...[0,-1,101,1.5,'20',null].map(limit=>({sessionId:'one',limit}))])assert.equal((await ops.getOverview(request)).ok,false)
  assert.equal(reads,0)
  assert.equal((await ops.getOverview({sessionId:'one',limit:100})).ok,true)
  assert.equal(reads,1)
 }finally{await ops.close()}
 assert.equal((await ops.getOverview({sessionId:'one'})).ok,false);assert.equal(reads,1)
})

test('getOverview has an independent session-scoped remote descriptor and survives repeat service mounting',async()=>{
 const descriptor=inspectorInvocations().find(d=>d.method==='getOverview')
 assert.ok(descriptor);assert.ok(INSPECTOR_SESSION_METHODS.includes('getOverview'))
 assert.equal(descriptor.id,'dsh-vertex-argon#vertexArgonDiagnostics/getOverview')
 assert.equal(descriptor.cancellation,undefined)
 assert.deepEqual(descriptor.parameters[0].codec.schema.parse({sessionId:'one'}),{sessionId:'one',limit:20})
 assert.ok(DIAGNOSTICS_REMOTE.descriptors.some(d=>d.method==='getOverview'))
 for(let n=0;n<2;n++){
  const ctx=new Context(),service=new ArgonDiagnosticsService(ctx,createDiagnosticHub())
  try{
   const marker=remoteMethods(service).find(m=>m.method==='getOverview')
   assert.equal(marker.resources.session({sessionId:'one'}),'one')
   assert.equal((await service.getOverview({sessionId:'one'})).overview.requestCount,0)
  }finally{await service.inspector.close();await ctx.fiber.dispose()}
 }
})

test('overview shares historical optional defaults with pricing without inventing totals',()=>{
 const usage={inputTokens:100,outputTokens:20,cachedTokens:null,thoughtTokens:null,toolTokens:null,totalTokens:null}
 for(const record of [gc([hop(usage)]),ia(usage)]){
  const before=structuredClone(record),r=overview([record])
  for(const key of ['cachedTokens','thoughtTokens','toolTokens'])assert.deepEqual(r.tokens[key],metric(0,1,1,true))
  assert.deepEqual(r.tokens.totalTokens,metric(null,0,0,false))
  assert.deepEqual(r.cache,{percent:0,completeRequests:1})
  assert.equal(r.cost.estimatedUsd,0.0004);assert.deepEqual(record,before)
 }
})
test('overview keeps empty and invalid usage unknown while honoring proven GC zero output',()=>{
 for(const usage of [null,{}, {cachedTokens:null,thoughtTokens:null,toolTokens:null}]){
  const r=overview([gc([hop(usage)]),ia(usage)])
  for(const key of USAGE_COUNT_KEYS)assert.deepEqual(r.tokens[key],metric(null,0,0,false))
  assert.equal(r.cost.knownSubtotalUsd,null);assert.equal(r.cost.estimatedUsd,null)
 }
 const zero={inputTokens:100,totalTokens:100,outputTokens:null,cachedTokens:null,thoughtTokens:null,toolTokens:null}
 const r=overview([gc([hop(zero)])])
 assert.deepEqual(r.tokens.outputTokens,metric(0,1,1,true));assert.equal(r.cost.estimatedUsd,0.0002)
 const invalid=overview([gc([hop({...zero,outputTokens:0,invalidCounts:['toolTokens']})])])
 assert.deepEqual(invalid.tokens.toolTokens,metric(null,0,0,false));assert.equal(invalid.cost.estimatedUsd,null)
})
test('overview computes cache percent from cache-complete requests without mixing tokens from failed requests, and recovers pre-progress retry GC ledgers',()=>{
 const complete=ia(counts({inputTokens:200,cachedTokens:50,outputTokens:10,thoughtTokens:0,toolTokens:0,totalTokens:210}))
 const failedWithUsage=gc([hop(counts({inputTokens:800,cachedTokens:800,outputTokens:10,thoughtTokens:0,toolTokens:0,totalTokens:810}))],{outcome:'error'})
 const r=overview([complete,failedWithUsage])
 assert.deepEqual(r.cache,{percent:25,completeRequests:1})
 assert.equal(r.tokens.inputTokens.knownSubtotal,1000)
 assert.equal(r.tokens.cachedTokens.knownSubtotal,850)
 let recovered
 const tracker=createArgonDiagnosticTracker({sessionId:'one',route:'google-vertex',regionClass:'global',protocol:'generate-content',model:'gemini-4-argon',requestedServiceTier:'standard'},v=>{recovered=v})
 const h1=tracker.beginHop({hopIndex:1,trigger:'initial',usedContinuationToken:false})
 tracker.recordUsageRow('gc-hop',1,'generate-content',undefined,false)
 h1.finish({error:new Error('fetch failed')})
 const h2=tracker.beginHop({hopIndex:2,trigger:'retry-original',usedContinuationToken:false})
 tracker.recordUsageRow('gc-hop',2,'generate-content',{promptTokenCount:100,cachedContentTokenCount:40,candidatesTokenCount:20,thoughtsTokenCount:0,toolUsePromptTokenCount:0,totalTokenCount:120},true,'standard')
 h2.finish({finishReason:'STOP'});tracker.finishStream({outcome:'done'})
 const r2=overview([recovered])
 assert.deepEqual(r2.cache,{percent:40,completeRequests:1})
 assert.equal(r2.tokens.totalTokens.completeRequests,1)
 assert.notEqual(r2.cost.estimatedUsd,null)
})
