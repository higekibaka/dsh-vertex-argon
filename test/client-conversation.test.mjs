import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture, button, deferred, tick, row, plain, toggle } from './client-inspector-fixture.mjs'

const viewId = 'dsh-vertex-argon/inspector'
const noSidebarTab = f => { for (const store of f.stores.values()) assert.equal(Object.values(store.getSnapshot().bySession).flatMap(value => Object.values(value.layout.tabs)).some(tab => tab.kind === 'argon-inspector'), false) }
for (const language of ['en', 'zh']) test('native conversation registration and accessible answer line icon: ' + language, async () => {
  const f = fixture({ language })
  try {
    const slot = f.slots.get('conversation.view')
    assert.ok(slot); assert.equal(slot.options.id, viewId); assert.equal(slot.options.order, 40)
    assert.equal(typeof slot.options.label, 'function'); assert.equal(slot.options.label(), f.dictionary.inspectorOpen)
    assert.equal(f.slots.has('conversation.session.header.actions'), false)
    assert.equal(f.slots.has('sidebar.workspaces.session.menu.item'), false)
    const entry = f.entry(), control = button(entry, f.dictionary.inspectorOpen)
    assert.ok(control); assert.equal(control.props.type, 'button')
    assert.equal(control.props['aria-label'], f.dictionary.inspectorOpen); assert.ok(control.props.title)
    assert.equal(control.children.some(value => typeof value === 'string' && value.trim()), false, 'icon must not retain a wide text label')
    const svg = entry.nodes.find(node => node.type === 'svg')
    assert.ok(svg); assert.equal(svg.props['aria-hidden'], true); assert.equal(svg.props.fill, 'none'); assert.equal(svg.props.stroke, 'currentColor')
    assert.ok(entry.nodes.some(node => node.type === 'style' && node.children.some(value => value.includes(':focus-visible'))))
    assert.equal(f.calls.length, 0); noSidebarTab(f)
  } finally { await f.close() }
})

test('matching Host renders only selected native view; registration and other views never load Argon', async () => {
  const f = fixture()
  try {
    for (const selected of ['chat', 'trajectory', 'context', 'fleet', 'missing', null]) {
      f.conversation(selected); await f.settle()
      assert.equal(f.calls.length, 0, String(selected)); assert.equal(f.draw().text, '')
    }
    f.conversation(viewId); const view = await f.settle()
    assert.equal(f.viewSelections.at(-1).only, viewId)
    assert.deepEqual(f.calls.map(call => call.method), ['getOverview'])
    assert.deepEqual(plain(f.calls[0].args[0]), { sessionId: 'session-A', limit: 100 })
    assert.ok(view.text.includes(f.dictionary.inspectorSessionScope)); assert.ok(button(view, f.dictionary.inspectorDiagnosis))
    assert.equal(button(view, f.dictionary.inspectorAllRequests), undefined)
    await f.settle(); assert.equal(f.calls.length, 1, 'not a polling view'); noSidebarTab(f)
    f.conversation('chat'); assert.equal(f.draw().text, '')
    f.conversation(viewId); await f.settle(); assert.equal(f.calls.length, 2, 'new legal view lifetime')
  } finally { await f.close() }
})

test('conversation lifetime rejects late lists across session, selected view, permission, reset and unmount', async () => {
  for (const boundary of ['session', 'view', 'permission', 'reset', 'unmount']) {
    const f = fixture(), pending = deferred()
    let reads = 0
    f.handlers.listRequests = () => ++reads === 1 ? pending.promise : Promise.resolve({ ok: true, records: [] })
    try {
      f.conversation(viewId); await f.settle(); assert.equal(reads, 1)
      const oldRefresh = button(f.draw(), f.dictionary.inspectorRefresh).props.onClick
      if (boundary === 'session') f.state.sessionId = 'session-B'
      if (boundary === 'view') f.conversation('context')
      if (boundary === 'permission') f.state.access = false
      if (boundary === 'reset') f.reset()
      if (boundary === 'unmount') f.unmount(); else await f.settle()
      const before = f.calls.length; await oldRefresh(); assert.equal(f.calls.length, before, boundary + ' stale action')
      pending.resolve({ ok: true, records: [{ ...row(), route: 'STALE_LIST_MARKER' }] }); await tick()
      if (boundary !== 'unmount') assert.equal((await f.settle()).text.includes('STALE_LIST_MARKER'), false, boundary)
      if (boundary === 'session') assert.equal(f.calls.at(-1).args[0].sessionId, 'session-B')
      noSidebarTab(f)
    } finally { await f.close() }
  }
})

