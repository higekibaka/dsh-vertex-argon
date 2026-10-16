import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDiagnosticHub, diagnosticWriter, recordSchema } from '../diagnostic-store.js'

const record = (id, offsetMs) => recordSchema.parse({
  schemaVersion: 1,
  id: '00000000-0000-4000-8000-' + String(id).padStart(12, '0'),
  startedAt: new Date(Date.UTC(2027, 0, 1) + offsetMs).toISOString(),
  sessionHash: null,
  route: 'google-vertex', model: 'gemini-4-argon', apiVersion: 'v1beta1', thinkingLevel: 'MEDIUM',
  longDecodeEnabled: true, configuredMaxTokens: 65536,
  hopCount: 0, continuationCount: 0, reconnectCount: 0, recoveredFromDrop: false,
  hops: [], hopsDropped: 0,
  tokenUsage: {
    reportedInputTokens: null, reportedCacheTokens: null, outputTokens: null,
    thoughtsTokens: null, billedPromptTokens: null, billedCachedTokens: null, billedTotalTokens: null,
  },
  outcome: 'done', failureCategory: null, durationMs: 0,
})
const ids = records => records.map(value => value.id)

function store(t, limit) {
  const rows = new Map(), deleted = [], warnings = []
  const writer = diagnosticWriter({
    table(name) {
      assert.equal(name, 'requests')
      return {
        entries: () => rows.entries(),
        put: async (id, value) => { rows.set(id, value) },
        delete: async id => { deleted.push(id); return rows.delete(id) },
      }
    },
    close: async () => {},
  }, message => warnings.push(message), limit)
  t.after(async () => {
    await writer.close()
    assert.deepEqual(warnings, [], 'valid fixtures must not be silently dropped')
  })
  return { writer, rows, deleted }
}

// Intentionally unordered, spanning a year boundary and adjacent milliseconds.
// Equal-time IDs are in reverse numeric order so an ID tie-breaker cannot pass.
const unordered = () => [record(3, 1), record(4, -1), record(2, 1000), record(1, 1)]

test('diagnostic writer lists newest first and preserves insertion order for equal timestamps', async t => {
  const { writer } = store(t, 10)
  const [middle, oldest, newest, tied] = unordered()
  for (const value of [middle, oldest, newest, tied]) writer.record(value)
  await writer.flush()
  assert.deepEqual(ids(writer.list(10)), ids([newest, middle, tied, oldest]))
  assert.deepEqual(ids(writer.list(2)), ids([newest, middle]), 'limit applies after sorting')
})

test('diagnostic writer evicts the oldest existing rows, not the earliest inserted rows', async t => {
  const { writer, rows, deleted } = store(t, 3)
  const [third, first, second, fourth, fifth] = [3, 1, 2, 4, 5].map(n => record(n, n * 1000))
  for (const value of [third, first, second, fourth, fifth]) writer.record(value)
  await writer.flush()
  assert.deepEqual(deleted, ids([first, second]))
  assert.deepEqual([...rows.keys()], ids([third, fourth, fifth]))
  assert.deepEqual(ids(writer.list(10)), ids([fifth, fourth, third]))
})

test('diagnostic writer evicts the first inserted row when oldest timestamps tie', async t => {
  const { writer, rows, deleted } = store(t, 3)
  const [first, second, third] = [3, 1, 2].map(n => record(n, 1000))
  const newer = record(4, 2000)
  for (const value of [first, second, third, newer]) writer.record(value)
  await writer.flush()
  assert.deepEqual(deleted, [first.id])
  assert.deepEqual([...rows.keys()], ids([second, third, newer]))
  assert.deepEqual(ids(writer.list(10)), ids([newer, second, third]))
})

test('diagnostic hub lists memory newest first and preserves equal-time insertion order without a writer', () => {
  const hub = createDiagnosticHub(10)
  const [middle, oldest, newest, tied] = unordered()
  for (const value of [middle, oldest, newest, tied]) hub.record(value)
  assert.deepEqual(ids(hub.listRecent(10)), ids([newest, middle, tied, oldest]))
  assert.deepEqual(ids(hub.listRecent(2)), ids([newest, middle]), 'limit applies after sorting')
})

test('diagnostic hub retains the newest records after unordered inserts and a late old record', () => {
  const hub = createDiagnosticHub(3)
  const [third, first, second, fourth, fifth] = [3, 1, 2, 4, 5].map(n => record(n, n * 1000))
  for (const value of [third, first, second, fourth, fifth]) hub.record(value)
  assert.deepEqual(ids(hub.listRecent(10)), ids([fifth, fourth, third]))
  hub.record(record(6, -1))
  assert.deepEqual(ids(hub.listRecent(10)), ids([fifth, fourth, third]), 'a late old record does not displace newer data')
})

test('diagnostic hub evicts the first inserted record when oldest timestamps tie', () => {
  const hub = createDiagnosticHub(3)
  const [first, second, third] = [3, 1, 2].map(n => record(n, 1000))
  const newer = record(4, 2000)
  for (const value of [first, second, third]) hub.record(value)
  assert.deepEqual(ids(hub.listRecent(10)), ids([first, second, third]))
  hub.record(newer)
  assert.deepEqual(ids(hub.listRecent(10)), ids([newer, second, third]))
})

test('diagnostic hub sorts the deduplicated union of memory and persisted records', async t => {
  const { writer } = store(t, 4)
  const oldest = record(1, -1), middle = record(2, 0), newest = record(3, 1)
  for (const value of [middle, newest]) writer.record(value)
  await writer.flush()
  const hub = createDiagnosticHub(4)
  hub.record(oldest)
  hub.record(middle)
  hub.attachWriter(writer)
  assert.deepEqual(ids(hub.listRecent(10)), ids([newest, middle, oldest]))
  assert.deepEqual(ids(hub.listRecent(2)), ids([newest, middle]))
})
