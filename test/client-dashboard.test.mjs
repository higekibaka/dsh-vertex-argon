import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'
import { createUsageDetails } from '../usage-details.js'
import { createArgonDiagnosticTracker } from '../diagnostics.js'
import { estimateDiagnosticCost } from '../pricing.js'
import { fixture, button, deferred, plain, row, requestId, secondId, tick } from './client-inspector-fixture.mjs'

// Expose only the existing pure function in a test VM. Keep its real factory
// closure and helpers; never copy the implementation or modify the source file.
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

test('timeline cards retain content height inside the bounded scrolling flex list', () => {
  const css = JSON.parse(source.match(/const INSPECTOR_CSS = ("[^\n]+")/)[1])
  const rule = css.match(/\.argon-inspector \.ag-request-item\{([^}]+)\}/)[1]
  assert.match(rule, /(?:^|;)flex:0 0 auto(?:;|$)/)
  assert.match(rule, /(?:^|;)height:auto(?:;|$)/)
  assert.match(rule, /(?:^|;)white-space:normal(?:;|$)/)
})
const marker = 'function extractTokenMix(record) {'
assert.equal(source.split(marker).length, 2, 'one production token-mix function')
let declaration
const sandbox = { window: { __ModuleLoader__: { load: value => { declaration = value } } } }
vm.runInNewContext(source.replace(marker, 'globalThis.testExtractTokenMix = extractTokenMix;\n' + marker), sandbox)
declaration.factory(name => { assert.equal(name, 'react'); return { createElement() {} } })
const mixOf = record => plain(sandbox.testExtractTokenMix(record))
const segment = (mix, key) => {
  const found = mix.segments.find(value => value.key === key)
  assert.ok(found, 'segment: ' + key)
  return found
}
const counts = mix => Object.fromEntries(mix.segments.map(value => [value.key, value.count]))
const noPercentages = mix => {
  assert.ok(mix.segments.every(value => value.pct === null), 'incomplete/inconsistent counts must not claim proportions')
}
const gcRaw = (patch = {}) => ({ promptTokenCount: 100, cachedContentTokenCount: 20, candidatesTokenCount: 25, thoughtsTokenCount: 10, toolUsePromptTokenCount: 5, totalTokenCount: 140, ...patch })
const iaRaw = (patch = {}) => ({ total_input_tokens: 1000, total_cached_tokens: 200, total_output_tokens: 250, total_thought_tokens: 100, total_tool_use_tokens: 50, total_tokens: 1400, ...patch })
function baseRecord(protocol, usageDetails, patch = {}) {
  return { ...row(), schemaVersion: 2, model: 'gemini-4-argon', protocol, hopCount: protocol === 'generate-content' ? usageDetails.rows.filter(value => value.kind === 'gc-hop').length : 1, serviceTier: { requested: 'standard', observed: 'standard' }, usageDetails, durationMs: 1234, ...patch }
}
function gcRecord(raws = [gcRaw()], patch = {}) {
  const ledger = createUsageDetails()
  raws.forEach((raw, i) => ledger.recordRow('gc-hop', i + 1, 'generate-content', raw, true, 'standard'))
  return baseRecord('generate-content', ledger.snapshot(), patch)
}
function iaRecord(raw = iaRaw(), patch = {}) {
  const ledger = createUsageDetails()
  ledger.recordAggregate('interactions', raw); ledger.completeAggregate()
  return baseRecord('interactions', ledger.snapshot(), patch)
}
function response(record) {
  return { ok: true, status: 'available', association: 'unassociated', record, cost: estimateDiagnosticCost(record) }
}
const hasClass = (node, value) => (node.props.className ?? '').split(/\s+/).includes(value)
const nodesWith = (view, value) => view.nodes.filter(node => hasClass(node, value))
function kpi(view, metric) {
  const found = nodesWith(view, 'ag-kpi-value').find(node => node.props['data-metric'] === metric)
  assert.ok(found, 'selected-request KPI: ' + metric)
  return textOf(found)
}
const textOf = node => (node.children ?? []).map(child => typeof child === 'string' || typeof child === 'number' ? String(child) : child && typeof child === 'object' ? textOf(child) : '').join(' ')
function requestButton(view, id = requestId) {
  const found = nodesWith(view, 'ag-request-item').find(node => node.props['data-request-id'] === id)
  assert.ok(found, 'request button: ' + id)
  assert.equal(found.type, 'button')
  assert.equal(found.props.type, 'button')
  return found
}
async function selectedView(f, record) {
  f.handlers.listRequests = async () => ({ ok: true, records: [row(record.id)] })
  f.handlers.getRequest = async () => response(record)
  const view = await f.settle()
  await requestButton(view, record.id).props.onClick()
  return f.settle()
}

