import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { readRequestImageFile } from '@deepseek-ai/dsh-attachment-local'
import { createArgonAdapter, ArgonAdapter, PROVIDER, MODEL, GOOGLE_API_MODEL } from '../adapter.js'
import { createInteractionsTransport, INTERACTIONS_REVISION } from '../interaction-transport.js'
import { createInteractionStateHub } from '../interaction-state.js'
const sharp = createRequire(import.meta.resolve('@deepseek-ai/dsh-attachment-local'))('sharp')
const collect = async stream => { const out = []; for await (const item of stream) out.push(item); return out }
const cfg = (protocol = 'interactions') => ({ maxTokens: 65536, reasoning: 'medium', longDecode: true, googleProtocol: protocol, vertexProtocol: protocol, routes: { hasGoogle: true, hasVertex: true } })
const request = (model, ref) => ({ provider: PROVIDER, model, maxTokens: 512, sessionId: 'offline-fixture', messages: [{ role: 'user', content: ref ? [{ type: 'image', attachment: ref }] : [{ type: 'text', text: 'fixture' }] }] })
const context = attachments => ({ get: key => key === 'attachments' ? attachments : key === 'launchEnvironment' ? { get: name => ['GOOGLE_API_KEY', 'GOOGLE_CLOUD_API_KEY'].includes(name) ? { value: 'offline-fixture-key' } : undefined } : undefined })
const created = { event_type: 'interaction.created', event_id: 'e0', interaction: { id: 'offline-task', status: 'in_progress' } }
const events = [created, { event_type: 'step.start', event_id: 'e1', index: 0, step: { type: 'model_output' } }, { event_type: 'step.delta', event_id: 'e2', index: 0, delta: { type: 'text', text: 'OK' } }, { event_type: 'step.stop', event_id: 'e3', index: 0 }, { event_type: 'interaction.completed', event_id: 'e4', interaction: { id: 'offline-task', status: 'completed' } }]
const sse = values => new Response(values.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } })
const response = url => sse(String(url).includes('streamGenerateContent') ? [{ candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] }] : events)
function encodedImages(value, images = []) {
  if (!value || typeof value !== 'object') return images
  if (typeof value.data === 'string' && (value.mime_type || value.mimeType)) images.push(value.data)
  for (const child of Object.values(value)) if (typeof child === 'object') encodedImages(child, images)
  return images
}
function assertAttribution(headers, sdkPrefix = false) {
  for (const [name, value] of Object.entries(attributionHeaders())) {
    if (sdkPrefix) assert.equal(headers.get(name)?.split(', ').filter(part => part === value).length, 1)
    else assert.equal(headers.get(name), value)
    assert.equal([...headers.keys()].filter(k => k.toLowerCase() === name.toLowerCase()).length, 1)
  }
}
const shapes = [
  [3840, 2160, [2048, 1152], [2730, 1536]],
  [2160, 3840, [1152, 2048], [1536, 2730]],
  [8192, 256, [2048, 64], [8192, 256]],
  [320, 200, [320, 200], [320, 200]],
  [2049, 1, [2048, 1], [2049, 1]],
]
for (const protocol of ['interactions', 'generate-content']) for (const model of [GOOGLE_API_MODEL, MODEL]) for (const [width, height, interactions, generate] of shapes) {
  test(protocol + '/' + model + ': declared target equals actual host-encoded wire bytes ' + width + 'x' + height, async t => {
    const cache = await mkdtemp(join(process.cwd(), 'argon-image-regression-'))
    t.after(() => rm(cache, { recursive: true, force: true }))
    const data = await sharp({ create: { width, height, channels: 3, background: { r: 51, g: 110, b: 170 } } }).png().toBuffer()
    const ref = { attachmentId: 'sha256:' + createHash('sha256').update(data).digest('hex'), mediaType: 'image/png', width, height, bytes: data.length }
    const targets = [], wire = []
    const attachments = {
      imageHostPath: () => undefined,
      readImageRequest: async (image, target, signal) => { targets.push(target); return readRequestImageFile(cache, { ref: image, data }, target, signal) },
    }
    t.mock.method(globalThis, 'fetch', async (url, init) => { wire.push({ body: JSON.parse(init.body), headers: new Headers(init.headers) }); return response(url) })
    const adapter = createArgonAdapter(context(attachments), cfg(protocol))
    const target = adapter.imageRequestTarget(PROVIDER, model, ref)
    const expected = protocol === 'interactions' ? interactions : generate
    assert.deepEqual(target, { width: expected[0], height: expected[1], maxBytes: 1024 * 1024 })
    const prepared = await adapter.prepareCall(PROVIDER, model)
    const chunks = await collect(prepared.stream(request(model, ref)))
    assert.equal(chunks.at(-1).reason.kind, 'stop', JSON.stringify(chunks.at(-1)))
    assert.deepEqual(targets, [target])
    assert.equal(wire.length, 1)
    assertAttribution(wire[0].headers, protocol === 'generate-content')
    const images = encodedImages(wire[0].body)
    assert.equal(images.length, 1)
    const bytes = Buffer.from(images[0], 'base64'), encoded = await sharp(bytes).metadata()
    assert.deepEqual([encoded.width, encoded.height], expected)
    assert.ok(bytes.length <= target.maxBytes)
  })
}
test('Interactions rejects absent, invalid and fractional dimensions before encoding or dispatch', async t => {
  let reads = 0, sends = 0
  const adapter = createArgonAdapter(context({ readImageRequest() { reads++; throw new Error('must not encode') } }), cfg())
  t.mock.method(globalThis, 'fetch', async () => { sends++; throw new Error('must not dispatch') })
  for (const ref of [{}, { width: 1 }, { height: 1 }, { width: 0, height: 1 }, { width: -1, height: 1 }, { width: 1.5, height: 1 }, { width: Infinity, height: 1 }, { width: 1, height: NaN }]) {
    assert.throws(() => adapter.imageRequestTarget(PROVIDER, GOOGLE_API_MODEL, ref), /Invalid image attachment dimensions/)
    const chunks = await collect(adapter.stream(request(GOOGLE_API_MODEL, ref)))
    assert.equal(chunks.at(-1).reason.kind, 'error')
  }
  assert.equal(reads, 0); assert.equal(sends, 0)
})
test('mixed route selection updates dimensions without reducing GenerateContent resolution', () => {
  const config = cfg(); config.vertexProtocol = 'generate-content'
  const adapter = createArgonAdapter(context(), () => config), image = { width: 3840, height: 2160 }
  assert.equal(adapter.imageRequestTarget(PROVIDER, GOOGLE_API_MODEL, image).width, 2048)
  assert.equal(adapter.imageRequestTarget(PROVIDER, MODEL, image).width, 2730)
  config.googleProtocol = 'generate-content'; config.vertexProtocol = 'interactions'
  assert.equal(adapter.imageRequestTarget(PROVIDER, GOOGLE_API_MODEL, image).width, 2730)
  assert.equal(adapter.imageRequestTarget(PROVIDER, MODEL, image).width, 2048)
})
test('wrapper delegates when there is no Interactions handler or provider is foreign', () => {
  const marker = { width: 7, height: 8, maxBytes: 9 }, inner = { imageRequestTarget: () => marker }
  assert.equal(new ArgonAdapter(inner, undefined, undefined, () => cfg()).imageRequestTarget(PROVIDER, MODEL, {}), marker)
  assert.equal(new ArgonAdapter(inner, undefined, () => {}, () => cfg()).imageRequestTarget('foreign', MODEL, {}), marker)
})
for (const revision of [INTERACTIONS_REVISION, null]) test('all HTTP operations carry attribution and preserve auth/protocol under mixed casing; revision=' + revision, async () => {
  const calls = []; let refresh = 0
  const transport = createInteractionsTransport({ endpoint: 'https://offline.invalid/interactions', revision,
    getHeaders: () => new Headers([['aUtHoRiZaTiOn', 'Bearer fixture-' + (++refresh)], ['X-GoOg-ApI-KeY', 'fixture-key'], ['UsEr-AgEnT', 'wrong'], ['cOnTeNt-TyPe', 'wrong'], ['aCcEpT', 'wrong'], ['aPi-ReViSiOn', '1900-01-01']]),
    fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return init.headers.get('accept') === 'text/event-stream' ? sse(events) : new Response('{}') },
  })
  await transport.create({ input: 'fixture' })
  await collect(await transport.create({ stream: true }))
  await transport.get('id')
  await collect(await transport.get('id', { stream: true, last_event_id: 'cursor' }))
  await transport.cancel('id'); await transport.delete('id')
  assert.equal(refresh, 6)
  for (const [index, { init }] of calls.entries()) {
    assertAttribution(init.headers)
    assert.equal(init.headers.get('authorization'), 'Bearer fixture-' + (index + 1))
    assert.equal(init.headers.get('x-goog-api-key'), 'fixture-key')
    assert.equal(init.headers.get('content-type'), 'application/json')
    assert.equal(init.headers.get('accept'), [1, 3].includes(index) ? 'text/event-stream' : 'application/json')
    assert.equal(init.headers.get('api-revision'), revision)
  }
})
test('prepared background POST and retried GET include host attribution on every hop', async t => {
  const hub = createInteractionStateHub(), rows = new Map(), calls = []; let gets = 0
  hub.attach({ table: () => ({ get: key => rows.get(key), get size() { return rows.size }, entries: () => rows.entries(), put: async (key, value) => rows.set(key, value), delete: async key => rows.delete(key) }), close: async () => {} })
  t.after(() => hub.close())
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), method: init.method, headers: new Headers(init.headers) })
    if (init.method === 'POST') return sse([created])
    if (++gets === 1) return new Response('{}', { status: 503 })
    return sse(events)
  })
  const adapter = createArgonAdapter(context(), { ...cfg(), interactionsBackground: true, allowInteractionStorage: true }, undefined, undefined, undefined, hub)
  const chunks = await collect(adapter.stream(request(GOOGLE_API_MODEL)))
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.deepEqual(calls.map(c => c.method), ['POST', 'GET', 'GET'])
  for (const call of calls) { assertAttribution(call.headers); assert.equal(call.headers.get('x-goog-api-key'), 'offline-fixture-key') }
  assert.equal(rows.size, 0)
})
