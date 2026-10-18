import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createInteractionStateHub, durableInteractionTransport, interactionStateDomain } from '../interaction-state.js'
import { streamInteractions } from '../interactions.js'

const events = list => (async function* () { for (const item of list) { if (item instanceof Error) throw item; if (typeof item === 'function') item(); else yield item } })()
const collect = async stream => { const out = []; for await (const item of stream) out.push(item); return out }
const created = { event_type: 'interaction.created', event_id: 'e0', interaction: { id: 'remote', status: 'in_progress' } }
const done = { event_type: 'interaction.completed', event_id: 'end', interaction: { id: 'remote', status: 'completed' } }
const opts = signal => ({ provider: 'p', model: 'gemini-4-argon-google', maxTokens: 64, sessionId: 'session', signal, messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }] })
function fixture() {
  const rows = new Map(), hub = createInteractionStateHub()
  hub.attach({ table: () => ({ get: k => rows.get(k), get size() { return rows.size }, entries: () => rows.entries(), put: async (k, v) => { interactionStateDomain.tables.tasks.valueSchema.parse(v); rows.set(k, v) }, delete: async k => rows.delete(k) }), close: async () => {} })
  const identity = hub.identity({ sessionId: 'session', endpoint: 'https://example.test/interactions', principalHash: '1'.repeat(64), body: { input: 'fixture' } })
  return { hub, rows, identity }
}

for (const fault of [Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }), new DOMException('stream interrupted without a user stop', 'AbortError'), null]) {
  test('bounded background read failure retains one task without cancelling: ' + (fault?.name ?? 'EOF'), async () => {
    const { hub, rows, identity } = fixture(); let posts = 0, gets = 0, cancels = 0, exit
    const base = { create: async () => { posts++; return events([created]) }, get: async () => { gets++; return events(fault ? [fault] : []) }, cancel: async () => { cancels++; return { status: 'cancelled' } } }
    const durable = durableInteractionTransport(base, hub, identity)
    const chunks = await collect(streamInteractions(opts(), { route: 'google-generative-ai', background: true, store: true, transport: durable, reconnectBackoff: { initialDelayMs: 0 }, onExit: reason => { exit = reason } }))
    assert.equal(chunks.at(-1).reason.kind, 'error')
    assert.equal(chunks.at(-1).reason.failure.code, 'ARGON_BACKGROUND_READ_INTERRUPTED')
    assert.equal(exit, 'read-interrupted')
    await durable.finish({ complete: false, reason: exit })
    assert.equal(posts, 1); assert.equal(gets, 4); assert.equal(cancels, 0)
    assert.equal(rows.get(identity.key).interactionId, 'remote')
    const changed = hub.identity({ sessionId: 'session', endpoint: 'https://example.test/interactions', principalHash: '1'.repeat(64), body: { input: 'changed' } })
    await assert.rejects(durableInteractionTransport(base, hub, changed).create({}), /outstanding|unresolved/)
    assert.equal(posts, 1); assert.equal(cancels, 0)
    base.get = async () => events([done])
    const resumed = durableInteractionTransport(base, hub, identity)
    await collect(await resumed.create({})); await resumed.finish({ complete: true, reason: 'completed' })
    assert.equal(posts, 1); assert.equal(rows.size, 0)
  })
}

for (const [label, reason, expectedExit, expectedCancels] of [
  ['user Stop', undefined, 'user-stop', 1],
  ['request timeout', new DOMException('deadline', 'TimeoutError'), 'read-interrupted', 0],
  ['managed host shutdown', Object.assign(new Error('host shutdown'), { name: 'AbortError', code: 'ARGON_HOST_SHUTDOWN' }), 'host-shutdown', 0],
]) {
  test(label + ' has an explicit cleanup disposition', async () => {
    const { hub, rows, identity } = fixture(); const controller = new AbortController(); let cancels = 0, exit
    const base = { create: async () => events([created]), get: async () => events([() => controller.abort(reason), done]), cancel: async (_id, options) => { assert.equal(options.signal.aborted, false); cancels++; return { status: 'cancelled' } } }
    const durable = durableInteractionTransport(base, hub, identity, { signal: controller.signal })
    await collect(streamInteractions(opts(controller.signal), { route: 'google-generative-ai', background: true, store: true, transport: durable, reconnectBackoff: { initialDelayMs: 0 }, onExit: reason => { exit = reason } }))
    assert.equal(exit, expectedExit)
    await durable.finish({ complete: false, reason: exit })
    assert.equal(cancels, expectedCancels)
    assert.equal(rows.size, expectedCancels ? 0 : 1)
  })
}

test('invalid semantic output cancels once and never emits a tool call', async () => {
  const { hub, rows, identity } = fixture(); let cancels = 0, exit
  const base = { create: async () => events([created]), get: async () => events([{ event_type: 'step.delta', index: 0, delta: { type: 'arguments_delta', arguments: '{}' } }]), cancel: async () => { cancels++; return { status: 'cancelled' } } }
  const durable = durableInteractionTransport(base, hub, identity)
  const chunks = await collect(streamInteractions(opts(), { route: 'google-generative-ai', background: true, store: true, transport: durable, onExit: reason => { exit = reason } }))
  assert.equal(exit, 'protocol-error')
  assert.equal(chunks.some(c => c.type === 'tool-call-delta'), false)
  await durable.finish({ complete: false, reason: exit })
  assert.equal(cancels, 1); assert.equal(rows.size, 0)
})

test('consumer abandonment still cancels rather than silently detaching', async () => {
  const { hub, rows, identity } = fixture(); let cancels = 0, exit
  const base = { create: async () => events([created]), get: async () => events([{ event_type: 'step.start', event_id: 's', index: 0, step: { type: 'model_output' } }, { event_type: 'step.delta', event_id: 'd', index: 0, delta: { type: 'text', text: 'partial' } }]), cancel: async () => { cancels++; return { status: 'cancelled' } } }
  const durable = durableInteractionTransport(base, hub, identity)
  const stream = streamInteractions(opts(), { route: 'google-generative-ai', background: true, store: true, transport: durable, onExit: reason => { exit = reason } })
  await stream.next(); await stream.return()
  assert.equal(exit, 'consumer-abandoned')
  await durable.finish({ complete: false, reason: exit })
  assert.equal(cancels, 1); assert.equal(rows.size, 0)
})
