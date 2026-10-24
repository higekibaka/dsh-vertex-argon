import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture, button, toggle, plain, row, detail, requestId, secondId, deferred, tick, selectRequest } from './client-inspector-fixture.mjs'

const argonTabs = (f, id) => Object.values(f.stores.get(id).getSnapshot().bySession[id]?.layout.tabs ?? {}).filter(tab => tab.kind === 'argon-inspector')
const choose = async (f, id) => { await selectRequest(f.draw()).props.onChange({ target: { value: id } }); return f.settle() }

for (const language of ['en', 'zh']) test('native registry Guide + answer only; actual sidebar destination respects mounted source: ' + language, async () => {
  const f = fixture({ language })
  try {
    assert.equal(f.slots.has('sidebar.workspaces.session.menu.item'), false)
    assert.equal(f.slots.has('conversation.session.header.actions'), false)
    assert.equal(f.types.length, 1); assert.equal(f.types[0].keepMounted, undefined)
    assert.equal(f.types[0].guide.length, 1); assert.equal(f.types[0].guide[0].title(), f.dictionary.inspectorTitle)
    const sourceB = button(f.entry('session-B', 'answer-B'), f.dictionary.inspectorOpen).props.onClick
    sourceB()
    assert.equal(argonTabs(f, 'session-A').length, 0, 'source B must not open in mounted A')
    assert.equal(argonTabs(f, 'session-B').length, 0, 'must not secretly select another session')
    assert.ok(f.entry('session-B', 'answer-B').text.includes(f.dictionary.inspectorScopeChanged))
    f.show(undefined); assert.doesNotThrow(sourceB)
    assert.equal(argonTabs(f, 'session-A').length, 0)
    f.show('session-B'); sourceB()
    const [tab] = argonTabs(f, 'session-B')
    assert.ok(tab); assert.equal(argonTabs(f, 'session-A').length, 0)
    assert.deepEqual(plain(f.controller.tabDomain.occurrence('session-B', tab).navigation.getSnapshot().params), { sessionId: 'session-B', messageId: 'answer-B' })
    assert.equal(f.entry('session-B', '').nodes.some(n => n.type === 'button'), false)
    assert.equal(f.calls.length, 0, 'entry does not perform RPC')
  } finally { await f.close() }
})

test('native Guide open has absent params and resolves only the slot session', async () => {
  const f = fixture()
  try {
    f.controller.openTab(f.types[0].kind)
    const [tab] = argonTabs(f, 'session-A')
    const nav = f.controller.tabDomain.occurrence('session-A', tab).navigation.getSnapshot()
    assert.equal(nav.params, undefined)
    f.state.params = nav.params
    const view = await f.settle()
    assert.equal(view.nodes.some(n => n.props.role === 'alert'), false)
    assert.deepEqual(plain(f.calls[0]?.args[0]), { sessionId: 'session-A', limit: 100 })
    assert.deepEqual(f.calls.map(x => x.method), ['listRequests'])
  } finally { await f.close() }
})

test('strict explicit navigation rejects wrong session, missing scope, unknown keys and malformed message without downgrade', async () => {
  for (const params of [{ sessionId: 'session-B' }, { messageId: 'm' }, { sessionId: 'session-A', messageId: '' }, { sessionId: 'session-A', messageId: 5 }, { sessionId: 'session-A', extra: true }, null, [], 'session-A']) {
    const f = fixture()
    try { f.state.params = params; const view = await f.settle(); assert.ok(view.text.includes(f.dictionary.inspectorScopeChanged), JSON.stringify(params)); assert.equal(f.calls.length, 0) } finally { await f.close() }
  }
})

