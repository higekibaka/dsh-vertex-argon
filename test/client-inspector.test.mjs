import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inspectorInvocations } from '../inspector-service.js'
import { fixture as createFixture, button, selectRequest, toggle, tick, deferred, plain, row, detail, page, requestId, secondId, queryId } from './client-inspector-fixture.mjs'

function fixture(options) {
  const f = createFixture(options)
  const props = f.state
  Object.defineProperties(props, {
    messageId: { get: () => props.params?.messageId, set: messageId => { props.params = { sessionId: props.sessionId, ...(messageId ? { messageId } : {}) } } },
    navigationSession: { set: sessionId => { props.params = { sessionId } } },
  })
  return { ...f, props, draw: f.settle, get mounted() { return f.mounted }, panel: { close: f.unmount } }
}
async function lookupView(f, id = 'opaque-id') {
  let view = await f.draw()
  button(view, f.dictionary.inspectorOperations).props.onClick()
  view = await f.draw(); toggle(view, 'query')
  view = await f.draw()
  view.nodes.find(n => n.type === 'input').props.onChange({ target: { value: id } })
  return f.draw()
}

test('sidebar type and session/global permission hooks match authoritative endpoints', async () => {
  const f = fixture()
  try {
    assert.equal(f.types[0].id, 'dsh-vertex-argon/inspector')
    assert.equal(f.slots.get('sidebar.right.pane.tab').options.key, f.types[0].id)
    await f.draw()
    assert.deepEqual([...new Set(f.permissions)].sort(), ['getRequest', 'listRequests', 'readResponse'].map(x => 'vertexArgonDiagnostics/' + x).sort())
    assert.deepEqual([...new Set(f.globalPermissions)].sort(), ['queryInteraction', 'readQueryResponse', 'listRecovery', 'releaseUnknown'].map(x => 'vertexArgonDiagnostics/' + x).sort())
  } finally { await f.close() }
})

test('five strict codecs match Host descriptors, global schemas reject session authority, signal is out of JSON', async () => {
  const f = fixture()
  try {
    await tick()
    const host = inspectorInvocations()
    for (const definition of host) {
      const client = f.mounted.descriptors.find(x => x.method === definition.method)
      for (const key of ['id', 'service', 'namespace', 'method', 'invocation', 'cancellation']) assert.deepEqual(plain(client[key] ?? null), plain(definition[key] ?? null))
      assert.equal(client.parameters[0].codec.typeSymbol, definition.parameters[0].codec.typeSymbol)
      assert.equal(client.result.typeSymbol, definition.result.typeSymbol)
    }
    const parse = method => f.mounted.descriptors.find(x => x.method === method).parameters[0].codec.schema.parse
    assert.deepEqual(plain(parse('listRequests')({ sessionId: 's', messageId: 'm' })), { sessionId: 's', messageId: 'm', limit: 20 })
    assert.deepEqual(plain(parse('readResponse')({ sessionId: 's', requestId })), { sessionId: 's', requestId, index: 0, offset: 0, length: 65536 })
    for (const value of [{ route: 'google-vertex', id: 'id', sessionId: 's' }, { route: 'google-vertex', id: 'id', signal: {} }, { route: 'google-vertex', id: '..' }, { route: 'google-vertex', id: 'https://host/id' }]) assert.throws(() => parse('queryInteraction')(value))
    assert.throws(() => parse('readQueryResponse')({ queryId, sessionId: 's' }))
    assert.throws(() => parse('listRequests')({ sessionId: 's', limit: '10' }))
    assert.throws(() => parse('readResponse')({ sessionId: 's', requestId, offset: -1 }))
    assert.throws(() => parse('readResponse')({ sessionId: 's', requestId, length: 65537 }))
  } finally { await f.close() }
})

