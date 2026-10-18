import assert from 'node:assert/strict'
import { test } from 'node:test'
import { estimateUsageCost, resolvePublicPrice } from '../pricing.js'
const args = { complete:true,route:'google-generative-ai',tier:'standard',at:'2026-10-18T04:00:00Z',usage:{inputTokens:1000000,cachedTokens:200000,outputTokens:40000,thoughtTokens:10000,toolTokens:100000} }
test('cached input is subtracted once and thinking is charged with output',()=>{
 const result=estimateUsageCost(args)
 assert.deepEqual(result.components,{inputUsd:1.8,cachedUsd:0.02,outputUsd:0.5});assert.equal(result.estimatedUsd,2.32)
 assert.equal(result.billingVerified,false);assert.equal(result.kind,'usage-estimate')
})
test('Gemini Flex and Priority use their own published rates',()=>{
 assert.equal(estimateUsageCost({...args,tier:'flex'}).estimatedUsd,1.16)
 assert.equal(estimateUsageCost({...args,tier:'priority'}).estimatedUsd,4.176)
})
test('promotional and announced post-promotion prices are versioned by date',()=>{
 assert.equal(estimateUsageCost({...args,at:'2026-12-01T00:00:00Z'}).estimatedUsd,4.64)
 assert.equal(resolvePublicPrice({...args,at:'not-a-date'}),null)
 assert.equal(resolvePublicPrice({...args,at:'2026-10-17T00:00:00Z'}),null)
})
test('Vertex location matters and credits-back pricing is not claimed as immediate debit',()=>{
 const global=estimateUsageCost({...args,route:'google-vertex',regionClass:'global'})
 const regional=estimateUsageCost({...args,route:'google-vertex',regionClass:'non-global'})
 assert.equal(global.estimatedUsd,2.32);assert.equal(regional.estimatedUsd,2.552)
 assert.equal(global.price.basis,'published-after-promotional-credits')
 assert.equal(estimateUsageCost({...args,route:'google-vertex'}).estimatedUsd,null)
})
test('unknown price, counts and inconsistent cache data never become a zero invoice',()=>{
 assert.equal(estimateUsageCost({...args,tier:'provisioned'}).knownSubtotalUsd,null)
 assert.equal(estimateUsageCost({...args,tier:'__proto__'}).estimatedUsd,null)
 const partial=estimateUsageCost({...args,usage:{...args.usage,thoughtTokens:null}})
 assert.equal(partial.estimatedUsd,null);assert.equal(partial.knownSubtotalUsd,1.82);assert.ok(partial.missing.includes('thoughtTokens'))
 const malformed=estimateUsageCost({...args,usage:{...args.usage,cachedTokens:2000000}})
 assert.equal(malformed.estimatedUsd,null);assert.ok(malformed.missing.includes('cached-exceeds-input'))
})
test('unsettled usage only produces a known subtotal, even when every count is present',()=>{
 const result=estimateUsageCost({...args,complete:false})
 assert.equal(result.estimatedUsd,null);assert.equal(result.knownSubtotalUsd,2.32);assert.ok(result.missing.includes('usage-not-final'))
})
test('explicit reported zero usage can be estimated as zero without claiming it was billed',()=>{
 const result=estimateUsageCost({...args,usage:{inputTokens:0,cachedTokens:0,outputTokens:0,thoughtTokens:0,toolTokens:0}})
 assert.equal(result.estimatedUsd,0);assert.equal(result.billingVerified,false)
})
