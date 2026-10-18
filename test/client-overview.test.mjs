import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createUsageDetails } from '../usage-details.js'
import { estimateDiagnosticCost } from '../pricing.js'
import { summarizeRequestOverview } from '../inspector-overview.js'
import { fixture, button, deferred, detail, plain, row, requestId, secondId, tick } from './client-inspector-fixture.mjs'

const tokenKeys = ['inputTokens', 'cachedTokens', 'outputTokens', 'thoughtTokens', 'toolTokens', 'totalTokens']
const metricNames = ['overview-total', 'overview-cache', 'overview-cost']
const textOf = node => (node?.children ?? []).map(child => typeof child === 'string' || typeof child === 'number' ? String(child) : child && typeof child === 'object' ? textOf(child) : '').join(' ')
const walk = node => [node, ...(node?.children ?? []).filter(child => child && typeof child === 'object').flatMap(walk)]
const hasClass = (node, name) => (node.props?.className ?? '').split(/\s+/).includes(name)
const metricNode = (view, name) => view.nodes.find(node => hasClass(node, 'ag-kpi-value') && node.props['data-metric'] === name)
const metric = (view, name) => { const node = metricNode(view, name); assert.ok(node, name); return textOf(node) }
const overviewNode = view => view.nodes.find(node => node.type === 'section' && node.props['data-overview'] === true)
const overviewText = view => textOf(overviewNode(view))
const choose = (view, id) => { const node = view.nodes.find(node => node.type === 'button' && node.props['data-request-id'] === id); assert.ok(node, id); return node.props.onClick() }
const absentValues = view => { for (const name of metricNames) assert.ok(!metricNode(view, name) || textOf(metricNode(view, name)) === '—', name + ': no available snapshot') }
const money = amount => '$' + amount.toFixed(6)
function record(id, input = 100, cached = 20, patch = {}) {
  const ledger = createUsageDetails()
  ledger.recordAggregate('interactions', { total_input_tokens: input, total_cached_tokens: cached, total_output_tokens: input / 4, total_thought_tokens: input / 10, total_tool_use_tokens: input / 20, total_tokens: input * 1.4, ...patch })
  ledger.completeAggregate()
  return { ...row(id), schemaVersion: 2, protocol: 'interactions', model: 'gemini-4-argon', hopCount: 1, serviceTier: { requested: 'standard', observed: 'standard' }, usageDetails: ledger.snapshot() }
}
const records = () => [record(requestId), record(secondId, 900, 480)]
async function snapshot(values = records(), window = {}) {
  const metadata = values.map(({ id, startedAt, route, protocol, outcome, association }) => ({ id, startedAt, route, protocol, outcome, association }))
  return { ok: true, records: metadata, overview: summarizeRequestOverview(values, { limit: 100, limited: false, ...window }) }
}
function installSnapshot(f, result) {
  f.handlers.getOverview = async () => result
  f.handlers.listRequests = async () => { throw new Error('Unexpected list RPC when overview is authorized') }
}

for (const language of ['en', 'zh']) test('overview ' + language + ' is visible before selection from one metadata/summary snapshot with no N+1', async () => {
  const f = fixture({ language }), result = await snapshot()
  installSnapshot(f, result)
  try {
    const view = await f.settle(), section = overviewNode(view)
    assert.ok(section, 'current-scope overview section')
    assert.equal(section.props['aria-label'], language === 'zh' ? '当前范围总览' : 'Current scope overview')
    assert.notEqual(section.props.hidden, true)
    assert.ok(!view.nodes.filter(node => node.type === 'details').some(node => walk(node).includes(section)), 'overview is not hidden in a disclosure')
    assert.deepEqual(f.calls.map(call => call.method), ['getOverview'])
    assert.deepEqual(plain(f.calls[0].args[0]), { sessionId: 'session-A', limit: 100 })
    assert.equal(metric(view, 'requests'), '2')
    assert.equal(metric(view, 'overview-total'), (1400).toLocaleString())
    assert.equal(metric(view, 'overview-cache'), '50.0%', 'weighted input/cache pairs, not mean of request rates')
    assert.equal(metric(view, 'overview-cost'), money(result.overview.cost.estimatedUsd))
    assert.ok(overviewText(view).includes('2/2') || overviewText(view).includes('2 / 2'), 'coverage is explicit')
    for (const key of tokenKeys.filter(key => key !== 'totalTokens')) {
      const field = view.nodes.find(node => node.type === 'dd' && node.props['data-metric'] === 'overview-' + key)
      assert.ok(field, 'visible breakdown: ' + key)
      assert.equal(textOf(field), result.overview.tokens[key].knownSubtotal.toLocaleString())
      const line = walk(section).find(node => node.children?.includes(field))
      assert.ok(line, key + ' belongs to the overview section')
      assert.ok(textOf(line).includes('2/2') || textOf(line).includes('2 / 2'), key + ' coverage')
    }
    assert.ok(result.records.every(value => !Object.hasOwn(value, 'usageDetails')), 'overview RPC does not fan out request payloads')
    await f.settle(); await f.settle()
    assert.equal(f.calls.length, 1, 'stable renders do not poll')
  } finally { await f.close() }
})