test('dashboard GC consumes tracker v2 hop rows once, not aggregate or prior SSE samples', () => {
  let record
  const tracker = createArgonDiagnosticTracker({ protocol: 'generate-content', route: 'google-generative-ai', requestedServiceTier: 'standard' }, value => { record = value })
  for (let i = 1; i <= 2; i++) {
    const hop = tracker.beginHop({ hopIndex: i, trigger: i === 1 ? 'initial' : 'continuation', usedContinuationToken: i === 2 })
    tracker.recordUsageRow('gc-hop', i, 'generate-content', gcRaw({ candidatesTokenCount: 1 }), false, 'standard')
    tracker.recordUsageRow('gc-hop', i, 'generate-content', i === 1 ? gcRaw() : gcRaw({ promptTokenCount: 200, cachedContentTokenCount: 80, candidatesTokenCount: 50, thoughtsTokenCount: 20, toolUsePromptTokenCount: 10, totalTokenCount: 280 }), true, 'standard')
    hop.finish({ finishReason: 'STOP' })
  }
  tracker.recordUsageAggregate('generate-content', gcRaw({ totalTokenCount: 99999 }))
  tracker.recordUsageRow('interaction-step', 0, 'interactions', iaRaw(), true)
  tracker.completeUsageAggregate(); tracker.finishStream({ outcome: 'done' })
  assert.equal(record.usageDetails.rows.filter(value => value.kind === 'gc-hop').length, 2)
  const mix = mixOf(record)
  assert.deepEqual(counts(mix), { uncached: 200, cached: 100, reasoning: 30, output: 75, tool: 15 })
  assert.equal(mix.total, 420)
  assert.ok(Math.abs(mix.cacheHitPct - 100 / 3) < 1e-10)
  for (const value of mix.segments) assert.ok(Math.abs(value.pct - value.count / 420 * 100) < 1e-10)
})

test('dashboard IA uses normalized aggregate once and never adds interaction steps', () => {
  const record = iaRecord()
  const ledger = createUsageDetails()
  ledger.recordAggregate('interactions', iaRaw()); ledger.completeAggregate()
  ledger.recordRow('interaction-step', 0, 'interactions', iaRaw(), true)
  ledger.recordRow('interaction-step', 1, 'interactions', iaRaw({ total_input_tokens: 9000 }), true)
  record.usageDetails = ledger.snapshot()
  const mix = mixOf(record)
  assert.deepEqual(counts(mix), { uncached: 800, cached: 200, reasoning: 100, output: 250, tool: 50 })
  assert.equal(mix.total, 1400)
  assert.equal(mix.cacheHitPct, 20)
  assert.equal(mix.segments.reduce((sum, value) => sum + value.count, 0), mix.total)
})

for (const [protocol, factory, fields] of [
  ['GC', raw => gcRecord([gcRaw(), gcRaw(raw)]), [['promptTokenCount', 'uncached'], ['cachedContentTokenCount', 'cached'], ['candidatesTokenCount', 'output'], ['thoughtsTokenCount', 'reasoning'], ['toolUsePromptTokenCount', 'tool'], ['totalTokenCount', null]]],
  ['IA', raw => iaRecord(iaRaw(raw)), [['total_input_tokens', 'uncached'], ['total_cached_tokens', 'cached'], ['total_output_tokens', 'output'], ['total_thought_tokens', 'reasoning'], ['total_tool_use_tokens', 'tool'], ['total_tokens', null]]],
]) {
  for (const [field, key] of fields) test(`dashboard ${protocol} ${field}=null remains unknown instead of zero or a partial sum`, () => {
    const mix = mixOf(factory({ [field]: null }))
    if (key) assert.equal(segment(mix, key).count, null)
    else assert.equal(mix.total, null, 'a missing total must never be synthesized from components')
    if (key) assert.equal(mix.total, protocol === 'GC' ? 280 : 1400, 'known fields remain available')
    if (key !== 'output') assert.equal(segment(mix, 'output').count, protocol === 'GC' ? 50 : 250)
    else assert.equal(segment(mix, 'reasoning').count, protocol === 'GC' ? 20 : 100)
    noPercentages(mix)
    if (field.includes('input') || field.includes('prompt') || field.includes('cached')) assert.equal(mix.cacheHitPct, null)
  })
}

