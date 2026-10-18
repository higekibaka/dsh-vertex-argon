import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createUsageDetails, normalizeUsageDetails, MAX_USAGE_ROWS } from '../usage-details.js'
import { createArgonDiagnosticTracker } from '../diagnostics.js'
import { recordSchema, diagnosticDomain } from '../diagnostic-store.js'
import { mergeServiceHeaders, resolveServicePolicy, serviceTierFromTraffic } from '../service-level.js'

test('missing counts and malformed modalities remain unknown, not zero', () => {
 const value = normalizeUsageDetails('interactions', { total_output_tokens: 0, total_input_tokens: -1, input_tokens_by_modality: [{modality:'SECRET',tokens:10}], output_tokens_by_modality: [] })
 assert.equal(value.outputTokens,0);assert.equal(value.inputTokens,null);assert.equal(value.thoughtTokens,null)
 assert.equal(value.inputByModality,null);assert.deepEqual(value.outputByModality,[])
 assert.ok(!JSON.stringify(value).includes('SECRET'));assert.equal(normalizeUsageDetails('interactions',null),null)
})
test('both protocols map exact documented modality fields', () => {
 const gc=normalizeUsageDetails('generate-content',{promptTokenCount:100,cachedContentTokenCount:20,candidatesTokenCount:7,thoughtsTokenCount:3,promptTokensDetails:[{modality:'TEXT',tokenCount:70},{modality:'IMAGE',tokenCount:30}]})
 const ia=normalizeUsageDetails('interactions',{total_input_tokens:100,total_cached_tokens:20,total_output_tokens:7,total_thought_tokens:3,input_tokens_by_modality:[{modality:'text',tokens:70},{modality:'image',tokens:30}]})
 assert.deepEqual(gc,ia)
})
test('replayed cumulative samples replace rows, detached snapshots cannot mutate the ledger', () => {
 const ledger=createUsageDetails()
 for(let i=0;i<3;i++)ledger.recordRow('interaction-step',2,'interactions',{total_output_tokens:8},true)
 ledger.recordAggregate('interactions',{total_output_tokens:9});ledger.recordAggregate('interactions',{total_output_tokens:11});ledger.completeAggregate()
 const snap=ledger.snapshot();assert.equal(snap.rows.length,1);assert.equal(snap.aggregate.outputTokens,11);assert.equal(snap.aggregateComplete,true)
 snap.rows[0].usage.outputTokens=1000;assert.equal(ledger.snapshot().rows[0].usage.outputTokens,8)
})
test('detail retention marks omitted rows and does not invent totals from a partial list', () => {
 const ledger=createUsageDetails()
 for(let i=0;i<MAX_USAGE_ROWS+2;i++)ledger.recordRow('interaction-step',i,'interactions',{},true)
 ledger.recordRow('interaction-step',MAX_USAGE_ROWS,'interactions',{},true)
 assert.equal(ledger.snapshot().rows.length,MAX_USAGE_ROWS);assert.equal(ledger.snapshot().omittedRows,2);assert.equal(ledger.snapshot().aggregate,null)
})
test('case-insensitive Vertex header overlay preserves credentials without duplicate tier values', () => {
 const policy=resolveServicePolicy({vertexServiceTier:'priority',vertexPaygoOnly:true},'google-vertex','generate-content')
 const headers=new Headers(mergeServiceHeaders({'x-vertex-ai-llm-shared-request-type':'standard',Authorization:'fixture'},policy))
 assert.equal(headers.get('x-vertex-ai-llm-shared-request-type'),'priority');assert.equal(headers.get('x-vertex-ai-llm-request-type'),'shared');assert.equal(headers.get('authorization'),'fixture')
 assert.equal(serviceTierFromTraffic('__proto__'),null)
})
test('diagnostic v2 retains normalized usage and accepts old v1 records', () => {
 let record;const tracker=createArgonDiagnosticTracker({requestedServiceTier:'priority'},r=>{record=r})
 tracker.recordServiceTier('standard','response-header')
 tracker.recordUsageAggregate('interactions',{total_output_tokens:12});tracker.recordUsageRow('interaction-step',0,'interactions',{total_output_tokens:5},true);tracker.completeUsageAggregate();tracker.finishStream({outcome:'done'})
 assert.equal(recordSchema.parse(record).usageDetails.aggregate.outputTokens,12)
 assert.equal(record.serviceTier.requested,'priority');assert.equal(record.serviceTier.observed,'standard')
 const old={...record,schemaVersion:1};delete old.serviceTier;delete old.usageDetails
 assert.equal(recordSchema.parse(old).schemaVersion,1);assert.deepEqual(diagnosticDomain.compatibleVersions,[1])
})