for (const language of ['en', 'zh']) test('overview ' + language + ' stays scoped to all listed requests while selection changes', async () => {
  const f = fixture({ language }), values = records(), result = await snapshot(values)
  installSnapshot(f, result)
  f.handlers.getRequest = async request => { const found = values.find(value => value.id === request.requestId); return { ...detail(found.id), record: found, cost: estimateDiagnosticCost(found) } }
  try {
    let view = await f.settle()
    const before = metricNames.map(name => metric(view, name)), text = overviewText(view)
    for (const value of values) {
      await choose(view, value.id); view = await f.settle()
      assert.deepEqual(metricNames.map(name => metric(view, name)), before)
      assert.equal(overviewText(view), text)
      assert.equal(metric(view, 'total'), value.usageDetails.aggregate.totalTokens.toLocaleString())
      assert.ok(view.text.includes(f.dictionary.inspectorSelectedScope))
    }
    assert.deepEqual(f.calls.map(call => call.method), ['getOverview', 'getRequest', 'getRequest'])
  } finally { await f.close() }
})

for (const language of ['en', 'zh']) test('overview ' + language + ' labels partial coverage and never substitutes zero or an incomplete cache ratio', async () => {
  const f = fixture({ language }), values = [record(requestId), { ...row(secondId), protocol: 'interactions' }], result = await snapshot(values)
  installSnapshot(f, result)
  try {
    const view = await f.settle(), text = overviewText(view)
    assert.equal(result.overview.tokens.totalTokens.knownSubtotal, 140)
    assert.equal(metric(view, 'overview-total'), '140')
    assert.equal(metric(view, 'overview-cache'), '—')
    assert.equal(metric(view, 'overview-cost'), money(result.overview.cost.knownSubtotalUsd))
    assert.ok(text.includes(language === 'zh' ? '已知小计' : 'Known subtotal'))
    assert.ok(text.includes('1/2') || text.includes('1 / 2'))
    assert.equal(result.overview.cost.estimatedUsd, null)
    assert.equal(result.overview.cache.percent, null)
    for (const key of tokenKeys.filter(key => key !== 'totalTokens')) {
      const field = view.nodes.find(node => node.type === 'dd' && node.props['data-metric'] === 'overview-' + key)
      assert.ok(field, key)
      assert.equal(textOf(field), result.overview.tokens[key].knownSubtotal.toLocaleString())
      const line = walk(overviewNode(view)).find(node => node.children?.includes(field))
      assert.ok(textOf(line).includes('1/2') || textOf(line).includes('1 / 2'), key + ' partial coverage')
    }
  } finally { await f.close() }
})

for (const language of ['en', 'zh']) test('overview ' + language + ' empty retained scope is unknown rather than a zero bill', async () => {
  const f = fixture({ language }); installSnapshot(f, await snapshot([]))
  try {
    const view = await f.settle()
    assert.ok(overviewNode(view))
    assert.equal(metric(view, 'requests'), '0')
    for (const name of metricNames) assert.equal(metric(view, name), '—')
    assert.ok(!overviewText(view).includes('$0'))
    assert.ok(view.text.includes(f.dictionary.inspectorEmpty))
  } finally { await f.close() }
})

