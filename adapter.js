import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { shared } from './runtime.js'
const { LlmAdapter, LlmError, resolveRetryPolicy, resolveImageAttachmentAccess } = await shared('@deepseek-ai/dsh-llm')
const { PiAiAdapter } = await shared('@deepseek-ai/dsh-llm-pi-ai')
const { launchEnvironmentOf } = await shared('@deepseek-ai/dsh-launch-environment')
const { googleVertexProvider } = await shared('@earendil-works/pi-ai/providers/google-vertex')
const { googleProvider } = await shared('@earendil-works/pi-ai/providers/google')

export const PROVIDER = 'google-vertex-argon'
export const NATIVE_PROVIDER = 'google-vertex'
export const MODEL = 'gemini-4-argon'
export const GOOGLE_API_MODEL = 'gemini-4-argon-google'
export const LEVELS = ['low', 'medium', 'high']
const ENV_KEYS = ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_CLOUD_API_KEY']
const DEFAULT_THINKING_MAP = { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null }

const readVal = v => (v && typeof v === 'object' && typeof v.get === 'function') ? v.get() : v

export function isGemini4Model(model) {
  return Boolean(
    model &&
    typeof model.id === 'string' &&
    /^(?:models\/)?gemini-4\b/i.test(model.id) &&
    (model.api === 'google-vertex' || model.api === 'google-generative-ai'),
  )
}

export function detectPiAiArgonRoutes(ctx, explicitRoutes) {
  if (explicitRoutes && typeof explicitRoutes === 'object') {
    return {
      hasVertex: explicitRoutes.hasVertex !== false,
      hasGoogle: Boolean(explicitRoutes.hasGoogle),
      googleApiKeyEnv: explicitRoutes.googleApiKeyEnv || 'GOOGLE_API_KEY',
      googleBaseUrl: explicitRoutes.googleBaseUrl,
      vertexBaseUrl: explicitRoutes.vertexBaseUrl,
    }
  }
  try {
    const entries = ctx?.get?.('configEditor')?.entries?.() ?? ctx?.root?.loader?.entries?.() ?? []
    for (const entry of entries) {
      if (entry?.options?.id !== 'llm-pi-ai' && entry?.options?.name !== '@deepseek-ai/dsh-llm-pi-ai') continue
      const providers = readVal(entry?.fiber?.config?.providers) ?? readVal(entry?.options?.config?.providers) ?? {}
      const googleCfg = providers?.google
      const vertexCfg = providers?.['google-vertex']
      const hasModel = list => Array.isArray(list) && list.some(m => /^(?:models\/)?gemini-4-argon\b/i.test(String(readVal(m?.id) ?? '')))
      const hasGoogle = hasModel(readVal(googleCfg?.models))
      const hasVertex = hasModel(readVal(vertexCfg?.models))
      return {
        hasVertex: hasVertex || !hasGoogle,
        hasGoogle,
        googleApiKeyEnv: readVal(googleCfg?.apiKeyEnv) || 'GOOGLE_API_KEY',
        googleBaseUrl: readVal(googleCfg?.baseURL),
        vertexBaseUrl: readVal(vertexCfg?.baseURL),
      }
    }
  } catch {}
  return { hasVertex: true, hasGoogle: false, googleApiKeyEnv: 'GOOGLE_API_KEY' }
}

const TRANSIENT_GEMINI_STOP_RE = /(?:Unhandled stop reason:\s*(?:MALFORMED_RESPONSE|MALFORMED_FUNCTION_CALL|UNEXPECTED_TOOL_CALL|TOO_MANY_TOOL_CALLS)|Provider stopped with:\s*(?:MALFORMED_RESPONSE|MALFORMED_FUNCTION_CALL|UNEXPECTED_TOOL_CALL|OTHER|FINISH_REASON_UNSPECIFIED))/i

function wrapGemini4Stream(rawStream) {
  if (!rawStream || typeof rawStream[Symbol.asyncIterator] !== 'function') return rawStream
  return {
    [Symbol.asyncIterator]: async function* () {
      for await (const event of rawStream) {
        if (event?.type === 'error' && typeof event?.error?.errorMessage === 'string' && TRANSIENT_GEMINI_STOP_RE.test(event.error.errorMessage)) {
          yield {
            ...event,
            error: {
              ...event.error,
              errorMessage: `${event.error.errorMessage} (502 upstream transient finishReason)`,
            },
          }
          continue
        }
        yield event
      }
    },
  }
}