test('stable visible authorized diagnosis auto-loads local list exactly once, never cloud/raw/recovery; empty Guide params also valid', async () => {
  const f = fixture()
  try {
    f.state.params = {}
    let view = await f.settle()
    assert.equal(button(view, f.dictionary.inspectorDiagnosis)?.props['aria-pressed'], true)
    assert.equal(button(view, f.dictionary.inspectorOperations)?.props['aria-pressed'], false)
    assert.deepEqual(f.calls.map(x => x.method), ['listRequests'])
    await f.settle(); await f.settle(); assert.equal(f.calls.length, 1, 'no render/effect polling')
    assert.equal(view.nodes.some(n => n.type === 'details' && n.props['data-operation']), false)
    button(view, f.dictionary.inspectorOperations).props.onClick(); view = await f.settle()
    assert.equal(f.calls.length, 1); assert.ok(view.nodes.find(n => n.props['data-operation'] === 'query'))
    assert.ok(view.nodes.find(n => n.props['data-operation'] === 'recovery'))
    assert.equal(view.nodes.some(n => n.type === 'details' && n.props.className?.includes('argon-json')), false)
    assert.equal(view.nodes.some(n => n.type === 'input' && n.props.name === 'input'), false)
  } finally { await f.close() }
})

test('hidden or denied scopes never auto-load and errors are not an empty success', async () => {
  for (const state of [{ visible: false }, { access: false }, { access: undefined }]) {
    const f = fixture()
    try { Object.assign(f.state, state); await f.settle(); assert.equal(f.calls.length, 0) } finally { await f.close() }
  }
  const f = fixture()
  try {
    f.handlers.listRequests = async () => ({ ok: false, error: 'private upstream error' })
    const view = await f.settle(); assert.ok(view.nodes.some(n => n.props.role === 'alert')); assert.ok(!view.text.includes(f.dictionary.inspectorEmpty)); assert.ok(!view.text.includes('private upstream error'))
    await f.settle(); assert.equal(f.calls.length, 1)
  } finally { await f.close() }
})

test('answer zero/one/many never guesses latest; only exact unique match loads details', async () => {
  for (const count of [0, 1, 2]) {
    const f = fixture()
    try {
      f.state.params = { sessionId: 'session-A', messageId: 'answer-exact' }
      f.handlers.listRequests = async () => ({ ok: true, records: [row(), row(secondId)].slice(0, count) })
      const view = await f.settle()
      assert.deepEqual(plain(f.calls[0].args[0]), { sessionId: 'session-A', messageId: 'answer-exact', limit: 100 })
      assert.equal(f.calls.filter(x => x.method === 'getRequest').length, count === 1 ? 1 : 0)
      assert.ok(!f.calls.some(x => ['readResponse', 'queryInteraction', 'listRecovery'].includes(x.method)))
      if (count === 0) assert.ok(view.text.includes(f.dictionary.inspectorMessageEmpty))
      if (count === 1) { assert.equal(selectRequest(view).props.value, requestId); assert.ok(view.text.includes('In: — · Cache: —')) }
      if (count === 2) assert.equal(selectRequest(view).props.value, '')
    } finally { await f.close() }
  }
})

test('refresh preserves the explicit selection and removal clears rather than selecting latest', async () => {
  const f = fixture()
  try {
    await f.settle(); await choose(f, secondId)
    await button(f.draw(), f.dictionary.inspectorRefresh).props.onClick(); let view = await f.settle()
    assert.equal(selectRequest(view).props.value, secondId)
    await button(view, f.dictionary.inspectorRaw).props.onClick(); view = await f.settle()
    assert.ok(view.text.includes('<script>not executed</script>'))
    f.handlers.listRequests = async () => ({ ok: true, records: [row()] })
    const prior = f.calls.filter(x => x.method === 'getRequest').length
    await button(view, f.dictionary.inspectorRefresh).props.onClick(); view = await f.settle()
    assert.equal(selectRequest(view).props.value, '')
    assert.equal(f.calls.filter(x => x.method === 'getRequest').length, prior)
    assert.ok(view.text.includes(f.dictionary.inspectorSelectionMissing))
    assert.ok(!view.text.includes('<script>not executed</script>'))
    assert.equal(button(view, f.dictionary.inspectorRaw), undefined)
  } finally { await f.close() }
})

