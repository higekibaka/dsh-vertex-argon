import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fixture, button, row, detail, requestId, secondId, selectRequest, plain } from './client-inspector-fixture.mjs'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const text = node => (node?.children ?? []).map(child => typeof child === 'object' ? text(child) : String(child ?? '')).join(' ')
const watermark = view => view.nodes.find(node => node.props.className === 'ag-token-watermark')
const choose = (view, id = requestId) => view.nodes.find(node => node.props['data-request-id'] === id).props.onClick()
const hop = index => ({ hopIndex: index, trigger: index === 1 ? 'initial' : 'checkpoint-reconnect', status: 200, streamErrorStatus: 503, errorPhase: 'stream', backoffDelayMs: 1500, chunkCount: 0, hasCheckpoint: false, finishReason: 'STOP', errorCodes: ['UNAVAILABLE'], durationMs: 321 })

for (const language of ['zh', 'en']) test('Debug summary, watermark and all 11 hop columns are complete: ' + language, async () => {
  const f = fixture({ language })
  const record = { ...row(), protocol: 'generate-content', thinkingLevel: 'HIGH', outcome: 'error', failureCategory: 'stream-error', durationMs: 1234, hopCount: 40,
    tokenUsage: { reportedInputTokens: 100, reportedCacheTokens: 0, outputTokens: 20, thoughtsTokens: 3, totalTokens: 123, billedPromptTokens: 900, billedTotalTokens: 923 },
    hops: Array.from({ length: 40 }, (_, i) => hop(i + 1)), hopsDropped: 2 }
  f.handlers.getRequest = async () => ({ ...detail(), association: 'linked', locator: { messageId: 'answer-A', settlementSeq: 17 }, record })
  try {
    let view = await f.settle(); await choose(view); view = await f.settle()
    assert.equal(button(view, 'Debug').props['aria-pressed'], true)
    assert.deepEqual(view.nodes.filter(n => n.props['data-summary-field']).map(n => n.props['data-summary-field']), ['id', 'route', 'protocol', 'thinkingLevel', 'outcome', 'failureCategory', 'durationMs', 'finishReason', 'association'])
    for (const value of [requestId, 'Gemini API', 'generate-content', 'HIGH', 'error', 'stream-error', '1.23s', 'STOP', f.dictionary.inspectorAssociated]) assert.ok(view.text.includes(value), value)
    assert.equal(text(watermark(view)), 'In: 100 · Cache: 0 · Out: 20 · Think: 3 · Total: 123 · Billed In: 900 · Billed Total: 923')
    assert.deepEqual(view.nodes.filter(n => n.type === 'th').map(text), ['#hopIndex', 'trigger', 'status', 'streamErrorStatus', 'errorPhase', 'backoffDelayMs', 'chunkCount', 'hasCheckpoint', 'finishReason', 'errorCodes', 'durationMs'])
    assert.equal(view.nodes.filter(n => n.props['data-hop-index']).length, 40, 'no 12-row preview truncation')
    assert.equal(view.nodes.filter(n => n.type === 'td').length, 440)
    assert.deepEqual(view.nodes.filter(n => n.type === 'td').slice(0, 11).map(text), ['1', 'initial', '200', '503', 'stream', '1500', '0', 'false', 'STOP', 'UNAVAILABLE', '321'])
    assert.ok(view.text.includes(f.dictionary.diagHopsDroppedPrefix + '2' + f.dictionary.diagHopsDroppedSuffix))
    const disclosure = view.nodes.find(n => n.type === 'details' && n.children.some(c => c?.type === 'summary' && text(c) === f.dictionary.inspectorSummary))
    assert.ok(disclosure); assert.equal(disclosure.props.open, undefined)
    assert.ok(text(disclosure).includes('settlementSeq')); assert.ok(text(disclosure).includes('reportedInputTokens'))
    assert.equal(button(view, f.dictionary.inspectorRaw).props['aria-expanded'], false)
    assert.deepEqual(f.calls.map(c => c.method), ['listRequests', 'getRequest'])
  } finally { await f.close() }
})