test('request selection preserves session/message scope and pages decoded raw frames explicitly', async () => {
  const f = fixture()
  try {
    f.props.messageId = 'message-A'
    let view = await f.draw()
    assert.deepEqual(plain(f.calls[0].args[0]), { sessionId: 'session-A', messageId: 'message-A', limit: 100 })
    view = await f.draw()
    assert.equal(f.calls.length, 1)
    await selectRequest(view).props.onChange({ target: { value: requestId } })
    view = await f.draw()
    assert.deepEqual(plain(f.calls[1].args[0]), { sessionId: 'session-A', requestId })
    assert.ok(view.text.includes(f.dictionary.inspectorUnassociated))
    await button(view, f.dictionary.inspectorRaw).props.onClick()
    view = await f.draw()
    assert.ok(view.text.includes(f.dictionary.inspectorPartial))
    assert.ok(view.text.includes(f.dictionary.inspectorCaptureError))
    assert.ok(view.text.includes(f.dictionary.inspectorMemory))
    assert.ok(view.text.includes('<script>not executed</script>'))
    assert.ok(!view.nodes.some(n => n.props.dangerouslySetInnerHTML))
    await button(view, f.dictionary.inspectorNextPage).props.onClick()
    assert.deepEqual(plain(f.calls.at(-1).args[0]), { sessionId: 'session-A', requestId, index: 0, offset: 65536, length: 65536 })
    view = await f.draw()
    await button(view, f.dictionary.inspectorNextFrame).props.onClick()
    assert.deepEqual(plain(f.calls.at(-1).args[0]), { sessionId: 'session-A', requestId, index: 1, offset: 0, length: 65536 })
  } finally { await f.close() }
})

test('association and locator are retained evidence, never navigation authority', async () => {
  const f = fixture({ language: 'zh' })
  f.handlers.getRequest = async () => ({ ...detail(), association: 'linked', locator: { messageId: 'm', settlementSeq: 10 } })
  try {
    let view = await f.draw()
    await selectRequest(view).props.onChange({ target: { value: requestId } }); view = await f.draw()
    assert.ok(view.text.includes(f.dictionary.inspectorAssociated))
    assert.ok(view.text.includes('settlementSeq'))
    assert.ok(view.text.includes('In: — · Cache: — · Out: — · Think: — · Total: —'))
    assert.ok(!view.nodes.some(n => n.type === 'a'), 'locator is evidence, not navigation authority')
  } finally { await f.close() }
})

test('lookup uses global route/id only and a second AbortSignal, then explicit cached-result paging', async () => {
  const f = fixture()
  try {
    let view = await lookupView(f)
    assert.deepEqual(f.calls.map(x => x.method), ['listRequests'])
    await button(view, f.dictionary.inspectorLookup).props.onClick()
    const first = f.calls.at(-1)
    assert.equal(first.method, 'queryInteraction')
    assert.deepEqual(plain(first.args[0]), { route: 'google-generative-ai', id: 'opaque-id' })
    assert.equal(first.args.length, 2)
    assert.ok(first.args[1] instanceof AbortSignal)
    assert.equal(f.calls.length, 2, 'only local list preceded explicit GET; result content is not auto-fetched')
    view = await f.draw(); await button(view, f.dictionary.inspectorReadQuery).props.onClick()
    assert.deepEqual(plain(f.calls.at(-1).args[0]), { queryId, offset: 0, length: 65536 })
    view = await f.draw(); await button(view, f.dictionary.inspectorNextPage).props.onClick()
    assert.deepEqual(plain(f.calls.at(-1).args[0]), { queryId, offset: 65536, length: 65536 })
    assert.ok(f.calls.every(call => !/cancel|generate|resume|create|import/i.test(call.method)))
  } finally { await f.close() }
})

test('invalid IDs, denied session/global reads and mismatched navigation never issue reads', async () => {
  const denied = fixture({ access: false, globalAccess: false })
  try {
    let view = await denied.draw()
    assert.equal(button(view, denied.dictionary.inspectorRefresh).props.disabled, true)
    await button(view, denied.dictionary.inspectorRefresh).props.onClick()
    view = await lookupView(denied)
    assert.equal(button(view, denied.dictionary.inspectorLookup).props.disabled, true)
    await button(view, denied.dictionary.inspectorLookup).props.onClick()
    assert.equal(denied.calls.length, 0)
    denied.props.navigationSession = 'other-session'
    assert.ok((await denied.draw()).nodes.some(n => n.props.role === 'alert'))
  } finally { await denied.close() }
  const f = fixture()
  try {
    for (const id of ['https://host/id', '../id', '.', '..', 'contains space']) {
      const view = await lookupView(f, id)
      await button(view, f.dictionary.inspectorLookup).props.onClick()
      assert.ok((await f.draw()).text.includes(f.dictionary.inspectorInvalidId))
    }
    assert.deepEqual(f.calls.map(x => x.method), ['listRequests'])
  } finally { await f.close() }
})

