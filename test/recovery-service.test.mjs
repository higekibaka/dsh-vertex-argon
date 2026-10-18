import assert from 'node:assert/strict'
import {test} from 'node:test'
import {shared} from '../runtime.js'
import {createInteractionStateHub,interactionStateDomain} from '../interaction-state.js'
import {ArgonDiagnosticsService,recoveryInvocations,createDiagnosticHub,recordSchema} from '../diagnostic-store.js'
import {createArgonDiagnosticTracker} from '../diagnostics.js'
const {Context}=await shared('@deepseek-ai/cordis')
function setup(){
  const rows=new Map(),hub=createInteractionStateHub()
  hub.attach({table:()=>({get:k=>rows.get(k),entries:()=>rows.entries(),get size(){return rows.size},put:async(k,v)=>{interactionStateDomain.tables.tasks.valueSchema.parse(v);rows.set(k,v)},delete:async k=>rows.delete(k)}),close:async()=>{}})
  const identity=hub.identity({sessionId:'fixture-secret-session',endpoint:'https://example.test/interactions',principalHash:'1'.repeat(64),body:{input:'PRIVATE_PROMPT'}})
  const ctx=new Context(),service=new ArgonDiagnosticsService(ctx,createDiagnosticHub(),hub)
  return{rows,hub,identity,service,close:()=>ctx.fiber.dispose()}
}
test('recovery list projects bounded metadata without remote IDs or request secrets',async()=>{
  const f=setup()
  try{
    await f.hub.put(f.identity,{stage:'unknown'})
    const result=await f.service.listRecovery({limit:20})
    assert.equal(result.ok,true);assert.equal(result.records.length,1)
    assert.equal(result.records[0].hasRemoteId,false);assert.equal(result.records[0].active,false)
    assert.equal(result.records[0].sessionHash.length,12)
    for(const secret of ['PRIVATE_PROMPT','fixture-secret-session','example.test'])assert.ok(!JSON.stringify(result).includes(secret))
  }finally{await f.close()}
})
test('recovery RPC strictly validates acknowledgement and preserves the released audit row',async()=>{
  const f=setup()
  try{
    const row=await f.hub.put(f.identity,{stage:'unknown'})
    const input={key:row.key,expectedUpdatedAt:row.updatedAt,acknowledgeRisk:true}
    assert.equal((await f.service.releaseUnknown({...input,acknowledgeRisk:false})).ok,false)
    assert.equal((await f.service.releaseUnknown({...input,extra:'untrusted'})).ok,false)
    assert.equal((await f.service.releaseUnknown({...input,expectedUpdatedAt:'2000-01-01T00:00:00.000Z'})).ok,false)
    assert.equal(f.rows.get(row.key).releasedAt,undefined)
    assert.deepEqual(await f.service.releaseUnknown(input),{ok:true,released:true,remoteAction:'none',newRequestStarted:false})
    assert.equal(f.rows.size,1);assert.equal(f.rows.get(row.key).stage,'unknown')
    assert.ok(f.rows.get(row.key).releasedAt)
    assert.equal((await f.service.listRecovery()).records[0].releasedAt,f.rows.get(row.key).releasedAt)
  }finally{await f.close()}
})
test('recovery wire descriptors require explicit true and return stale failures rather than success',()=>{
  const descriptors=recoveryInvocations(),release=descriptors.find(d=>d.method==='releaseUnknown')
  assert.equal(descriptors.length,2)
  assert.throws(()=>release.parameters[0].codec.schema.parse({key:'a'.repeat(64),expectedUpdatedAt:new Date().toISOString()}))
  assert.throws(()=>release.parameters[0].codec.schema.parse({key:'a'.repeat(64),expectedUpdatedAt:new Date().toISOString(),acknowledgeRisk:'true'}))
  assert.equal(release.result.schema.parse({ok:false,error:'changed'}).ok,false)
})
test('HTTP 200 stream reset records its phase/status as transport drop, never API rejection',()=>{
  let record
  const tracker=createArgonDiagnosticTracker({route:'google-generative-ai',model:'gemini-4-argon-google',protocol:'interactions',background:true,apiVersion:'v1beta',thinkingLevel:'HIGH',maxTokens:131072},r=>record=r)
  const error=Object.assign(new Error('stream closed'),{status:200,phase:'stream',cause:{code:'ECONNRESET'}})
  tracker.beginHop({hopIndex:1,trigger:'interaction-create',body:'{}'}).finish({error})
  tracker.finishStream({outcome:'error',error})
  assert.equal(record.hops[0].status,200);assert.equal(record.hops[0].errorPhase,'stream')
  assert.equal(record.hops[0].outcome,'dropped');assert.equal(record.failureCategory,'mid-stream-drop')
  assert.deepEqual(record.hops[0].errorCodes,['ECONNRESET']);recordSchema.parse(record)
})