test('overview uses request bounds and reports retained-window truncation without claiming lifetime totals', async () => {
  const f = fixture(), values = records()
  values[0].startedAt = '2026-10-18T01:00:00.000Z'
  values[1].startedAt = '2026-10-18T02:00:00.000Z'
  const result = await snapshot(values, { limit: 100, limited: true })
  installSnapshot(f, result)
  try {
    f.state.params = { sessionId: 'session-A', messageId: 'answer-A' }
    const view = await f.settle(), text = overviewText(view)
    assert.deepEqual(plain(f.calls[0].args[0]), { sessionId: 'session-A', messageId: 'answer-A', limit: 100 })
    assert.ok(text.includes('100') && text.includes('200'), 'query limit and retained-window ceiling remain distinct')
    assert.ok(text.includes('01:00') && text.includes('02:00'), 'returned snapshot range is visible')
    assert.match(text, /limited|truncat|retain/i)
    assert.equal(f.calls.length, 1)
  } finally { await f.close() }
})

for (const language of ['en', 'zh']) test('overview ' + language + ' permission denial falls back to metadata list without pretending overview is available', async () => {
  const f = fixture({ language, access: endpoint => endpoint !== 'vertexArgonDiagnostics/getOverview' })
  try {
    let view = await f.settle()
    assert.deepEqual(f.calls.map(call => call.method), ['listRequests'])
    assert.equal(metric(view, 'requests'), '2')
    assert.ok(overviewNode(view))
    assert.ok(overviewText(view).includes(language === 'zh' ? '权限' : 'permission'))
    absentValues(view)
    await button(view, f.dictionary.inspectorRefresh).props.onClick(); view = await f.settle()
    assert.deepEqual(f.calls.map(call => call.method), ['listRequests', 'listRequests'])
    assert.ok(!f.globalPermissions.includes('vertexArgonDiagnostics/getOverview'), 'overview requires session, not global authority')
  } finally { await f.close() }
})

test('overview also requires list permission and treats undefined overview access as denied', async () => {
  for (const [access, expected] of [
    [endpoint => endpoint !== 'vertexArgonDiagnostics/listRequests', []],
    [endpoint => endpoint === 'vertexArgonDiagnostics/getOverview' ? undefined : true, ['listRequests']],
  ]) {
    const f = fixture({ access })
    try {
      const view = await f.settle()
      assert.deepEqual(f.calls.map(call => call.method), expected)
      absentValues(view)
    } finally { await f.close() }
  }
})

test('overview revocation discards previously visible values and stale refresh callbacks cannot invoke it', async () => {
  const f = fixture(), result = await snapshot()
  f.handlers.getOverview = async () => result
  try {
    let view = await f.settle()
    assert.equal(metric(view, 'overview-total'), (1400).toLocaleString())
    const previousRefresh = button(view, f.dictionary.inspectorRefresh).props.onClick
    f.state.access = endpoint => endpoint !== 'vertexArgonDiagnostics/getOverview'
    view = await f.settle(); absentValues(view)
    assert.equal(f.calls.at(-1).method, 'listRequests')
    const before = f.calls.length; await previousRefresh()
    assert.equal(f.calls.length, before)
  } finally { await f.close() }
})

test('overview refresh clears the old snapshot before loading and publishes records plus totals together', async () => {
  const f = fixture(), initial = await snapshot(), pending = deferred()
  f.handlers.getOverview = async () => initial
  try {
    let view = await f.settle()
    assert.equal(metric(view, 'overview-total'), (1400).toLocaleString())
    f.handlers.getOverview = () => pending.promise
    const work = button(view, f.dictionary.inspectorRefresh).props.onClick()
    await tick(); view = await f.settle(); absentValues(view)
    assert.notEqual(metric(view, 'requests'), '2', 'old metadata cannot look current while its overview was discarded')
    const next = await snapshot([record(secondId, 200, 40)])
    pending.resolve(next); await work; view = await f.settle()
    assert.equal(metric(view, 'requests'), '1')
    assert.equal(metric(view, 'overview-total'), '280')
    assert.equal(view.nodes.some(node => node.props['data-request-id'] === requestId), false)
    assert.deepEqual(f.calls.map(call => call.method), ['getOverview', 'getOverview'])
  } finally { pending.resolve({ ok: false, error: 'cancelled' }); await f.close() }
})