test('hide, unmount, navigation, permission loss, reset and tab abort cancel GET without cloud cancel', async () => {
  for (const reason of ['hide', 'unmount', 'navigation', 'permission', 'reset', 'tab-abort', 'mode', 'input', 'disclosure']) {
    const f = fixture(), pending = deferred()
    f.handlers.queryInteraction = () => pending.promise
    try {
      const view = await lookupView(f)
      const work = button(view, f.dictionary.inspectorLookup).props.onClick()
      await tick()
      const signal = f.calls.find(x => x.method === 'queryInteraction').args[1]
      assert.equal(signal.aborted, false)
      if (reason === 'hide') { f.props.visible = false; await f.draw() }
      if (reason === 'unmount') f.panel.close()
      if (reason === 'navigation') { f.props.sessionId = 'session-B'; f.props.revision++; await f.draw() }
      if (reason === 'permission') { f.props.globalAccess = false; await f.draw() }
      if (reason === 'reset') f.reset()
      if (reason === 'tab-abort') f.tabLifetime.abort()
      if (reason === 'mode') button(await f.draw(), f.dictionary.inspectorDiagnosis).props.onClick()
      if (reason === 'disclosure') toggle(await f.draw(), 'query', false)
      if (reason === 'input') (await f.draw()).nodes.find(n => n.type === 'input').props.onChange({ target: { value: 'different-id' } })
      assert.equal(signal.aborted, true, reason)
      pending.resolve({ ok: true, queryId, secretMarker: 'stale-query' })
      await work
      const after = await f.draw()
      assert.ok(!after?.text?.includes('stale-query'), reason)
      assert.equal(f.calls.filter(x => x.method === 'queryInteraction').length, 1)
    } finally { pending.resolve({ ok: false, error: 'cancelled' }); await f.close() }
  }
})

test('manual cancel and out-of-order request details never paint stale results', async () => {
  const f = fixture(), pending = deferred()
  try {
    let view = await f.draw(); await button(view, f.dictionary.inspectorRefresh).props.onClick(); view = await f.draw()
    f.handlers.getRequest = request => request.requestId === requestId ? pending.promise : Promise.resolve(detail(secondId))
    const old = selectRequest(view).props.onChange({ target: { value: requestId } })
    await tick(); view = await f.draw()
    await selectRequest(view).props.onChange({ target: { value: secondId } })
    pending.resolve({ ...detail(requestId), record: { ...row(requestId), secretMarker: 'stale-detail' } }); await old
    view = await f.draw()
    assert.ok(!view.text.includes('stale-detail'))
    const pendingQuery = deferred(); f.handlers.queryInteraction = () => pendingQuery.promise
    view = await lookupView(f)
    const work = button(view, f.dictionary.inspectorLookup).props.onClick(); await tick()
    button(await f.draw(), f.dictionary.inspectorCancel).props.onClick()
    assert.equal(f.calls.at(-1).args[1].aborted, true)
    pendingQuery.resolve({ ok: true, queryId, secretMarker: 'cancelled-result' }); await work
    view = await f.draw()
    assert.ok(view.text.includes(f.dictionary.inspectorCancelled)); assert.ok(!view.text.includes('cancelled-result'))
  } finally { pending.resolve(detail()); await f.close() }
})

test('empty message, missing raw and failed query have distinct localized states and no retry loop', async () => {
  for (const language of ['en', 'zh']) {
    const f = fixture({ language })
    try {
      f.props.messageId = 'missing-message'; f.handlers.listRequests = async () => ({ ok: true, records: [] })
      let view = await f.draw(); await button(view, f.dictionary.inspectorRefresh).props.onClick(); view = await f.draw()
      assert.ok(view.text.includes(f.dictionary.inspectorMessageEmpty))
      f.props.messageId = undefined; f.handlers.listRequests = async () => ({ ok: true, records: [row()] }); view = await f.draw()
      await button(view, f.dictionary.inspectorRefresh).props.onClick(); view = await f.draw(); await selectRequest(view).props.onChange({ target: { value: requestId } })
      f.handlers.readResponse = async () => ({ ok: true, page: { status: 'not-retained' } })
      view = await f.draw(); await button(view, f.dictionary.inspectorRaw).props.onClick(); view = await f.draw()
      assert.ok(view.text.includes(f.dictionary.inspectorNotRetained))
      f.handlers.queryInteraction = async () => ({ ok: false, code: 'ARGON_QUERY_UNAVAILABLE', error: 'lookup failed' })
      view = await lookupView(f); await button(view, f.dictionary.inspectorLookup).props.onClick(); view = await f.draw()
      assert.ok(view.text.includes(f.dictionary.ARGON_QUERY_UNAVAILABLE))
      assert.equal(f.calls.filter(x => x.method === 'queryInteraction').length, 1)
      assert.ok(!view.text.includes('undefined'))
    } finally { await f.close() }
  }
})
