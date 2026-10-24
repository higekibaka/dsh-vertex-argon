import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture, button, deferred, detail, row, requestId, secondId, tick, selectRequest } from './client-inspector-fixture.mjs'

const choose = (view, id = requestId) => view.nodes.find(node => node.props['data-request-id'] === id).props.onClick()
const selectedSummary = view => view.nodes.find(node => node.props['data-summary-field'] === 'id')

for (const forbidden of ['getRequest', 'readResponse', 'listRequests']) test('Debug refuses denied endpoint and retained callbacks: ' + forbidden, async () => {
  const f = fixture()
  try {
    let view = await f.settle(); const select = () => choose(view)
    await select(); view = await f.settle()
    const oldRaw = button(view, f.dictionary.inspectorRaw).props.onClick
    const oldRefresh = button(view, f.dictionary.inspectorRefresh).props.onClick
    const oldSelect = view.nodes.find(node => node.props['data-request-id'] === requestId).props.onClick
    f.state.access = endpoint => endpoint !== 'vertexArgonDiagnostics/' + forbidden
    view = await f.settle(); const before = f.calls.length
    await oldRaw(); await oldRefresh(); await oldSelect()
    assert.equal(f.calls.length, before, 'revoked surface callbacks cannot escape remount')
    assert.equal(selectedSummary(view), undefined)
    assert.ok(f.permissions.every(endpoint => !endpoint.endsWith('/getOverview')))
  } finally { await f.close() }
})

test('refresh immediately invalidates old list callbacks and hides previous details/raw data', async () => {
  const f = fixture(), pending = deferred()
  try {
    let view = await f.settle(); await choose(view); view = await f.settle()
    await button(view, f.dictionary.inspectorRaw).props.onClick(); view = await f.settle()
    assert.ok(view.text.includes('<script>not executed</script>'))
    const oldSelect = view.nodes.find(n => n.props['data-request-id'] === secondId).props.onClick
    const oldRaw = button(view, f.dictionary.inspectorRaw).props.onClick
    f.handlers.listRequests = () => pending.promise
    const work = button(view, f.dictionary.inspectorRefresh).props.onClick(); await tick()
    view = f.draw(); assert.equal(selectedSummary(view), undefined); assert.ok(!view.text.includes('<script>not executed</script>'))
    const before = f.calls.length; await oldSelect(); await oldRaw(); assert.equal(f.calls.length, before)
    pending.resolve({ ok: true, records: [row(secondId)] }); await work; view = await f.settle()
    assert.equal(selectRequest(view).props.value, '')
    assert.ok(view.text.includes(f.dictionary.inspectorSelectionMissing))
    await oldSelect(); view = await f.settle(); assert.equal(selectRequest(view).props.value, secondId)
  } finally { pending.resolve({ ok: false, error: 'stopped' }); await f.close() }
})

test('same selection is explicitly reread after refresh, not left with a stale record', async () => {
  const f = fixture()
  let version = 'first-version'
  f.handlers.getRequest = async () => ({ ...detail(), record: { ...row(), marker: version } })
  try {
    let view = await f.settle(); await choose(view); view = await f.settle(); assert.ok(view.text.includes('first-version'))
    version = 'second-version'; await button(view, f.dictionary.inspectorRefresh).props.onClick(); view = await f.settle()
    assert.ok(!view.text.includes('first-version')); assert.ok(view.text.includes('second-version'))
    assert.equal(selectRequest(view).props.value, requestId)
    assert.deepEqual(f.calls.map(call => call.method), ['listRequests', 'getRequest', 'listRequests', 'getRequest'])
  } finally { await f.close() }
})

test('out-of-order list refresh cannot replace the newest local snapshot', async () => {
  const f = fixture(), first = deferred(), second = deferred()
  try {
    const view = await f.settle(); let count = 0
    f.handlers.listRequests = () => ++count === 1 ? first.promise : second.promise
    const refresh = button(view, f.dictionary.inspectorRefresh).props.onClick
    const one = refresh(); await tick(); const two = refresh(); await tick()
    second.resolve({ ok: true, records: [row(secondId)] }); await two
    first.resolve({ ok: true, records: [row()] }); await one
    const result = await f.settle()
    assert.deepEqual(result.nodes.filter(n => n.props['data-request-id']).map(n => n.props['data-request-id']), [secondId])
  } finally { first.resolve({ ok: false, error: 'stopped' }); second.resolve({ ok: false, error: 'stopped' }); await f.close() }
})

for (const records of [null, [null], [{ id: 'bad' }], [row(), row()]]) test('malformed refreshed list fails closed without making old selection actionable: ' + JSON.stringify(records), async () => {
  const f = fixture()
  try {
    let view = await f.settle(); await choose(view); view = await f.settle()
    const oldSelect = view.nodes.find(n => n.props['data-request-id'] === requestId).props.onClick
    f.handlers.listRequests = async () => ({ ok: true, records })
    await button(view, f.dictionary.inspectorRefresh).props.onClick(); view = await f.settle()
    assert.ok(view.text.includes(f.dictionary.inspectorError)); assert.equal(selectedSummary(view), undefined)
    const before = f.calls.length; await oldSelect(); assert.equal(f.calls.length, before)
  } finally { await f.close() }
})

test('refresh cancels pending detail acceptance before a removed request returns', async () => {
  const f = fixture(), pending = deferred()
  try {
    let view = await f.settle(); f.handlers.getRequest = () => pending.promise
    const work = choose(view); await tick()
    f.handlers.listRequests = async () => ({ ok: true, records: [] })
    await button(f.draw(), f.dictionary.inspectorRefresh).props.onClick()
    pending.resolve({ ...detail(), record: { ...row(), marker: 'late-removed-request' } }); await work
    view = await f.settle(); assert.equal(selectedSummary(view), undefined); assert.ok(!view.text.includes('late-removed-request'))
  } finally { pending.resolve(detail()); await f.close() }
})
