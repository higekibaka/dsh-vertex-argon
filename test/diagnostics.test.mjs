import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createArgonDiagnosticTracker, MAX_RECORDED_HOPS } from '../diagnostics.js'
import { recordSchema, storedRecordSchema, diagnosticDomain, diagnosticWriter, createDiagnosticHub } from '../diagnostic-store.js'

const keys = ['reportedInputTokens','reportedCacheTokens','outputTokens','thoughtsTokens','totalTokens','billedPromptTokens','billedCachedTokens','billedOutputTokens','billedThoughtsTokens','billedToolTokens','billedTotalTokens']
function fixture() {
 let record
 const tracker = createArgonDiagnosticTracker({ sessionId: 'debug', model: 'gemini-4-argon-proxy', route: 'google-generative-ai' }, value => { record = value })
 return { tracker, finish() { tracker.finishStream({ outcome: 'done' }); return record } }
}
test('diagnostics retain exactly the basic request counters and safe per-hop metadata', () => {
 const f = fixture(), usage = Object.fromEntries(keys.map((key, index) => [key, index]))
 f.tracker.recordTokenUsage({ ...usage, secret: 'not retained' })
 const hop = f.tracker.beginHop({ hopIndex: 1, trigger: 'retry-initial', backoffDelayMs: 700 })
 hop.recordTokenUsage({ promptTokens: 100, cachedTokens: 90, outputTokens: 10, thoughtsTokens: 5, totalTokens: 115, secret: 'not retained' })
 hop.onChunk({ status: 200 })
 hop.finish({ error: Object.assign(Error('secret upstream content'), { status: 504, code: 'STREAM_PHASE_TIMEOUT', phase: 'stream' }) })
 const record = f.finish()
 assert.deepEqual(record.tokenUsage, usage)
 assert.equal(record.hops[0].promptTokens, 100)
 assert.equal(record.hops[0].totalTokens, 115)
 assert.deepEqual(record.hops[0].errorCodes, ['STREAM_PHASE_TIMEOUT'])
 assert.equal(record.hops[0].trigger, 'retry-initial')
 assert.equal(record.hops[0].errorPhase, 'stream')
 assert.equal(record.reconnectCount, 1)
 assert.equal(record.recoveredFromDrop, true)
 assert.doesNotMatch(JSON.stringify(record), /secret|usageDetails|regionClass/)
 recordSchema.parse(record)
})
test('invalid counts remain unknown, omissions preserve values and diagnostics stay bounded', () => {
 const f = fixture()
 f.tracker.recordTokenUsage({ totalTokens: 20, billedToolTokens: 0 })
 f.tracker.recordTokenUsage({ totalTokens: -1, outputTokens: 'invalid' })
 for (let i = 1; i <= MAX_RECORDED_HOPS + 1; i++) {
  const hop = f.tracker.beginHop({ hopIndex: i, trigger: 'thinking-dropout-heal' })
  hop.recordTokenUsage({ promptTokens: 1, outputTokens: -1, totalTokens: NaN })
  hop.finish({ finishReason: 'STOP' })
 }
 const record = f.finish()
 assert.equal(record.tokenUsage.totalTokens, null)
 assert.equal(record.tokenUsage.outputTokens, null)
 assert.equal(record.tokenUsage.billedToolTokens, 0)
 assert.equal(record.hops[0].outputTokens, null)
 assert.equal(record.hops[0].totalTokens, null)
 assert.equal(record.hops.length, MAX_RECORDED_HOPS)
 assert.equal(record.hopsDropped, 1)
 recordSchema.parse(record)
})
test('legacy storage reads strip only retired fields without mutating history; new writes remain strict', async () => {
 const f = fixture(), legacy = { ...f.finish(), usageDetails: { obsolete: true }, regionClass: 'global' }
 const before = structuredClone(legacy)
 assert.equal(recordSchema.safeParse(legacy).success, false)
 const clean = storedRecordSchema.parse(legacy)
 assert.equal(clean.usageDetails, undefined)
 assert.equal(clean.regionClass, undefined)
 assert.deepEqual(legacy, before)
 assert.equal(storedRecordSchema.safeParse({ ...legacy, secret: 'unsafe' }).success, false)
 assert.deepEqual(diagnosticDomain.tables.requests.valueSchema.parse(legacy), clean)
 const table = new Map([[legacy.id, legacy]])
 const writer = diagnosticWriter({ table: () => ({ entries: () => table.entries() }), close: async () => {} })
 const hub = createDiagnosticHub()
 hub.attachWriter(writer)
 assert.deepEqual(hub.listRecent(), [clean])
 assert.deepEqual(legacy, before)
 await writer.close()
})