const screenshotRaw = () => gcRaw({ promptTokenCount: 116679, cachedContentTokenCount: 111536, candidatesTokenCount: 103, thoughtsTokenCount: 567, toolUsePromptTokenCount: undefined, totalTokenCount: 117349 })

test('dashboard charts recorded screenshot parts and resolves omitted optional zero tool count while keeping explicit null unknown', () => {
  for (const [toolUsePromptTokenCount, expectedTool, expectedPct] of [[undefined, 0, 0], [null, null, null]]) {
    const record = gcRecord([{ ...screenshotRaw(), toolUsePromptTokenCount }]), before = structuredClone(record)
    const mix = mixOf(record)
    assert.equal(mix.chartReady, true)
    assert.deepEqual(counts(mix), { uncached: 5143, cached: 111536, output: 103, reasoning: 567, tool: expectedTool })
    assert.equal(segment(mix, 'tool').pct, expectedPct)
    for (const part of mix.segments.filter(part => part.count !== null)) assert.equal(part.pct, part.count / 117349 * 100)
    assert.equal(mix.cacheHitPct.toFixed(1), '95.6')
    assert.deepEqual(record, before, 'display must not fill in or mutate retained diagnostics')
  }
})

test('dashboard IA can chart balanced recorded parts while leaving missing tool usage unknown', () => {
  const mix = mixOf(iaRecord(iaRaw({ total_tool_use_tokens: null, total_tokens: 1350 })))
  assert.equal(mix.chartReady, true)
  assert.equal(segment(mix, 'tool').count, null)
  assert.equal(segment(mix, 'tool').pct, null)
  assert.equal(segment(mix, 'output').pct, 250 / 1350 * 100)
})

test('dashboard missing fields never hide per-hop imbalances or invalid cache subsets', () => {
  const raw = screenshotRaw()
  const cancelledTotals = gcRecord([{ ...raw, totalTokenCount: 117348 }, { ...raw, totalTokenCount: 117350 }])
  const cancelledCache = gcRecord([{ ...raw, cachedContentTokenCount: 116680 }, { ...raw, cachedContentTokenCount: 0 }])
  for (const record of [cancelledTotals, cancelledCache]) {
    assert.equal(mixOf(record).chartReady, false)
    noPercentages(mixOf(record))
  }
})

test('dashboard balanced missing fields still require a complete ledger and no hidden partial sums', () => {
  const raw = screenshotRaw(), complete = gcRecord([raw, raw])
  assert.equal(mixOf(complete).chartReady, true)
  const unfinished = gcRecord([raw]); unfinished.usageDetails.rows[0].complete = false
  const omitted = gcRecord([raw]); omitted.usageDetails.omittedRows = 1
  const missingHop = gcRecord([raw]); missingHop.hopCount = 2
  const mixedTool = gcRecord([{ ...raw, toolUsePromptTokenCount: null }, { ...raw, toolUsePromptTokenCount: 5, totalTokenCount: 117354 }])
  for (const record of [unfinished, omitted, missingHop, mixedTool, gcRecord([{ ...raw, totalTokenCount: 117350 }])]) {
    assert.equal(mixOf(record).chartReady, false)
    noPercentages(mixOf(record))
  }
})

