import assert from 'node:assert/strict'
import {test} from 'node:test'
import {estimateDiagnosticCost,classifyRequestRegion} from '../pricing.js'
const usage={inputTokens:1000000,cachedTokens:0,outputTokens:100000,thoughtTokens:0,toolTokens:0}
const record={route:'google-generative-ai',model:'gemini-4-argon',startedAt:'2026-10-18T00:00:00.000Z',protocol:'interactions',outcome:'done',serviceTier:{requested:'priority',observed:'flex'},usageDetails:{aggregate:usage,aggregateComplete:true,rows:[],omittedRows:0}}
test('configured global, multi-region and regional locations are classified without guessing unknown locations',()=>{
 assert.equal(classifyRequestRegion('global'),'global')
 for(const value of ['us','eu','us-central1','europe-west10','northamerica-northeast1'])assert.equal(classifyRequestRegion(value),'non-global')
 for(const value of [undefined,null,'','some-proxy','global.evil'])assert.equal(classifyRequestRegion(value),null)
})
test('Interactions prices the cumulative total once, never adds per-step reports',()=>{
 const cost=estimateDiagnosticCost({...record,usageDetails:{...record.usageDetails,rows:[{kind:'interaction-step',usage}]}})
 assert.equal(cost.estimatedUsd,1.5);assert.equal(cost.basis,'interaction-aggregate');assert.equal(cost.rows.length,1);assert.equal(cost.rows[0].tierBasis,'observed');assert.equal(cost.billingVerified,false)
})
test('unknown observed tier uses a clearly marked requested-tier scenario, not a billing claim',()=>{
 const c=estimateDiagnosticCost({...record,serviceTier:{requested:'priority',observed:null}});assert.equal(c.estimatedUsd,5.4);assert.equal(c.rows[0].tierBasis,'requested');assert.equal(c.billingVerified,false)
})
test('GenerateContent prices each hop at its own observed tier and adds once',()=>{
 const c=estimateDiagnosticCost({...record,route:'google-vertex',regionClass:'global',protocol:'generate-content',hopCount:2,serviceTier:{requested:'priority',observed:'mixed'},usageDetails:{aggregate:null,aggregateComplete:false,omittedRows:0,rows:[{kind:'gc-hop',index:1,usage,complete:true,observedServiceTier:'standard'},{kind:'gc-hop',index:2,usage,complete:true,observedServiceTier:'priority'}]}})
 assert.equal(c.estimatedUsd,8.4);assert.equal(c.rows.length,2);assert.equal(c.basis,'gc-hops')
})
test('missing region, omitted hops and interrupted observed tail cannot become a complete estimate',()=>{
 const r={...record,protocol:'generate-content',hopCount:2,usageDetails:{omittedRows:1,rows:[{kind:'gc-hop',index:1,usage,complete:false,observedServiceTier:null}]}}
 const c=estimateDiagnosticCost(r);assert.equal(c.estimatedUsd,null);assert.equal(c.knownSubtotalUsd,5.4);assert.ok(c.missing.includes('omitted-usage-rows'));assert.ok(c.missing.includes('incomplete-hop-ledger'))
 assert.equal(estimateDiagnosticCost({...record,route:'google-vertex'}).estimatedUsd,null)
})
test('an unobserved GC hop uses requested scenario, never borrows another hop receipt',()=>{
 const r={...record,protocol:'generate-content',hopCount:2,serviceTier:{requested:'priority',observed:'standard'},usageDetails:{omittedRows:0,rows:[{kind:'gc-hop',index:1,usage,complete:true,observedServiceTier:'standard'},{kind:'gc-hop',index:2,usage,complete:true,observedServiceTier:null}]}}
 const c=estimateDiagnosticCost(r);assert.equal(c.estimatedUsd,8.4);assert.equal(c.rows[1].tier,'priority');assert.equal(c.rows[1].tierBasis,'requested')
})
test('old records, provisioned traffic and mixed aggregate tier are unknown, not zero or requested fallback',()=>{
 for(const r of [{...record,usageDetails:undefined},{...record,serviceTier:{requested:'priority',observed:'provisioned'}},{...record,serviceTier:{requested:'priority',observed:'mixed'}}])assert.equal(estimateDiagnosticCost(r).estimatedUsd,null)
})