for (const tokenUsage of [undefined, {}, { reportedInputTokens: null, reportedCacheTokens: -1, outputTokens: '7', thoughtsTokens: NaN, totalTokens: Infinity }]) test('Debug never invents unknown token watermarks: ' + JSON.stringify(tokenUsage), async () => {
  const f = fixture()
  f.handlers.getRequest = async () => ({ ...detail(), record: { ...row(), hopCount: 1, tokenUsage, hops: [{}] } })
  try {
    let view = await f.settle(); await choose(view); view = await f.settle()
    assert.equal(text(watermark(view)), 'In: — · Cache: — · Out: — · Think: — · Total: —')
    assert.equal(view.nodes.filter(n => n.type === 'td').length, 11)
    assert.ok(view.nodes.filter(n => n.type === 'td').every(n => text(n) === f.dictionary.inspectorUnknown))
  } finally { await f.close() }
})

test('Debug uses tokenUsage watermark verbatim without summing hops or substituting old ledgers', async () => {
  const f = fixture()
  const record = { ...row(), hopCount: 2, tokenUsage: { reportedInputTokens: 0, reportedCacheTokens: 0, outputTokens: 0, thoughtsTokens: 0, totalTokens: 0, billedPromptTokens: null, billedTotalTokens: 0 }, hops: [hop(1), hop(2)] }
  Object.defineProperty(record, 'usageDetails', { get() { throw Error('Retired usage ledger accessed') } })
  f.handlers.getRequest = async () => ({ ...detail(), record })
  try {
    let view = await f.settle(); await choose(view); view = await f.settle()
    assert.equal(text(watermark(view)), 'In: 0 · Cache: 0 · Out: 0 · Think: 0 · Total: 0 · Billed In: — · Billed Total: 0')
  } finally { await f.close() }
})

for (const patch of [{ route: 'google-generative-ai', model: 'gemini-4-argon-proxy' }, { route: 'google-generative-ai', model: 'gemini-3.8-flash-proxy' }, { route: 'antigravity-proxy' }]) test('proxy is visibly distinct while retained backend route stays unchanged: ' + JSON.stringify(patch), async () => {
  const f = fixture(), record = { ...row(), ...patch }
  const before = plain(record)
  f.handlers.listRequests = async () => ({ ok: true, records: [record] }); f.handlers.getRequest = async () => ({ ...detail(), record })
  try {
    let view = await f.settle()
    assert.ok(text(view.nodes.find(n => n.props['data-request-id'] === requestId)).includes('Antigravity Proxy'))
    assert.ok(text(selectRequest(view)).includes('Antigravity Proxy'))
    await choose(view); view = await f.settle()
    assert.ok(text(view.nodes.find(n => n.props['data-summary-field'] === 'route')).includes('Antigravity Proxy'))
    assert.deepEqual(record, before)
  } finally { await f.close() }
})

test('retired dashboards have no component, CSS, text, permission or RPC surface', async () => {
  assert.doesNotMatch(source, /DiagnosticsPanel|ScopeOverview|UsageEvidence|extractTokenMix|TokenMixVisual|OVERVIEW_CSS|getOverview|ag-kpi|ag-donut|ag-metric|inspectorEstimateBadge|USD/)
  for (const language of ['zh', 'en']) {
    const f = fixture({ language })
    try {
      await f.settle()
      assert.ok(f.permissions.every(p => !p.endsWith('/getOverview')))
      assert.ok(f.mounted.descriptors.every(d => !['getOverview', 'listRecent'].includes(d.method)))
      assert.ok(Object.keys(f.dictionary).every(key => !/Overview|Kpi|TokenMix|Chart|Estimate|Subtotal|Billing/.test(key)))
    } finally { await f.close() }
  }
})

test('request list keeps intrinsic button height and hop table owns horizontal scrolling', () => {
  const css = JSON.parse(source.match(/const INSPECTOR_CSS = ("[^\n]+")/)[1])
  const rule = css.match(/\.argon-inspector \.ag-request-item\{([^}]+)\}/)[1]
  assert.match(rule, /flex:0 0 auto/); assert.match(rule, /height:auto/); assert.match(rule, /white-space:normal/)
  assert.match(css, /\.ag-hop-scroll\{overflow:auto/)
})