export function gemini4StreamSimple(nativeStream, requestModel, context, options = {}, defaultLevel = 'medium', upstreamModelId = requestModel.id) {
  const fallback = defaultLevel ?? (/cyber-permissive/i.test(requestModel?.id ?? '') ? 'high' : 'medium')
  const rawLevel = options.reasoning ?? fallback
  const mapped = requestModel?.thinkingLevelMap?.[rawLevel] ?? rawLevel
  const level = typeof mapped === 'string' ? mapped.toLowerCase() : fallback
  if (!LEVELS.includes(level)) throw new LlmError('Gemini 4 Argon requires low, medium or high.', 'UNSUPPORTED_REASONING_EFFORT')
  const { reasoning, thinking, thinkingBudgets, temperature, onPayload: prior, ...rest } = options
  return wrapGemini4Stream(nativeStream(requestModel, context, {
    ...rest,
    maxTokens: options.maxTokens ?? requestModel.maxTokens,
    async onPayload(payload, payloadModel) {
      const replacement = await prior?.(payload, payloadModel)
      const body = replacement === undefined ? payload : replacement
      if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.contents) || !body.config || typeof body.config !== 'object' || Array.isArray(body.config)) {
        throw new LlmError('Gemini 4 Argon received an incompatible native payload.', 'INVALID_REQUEST')
      }
      if (body.model !== requestModel.id && body.model !== upstreamModelId) {
        throw new LlmError('Gemini 4 Argon received an incompatible model payload.', 'INVALID_REQUEST')
      }
      const { temperature: _t, topP: _tp, topK: _tk, candidateCount: _cc, frequencyPenalty: _fp, presencePenalty: _pp, ...cleanConfig } = body.config
      return {
        ...body,
        model: upstreamModelId,
        config: { ...cleanConfig, thinkingConfig: { thinkingLevel: level.toUpperCase(), includeThoughts: true } },
      }
    },
  }))
}

export function installGemini4PiAiPatch() {
  const proto = PiAiAdapter?.prototype
  if (!proto || typeof proto.current !== 'function') return () => {}
  const origCurrent = proto.current
  const patchedProviders = new Map()
  const ensureGemini4Capabilities = piProvider => {
    if (typeof piProvider?.getModels !== 'function') return
    try {
      for (const m of piProvider.getModels()) {
        if (isGemini4Model(m) && !m.reasoning) {
          m.reasoning = true
          m.thinkingLevelMap = { ...DEFAULT_THINKING_MAP }
        }
      }
    } catch {}
  }
  const wrapProvider = (piProvider, defaultReasoning) => {
    if (!piProvider || typeof piProvider.streamSimple !== 'function' || typeof piProvider.stream !== 'function') return
    ensureGemini4Capabilities(piProvider)
    if (piProvider.id === PROVIDER || patchedProviders.has(piProvider)) return
    const origStreamSimple = piProvider.streamSimple
    patchedProviders.set(piProvider, origStreamSimple)
    piProvider.streamSimple = function (requestModel, context, options = {}) {
      if (isGemini4Model(requestModel)) {
        return gemini4StreamSimple((m, c, o) => piProvider.stream(m, c, o), requestModel, context, options, defaultReasoning, requestModel.id)
      }
      return origStreamSimple.call(this, requestModel, context, options)
    }
  }
  function patchedCurrent() {
    const snapshot = origCurrent.call(this)
    if (snapshot?.profiles instanceof Map) {
      for (const profile of snapshot.profiles.values()) {
        if (profile?.piProvider) wrapProvider(profile.piProvider, profile.reasoning)
      }
    }
    return snapshot
  }
  proto.current = patchedCurrent
  return () => {
    if (proto.current === patchedCurrent) proto.current = origCurrent
    for (const [piProvider, origStreamSimple] of patchedProviders.entries()) {
      piProvider.streamSimple = origStreamSimple
    }
    patchedProviders.clear()
  }
}