for (const language of ['en', 'zh']) test('dashboard ' + language + ' displays missing labels and real SVG arcs for balanced recorded parts', async () => {
  for (const toolUsePromptTokenCount of [null, 0, undefined]) {
    const f = fixture({ language })
    try {
      const record = gcRecord([{ ...screenshotRaw(), toolUsePromptTokenCount }]), view = await selectedView(f, record)
      const missing = toolUsePromptTokenCount === null
      assert.equal(nodesWith(view, 'ag-donut-arc').length, 4)
      assert.deepEqual(nodesWith(view, 'ag-legend-pct').map(textOf), ['4.4%', '95.0%', '0.1%', '0.5%', missing ? '—' : '0.0%'])
      assert.equal(nodesWith(view, 'ag-legend-num').map(textOf)[4], missing ? (language === 'zh' ? '未记录' : 'Not recorded') : '0')
      assert.equal(view.text.includes(f.dictionary.inspectorChartRecordedOnly), missing)
      assert.equal(view.text.includes(f.dictionary.inspectorChartUnavailable), false)
      const arcs = nodesWith(view, 'ag-donut-arc'), values = [5143, 111536, 103, 567]
      arcs.forEach((arc, i) => assert.ok(Math.abs(Number(arc.props.strokeDasharray.split(' ')[0]) - values[i] / 117349 * 2 * Math.PI * 42) < 1e-9))
    } finally { await f.close() }
  }
})

test('dashboard resolves omitted cachedContentTokenCount and proven-zero GC candidatesTokenCount to 0', () => {
  const zeroCache = gcRecord([gcRaw({ promptTokenCount: 4895, cachedContentTokenCount: undefined, candidatesTokenCount: 1256, thoughtsTokenCount: undefined, toolUsePromptTokenCount: undefined, totalTokenCount: 6151 })])
  const mix1 = mixOf(zeroCache)
  assert.equal(mix1.chartReady, true)
  assert.equal(mix1.cacheHitPct, 0)
  assert.deepEqual(counts(mix1), { uncached: 4895, cached: 0, output: 1256, reasoning: 0, tool: 0 })
  const zeroCandidates = gcRecord([gcRaw({ promptTokenCount: 100, cachedContentTokenCount: undefined, candidatesTokenCount: undefined, thoughtsTokenCount: 20, toolUsePromptTokenCount: undefined, totalTokenCount: 120 })])
  const mix2 = mixOf(zeroCandidates)
  assert.equal(mix2.chartReady, true)
  assert.equal(mix2.cacheHitPct, 0)
  assert.deepEqual(counts(mix2), { uncached: 100, cached: 0, output: 0, reasoning: 20, tool: 0 })
})

test('dashboard strips unanswered pre-progress retry hops while keeping mid-stream failures incomplete', async () => {
  let recovered
  const tracker = createArgonDiagnosticTracker({ protocol: 'generate-content', route: 'google-vertex', regionClass: 'global', requestedServiceTier: 'standard' }, value => { recovered = value })
  const hop1 = tracker.beginHop({ hopIndex: 1, trigger: 'initial', usedContinuationToken: false })
  tracker.recordUsageRow('gc-hop', 1, 'generate-content', undefined, false)
  hop1.finish({ error: new Error('fetch failed') })
  const hop2 = tracker.beginHop({ hopIndex: 2, trigger: 'retry-original', usedContinuationToken: false })
  tracker.recordUsageRow('gc-hop', 2, 'generate-content', screenshotRaw(), true, 'standard')
  hop2.finish({ finishReason: 'STOP' })
  tracker.finishStream({ outcome: 'done' })
  const mix = mixOf(recovered)
  assert.equal(mix.chartReady, true)
  assert.equal(mix.total, 117349)
  assert.equal(mix.cacheHitPct.toFixed(1), '95.6')
  const f = fixture()
  try {
    const view = await selectedView(f, recovered)
    assert.equal(kpi(view, 'total'), (117349).toLocaleString())
    assert.equal(kpi(view, 'cache'), '95.6%')
    assert.equal(kpi(view, 'cost'), '$' + estimateDiagnosticCost(recovered).estimatedUsd.toFixed(6))
  } finally { await f.close() }
  const progressedBeforeFail = structuredClone(recovered)
  progressedBeforeFail.hops[0].chunkCount = 1
  assert.equal(mixOf(progressedBeforeFail).total, null)
  assert.equal(mixOf(progressedBeforeFail).cacheHitPct, null)
})

test('dashboard invalid per-hop relationships cannot cancel out when summed', () => {
  const badCache = gcRecord([gcRaw({ cachedContentTokenCount: 150 }), gcRaw({ promptTokenCount: 200, cachedContentTokenCount: 0, candidatesTokenCount: 50, thoughtsTokenCount: 20, toolUsePromptTokenCount: 10, totalTokenCount: 280 })])
  const mix = mixOf(badCache)
  assert.equal(mix.cacheHitPct, null)
  assert.equal(segment(mix, 'uncached').count, null)
  assert.equal(mix.total, 420)
  noPercentages(mix)
  const badTotals = gcRecord([gcRaw({ totalTokenCount: 130 }), gcRaw({ totalTokenCount: 150 })])
  assert.equal(mixOf(badTotals).total, 280)
  noPercentages(mixOf(badTotals))
})

