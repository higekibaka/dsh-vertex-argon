import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createArgonAdapter,
  argonProvider,
  installGemini4PiAiPatch,
  detectPiAiArgonRoutes,
  resolveConfigValues,
  PROVIDER,
  MODEL,
  GOOGLE_API_MODEL,
  LEVELS,
  MAX_SINGLE_CALL_TOKENS,
  MAX_LONG_DECODE_TOKENS,
  computeReconnectDelayMs,
} from '../adapter.js'
import { Config, apply } from '../index.js'
import { shared } from '../runtime.js'
const { PiAiAdapter } = await shared('@deepseek-ai/dsh-llm-pi-ai')
const { resolveRetryPolicy } = await shared('@deepseek-ai/dsh-llm')
const { googleProvider } = await shared('@earendil-works/pi-ai/providers/google')

const config = { showInModelPicker: true, longDecode: true, contextWindow: 1048576, maxTokens: 65536, reasoning: 'medium' }
const ctx = {
  get: k => k === 'launchEnvironment'
    ? { get: n => n === 'GOOGLE_CLOUD_API_KEY' || n === 'GOOGLE_API_KEY' ? { value: 'fixture-key' } : undefined }
    : undefined,
}
const req = (e, m = MODEL, maxTokens = 512) => ({
  provider: PROVIDER,
  model: m,
  reasoningEffort: e,
  maxTokens,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Use add 17 and 25.' }] }],
  tools: [{
    name: 'add',
    description: 'Add two integers',
    parameters: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'] },
  }],
})
const collect = async stream => {
  const chunks = []
  for await (const c of stream) chunks.push(c)
  return chunks
}
const sseResponse = events => {
  const payload = events.map(e => 'data: ' + JSON.stringify(e) + String.fromCharCode(10, 10)).join('')
  return new Response(payload, { headers: { 'Content-Type': 'text/event-stream' } })
}

const wire = []
let mode = 'tool'
let customResponder = null

globalThis.fetch = async (input, init) => {
  const entry = {
    url: typeof input === 'string' ? input : input.url,
    body: JSON.parse(init?.body ?? await input.text()),
  }
  wire.push(entry)
  if (typeof customResponder === 'function') {
    return customResponder(entry, wire.length)
  }
  const parts = mode === 'tool'
    ? [
        { text: 'Using the tool.', thought: true, thoughtSignature: 'dGhvdWdodA==' },
        { functionCall: { id: 'fixture-id', name: 'add', args: { a: 17, b: 25 } }, thoughtSignature: 'dG9vbA==' },
      ]
    : [{ text: '42', thoughtSignature: 'dGV4dA==' }]
  const finishReason = mode === 'malformed' ? 'MALFORMED_RESPONSE' : 'STOP'
  const data = {
    candidates: [{ content: { role: 'model', parts }, finishReason }],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 6, thoughtsTokenCount: 4, totalTokenCount: 22 },
  }
  return sseResponse([data])
}