export function resolveConfigValues(raw = {}) {
  const source = typeof raw === 'function' ? raw() : raw
  const showInModelPicker = readVal(source?.showInModelPicker) ?? true
  const reasoning = readVal(source?.reasoning) ?? 'medium'
  const contextWindow = readVal(source?.contextWindow) ?? 1048576
  const maxTokens = readVal(source?.maxTokens) ?? 65536
  if (!LEVELS.includes(reasoning)) throw new LlmError('Invalid default Argon effort.', 'INVALID_CONFIG')
  for (const [key, val] of [['contextWindow', contextWindow], ['maxTokens', maxTokens]]) {
    if (!Number.isSafeInteger(val) || val <= 0) throw new LlmError('Invalid Argon ' + key, 'INVALID_CONFIG')
  }
  return {
    showInModelPicker: Boolean(showInModelPicker),
    reasoning,
    contextWindow,
    maxTokens,
    routes: source?.routes,
  }
}

/** Serve both Vertex AI Argon and Gemini API (google) Argon under the unified plugin group. */
export function argonProvider(nativeVertex, models, defaultLevel = 'medium', nativeGoogle = googleProvider()) {
  const modelMap = new Map((Array.isArray(models) ? models : [models]).map(m => [m.id, m]))
  return {
    id: PROVIDER,
    name: 'Vertex Argon',
    auth: nativeVertex.auth,
    getModels: () => [...modelMap.values()],
    streamSimple(requestModel, context, options = {}) {
      const configured = modelMap.get(requestModel?.id)
      if (!configured || requestModel.provider !== PROVIDER) {
        throw new LlmError('Vertex Argon only serves configured Gemini 4 Argon routes.', 'UNSUPPORTED_OPTION')
      }
      const { env: rawEnv, ...restOptions } = options
      const googleApiKey = rawEnv?.__GOOGLE_API_KEY__
      const cleanEnv = rawEnv ? { ...rawEnv } : undefined
      if (cleanEnv) delete cleanEnv.__GOOGLE_API_KEY__
      if (requestModel.id === GOOGLE_API_MODEL || requestModel.api === 'google-generative-ai') {
        const apiKey = googleApiKey || options.apiKey
        return gemini4StreamSimple(
          (m, c, o) => nativeGoogle.stream(m, c, o),
          requestModel,
          context,
          { ...restOptions, ...(cleanEnv ? { env: cleanEnv } : {}), ...(apiKey ? { apiKey } : {}), maxTokens: options.maxTokens ?? configured.maxTokens },
          defaultLevel,
          MODEL,
        )
      }
      if (requestModel.api !== 'google-vertex') {
        throw new LlmError('Vertex Argon only serves google-vertex or google-generative-ai.', 'UNSUPPORTED_OPTION')
      }
      return gemini4StreamSimple(
        (m, c, o) => nativeVertex.stream(m, c, o),
        requestModel,
        context,
        { ...restOptions, ...(cleanEnv ? { env: cleanEnv } : {}), maxTokens: options.maxTokens ?? configured.maxTokens },
        defaultLevel,
        MODEL,
      )
    },
  }
}

export class ArgonAdapter extends LlmAdapter {
  constructor(inner, isVisible = () => true) {
    super()
    this.inner = inner
    this.isVisible = isVisible
  }
  providerInfo(provider) { return this.inner.providerInfo(provider) }
  providerRetryPolicy(provider) { return this.inner.providerRetryPolicy(provider) }
  imageRequestPricing(provider, model) { return this.inner.imageRequestPricing(provider, model) }
  async listModels(provider) {
    if (!this.isVisible()) return []
    return this.inner.listModels(provider)
  }
  resolveModel(provider, model, signal) { return this.inner.resolveModel(provider, model, signal) }
  prepareCall(provider, model, signal) { return this.inner.prepareCall(provider, model, signal) }
  stream(options) { return this.inner.stream(options) }
}