test('dashboard cached count above input is not clamped into a fake 100% cache hit', () => {
  for (const record of [gcRecord([gcRaw({ cachedContentTokenCount: 150 })]), iaRecord(iaRaw({ total_cached_tokens: 1500 }))]) {
    const mix = mixOf(record)
    assert.equal(mix.cacheHitPct, null)
    assert.equal(segment(mix, 'uncached').count, null)
    noPercentages(mix)
  }
})

test('dashboard requires complete matching totals, not only nonnegative segment counts', () => {
  const incompleteGc = gcRecord(); incompleteGc.usageDetails.rows[0].complete = false
  const incompleteIa = iaRecord(); incompleteIa.usageDetails.aggregateComplete = false
  const omitted = gcRecord(); omitted.usageDetails.omittedRows = 1
  const missingHop = gcRecord(); missingHop.hopCount = 2
  for (const record of [incompleteGc, incompleteIa, omitted, missingHop, gcRecord([gcRaw({ totalTokenCount: 141 })]), iaRecord(iaRaw({ total_tokens: 1401 }))]) noPercentages(mixOf(record))
})

test('dashboard does not substitute steps, undocumented aliases or missing aggregate for usage', () => {
  const record = iaRecord()
  record.usageDetails.rows = gcRecord().usageDetails.rows
  record.usageDetails.aggregate = null
  record.usage = { input: 123, output: 456, totalTokenCount: 579 }
  const mix = mixOf(record)
  assert.equal(mix.total, null)
  assert.equal(mix.cacheHitPct, null)
  assert.ok(mix.segments.every(value => value.count === null))
  noPercentages(mix)
})

test('dashboard explicit zero counts stay zero without inventing a cache rate or drawing a chart', () => {
  const record = iaRecord(iaRaw({ total_input_tokens: 0, total_cached_tokens: 0, total_output_tokens: 0, total_thought_tokens: 0, total_tool_use_tokens: 0, total_tokens: 0 }))
  const mix = mixOf(record)
  assert.equal(mix.total, 0)
  assert.equal(mix.cacheHitPct, null)
  assert.ok(mix.segments.every(value => value.count === 0))
  noPercentages(mix)
})

for (const language of ['en', 'zh']) test(`dashboard ${language} renders real counts and suppresses incomplete chart proportions`, async () => {
  for (const record of [gcRecord(), iaRecord(), gcRecord([gcRaw({ thoughtsTokenCount: null })]), iaRecord(iaRaw({ total_tokens: null })), iaRecord(iaRaw({ total_tokens: 1401 }))]) {
    const f = fixture({ language })
    try {
      const view = await selectedView(f, record), mix = mixOf(record)
      assert.equal(nodesWith(view, 'ag-donut-val').map(textOf).join(), mix.total === null ? '—' : mix.total.toLocaleString())
      const chartable = mix.total > 0 && mix.segments.every(value => value.pct !== null)
      assert.equal(nodesWith(view, 'ag-donut-arc').length > 0, chartable)
      assert.equal(nodesWith(view, 'ag-stacked-seg').length, 0, 'avoid duplicate charts for the same breakdown')
      const legend = nodesWith(view, 'ag-legend-num').map(textOf)
      assert.deepEqual(legend, mix.segments.map(value => value.count === null ? f.dictionary.inspectorTokenNotRecorded : value.count.toLocaleString()))
      assert.deepEqual(nodesWith(view, 'ag-legend-pct').map(textOf), mix.segments.map(value => value.pct === null ? '—' : value.pct.toFixed(1) + '%'))
      assert.ok(view.text.includes(f.dictionary.inspectorBilling), 'always distinguish estimates from bills')
    } finally { await f.close() }
  }
})