test('auto-detects google & google-vertex Argon configs and exposes both in plugin group', async () => {
  const mockCtx = {
    get: k => {
      if (k === 'launchEnvironment') return { get: n => n === 'GOOGLE_CLOUD_API_KEY' || n === 'GOOGLE_API_KEY' ? { value: 'fixture-key' } : undefined }
      if (k === 'configEditor') return {
        entries: () => [{
          options: {
            id: 'llm-pi-ai',
            config: {
              providers: {
                google: { apiKeyEnv: 'GOOGLE_API_KEY', models: [{ id: 'gemini-4-argon' }] },
                'google-vertex': { models: [{ id: 'gemini-4-argon' }] },
              },
            },
          },
        }],
      }
    },
  }
  const detected = detectPiAiArgonRoutes(mockCtx)
  assert.equal(detected.hasVertex, true)
  assert.equal(detected.hasGoogle, true)
  const a = createArgonAdapter(mockCtx, config)
  const models = await a.listModels(PROVIDER)
  assert.deepEqual(models.map(m => ({ id: m.id, name: m.name })), [
    { id: MODEL, name: 'Gemini 4 Argon (Vertex AI)' },
    { id: GOOGLE_API_MODEL, name: 'Gemini 4 Argon (Gemini API)' },
  ])
  const mVertex = await a.resolveModel(PROVIDER, MODEL)
  const mGoogle = await a.resolveModel(PROVIDER, GOOGLE_API_MODEL)
  assert.deepEqual(mVertex.reasoning.efforts.map(e => e.id), ['low', 'medium', 'high'])
  assert.deepEqual(mGoogle.reasoning.efforts.map(e => e.id), ['low', 'medium', 'high'])
  mode = 'tool'
  const outGoogle = await collect(a.stream(req('high', GOOGLE_API_MODEL)))
  assert.deepEqual(outGoogle.at(-1).reason, { kind: 'tool-calls' })
  assert.ok(outGoogle.some(c => c.type === 'reasoning-delta'))
  assert.ok(wire.at(-1).url.includes('generativelanguage.googleapis.com'))
  assert.ok(wire.at(-1).url.includes('models/gemini-4-argon:streamGenerateContent'))
  assert.deepEqual(wire.at(-1).body.generationConfig.thinkingConfig, { thinkingLevel: 'HIGH', includeThoughts: true })
  // Multi-turn signed tool replay on Gemini API model
  const blocks = outGoogle.filter(c => c.type === 'block-end').map(c => c.block)
  const call = blocks.find(b => b.type === 'tool-call')
  const finish = outGoogle.at(-1)
  assert.equal(finish.replayState.response.model, GOOGLE_API_MODEL)
  mode = 'text'
  const next = req('medium', GOOGLE_API_MODEL)
  next.messages.push(
    { id: 'a-1', role: 'assistant', source: { kind: 'model', provider: PROVIDER, model: GOOGLE_API_MODEL, replayState: finish.replayState }, content: blocks },
    { id: 't-1', role: 'tool', toolCallId: call.id, source: { kind: 'tool', callId: call.id }, content: [{ type: 'text', text: '42' }] },
  )
  const second = await collect(a.stream(next))
  assert.deepEqual(second.at(-1).reason, { kind: 'stop' })
  const parts = wire.at(-1).body.contents.flatMap(c => c.parts)
  assert.equal(parts.find(p => p.functionCall).thoughtSignature, 'dG9vbA==')
})

test('all three official levels survive SDK serialization with no thinkingBudget and use v1beta1 on Vertex', async () => {
  mode = 'tool'
  for (const e of LEVELS) {
    const chunks = await collect(createArgonAdapter(ctx, config).stream(req(e)))
    assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' })
    assert.ok(wire.at(-1).url.includes('/v1beta1/'))
    assert.deepEqual(wire.at(-1).body.generationConfig.thinkingConfig, { thinkingLevel: e.toUpperCase(), includeThoughts: true })
    assert.ok(!JSON.stringify(wire.at(-1).body).includes('thinkingBudget'))
    assert.equal(wire.at(-1).body.generationConfig.maxOutputTokens, 512)
    assert.equal(wire.at(-1).body.tools[0].functionDeclarations[0].name, 'add')
  }
})

test('max, off, and xhigh refuse before I/O; omitted effort defaults medium', async () => {
  const a = createArgonAdapter(ctx, config)
  const n = wire.length
  for (const e of ['off', 'xhigh', 'max']) await assert.rejects(collect(a.stream(req(e))), /does not support/)
  assert.equal(wire.length, n)
  await collect(a.stream(req(undefined)))
  assert.equal(wire.at(-1).body.generationConfig.thinkingConfig.thinkingLevel, 'MEDIUM')
})

