import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { createArgonAdapter, argonProvider, normalizeProxyBaseUrl, resolveConfigValues, detectPiAiArgonRoutes, PROVIDER, MODEL, GOOGLE_API_MODEL, PROXY_MODEL, DEFAULT_PROXY_BASE_URL } from '../adapter.js'
import { Config, apply } from '../index.js'
import { createGoogleConnection } from '../google-connection.js'
import { shared } from '../runtime.js'
const { GoogleGenAI } = await shared('@google/genai')
const protocols = ['generate-content', 'interactions']
const keys = { GOOGLE_API_KEY: 'google-only-key', GOOGLE_CLOUD_API_KEY: 'vertex-only-key', ANTIGRAVITY_API_KEY: 'proxy-only-key' }
const context = (values = keys, credentials) => ({ get: name => name === 'launchEnvironment' ? { get: key => values[key] ? { value: values[key] } : undefined } : name === 'credentials' ? credentials : undefined })
const config = (protocol = 'generate-content', overrides = {}) => ({ proxyEnabled: true, googleProtocol: protocol, vertexProtocol: protocol, routes: { hasGoogle: true, hasVertex: true }, ...overrides })
const request = model => ({ provider: PROVIDER, model, sessionId: 'proxy-offline-fixture', maxTokens: 512, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks }
const sse = events => new Response(events.map(e => 'data: ' + JSON.stringify(e) + String.fromCharCode(10, 10)).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
const wire = []
const originalFetch = globalThis.fetch
// Real host SDK and pi-ai paths; only the final fetch is mocked, never forwarded.
globalThis.fetch = async (input, init) => {
  const entry = { url: String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url), body: JSON.parse(init?.body ?? await input.text()), headers: new Headers(init?.headers ?? input.headers) }
  wire.push(entry)
  if (entry.url.includes(':streamGenerateContent')) return sse([{ candidates: [{ content: { role: 'model', parts: [{ text: 'answer' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 30, cachedContentTokenCount: 2, candidatesTokenCount: 3, thoughtsTokenCount: 1, totalTokenCount: 34 } }])
  return sse([
    { event_type: 'interaction.created', interaction: { id: 'proxy-fixture', status: 'in_progress' } },
    { event_type: 'step.start', index: 0, step: { type: 'model_output' } },
    { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'answer' } },
    { event_type: 'step.stop', index: 0 },
    { event_type: 'interaction.completed', interaction: { id: 'proxy-fixture', status: 'completed', usage: { total_input_tokens: 30, total_cached_tokens: 2, total_output_tokens: 3, total_thought_tokens: 1, total_tokens: 34 } } },
  ])
}
after(() => { globalThis.fetch = originalFetch })
function assertKey(entry, expected) {
  assert.equal(entry.headers.get('x-goog-api-key'), expected)
  assert.equal(entry.headers.has('authorization'), false)
  const serialized = JSON.stringify([entry.url, entry.body, [...entry.headers]])
  for (const key of Object.values(keys)) if (key !== expected) assert.equal(serialized.includes(key), false)
  assert.equal(serialized.includes('__GOOGLE_API_KEY__'), false)
  assert.equal(serialized.includes('__ANTIGRAVITY_API_KEY__'), false)
}
async function successful(adapter, model) {
  const chunks = await collect(adapter.stream(request(model)))
  assert.equal(chunks.at(-1)?.reason?.kind, 'stop', JSON.stringify(chunks.at(-1)))
  return chunks
}

test('proxy URL normalization handles defaults, roots, versions and custom prefixes', () => {
  for (const value of [undefined, '', '  ']) assert.equal(normalizeProxyBaseUrl(value), DEFAULT_PROXY_BASE_URL)
  for (const value of [' http://127.0.0.1:8045/ ', 'http://127.0.0.1:8045', 'http://127.0.0.1:8045/v1beta/']) assert.equal(normalizeProxyBaseUrl(value), DEFAULT_PROXY_BASE_URL)
  assert.equal(normalizeProxyBaseUrl('https://proxy.invalid/gateway/v1beta///'), 'https://proxy.invalid/gateway/v1beta')
  assert.equal(normalizeProxyBaseUrl('http://proxy.invalid/gateway'), 'http://proxy.invalid/gateway')
  for (const value of ['invalid', 'ftp://proxy.invalid', 'file:///tmp/key', 42, {}]) assert.throws(() => normalizeProxyBaseUrl(value))
  assert.equal(resolveConfigValues({ proxyApiKey: '  configured  ' }).proxyApiKey, 'configured')
  assert.throws(() => resolveConfigValues({ proxyEnabled: 'true' }))
  assert.throws(() => resolveConfigValues({ proxyApiKey: 123 }))
})

test('proxy settings are volatile and independent of existing native provider configuration', async () => {
  const cfg = Config({})
  assert.equal(cfg.proxyEnabled.get(), false)
  assert.equal(cfg.proxyBaseUrl.get(), DEFAULT_PROXY_BASE_URL)
  assert.equal(cfg.proxyApiKey.get(), '')
  const nativeRoutes = { hasGoogle: true, hasVertex: true, googleBaseUrl: 'https://google.invalid/v1beta', vertexBaseUrl: 'https://vertex.invalid' }
  const adapter = createArgonAdapter(context(), () => ({ ...config(), routes: nativeRoutes }))
  assert.deepEqual((await adapter.listModels(PROVIDER)).map(m => m.id), [MODEL, GOOGLE_API_MODEL, PROXY_MODEL])
  const model = await adapter.resolveModel(PROVIDER, PROXY_MODEL)
  assert.equal(model.name, 'Gemini 4 Argon (Antigravity)')
  assert.deepEqual(model.reasoning.efforts.map(e => e.id), ['low', 'medium', 'high'])
  assert.deepEqual(nativeRoutes, { hasGoogle: true, hasVertex: true, googleBaseUrl: 'https://google.invalid/v1beta', vertexBaseUrl: 'https://vertex.invalid' })
})

for (const enabled of [false, true]) for (const explicit of [undefined, false, true]) test('proxy registration uses enabled OR explicit route: ' + enabled + '/' + explicit, async () => {
  const cfg = config('generate-content', { proxyEnabled: enabled, routes: { hasVertex: false, hasGoogle: false, ...(explicit === undefined ? {} : { hasProxy: explicit }) } })
  assert.equal(detectPiAiArgonRoutes({}, cfg.routes).hasProxy, explicit === true)
  const adapter = createArgonAdapter(context(), cfg)
  const available = (await adapter.listModels(PROVIDER)).some(m => m.id === PROXY_MODEL)
  assert.equal(available, enabled || explicit === true)
  if (!available) {
    const before = wire.length
    await assert.rejects(adapter.prepareCall(PROVIDER, PROXY_MODEL), /configured model/)
    assert.equal(wire.length, before)
  }
})

for (const protocol of protocols) for (const baseUrl of ['http://127.0.0.1:8045', 'http://127.0.0.1:8045/v1beta/', 'http://127.0.0.1:8045/gateway/v1beta/']) test(protocol + ': real SDK proxy URL and dedicated key at ' + baseUrl, async () => {
  let diagnostic
  const cfg = config(protocol, { proxyBaseUrl: baseUrl, googleServiceTier: 'priority' })
  const adapter = createArgonAdapter(context(), cfg, undefined, undefined, record => { diagnostic = record })
  await successful(adapter, PROXY_MODEL)
  const sent = wire.at(-1)
  const base = normalizeProxyBaseUrl(baseUrl)
  assert.ok(sent.url.startsWith(base + '/'), sent.url)
  assert.ok(sent.url.endsWith(protocol === 'interactions' ? '/interactions' : '/models/gemini-4-argon-medium:streamGenerateContent?alt=sse'), sent.url)
  if (protocol === 'interactions') assert.equal(sent.body.model, 'gemini-4-argon-medium')
  assert.equal((sent.url.match(/v1beta/g) ?? []).length, 1)
  assertKey(sent, keys.ANTIGRAVITY_API_KEY)
  assert.equal(sent.body.service_tier, 'priority')
  assert.equal(diagnostic.model, PROXY_MODEL)
  assert.equal(diagnostic.route, 'google-generative-ai')
  assert.equal(diagnostic.protocol, protocol)
  assert.equal(diagnostic.hops[0].promptTokens, 30)
  assert.equal(diagnostic.hops[0].outputTokens, 3)
  assert.equal(JSON.stringify(diagnostic).includes(keys.ANTIGRAVITY_API_KEY), false)
})

for (const protocol of protocols) test(protocol + ': proxy reasoning effort maps 1-to-1 to gemini-4-argon-{low,medium,high} while direct routes keep gemini-4-argon', async () => {
  const adapter = createArgonAdapter(context(), config(protocol))
  for (const level of ['low', 'medium', 'high']) {
    const chunks = await collect(adapter.stream({ ...request(PROXY_MODEL), reasoningEffort: level }))
    assert.equal(chunks.at(-1)?.reason?.kind, 'stop')
    const sent = wire.at(-1)
    if (protocol === 'interactions') {
      assert.equal(sent.body.model, `gemini-4-argon-${level}`)
      assert.equal(sent.body.generation_config.thinking_level, level)
    } else {
      assert.ok(sent.url.endsWith(`/models/gemini-4-argon-${level}:streamGenerateContent?alt=sse`), sent.url)
      assert.equal(sent.body.generationConfig.thinkingConfig.thinkingLevel, level.toUpperCase())
    }
    const directChunks = await collect(adapter.stream({ ...request(GOOGLE_API_MODEL), reasoningEffort: level }))
    assert.equal(directChunks.at(-1)?.reason?.kind, 'stop')
    const directSent = wire.at(-1)
    if (protocol === 'interactions') {
      assert.equal(directSent.body.model, 'gemini-4-argon')
    } else {
      assert.ok(directSent.url.endsWith('/models/gemini-4-argon:streamGenerateContent?alt=sse'), directSent.url)
    }
  }
})

for (const protocol of protocols) test(protocol + ': each route uses only its own key, and configuration wins only for proxy', async () => {
  const adapter = createArgonAdapter(context(), config(protocol, { proxyApiKey: '  explicit-proxy-key  ' }))
  for (const [model, expected] of [[PROXY_MODEL, 'explicit-proxy-key'], [GOOGLE_API_MODEL, keys.GOOGLE_API_KEY], [MODEL, keys.GOOGLE_CLOUD_API_KEY]]) {
    await successful(adapter, model)
    assertKey(wire.at(-1), expected)
    if (model !== PROXY_MODEL) assert.equal(JSON.stringify([wire.at(-1).url, [...wire.at(-1).headers], wire.at(-1).body]).includes('explicit-proxy-key'), false)
  }
})

for (const protocol of protocols) test(protocol + ': missing proxy key never falls back to Google or Vertex', async () => {
  const before = wire.length
  const adapter = createArgonAdapter(context({ GOOGLE_API_KEY: keys.GOOGLE_API_KEY, GOOGLE_CLOUD_API_KEY: keys.GOOGLE_CLOUD_API_KEY }), config(protocol))
  const chunks = await collect(adapter.stream(request(PROXY_MODEL)))
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(wire.length, before)
})

for (const protocol of protocols) test(protocol + ': proxy-only credentials authenticate proxy but never a Google model', async () => {
  const adapter = createArgonAdapter(context({ ANTIGRAVITY_API_KEY: keys.ANTIGRAVITY_API_KEY }), config(protocol))
  await successful(adapter, PROXY_MODEL)
  assertKey(wire.at(-1), keys.ANTIGRAVITY_API_KEY)
  const before = wire.length
  const chunks = await collect(adapter.stream(request(GOOGLE_API_MODEL)))
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(wire.length, before)
})

for (const protocol of protocols) test(protocol + ': live key/base/protocol settings refresh profiles while prepared calls retain their snapshot', async () => {
  const values = { ...keys }
  const cfg = config(protocol, { proxyApiKey: 'configured-a' })
  const adapter = createArgonAdapter(context(values), () => cfg)
  const initialProfiles = adapter.inner.current().profiles
  const prepared = await adapter.prepareCall(PROVIDER, PROXY_MODEL)
  cfg.proxyApiKey = 'configured-b'; cfg.proxyBaseUrl = 'http://127.0.0.1:9999/v1beta'
  assert.notEqual(adapter.inner.current().profiles, initialProfiles)
  const prior = await collect(prepared.stream(request(PROXY_MODEL)))
  assert.equal(prior.at(-1).reason.kind, 'stop')
  assertKey(wire.at(-1), 'configured-a')
  assert.equal(new URL(wire.at(-1).url).port, '8045')
  await successful(adapter, PROXY_MODEL); assertKey(wire.at(-1), 'configured-b')
  assert.equal(new URL(wire.at(-1).url).port, '9999')
  cfg.proxyApiKey = ''
  values.ANTIGRAVITY_API_KEY = 'rotated-env-key'
  await successful(adapter, PROXY_MODEL); assertKey(wire.at(-1), 'rotated-env-key')
  values.ANTIGRAVITY_API_KEY = 'rotated-again'
  await successful(adapter, PROXY_MODEL); assertKey(wire.at(-1), 'rotated-again')
  cfg.googleProtocol = protocol === 'interactions' ? 'generate-content' : 'interactions'
  await successful(adapter, PROXY_MODEL)
  assert.equal(wire.at(-1).url.includes('/interactions'), cfg.googleProtocol === 'interactions')
  cfg.proxyEnabled = false
  assert.equal((await adapter.listModels(PROVIDER)).some(m => m.id === PROXY_MODEL), false)
  cfg.routes.hasProxy = true
  assert.equal((await adapter.listModels(PROVIDER)).some(m => m.id === PROXY_MODEL), true)
})

test('volatile proxy edits refresh model registration and effective provider profiles', async () => {
  const settings = config('generate-content', { proxyEnabled: false })
  const hooks = new Map(), cleanups = []
  let adapter, replacements = 0
  const registration = () => {}
  registration.replace = ids => { assert.deepEqual(ids, [PROVIDER]); replacements++ }
  apply({
    ...context(),
    effect: fn => { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
    on: (event, listener) => hooks.set(event, listener),
    llm: { registerAdapter(ids, value) { adapter = value; return registration } },
  }, settings)
  try {
    for (const [name, value] of [['proxyEnabled', true], ['proxyBaseUrl', 'http://127.0.0.1:8888/'], ['proxyApiKey', 'new-key']]) {
      const before = adapter.inner.current().profiles
      settings[name] = value
      hooks.get('loader/volatile-update')()
      assert.notEqual(adapter.inner.current().profiles, before)
    }
    assert.equal(replacements, 3)
    hooks.get('loader/volatile-update')()
    assert.equal(replacements, 3)
    await successful(adapter, PROXY_MODEL)
    assertKey(wire.at(-1), 'new-key')
    assert.equal(new URL(wire.at(-1).url).port, '8888')
  } finally { for (const cleanup of cleanups.reverse()) await cleanup() }
})

for (const protocol of protocols) test(protocol + ': configured key works alone and credential rotation is resolved on every request', async () => {
  const configured = createArgonAdapter(context({}), config(protocol, { proxyApiKey: 'standalone-key' }))
  await successful(configured, PROXY_MODEL)
  assertKey(wire.at(-1), 'standalone-key')
  let credential = 'stored-proxy-a'
  const adapter = createArgonAdapter(context(keys, { resolve: async name => name === 'ANTIGRAVITY_API_KEY' ? { value: credential } : undefined }), config(protocol))
  await successful(adapter, PROXY_MODEL); assertKey(wire.at(-1), 'stored-proxy-a')
  credential = 'stored-proxy-b'
  await successful(adapter, PROXY_MODEL); assertKey(wire.at(-1), 'stored-proxy-b')
})

for (const protocol of protocols) test(protocol + ': proxy credential-store failures never fall back to ambient credentials', async () => {
  const before = wire.length
  let ambientProxyReads = 0
  const ctx = { get: name => name === 'credentials' ? { resolve: async key => { if (key === 'ANTIGRAVITY_API_KEY') throw new Error('secret store unavailable'); return undefined } } : name === 'launchEnvironment' ? { get: key => { if (key === 'ANTIGRAVITY_API_KEY') ambientProxyReads++; return keys[key] ? { value: keys[key] } : undefined } } : undefined }
  const chunks = await collect(createArgonAdapter(ctx, config(protocol)).stream(request(PROXY_MODEL)))
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(ambientProxyReads, 0)
  assert.equal(wire.length, before)
})

for (const protocol of protocols) test(protocol + ': reserved proxy env aliases never select proxy credentials for Google', async () => {
  for (const alias of ['ANTIGRAVITY_API_KEY', 'antigravity_api_key']) {
    const cfg = config(protocol, { routes: { hasGoogle: true, hasVertex: true, googleApiKeyEnv: alias } })
    assert.equal(detectPiAiArgonRoutes({}, cfg.routes).googleApiKeyEnv, 'GOOGLE_API_KEY')
    const adapter = createArgonAdapter(context(keys), cfg)
    await successful(adapter, PROXY_MODEL); assertKey(wire.at(-1), keys.ANTIGRAVITY_API_KEY)
    await successful(adapter, GOOGLE_API_MODEL); assertKey(wire.at(-1), keys.GOOGLE_API_KEY)
    const before = wire.length
    const missingGoogle = createArgonAdapter(context({ ANTIGRAVITY_API_KEY: keys.ANTIGRAVITY_API_KEY }), cfg)
    const chunks = await collect(missingGoogle.stream(request(GOOGLE_API_MODEL)))
    assert.equal(chunks.at(-1).reason.kind, 'error')
    assert.equal(wire.length, before)
  }
})

for (const protocol of protocols) test(protocol + ': non-reserved custom Google credentials remain supported and distinct', async () => {
  const cfg = config(protocol, { routes: { hasGoogle: true, hasVertex: true, googleApiKeyEnv: 'CUSTOM_GOOGLE_KEY' } })
  const adapter = createArgonAdapter(context({ ...keys, CUSTOM_GOOGLE_KEY: 'custom-google-only' }), cfg)
  await successful(adapter, GOOGLE_API_MODEL); assertKey(wire.at(-1), 'custom-google-only')
  await successful(adapter, PROXY_MODEL); assertKey(wire.at(-1), keys.ANTIGRAVITY_API_KEY)
})

test('provider strips both private env markers on every native stream and rejects fallback apiKey', () => {
  const models = [MODEL, GOOGLE_API_MODEL, PROXY_MODEL].map(id => ({ id, provider: PROVIDER, api: id === MODEL ? 'google-vertex' : 'google-generative-ai', maxTokens: 512 }))
  const seen = []
  const native = { auth: {}, stream(model, context, options) { seen.push({ model, options }); return { async *[Symbol.asyncIterator]() {} } } }
  const provider = argonProvider(native, models, 'medium', native)
  for (const model of models) provider.streamSimple(model, { messages: [] }, { apiKey: keys.GOOGLE_CLOUD_API_KEY, env: { __GOOGLE_API_KEY__: keys.GOOGLE_API_KEY, __ANTIGRAVITY_API_KEY__: keys.ANTIGRAVITY_API_KEY, harmless: 'value' } })
  assert.deepEqual(seen.map(x => x.options.apiKey), [keys.GOOGLE_CLOUD_API_KEY, keys.GOOGLE_API_KEY, keys.ANTIGRAVITY_API_KEY])
  for (const row of seen) assert.deepEqual(row.options.env, { harmless: 'value' })
  for (const model of models.slice(1)) assert.throws(() => provider.streamSimple(model, { messages: [] }, { apiKey: keys.GOOGLE_CLOUD_API_KEY }), /credentials|dedicated API key/)
})

test('Google connection explicit key and dedicated namespace prevent all fallback lookups', async () => {
  const lookups = []
  const secret = async name => { lookups.push(name); return keys[name] }
  const explicit = await createGoogleConnection(GoogleGenAI, { route: 'google-generative-ai', resolveSecret: secret, apiKey: 'explicit-key', apiKeyEnv: 'ANTIGRAVITY_API_KEY', baseURL: DEFAULT_PROXY_BASE_URL })
  assert.deepEqual(lookups, [])
  assert.equal(new Headers(await explicit.client.apiClient.getAuthHeaders()).get('x-goog-api-key'), 'explicit-key')
  assert.equal('regionClass' in explicit, false)
  await createGoogleConnection(GoogleGenAI, { route: 'google-generative-ai', resolveSecret: secret, apiKeyEnv: 'ANTIGRAVITY_API_KEY', baseURL: DEFAULT_PROXY_BASE_URL })
  assert.deepEqual(lookups, ['ANTIGRAVITY_API_KEY'])
  lookups.length = 0
  await assert.rejects(createGoogleConnection(GoogleGenAI, { route: 'google-generative-ai', resolveSecret: async name => { lookups.push(name); return name === 'ANTIGRAVITY_API_KEY' ? undefined : 'wrong-key' }, apiKeyEnv: 'ANTIGRAVITY_API_KEY' }), /credentials/)
  assert.deepEqual(lookups, ['ANTIGRAVITY_API_KEY'])
  await assert.rejects(createGoogleConnection(GoogleGenAI, { route: 'google-generative-ai', resolveSecret: secret, apiKey: '', apiKeyEnv: 'ANTIGRAVITY_API_KEY' }), /credentials/)
})
