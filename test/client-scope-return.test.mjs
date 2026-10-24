import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture, button, plain, row, deferred, tick, selectRequest } from './client-inspector-fixture.mjs'

function openAnswer(f, messageId = 'answer-A') {
  button(f.entry('session-A', messageId), f.dictionary.inspectorOpen).props.onClick()
  const layout = f.stores.get('session-A').getSnapshot().bySession['session-A'].layout
  const tab = Object.values(layout.tabs).find(tab => tab.kind === f.types[0].kind)
  f.followTab('session-A', tab)
  return tab
}
const listCalls = f => f.calls.filter(call => call.method === 'listRequests').map(call => plain(call.args[0]))
const backLabel = language => language === 'zh' ? '返回此回答的请求' : 'Back to this answer’s requests'

test('answer scope can round-trip through all requests in both languages and remembers only the current answer', async () => {
  for (const language of ['en', 'zh']) {
    const f = fixture({ language })
    try {
      openAnswer(f)
      let view = await f.settle()
      assert.equal(button(view, backLabel(language)), undefined)
      for (const answer of ['answer-A', 'answer-A', 'answer-B']) {
        if (answer === 'answer-B') { openAnswer(f, answer); view = await f.settle() }
        button(view, f.dictionary.inspectorAllRequests).props.onClick()
        view = await f.settle()
        assert.ok(view.text.includes(f.dictionary.inspectorSessionScope))
        assert.deepEqual(listCalls(f).at(-1), { sessionId: 'session-A', limit: 100 })
        const back = button(view, backLabel(language))
        assert.ok(back, 'whole-session scope must retain a return action')
        assert.equal(back.props.type, 'button')
        back.props.onClick()
        view = await f.settle()
        assert.ok(view.text.includes(f.dictionary.inspectorAnswerScope))
        assert.deepEqual(listCalls(f).at(-1), { sessionId: 'session-A', messageId: answer, limit: 100 })
        assert.equal(button(view, backLabel(language)), undefined)
      }
      assert.ok(f.calls.every(call => call.method === 'listRequests'), 'navigation only reads local lists')
    } finally { await f.close() }
  }
})

test('return target survives a body remount without becoming a message filter in session scope', async () => {
  const f = fixture()
  try {
    const tab = openAnswer(f)
    await f.settle()
    button(f.draw(), f.dictionary.inspectorAllRequests).props.onClick()
    await f.settle(); f.unmount()
    const view = await f.settle()
    const nav = f.controller.tabDomain.occurrence('session-A', tab).navigation.getSnapshot()
    assert.deepEqual(plain(nav.params), { sessionId: 'session-A', returnMessageId: 'answer-A' })
    assert.deepEqual(listCalls(f).at(-1), { sessionId: 'session-A', limit: 100 })
    button(view, backLabel('en')).props.onClick(); await f.settle()
    assert.deepEqual(listCalls(f).at(-1), { sessionId: 'session-A', messageId: 'answer-A', limit: 100 })
  } finally { await f.close() }
})

test('return cancels stale whole-session data acceptance and old return callbacks cannot override new navigation', async () => {
  const f = fixture(), pending = deferred()
  try {
    openAnswer(f); await f.settle()
    f.handlers.listRequests = request => request.messageId ? Promise.resolve({ ok: true, records: [] }) : pending.promise
    button(f.draw(), f.dictionary.inspectorAllRequests).props.onClick()
    await f.settle()
    const back = button(f.draw(), backLabel('en')).props.onClick
    back(); await f.settle()
    pending.resolve({ ok: true, records: [{ ...row(), id: 'stale-session-request' }] }); await tick()
    let view = await f.settle()
    assert.ok(view.text.includes(f.dictionary.inspectorMessageEmpty))
    assert.ok(!view.text.includes('stale-session-request'))
    openAnswer(f, 'answer-B'); await f.settle()
    const before = f.calls.length
    back(); view = await f.settle()
    assert.equal(f.calls.length, before)
    assert.deepEqual(listCalls(f).at(-1), { sessionId: 'session-A', messageId: 'answer-B', limit: 100 })
    assert.equal(selectRequest(view), undefined)
  } finally { pending.resolve({ ok: true, records: [] }); await f.close() }
})

test('an unused retained Back callback cannot navigate after another answer replaces its scope', async () => {
  const f = fixture()
  try {
    const tab = openAnswer(f); await f.settle()
    button(f.draw(), f.dictionary.inspectorAllRequests).props.onClick(); await f.settle()
    const unusedBack = button(f.draw(), backLabel('en')).props.onClick
    openAnswer(f, 'answer-B'); await f.settle()
    const before = f.calls.length
    const navigation = f.controller.tabDomain.occurrence('session-A', tab).navigation.getSnapshot()
    unusedBack(); await f.settle()
    assert.equal(f.calls.length, before)
    assert.deepEqual(plain(f.controller.tabDomain.occurrence('session-A', tab).navigation.getSnapshot()), plain(navigation))
    assert.deepEqual(listCalls(f).at(-1), { sessionId: 'session-A', messageId: 'answer-B', limit: 100 })
  } finally { await f.close() }
})

test('return navigation rejects mismatched, ambiguous and malformed return scope without RPC', async () => {
  for (const params of [
    { sessionId: 'session-B', returnMessageId: 'answer-A' },
    { sessionId: 'session-A', messageId: 'answer-A', returnMessageId: 'answer-B' },
    { sessionId: 'session-A', returnMessageId: '' },
    { sessionId: 'session-A', returnMessageId: ' ' },
    { sessionId: 'session-A', returnMessageId: 3 },
    { returnMessageId: 'answer-A' },
  ]) {
    const f = fixture()
    try { f.state.params = params; const view = await f.settle(); assert.ok(view.text.includes(f.dictionary.inspectorScopeChanged)); assert.equal(f.calls.length, 0) }
    finally { await f.close() }
  }
})

test('Guide and conversation page do not invent an answer return target', async () => {
  for (const surface of ['sidebar', 'conversation']) {
    const f = fixture()
    try {
      if (surface === 'conversation') f.conversation(f.slots.get('conversation.view').options.id)
      const view = await f.settle()
      assert.equal(button(view, backLabel('en')), undefined)
      assert.equal(button(view, f.dictionary.inspectorAllRequests), undefined)
      assert.deepEqual(listCalls(f).at(-1), { sessionId: 'session-A', limit: 100 })
    } finally { await f.close() }
  }
})