test('installGemini4PiAiPatch also protects direct google/gemini-4-argon calls', async () => {
  const unpatch = installGemini4PiAiPatch()
  try {
    const baseGoogle = googleProvider()
    const rawModel = {
      id: MODEL,
      name: 'Gemini 4 Argon',
      provider: 'google',
      api: 'google-generative-ai',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      reasoning: false,
      input: ['text', 'image'],
      contextWindow: 1048576,
      maxTokens: 65536,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }
    const customGoogle = { ...baseGoogle, id: 'google', name: 'Google', getModels: () => [rawModel] }
    const profiles = new Map([['google', {
      provider: 'google',
      displayName: 'Google',
      piProvider: customGoogle,
      reasoning: 'medium',
      streamIdleTimeoutMs: 300000,
      maxRequestImageBytes: 20971520,
      requestImagePixelBudget: 4194304,
      requestImageMaxBytes: 1048576,
      retryPolicy: resolveRetryPolicy(undefined, 'test'),
      modelErrors: new Map(),
      configuredMaxTokens: new Map([[MODEL, 65536]]),
    }]])
    const piAdapter = new PiAiAdapter({
      profiles: () => profiles,
      resolveApiKey: async () => 'fixture-google-api-key',
      auth: { authContext: { env: async () => undefined, fileExists: async () => false } },
    })
    const resolved = await piAdapter.resolveModel('google', MODEL)
    assert.deepEqual(resolved.reasoning.efforts.map(e => e.id), ['low', 'medium', 'high'])
    mode = 'tool'
    const out = await collect(piAdapter.stream({ ...req('high'), provider: 'google' }))
    assert.deepEqual(out.at(-1).reason, { kind: 'tool-calls' })
    assert.deepEqual(wire.at(-1).body.generationConfig.thinkingConfig, { thinkingLevel: 'HIGH', includeThoughts: true })
  } finally {
    unpatch()
  }
})

test('long decode multi-hop CONTINUATION stitches thoughts, text, and tool calls while keeping first-hop input usage', async () => {
  const longConfig = { ...config, longDecode: true, maxTokens: 262144 }
  const a = createArgonAdapter(ctx, longConfig)
  const resolved = await a.resolveModel(PROVIDER, MODEL)
  assert.equal(resolved.defaultMaxTokens, 262144)

  const hopCalls = []
  customResponder = entry => {
    hopCalls.push(entry)
    if (hopCalls.length === 1) {
      // Hop 1: thinking-only + empty text placeholder + CONTINUATION
      return sseResponse([{
        candidates: [{
          content: {
            role: 'model',
            parts: [
              { text: 'Step 1. ', thought: true, thoughtSignature: 'dGhvdWdodC0x' },
              { text: '' },
            ],
          },
          finishReason: 'CONTINUATION',
          continuationToken: 'tok-hop-1',
        }],
        usageMetadata: {
          promptTokenCount: 100,
          cachedContentTokenCount: 80,
          candidatesTokenCount: 0,
          thoughtsTokenCount: 40,
          totalTokenCount: 140,
        },
      }])
    }
    if (hopCalls.length === 2) {
      // Hop 2: continues thinking, starts text, emits checkpoint then CONTINUATION
      return sseResponse([
        {
          candidates: [{
            content: {
              role: 'model',
              parts: [
                { text: 'Step 2.', thought: true },
                { text: 'Hello ' },
              ],
            },
            continuationToken: 'tok-ckpt-mid',
          }],
        },
        {
          candidates: [{
            content: {
              role: 'model',
              parts: [{ text: 'world! ' }],
            },
            finishReason: 'CONTINUATION',
            continuationToken: 'tok-hop-2',
          }],
          usageMetadata: {
            promptTokenCount: 140,
            cachedContentTokenCount: 120,
            candidatesTokenCount: 10,
            thoughtsTokenCount: 20,
            totalTokenCount: 170,
          },
        },
      ])
    }
    // Hop 3: finishes text + signed tool call + STOP
    return sseResponse([{
      candidates: [{
        content: {
          role: 'model',
          parts: [
            { text: 'Done.', thoughtSignature: 'dGV4dC1zaWc=' },
            { functionCall: { id: 'call-long-1', name: 'add', args: { a: 17, b: 25 } }, thoughtSignature: 'dG9vbC1zaWc=' },
          ],
        },
        finishReason: 'STOP',
      }],
      usageMetadata: {
        promptTokenCount: 170,
        cachedContentTokenCount: 150,
        candidatesTokenCount: 15,
        thoughtsTokenCount: 5,
        totalTokenCount: 190,
      },
    }])
  }

  try {
    const chunks = await collect(a.stream(req('high', MODEL, 262144)))
    assert.equal(hopCalls.length, 3)
    assert.ok(hopCalls[0].url.includes('/v1beta1/'))
    assert.equal(hopCalls[0].body.continuationToken, undefined)
    assert.equal(hopCalls[1].body.continuationToken, 'tok-hop-1')
    assert.equal(hopCalls[2].body.continuationToken, 'tok-hop-2')

    // Original prompt, tools, and generationConfig are preserved across hops
    const { continuationToken: _1, ...hop2Base } = hopCalls[1].body
    const { continuationToken: _2, ...hop3Base } = hopCalls[2].body
    assert.deepEqual(hop2Base, hopCalls[0].body)
    assert.deepEqual(hop3Base, hopCalls[0].body)

    const blocks = chunks.filter(c => c.type === 'block-end').map(c => c.block)
    assert.equal(blocks.length, 3)
    assert.equal(blocks[0].type, 'reasoning')
    assert.equal(blocks[0].text, 'Step 1. Step 2.')
    assert.equal(blocks[1].type, 'text')
    assert.equal(blocks[1].text, 'Hello world! Done.')
    assert.equal(blocks[2].type, 'tool-call')
    assert.equal(blocks[2].name, 'add')

    const usageChunk = chunks.find(c => c.type === 'usage')
    assert.ok(usageChunk)
    // First-hop prompt tokens (100 total: 20 uncached + 80 cacheRead), NOT summed (100+140+170)
    assert.equal(usageChunk.usage.inputTokens, 20)
    assert.equal(usageChunk.usage.cacheReadTokens, 80)
    // Output tokens summed across all 3 hops: (0+10+15) candidates + (40+20+5) thoughts = 90
    assert.equal(usageChunk.usage.outputTokens, 90)
    assert.equal(usageChunk.usage.totalTokens, 190)

    const finish = chunks.at(-1)
    assert.deepEqual(finish.reason, { kind: 'tool-calls' })
    assert.equal(finish.replayState.blocks[0].thinkingSignature, 'dGhvdWdodC0x')
    assert.equal(finish.replayState.blocks[1].textSignature, 'dGV4dC1zaWc=')
    assert.equal(finish.replayState.blocks[2].thoughtSignature, 'dG9vbC1zaWc=')
  } finally {
    customResponder = null
  }
})