test('dashboard rejects an incomplete or duplicate GC ledger instead of presenting partial totals', () => {
  const omitted = gcRecord(); omitted.usageDetails.omittedRows = 1
  const missing = gcRecord(); missing.hopCount = 2
  const duplicate = gcRecord([gcRaw(), gcRaw()]); duplicate.usageDetails.rows[1].index = 1
  for (const record of [omitted, missing, duplicate]) {
    const mix = mixOf(record)
    assert.equal(mix.total, null)
    assert.equal(mix.cacheHitPct, null)
    assert.ok(mix.segments.every(value => value.count === null))
    noPercentages(mix)
  }
})

test('dashboard preserves tiny real proportions without minimum-angle inflation', async () => {
  const f = fixture()
  try {
    const record = gcRecord([gcRaw({ promptTokenCount: 10000, cachedContentTokenCount: 1, candidatesTokenCount: 0, thoughtsTokenCount: 0, toolUsePromptTokenCount: 0, totalTokenCount: 10000 })])
    const view = await selectedView(f, record)
    const arcs = nodesWith(view, 'ag-donut-arc')
    assert.equal(arcs.length, 2)
    const smallArc = Math.min(...arcs.map(node => Number(node.props.strokeDasharray.split(' ')[0])))
    assert.ok(Math.abs(smallArc - 2 * Math.PI * 42 / 10000) < 1e-10)
    assert.equal(segment(mixOf(record), 'cached').pct, 0.01)
  } finally { await f.close() }
})

for (const language of ['en', 'zh']) test('dashboard ' + language + ' request buttons scope KPIs to the selected request, not the listed session', async () => {
  const f = fixture({ language })
  const first = gcRecord(), second = iaRecord(iaRaw({ total_cached_tokens: 700 }), { id: secondId })
  f.state.params = { sessionId: 'session-A', messageId: 'answer-A' }
  f.handlers.listRequests = async () => ({ ok: true, records: [row(), row(secondId)] })
  f.handlers.getRequest = async request => response(request.requestId === requestId ? first : second)
  try {
    let view = await f.settle()
    assert.deepEqual(plain(f.calls[0].args[0]), { sessionId: 'session-A', messageId: 'answer-A', limit: 100 })
    assert.equal(kpi(view, 'requests'), '2')
    assert.equal(nodesWith(view, 'ag-kpi-value').filter(node => ['total', 'cache', 'cost'].includes(node.props['data-metric'])).length, 0)
    assert.deepEqual(f.calls.map(call => call.method), ['getOverview'], 'no latest-request guess or automatic detail fanout')
    for (const record of [first, second]) {
      await requestButton(view, record.id).props.onClick(); view = await f.settle()
      assert.deepEqual(plain(f.calls.at(-1).args[0]), { sessionId: 'session-A', requestId: record.id })
      assert.equal(requestButton(view, record.id).props['aria-pressed'], true)
      assert.equal(requestButton(view, record.id === requestId ? secondId : requestId).props['aria-pressed'], false)
      assert.equal(kpi(view, 'requests'), '2')
      assert.equal(kpi(view, 'total'), record.id === requestId ? '140' : (1400).toLocaleString())
      assert.equal(kpi(view, 'cache'), record.id === requestId ? '20.0%' : '70.0%')
      assert.equal(kpi(view, 'cost'), '$' + estimateDiagnosticCost(record).estimatedUsd.toFixed(6))
      assert.ok(view.text.includes(f.dictionary.inspectorSelectedScope))
    }
    assert.deepEqual(f.calls.map(call => call.method), ['getOverview', 'getRequest', 'getRequest'])
  } finally { await f.close() }
})

test('dashboard unknown cost remains unknown even when a nonzero subtotal exists; explicit zero remains zero', async () => {
  for (const zero of [false, true]) {
    const f = fixture()
    const record = zero
      ? iaRecord(iaRaw({ total_input_tokens: 0, total_cached_tokens: 0, total_output_tokens: 0, total_thought_tokens: 0, total_tool_use_tokens: 0, total_tokens: 0 }))
      : iaRecord(iaRaw({ total_cached_tokens: null, total_tokens: null }))
    const cost = estimateDiagnosticCost(record)
    if (!zero) { assert.equal(cost.estimatedUsd, null); assert.ok(cost.knownSubtotalUsd > 0) }
    try {
      const view = await selectedView(f, record)
      assert.equal(kpi(view, 'total'), zero ? '0' : '—')
      assert.equal(kpi(view, 'cache'), '—')
      assert.equal(kpi(view, 'cost'), zero ? '$0.000000' : '—')
      assert.equal(nodesWith(view, 'ag-donut-arc').length, 0)
    } finally { await f.close() }
  }
})