for (const reason of ['permission', 'session', 'message', 'reset', 'hidden', 'cancel', 'unmount', 'mode']) test('overview late response is ignored after ' + reason, async () => {
  const f = fixture(), pending = deferred(), late = await snapshot(), replacement = await snapshot([])
  let reads = 0
  f.handlers.getOverview = () => ++reads === 1 ? pending.promise : Promise.resolve(replacement)
  try {
    f.draw(); await tick(); let view = await f.settle()
    assert.equal(reads, 1)
    if (reason === 'permission') f.state.access = endpoint => endpoint !== 'vertexArgonDiagnostics/getOverview'
    if (reason === 'session') { f.state.sessionId = 'session-B'; f.state.revision++ }
    if (reason === 'message') { f.state.params = { sessionId: 'session-A', messageId: 'answer-B' }; f.state.revision++ }
    if (reason === 'reset') f.reset()
    if (reason === 'hidden') f.state.visible = false
    if (reason === 'cancel') button(view, f.dictionary.inspectorCancel).props.onClick()
    if (reason === 'unmount') f.unmount()
    if (reason === 'mode') button(view, f.dictionary.inspectorOperations).props.onClick()
    if (reason !== 'unmount') await f.settle()
    pending.resolve(late); await tick(); await tick()
    if (reason !== 'unmount') { view = await f.settle(); absentValues(view) }
    assert.ok(!f.calls.some(call => ['getRequest', 'readResponse', 'queryInteraction', 'readQueryResponse'].includes(call.method)))
    if (reason === 'session') assert.equal(f.calls.filter(call => call.method === 'getOverview').at(-1).args[0].sessionId, 'session-B')
    if (reason === 'message') assert.equal(f.calls.filter(call => call.method === 'getOverview').at(-1).args[0].messageId, 'answer-B')
  } finally { pending.resolve({ ok: false, error: 'cancelled' }); await f.close() }
})

for (const malformed of ['count', 'missing-overview', 'failure']) test('overview ' + malformed + ' result is not published as available or empty success', async () => {
  const f = fixture(), initial = await snapshot(), invalid = structuredClone(initial)
  if (malformed === 'count') invalid.overview.requestCount++
  if (malformed === 'missing-overview') delete invalid.overview
  if (malformed === 'failure') { invalid.ok = false; invalid.error = 'private-server-marker' }
  f.handlers.getOverview = async () => initial
  try {
    let view = await f.settle(); assert.equal(metric(view, 'overview-total'), (1400).toLocaleString())
    f.handlers.getOverview = async () => invalid
    await button(view, f.dictionary.inspectorRefresh).props.onClick(); view = await f.settle()
    absentValues(view)
    assert.ok(view.nodes.some(node => node.props.role === 'alert'))
    assert.ok(!view.text.includes('private-server-marker'))
    assert.ok(!view.text.includes(f.dictionary.inspectorEmpty))
    assert.deepEqual(f.calls.map(call => call.method), ['getOverview', 'getOverview'], 'failed authorized RPC does not silently retry another endpoint')
  } finally { await f.close() }
})

test('overview request codec mirrors bounded list scope but has a distinct descriptor', async () => {
  const f = fixture()
  try {
    await tick()
    const descriptor = f.mounted.descriptors.find(value => value.method === 'getOverview')
    assert.ok(descriptor)
    assert.notEqual(descriptor.parameters[0].codec.typeSymbol, f.mounted.descriptors.find(value => value.method === 'listRequests').parameters[0].codec.typeSymbol)
    const parse = descriptor.parameters[0].codec.schema.parse
    assert.deepEqual(plain(parse({ sessionId: 's', messageId: 'm' })), { sessionId: 's', messageId: 'm', limit: 20 })
    for (const request of [{ sessionId: 's', limit: 101 }, { sessionId: 's', limit: 0 }, { sessionId: 's', limit: '20' }, { sessionId: 's', requestId }, { sessionId: 's', messageId: '' }]) assert.throws(() => parse(request))
  } finally { await f.close() }
})