test('resumes dropped stream from intermediate checkpoint token and stops on MAX_TOKENS budget exhaustion', async () => {
  const a = createArgonAdapter(ctx, { ...config, maxTokens: 131072 })
  let step = 0
  customResponder = () => {
    step += 1
    if (step === 1) {
      // Stream ends at checkpoint without a finishReason
      return sseResponse([{
        candidates: [{
          content: { role: 'model', parts: [{ text: 'Part A ' }] },
          continuationToken: 'ckpt-resume-1',
        }],
        usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 10, thoughtsTokenCount: 5, totalTokenCount: 45 },
      }])
    }
    if (step === 2) {
      // Simulate transient "fetch failed" during first reconnect attempt
      throw new TypeError('fetch failed')
    }
    return sseResponse([{
      candidates: [{
        content: { role: 'model', parts: [{ text: 'Part B' }] },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 45, candidatesTokenCount: 12, thoughtsTokenCount: 3, totalTokenCount: 60 },
    }])
  }

  try {
    assert.equal(computeReconnectDelayMs(1, { random: () => 0.5 }), 500)
    assert.equal(computeReconnectDelayMs(2, { random: () => 0.5 }), 1000)
    assert.equal(computeReconnectDelayMs(3, { random: () => 0.5 }), 2000)
    assert.equal(computeReconnectDelayMs(4, { random: () => 0.5 }), 4000)
    assert.equal(computeReconnectDelayMs(5, { random: () => 0.5 }), 8000)
    assert.equal(computeReconnectDelayMs(6, { random: () => 0.5 }), 10000)
    const jittered = computeReconnectDelayMs(1, { random: () => 0.41 })
    assert.ok(jittered >= 450 && jittered <= 550)

    const t0 = Date.now()
    const resumed = await collect(a.stream(req('medium', MODEL, 131072)))
    const elapsed = Date.now() - t0
    assert.equal(step, 3)
    assert.ok(elapsed >= 1300, `expected exponential backoff delay (~500ms + ~1000ms), got ${elapsed}ms`)
    assert.equal(wire.at(-1).body.continuationToken, 'ckpt-resume-1')
    const textBlock = resumed.filter(c => c.type === 'block-end').map(c => c.block).find(b => b.type === 'text')
    assert.equal(textBlock.text, 'Part A Part B')
    const usage = resumed.find(c => c.type === 'usage').usage
    assert.equal(usage.inputTokens, 30)
    assert.equal(usage.outputTokens, 30)
    assert.equal(usage.totalTokens, 60)

    // MAX_TOKENS with continuationToken must NOT auto-continue past budget
    let maxCalls = 0
    customResponder = () => {
      maxCalls += 1
      return sseResponse([{
        candidates: [{
          content: { role: 'model', parts: [{ text: 'Truncated by budget' }] },
          finishReason: 'MAX_TOKENS',
          continuationToken: 'tok-budget-cap',
        }],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 50, thoughtsTokenCount: 10, totalTokenCount: 80 },
      }])
    }
    const capped = await collect(a.stream(req('medium', MODEL, 65536)))
    assert.equal(maxCalls, 1)
    assert.deepEqual(capped.at(-1).reason, { kind: 'max-tokens' })
  } finally {
    customResponder = null
  }
})