test('explicit whole-session action broadens only after click, clears prior detail and cancels pending detail acceptance', async () => {
  const f = fixture(), pending = deferred()
  try {
    button(f.entry('session-A', 'answer-A'), f.dictionary.inspectorOpen).props.onClick()
    f.followTab('session-A', argonTabs(f, 'session-A')[0])
    await f.settle(); f.handlers.getRequest = () => pending.promise
    const old = selectRequest(f.draw()).props.onChange({ target: { value: requestId } }); await tick()
    const broaden = button(f.draw(), f.dictionary.inspectorAllRequests); assert.ok(broaden)
    await broaden.props.onClick(); await f.settle()
    assert.deepEqual(plain(f.calls.filter(x => x.method === 'listRequests').at(-1).args[0]), { sessionId: 'session-A', limit: 100 })
    pending.resolve({ ...detail(), record: { ...row(), marker: 'stale-answer' } }); await old
    const view = await f.settle(); assert.equal(selectRequest(view).props.value, ''); assert.ok(!view.text.includes('stale-answer'))
  } finally { pending.resolve(detail()); await f.close() }
})

test('recovery is lazy under Operations only; disclosure close invalidates late local records', async () => {
  const f = fixture(), pending = deferred()
  try {
    await f.settle(); assert.equal(f.calls.some(x => x.method === 'listRecovery'), false)
    button(f.draw(), f.dictionary.inspectorOperations).props.onClick(); let view = await f.settle()
    assert.equal(f.calls.some(x => x.method === 'listRecovery'), false)
    f.handlers.listRecovery = () => pending.promise
    toggle(view, 'recovery'); await f.settle(); assert.equal(f.calls.filter(x => x.method === 'listRecovery').length, 1)
    toggle(f.draw(), 'recovery', false); f.draw()
    pending.resolve({ ok: true, records: [{ key: 'a'.repeat(64), sessionHash: 'cccccccccccc', stage: 'unknown', updatedAt: '2026-10-18T00:00:00Z', releasedAt: null, uncertainAt: null, hasRemoteId: false, active: false }] })
    await tick(); view = await f.settle(); assert.ok(!view.text.includes('cccccccccccc'))
  } finally { pending.resolve({ ok: true, records: [] }); await f.close() }
})

test('auto list late replies are discarded across hide/navigation/access/reset/tab lifetime', async () => {
  for (const reason of ['hide', 'navigation', 'permission', 'reset', 'abort', 'unmount']) {
    const f = fixture(), pending = deferred()
    try {
      let lists = 0
      f.handlers.listRequests = () => ++lists === 1 ? pending.promise : Promise.resolve({ ok: true, records: [] }); f.draw(); await tick()
      assert.equal(f.calls.length, 1)
      const retained = button(f.draw(), f.dictionary.inspectorRefresh).props.onClick
      if (reason === 'hide') f.state.visible = false
      if (reason === 'navigation') { f.state.revision++; f.state.params = { sessionId: 'session-B' } }
      if (reason === 'permission') f.state.access = false
      if (reason === 'reset') f.reset()
      if (reason === 'abort') f.tabLifetime.abort()
      if (reason === 'unmount') f.unmount(); else f.draw()
      await retained(); pending.resolve({ ok: true, records: [{ ...row(), outcome: 'stale-list' }] }); await tick()
      if (reason !== 'unmount') assert.ok(!(await f.settle()).text.includes('stale-list'), reason)
    } finally { pending.resolve({ ok: true, records: [] }); await f.close() }
  }
})