export function createArgonAdapter(ctx, configInput, nativeVertex = googleVertexProvider(), nativeGoogle = googleProvider()) {
  resolveConfigValues(configInput)
  const environment = launchEnvironmentOf(ctx)
  const resolveSecret = async name => {
    try {
      const cred = await ctx?.get?.('credentials')?.resolve?.(name)
      if (cred?.value) return cred.value
    } catch {}
    return environment.get(name)?.value
  }
  const authContext = {
    env: async key => resolveSecret(key),
    async fileExists(file) {
      const expanded = file.startsWith('~/') || file === '~' ? resolve(homedir(), file === '~' ? '' : file.slice(2)) : file
      try { await access(expanded); return true } catch { return false }
    },
  }
  let cachedKey = ''
  let cachedProfiles = null
  const getProfiles = () => {
    const cfg = resolveConfigValues(configInput)
    const detected = detectPiAiArgonRoutes(ctx, cfg.routes)
    const key = JSON.stringify({
      r: cfg.reasoning,
      cw: cfg.contextWindow,
      mt: cfg.maxTokens,
      v: detected.hasVertex,
      g: detected.hasGoogle,
      ge: detected.googleApiKeyEnv,
      gb: detected.googleBaseUrl,
      vb: detected.vertexBaseUrl,
    })
    if (key === cachedKey && cachedProfiles) return cachedProfiles
    const auth = {
      apiKey: {
        ...nativeVertex.auth.apiKey,
        async resolve(input) {
          const vertexRes = await nativeVertex.auth.apiKey.resolve(input)
          const env = {}
          for (const k of ENV_KEYS) {
            const val = await input.ctx.env(k)
            if (val !== undefined) env[k] = val
          }
          const googleKey =
            (await input.ctx.env(detected.googleApiKeyEnv || 'GOOGLE_API_KEY')) ??
            (await input.ctx.env('GOOGLE_API_KEY')) ??
            (await input.ctx.env('GEMINI_API_KEY'))
          if (googleKey) env.__GOOGLE_API_KEY__ = googleKey
          if (vertexRes) {
            return { ...vertexRes, env: { ...env, ...vertexRes.env } }
          }
          if (googleKey) {
            return { auth: {}, env, source: detected.googleApiKeyEnv || 'GOOGLE_API_KEY' }
          }
          return undefined
        },
      },
    }
    const models = []
    if (detected.hasVertex) {
      models.push({
        id: MODEL,
        name: detected.hasGoogle ? 'Gemini 4 Argon (Vertex AI)' : 'Gemini 4 Argon',
        provider: PROVIDER,
        api: 'google-vertex',
        baseUrl: detected.vertexBaseUrl || 'https://{location}-aiplatform.googleapis.com',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: cfg.contextWindow,
        maxTokens: cfg.maxTokens,
        thinkingLevelMap: { ...DEFAULT_THINKING_MAP },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      })
    }
    if (detected.hasGoogle) {
      models.push({
        id: GOOGLE_API_MODEL,
        name: 'Gemini 4 Argon (Gemini API)',
        provider: PROVIDER,
        api: 'google-generative-ai',
        baseUrl: detected.googleBaseUrl || 'https://generativelanguage.googleapis.com/v1beta',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: cfg.contextWindow,
        maxTokens: cfg.maxTokens,
        thinkingLevelMap: { ...DEFAULT_THINKING_MAP },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      })
    }
    const configuredMaxTokens = new Map(models.map(m => [m.id, cfg.maxTokens]))
    const provider = argonProvider({ ...nativeVertex, auth }, models, cfg.reasoning, nativeGoogle)
    cachedKey = key
    cachedProfiles = new Map([[PROVIDER, {
      provider: PROVIDER,
      displayName: 'Vertex Argon',
      piProvider: provider,
      reasoning: cfg.reasoning,
      streamIdleTimeoutMs: 300000,
      maxRequestImageBytes: 20 * 1024 * 1024,
      requestImagePixelBudget: 2048 * 2048,
      requestImageMaxBytes: 1024 * 1024,
      retryPolicy: resolveRetryPolicy(undefined, 'local-vertex-argon'),
      modelErrors: new Map(),
      configuredMaxTokens,
    }]])
    return cachedProfiles
  }
  const inner = new PiAiAdapter({
    profiles: getProfiles,
    resolveApiKey: async () => undefined,
    auth: { authContext },
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, path => ctx.get('fs')?.processPathFromHostPath(path), ref),
  })
  return new ArgonAdapter(inner, () => resolveConfigValues(configInput).showInModelPicker)
}