test('conversation StrictMode effect replay creates fresh live ownership and one settled local read', async () => {
  const f = fixture({ strictEffects: true })
  try {
    f.conversation(viewId); const view = await f.settle()
    assert.ok(f.controllers.length >= 2); assert.equal(f.controllers[0].signal.aborted, true)
    assert.equal(f.controllers[1].signal.aborted, false, 'second setup cannot reuse first aborted lifetime')
    assert.equal(f.calls.filter(call => call.method === 'getOverview').length, 1)
    assert.ok(view.text.includes(f.dictionary.inspectorSessionScope))
    f.conversation('chat'); assert.equal(f.controllers[1].signal.aborted, true, 'active view owner is cancelled; completed read controllers need no cancellation')
  } finally { await f.close() }
})

test('conversation cloud GET is explicit and cancelled on native view switch without late output', async () => {
  const f = fixture(), pending = deferred()
  f.handlers.queryInteraction = () => pending.promise
  try {
    f.conversation(viewId); await f.settle()
    button(f.draw(), f.dictionary.inspectorOperations).props.onClick(); toggle(f.draw(), 'query')
    let view = f.draw(); view.nodes.find(node => node.type === 'input').props.onChange({ target: { value: 'known-id' } })
    assert.equal(f.calls.some(call => call.method === 'queryInteraction'), false)
    const work = button(f.draw(), f.dictionary.inspectorLookup).props.onClick(); await tick()
    const call = f.calls.find(call => call.method === 'queryInteraction'); assert.ok(call); assert.equal(call.args[1].aborted, false)
    f.conversation('trajectory'); assert.equal(call.args[1].aborted, true)
    pending.resolve({ ok: true, queryId: '33333333-3333-4333-8333-333333333333', readOnly: true, retention: 'memory-only' }); await work
    f.conversation(viewId); const fresh = await f.settle(); assert.equal(fresh.text.includes('33333333-3333-4333-8333-333333333333'), false)
    assert.equal(f.calls.filter(call => call.method === 'queryInteraction').length, 1)
  } finally { await f.close() }
})

test('conversation unknown-state confirmation stays lazy and revokes on page/session/access/reset', async () => {
  for (const boundary of ['page', 'session', 'access', 'reset']) {
    const f = fixture()
    f.handlers.listRecovery = async () => ({ ok: true, records: [{ key: 'a'.repeat(64), sessionHash: 'b'.repeat(12), stage: 'unknown', updatedAt: '2026-10-17T01:00:00.000Z', releasedAt: null, uncertainAt: null, hasRemoteId: false, active: false }] })
    f.handlers.releaseUnknown = async () => ({ ok: true, released: true, remoteAction: 'none', newRequestStarted: false })
    try {
      f.conversation(viewId); await f.settle()
      assert.equal(f.calls.some(call => call.method === 'listRecovery'), false)
      button(f.draw(), f.dictionary.inspectorOperations).props.onClick(); toggle(f.draw(), 'recovery')
      await f.settle(); button(f.draw(), f.dictionary.recoveryRelease).props.onClick()
      let view = f.draw(); const checkbox = view.nodes.find(node => node.type === 'input' && node.props.type === 'checkbox')
      assert.equal(checkbox.props.checked, false); await button(view, f.dictionary.recoveryConfirm).props.onClick()
      assert.equal(f.calls.some(call => call.method === 'releaseUnknown'), false)
      checkbox.props.onChange({ target: { checked: true } })
      const retained = button(f.draw(), f.dictionary.recoveryConfirm).props.onClick
      if (boundary === 'page') f.conversation('context')
      if (boundary === 'session') f.state.sessionId = 'session-B'
      if (boundary === 'access') f.state.globalAccess = false
      if (boundary === 'reset') f.reset()
      await f.settle(); await retained()
      assert.equal(f.calls.some(call => call.method === 'releaseUnknown'), false, boundary)
      noSidebarTab(f)
    } finally { await f.close() }
  }
})


test('conversation page owns a full-area content layer even while loading; sidebar and Chat do not', async () => {
  const f = fixture()
  const layer = view => view.nodes.find(node => node.props.className === 'argon-conversation-page')
  const check = view => {
    const node = layer(view); assert.ok(node, 'page must cover blank/loading space, not only its text')
    assert.deepEqual(plain(node.props.style), { position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', flex: '1', minWidth: 0, minHeight: 0 })
    assert.equal(node.props.onPointerDown, undefined, 'no interception of host input handlers')
  }
  try {
    check(f.conversation(viewId)); check(await f.settle())
    f.state.sessionId = 'session-B'; check(f.draw()); check(await f.settle())
    f.state.access = false; check(await f.settle())
    f.state.sessionId = ''; check(f.draw())
    f.state.sessionId = 'session-A'; f.state.access = true
    f.conversation('chat'); assert.equal(layer(f.draw()), undefined)
    f.state.surface = 'sidebar'; assert.equal(layer(await f.settle()), undefined)
  } finally { await f.close() }
})