test('dashboard request buttons enforce detail permission and invalidate an old callback after revocation', async () => {
  const f = fixture({ access: endpoint => endpoint !== 'vertexArgonDiagnostics/getRequest' })
  try {
    let view = await f.settle()
    const denied = requestButton(view)
    assert.equal(denied.props.disabled, true)
    await denied.props.onClick()
    assert.deepEqual(f.calls.map(call => call.method), ['getOverview'])
    f.state.access = true; view = await f.settle()
    const previous = requestButton(view).props.onClick
    await previous(); view = await f.settle()
    assert.equal(requestButton(view).props['aria-pressed'], true)
    f.state.access = endpoint => endpoint !== 'vertexArgonDiagnostics/getRequest'
    view = await f.settle()
    const before = f.calls.length
    await previous(); await requestButton(view).props.onClick()
    assert.equal(f.calls.length, before, 'stale or disabled callback cannot bypass live permissions')
    assert.equal(nodesWith(view, 'ag-kpi-value').filter(node => node.props['data-metric'] === 'total').length, 0)
  } finally { await f.close() }
})

test('dashboard selecting another request supersedes pending details and never paints late KPIs', async () => {
  const f = fixture(), pending = deferred()
  const current = iaRecord(iaRaw({ total_cached_tokens: 700 }), { id: secondId })
  f.handlers.getRequest = request => request.requestId === requestId ? pending.promise : Promise.resolve(response(current))
  try {
    let view = await f.settle()
    const old = requestButton(view).props.onClick()
    await tick(); view = await f.settle()
    assert.equal(requestButton(view, secondId).props.disabled, false, 'another request remains selectable while detail loads')
    await requestButton(view, secondId).props.onClick()
    pending.resolve(response(gcRecord())); await old
    view = await f.settle()
    assert.equal(requestButton(view, secondId).props['aria-pressed'], true)
    assert.equal(kpi(view, 'total'), (1400).toLocaleString())
    assert.equal(kpi(view, 'cache'), '70.0%')
    assert.equal(kpi(view, 'cost'), '$' + estimateDiagnosticCost(current).estimatedUsd.toFixed(6))
    assert.deepEqual(f.calls.map(call => call.method), ['getOverview', 'getRequest', 'getRequest'])
  } finally { pending.resolve(response(gcRecord())); await f.close() }
})

test('dashboard late details cannot restore selected KPIs after permission, navigation, hide or reset', async () => {
  for (const reason of ['permission', 'navigation', 'hide', 'reset']) {
    const f = fixture(), pending = deferred()
    f.handlers.getRequest = () => pending.promise
    try {
      let view = await f.settle()
      const previous = requestButton(view).props.onClick
      const work = previous(); await tick()
      if (reason === 'permission') f.state.access = false
      if (reason === 'navigation') { f.state.params = { sessionId: 'session-A', messageId: 'another-answer' }; f.state.revision++ }
      if (reason === 'hide') f.state.visible = false
      if (reason === 'reset') f.reset()
      await f.settle()
      pending.resolve(response(gcRecord())); await work
      view = await f.settle()
      assert.equal(nodesWith(view, 'ag-kpi-value').filter(node => node.props['data-metric'] === 'total').length, 0, reason)
      const before = f.calls.length; await previous()
      assert.equal(f.calls.length, before, reason + ': old request button is inert')
    } finally { pending.resolve(response(gcRecord())); await f.close() }
  }
})

test('dashboard refresh removing a selected request clears KPIs and invalidates its old button', async () => {
  const f = fixture()
  try {
    let view = await selectedView(f, gcRecord())
    const previous = requestButton(view).props.onClick
    f.handlers.listRequests = async () => ({ ok: true, records: [row(secondId)] })
    await button(view, f.dictionary.inspectorRefresh).props.onClick(); view = await f.settle()
    assert.equal(nodesWith(view, 'ag-kpi-value').filter(node => node.props['data-metric'] === 'total').length, 0)
    assert.ok(view.text.includes(f.dictionary.inspectorSelectionMissing))
    const before = f.calls.length; await previous()
    assert.equal(f.calls.length, before)
    assert.equal(requestButton(view, secondId).props['aria-pressed'], false)
  } finally { await f.close() }
})