test('unknown release confirmation is revoked by Operations disclosure and pane lifetimes', async () => {
  for (const boundary of ['disclosure', 'mode', 'hide', 'navigation', 'permission', 'reset', 'abort', 'unmount']) {
    const f = fixture()
    try {
      f.handlers.listRecovery = async () => ({ ok: true, records: [{ key: 'a'.repeat(64), sessionHash: 'b'.repeat(12), stage: 'unknown', updatedAt: '2026-10-17T01:00:00.000Z', releasedAt: null, uncertainAt: '2026-10-17T00:59:00.000Z', hasRemoteId: false, active: false }] })
      f.handlers.releaseUnknown = async () => ({ ok: true, released: true, remoteAction: 'none', newRequestStarted: false })
      await f.settle(); button(f.draw(), f.dictionary.inspectorOperations).props.onClick(); toggle(f.draw(), 'recovery')
      let view = await f.settle()
      button(view, f.dictionary.recoveryRelease).props.onClick(); view = f.draw()
      const checkbox = view.nodes.find(n => n.type === 'input' && n.props.type === 'checkbox')
      assert.equal(checkbox.props.checked, false)
      await button(view, f.dictionary.recoveryConfirm).props.onClick()
      assert.equal(f.calls.some(x => x.method === 'releaseUnknown'), false)
      checkbox.props.onChange({ target: { checked: true } })
      const retained = button(f.draw(), f.dictionary.recoveryConfirm).props.onClick
      if (boundary === 'disclosure') toggle(f.draw(), 'recovery', false)
      if (boundary === 'mode') button(f.draw(), f.dictionary.inspectorDiagnosis).props.onClick()
      if (boundary === 'hide') f.state.visible = false
      if (boundary === 'navigation') f.state.revision++
      if (boundary === 'permission') f.state.globalAccess = false
      if (boundary === 'reset') f.reset()
      if (boundary === 'abort') f.tabLifetime.abort()
      if (boundary === 'unmount') f.unmount(); else f.draw()
      await retained()
      assert.equal(f.calls.some(x => x.method === 'releaseUnknown'), false, boundary)
      if (['disclosure', 'mode'].includes(boundary)) {
        if (boundary === 'mode') button(f.draw(), f.dictionary.inspectorOperations).props.onClick()
        toggle(f.draw(), 'recovery'); view = await f.settle()
        assert.equal(view.nodes.some(n => n.type === 'input' && n.props.type === 'checkbox'), false)
        button(view, f.dictionary.recoveryRelease).props.onClick(); view = f.draw()
        assert.equal(view.nodes.find(n => n.type === 'input' && n.props.type === 'checkbox').props.checked, false)
      }
    } finally { await f.close() }
  }
})

test('raw disclosure and mode changes discard pending pages and never retain hidden text', async () => {
  for (const boundary of ['disclosure', 'mode', 'selection']) {
    const f = fixture(), pending = deferred()
    try {
      await f.settle(); await choose(f, requestId)
      assert.equal(button(f.draw(), f.dictionary.inspectorRaw).props['aria-expanded'], false)
      f.handlers.readResponse = () => pending.promise
      const work = button(f.draw(), f.dictionary.inspectorRaw).props.onClick(); await tick()
      assert.equal(button(f.draw(), f.dictionary.inspectorRaw).props['aria-expanded'], true)
      if (boundary === 'disclosure') button(f.draw(), f.dictionary.inspectorRaw).props.onClick()
      if (boundary === 'mode') button(f.draw(), f.dictionary.inspectorOperations).props.onClick()
      if (boundary === 'selection') await choose(f, secondId)
      pending.resolve({ ok: true, page: { status: 'available', metadata: { frames: 1 }, frame: { index: 0, offset: 0, text: 'stale-raw-text', nextOffset: null } } }); await work
      assert.ok(!(await f.settle()).text.includes('stale-raw-text'), boundary)
      if (boundary === 'mode') button(f.draw(), f.dictionary.inspectorDiagnosis).props.onClick()
      assert.equal(button(f.draw(), f.dictionary.inspectorRaw).props['aria-expanded'], false)
      assert.equal(f.calls.filter(x => x.method === 'readResponse').length, 1)
    } finally { pending.resolve({ ok: false }); await f.close() }
  }
})