test('longDecode=false caps maxTokens at 64K on v1; compaction headroom clamp protects smaller contextWindow', async () => {
  const disabledCfg = resolveConfigValues({ ...config, longDecode: false, maxTokens: 262144 })
  assert.equal(disabledCfg.longDecode, false)
  assert.equal(disabledCfg.maxTokens, MAX_SINGLE_CALL_TOKENS)

  const smallWinCfg = resolveConfigValues({ ...config, longDecode: true, contextWindow: 262144, maxTokens: 524288 })
  assert.equal(smallWinCfg.maxTokens, 131072)

  mode = 'text'
  const aDisabled = createArgonAdapter(ctx, { ...config, longDecode: false, maxTokens: 262144 })
  const out = await collect(aDisabled.stream(req('low', MODEL, 262144)))
  assert.deepEqual(out.at(-1).reason, { kind: 'stop' })
  assert.ok(wire.at(-1).url.includes('/v1/'))
  assert.equal(wire.at(-1).body.generationConfig.maxOutputTokens, MAX_SINGLE_CALL_TOKENS)
})

test('abort, config validation, legacy max listener migration and scoped registration cleanup', async () => {
  const c = new AbortController()
  c.abort()
  const n = wire.length
  const aborted = await collect(createArgonAdapter(ctx, config).stream({ ...req('low'), signal: c.signal }))
  assert.equal(aborted.at(-1).reason.kind, 'aborted')
  assert.equal(wire.length, n)
  assert.equal(Config({}).reasoning.get(), 'medium')
  assert.equal(Config({}).longDecode.get(), true)
  assert.equal(Config({}).maxTokens.get(), MAX_SINGLE_CALL_TOKENS)
  assert.equal(Config({ maxTokens: MAX_LONG_DECODE_TOKENS }).maxTokens.get(), MAX_LONG_DECODE_TOKENS)
  assert.equal(Config({}).contextWindow.get(), 1048576)
  assert.throws(() => Config({ reasoning: 'max' }))
  assert.throws(() => Config({ maxTokens: MAX_LONG_DECODE_TOKENS + 1 }))
  let cleanup
  let disposed = false
  let requestListener
  apply({
    ...ctx,
    effect: f => cleanup = f(),
    on: (ev, fn) => { if (ev === 'agent/request') requestListener = fn },
    llm: {
      registerAdapter: ids => {
        assert.deepEqual(ids, [PROVIDER])
        return () => { disposed = true }
      },
    },
  }, Config({}))
  const migrated1 = await requestListener({}, async () => ({ provider: PROVIDER, model: GOOGLE_API_MODEL, reasoningEffort: 'max' }))
  assert.equal(migrated1.reasoningEffort, 'high')
  cleanup()
  assert.ok(disposed)
  mode = 'malformed'
  const malformed = await collect(createArgonAdapter(ctx, config).stream(req('medium')))
  assert.equal(malformed.at(-1).reason.kind, 'error')
  assert.equal(malformed.at(-1).reason.failure.code, 'SERVER')
  mode = 'tool'
})