test('changing lookup ID or route revokes a retained GET callback before dispatch', async () => {
  for (const changed of ['id', 'route']) {
    const f = fixture()
    try {
      await f.settle(); button(f.draw(), f.dictionary.inspectorOperations).props.onClick(); toggle(f.draw(), 'query')
      f.draw().nodes.find(n => n.type === 'input').props.onChange({ target: { value: 'old-id' } })
      const view = f.draw(), retained = button(view, f.dictionary.inspectorLookup).props.onClick
      view.nodes.find(n => n.type === (changed === 'id' ? 'input' : 'select')).props.onChange({ target: { value: changed === 'id' ? 'new-id' : 'google-vertex' } })
      const before = f.calls.length; await retained()
      assert.equal(f.calls.length, before, changed + ': old GET must be revoked synchronously')
      await button(f.draw(), f.dictionary.inspectorLookup).props.onClick()
      assert.deepEqual(plain(f.calls.at(-1).args[0]), { route: changed === 'route' ? 'google-vertex' : 'google-generative-ai', id: changed === 'id' ? 'new-id' : 'old-id' })
    } finally { await f.close() }
  }
})

test('changing lookup ID or route revokes retained cached-result paging callbacks', async () => {
  for (const changed of ['id', 'route']) {
    const f = fixture()
    try {
      await f.settle(); button(f.draw(), f.dictionary.inspectorOperations).props.onClick(); toggle(f.draw(), 'query')
      f.draw().nodes.find(n => n.type === 'input').props.onChange({ target: { value: 'old-id' } })
      await button(f.draw(), f.dictionary.inspectorLookup).props.onClick()
      const view = f.draw(), retained = button(view, f.dictionary.inspectorReadQuery).props.onClick
      view.nodes.find(n => n.type === (changed === 'id' ? 'input' : 'select')).props.onChange({ target: { value: changed === 'id' ? 'new-id' : 'google-vertex' } })
      const before = f.calls.length; await retained()
      assert.equal(f.calls.length, before, changed + ': old queryId read must be revoked synchronously')
      assert.equal(button(f.draw(), f.dictionary.inspectorReadQuery), undefined)
    } finally { await f.close() }
  }
})

test('changing selected request revokes old raw disclosure and page callbacks', async () => {
  const f = fixture()
  try {
    await f.settle(); await choose(f, requestId)
    const oldToggle = button(f.draw(), f.dictionary.inspectorRaw).props.onClick
    await oldToggle(); const oldPage = button(f.draw(), f.dictionary.inspectorNextPage).props.onClick
    await choose(f, secondId)
    const before = f.calls.length; await oldToggle(); await oldPage()
    assert.equal(f.calls.length, before)
    assert.equal(button(f.draw(), f.dictionary.inspectorRaw).props['aria-expanded'], false)
  } finally { await f.close() }
})

test('Operations recovery preserves ConfigForm method receivers and subscribes to write-state changes', async () => {
  const f = fixture()
  try {
    f.handlers.listRecovery = async () => ({ ok: true, records: [{ key: 'a'.repeat(64), sessionHash: 'b'.repeat(12), stage: 'unknown', updatedAt: '2026-10-17T01:00:00.000Z', releasedAt: null, uncertainAt: null, hasRemoteId: false, active: false }] })
    await f.settle(); assert.equal(f.form.listeners.size, 0)
    button(f.draw(), f.dictionary.inspectorOperations).props.onClick(); toggle(f.draw(), 'recovery')
    let view = await f.settle(); assert.equal(f.form.listeners.size, 1)
    const retained = button(view, f.dictionary.recoveryRelease).props.onClick
    assert.equal(button(view, f.dictionary.recoveryRelease).props.disabled, false)
    f.form.publish({ writable: false }); assert.ok(f.form.notifications > 0)
    await retained(); view = f.draw()
    assert.equal(button(view, f.dictionary.recoveryRelease).props.disabled, true)
    assert.equal(view.nodes.some(n => n.type === 'input' && n.props.type === 'checkbox'), false)
    toggle(view, 'recovery', false); f.draw(); assert.equal(f.form.listeners.size, 0)
  } finally { await f.close() }
})


