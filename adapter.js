import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { shared } from './runtime.js'
import { createArgonDiagnosticTracker } from './diagnostics.js'
import { createInteractionsHandler } from './interaction-adapter.js'
import { interactionImageRequestTarget } from './interaction-image.js'
import { SERVICE_TIERS, resolveServicePolicy, mergeServiceHeaders } from './service-level.js'
import { generateContentHistory } from './interactions-input.js'
import { createGoogleSignatureBridge } from './google-signatures.js'
import { createInteractionQuery } from './interaction-query.js'
import { assertPreparedStructuredOutput } from './structured-output.js'
import { continueArgonRequestStream, STREAM_READ_TIMEOUT_MS, LONG_DECODE_SYMBOL as ARGON_LONG_DECODE_SYMBOL } from './generate-content.js'
export { MAX_CONTINUATION_HOPS, RECONNECT_INITIAL_DELAY_MS, RECONNECT_MAX_DELAY_MS, RECONNECT_JITTER_RATIO, computeReconnectDelayMs } from './generate-content.js'
const { LlmAdapter, LlmError, resolveRetryPolicy, resolveImageAttachmentAccess } = await shared('@deepseek-ai/dsh-llm')
const { PiAiAdapter } = await shared('@deepseek-ai/dsh-llm-pi-ai')
const { launchEnvironmentOf } = await shared('@deepseek-ai/dsh-launch-environment')
const { googleVertexProvider } = await shared('@earendil-works/pi-ai/providers/google-vertex')
const { googleProvider } = await shared('@earendil-works/pi-ai/providers/google')
const { GoogleGenAI } = await shared('@google/genai')

export const PROVIDER = 'google-vertex-argon'
export const NATIVE_PROVIDER = 'google-vertex'
export const MODEL = 'gemini-4-argon'
export const GOOGLE_API_MODEL = 'gemini-4-argon-google'
export const PROXY_MODEL = 'gemini-4-argon-proxy'
export const PROXY_API_KEY_ENV = 'ANTIGRAVITY_API_KEY'
export const DEFAULT_PROXY_BASE_URL = 'http://127.0.0.1:8045/v1beta'
export const LEVELS = ['low', 'medium', 'high']
export const MAX_SINGLE_CALL_TOKENS = 65536
export const MAX_LONG_DECODE_TOKENS = 1048576
const COMPACTION_HEADROOM_FLOOR = 131072
const ENV_KEYS = ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_CLOUD_API_KEY']
const DEFAULT_THINKING_MAP = { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null }

const readVal = v => (v && typeof v === 'object' && typeof v.get === 'function') ? v.get() : v

export function normalizeProxyBaseUrl(raw) {
  const value = typeof raw === 'string' ? raw.trim() : raw
  if (value != null && typeof value !== 'string') throw new LlmError('Antigravity proxy base URL must be a string.', 'INVALID_CONFIG')
  let url
  try { url = new URL(value || DEFAULT_PROXY_BASE_URL) } catch { throw new LlmError('Antigravity proxy base URL must be a valid HTTP(S) URL.', 'INVALID_CONFIG') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new LlmError('Antigravity proxy base URL must use HTTP or HTTPS.', 'INVALID_CONFIG')
  url.pathname = (!url.pathname || url.pathname === '/') ? '/v1beta' : url.pathname.replace(/[/]+$/, '')
  return url.href
}

export function isGemini4Model(model) {
  return Boolean(
    model &&
    typeof model.id === 'string' &&
    /^(?:models\/)?gemini-4\b/i.test(model.id) &&
    (model.api === 'google-vertex' || model.api === 'google-generative-ai'),
  )
}

function googleKeyEnvironment(value) {
  const name = typeof value === 'string' ? value.trim() : ''
  // The proxy credential namespace is reserved, including Windows case aliases.
  return !name || name.toUpperCase() === PROXY_API_KEY_ENV ? 'GOOGLE_API_KEY' : name
}

export function detectPiAiArgonRoutes(ctx, explicitRoutes) {
  if (explicitRoutes && typeof explicitRoutes === 'object') {
    return {
      hasVertex: explicitRoutes.hasVertex !== false,
      hasGoogle: Boolean(explicitRoutes.hasGoogle),
      hasProxy: explicitRoutes.hasProxy === true,
      googleApiKeyEnv: googleKeyEnvironment(explicitRoutes.googleApiKeyEnv),
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
        googleApiKeyEnv: googleKeyEnvironment(readVal(googleCfg?.apiKeyEnv)),
        googleBaseUrl: readVal(googleCfg?.baseURL),
        vertexBaseUrl: readVal(vertexCfg?.baseURL),
      }
    }
  } catch {}
  return { hasVertex: true, hasGoogle: false, googleApiKeyEnv: 'GOOGLE_API_KEY' }
}

const TRANSIENT_GEMINI_STOP_RE = /(?:Unhandled stop reason:\s*(?:MALFORMED_RESPONSE|MALFORMED_FUNCTION_CALL|UNEXPECTED_TOOL_CALL|TOO_MANY_TOOL_CALLS)|Provider stopped with:\s*(?:MALFORMED_RESPONSE|MALFORMED_FUNCTION_CALL|UNEXPECTED_TOOL_CALL|OTHER|FINISH_REASON_UNSPECIFIED))/i

let apiClientProtoRef = null
let apiClientPatch = null

function getApiClientPrototype() {
  if (apiClientProtoRef) return apiClientProtoRef
  try {
    const probe = new GoogleGenAI({ apiKey: 'argon-probe' })
    if (probe?.apiClient) {
      apiClientProtoRef = Object.getPrototypeOf(probe.apiClient)
    }
  } catch {}
  return apiClientProtoRef
}

export function ensureGemini4ApiClientPatch() {
  const proto = getApiClientPrototype()
  if (!proto || typeof proto.requestStream !== 'function') return () => {}
  if (apiClientPatch) return apiClientPatch.dispose
  const orig = proto.requestStream
  let active = true
  function patchedRequestStream(request) {
    const meta = request?.httpOptions?.[ARGON_LONG_DECODE_SYMBOL]
    if (!active || !meta) return orig.call(this, request)
    return continueArgonRequestStream(this, orig, request, meta)
  }
  const patch = {
    dispose() {
      if (!active) return
      active = false
      // A later wrapper belongs to its installer, even when it delegates to us.
      if (proto.requestStream === patchedRequestStream) proto.requestStream = orig
      if (apiClientPatch === patch) apiClientPatch = null
    },
  }
  proto.requestStream = patchedRequestStream
  apiClientPatch = patch
  return patch.dispose
}

function wrapGemini4Stream(rawStream, tracker, signal) {
  if (!rawStream || typeof rawStream[Symbol.asyncIterator] !== 'function') return rawStream
  return {
    [Symbol.asyncIterator]: async function* () {
      try {
        for await (const event of rawStream) {
          if (event?.type === 'done') {
            const stop = event.message?.stopReason
            const outcome = stop === 'toolUse' ? 'tool-calls' : stop === 'length' ? 'max-tokens' : 'done'
            tracker?.finishStream({ outcome })
          } else if (event?.type === 'error') {
            const isTransient =
              typeof event?.error?.errorMessage === 'string' &&
              TRANSIENT_GEMINI_STOP_RE.test(event.error.errorMessage)
            tracker?.finishStream({
              outcome: signal?.aborted ? 'aborted' : 'error',
              error: event.error,
              transientFinishReason: isTransient,
            })
            if (isTransient) {
              yield {
                ...event,
                error: {
                  ...event.error,
                  errorMessage: `${event.error.errorMessage} (502 upstream transient finishReason)`,
                },
              }
              continue
            }
          }
          yield event
        }
      } catch (error) {
        tracker?.finishStream({
          outcome: signal?.aborted ? 'aborted' : 'error',
          error,
        })
        throw error
      } finally {
        tracker?.finalize(Boolean(signal?.aborted))
      }
    },
    ...(typeof rawStream.result === 'function' ? { result: rawStream.result.bind(rawStream) } : {}),
  }
}

export function gemini4StreamSimple(
  nativeStream,
  requestModel,
  context,
  options = {},
  defaultLevel = 'medium',
  upstreamModelId = requestModel.id,
  longDecode = true,
  recordDiagnostic,
  servicePolicy = { tier: 'standard', headers: {} },
  captureOptions = {},
  structuredOutput,
) {
  assertPreparedStructuredOutput(structuredOutput)
  ensureGemini4ApiClientPatch()
  const fallback = defaultLevel ?? (/cyber-permissive/i.test(requestModel?.id ?? '') ? 'high' : 'medium')
  const rawLevel = options.reasoning ?? fallback
  const mapped = requestModel?.thinkingLevelMap?.[rawLevel] ?? rawLevel
  const level = typeof mapped === 'string' ? mapped.toLowerCase() : fallback
  if (!LEVELS.includes(level)) throw new LlmError('Gemini 4 Argon requires low, medium or high.', 'UNSUPPORTED_REASONING_EFFORT')
  const resolvedUpstreamModelId = requestModel?.id === PROXY_MODEL ? `${MODEL}-${level}` : upstreamModelId
  const { reasoning, thinking, thinkingBudgets, temperature, onPayload: prior, onProviderStreamEvent: priorEvent, ...rest } = options
  const requestedMaxTokens = options.maxTokens ?? requestModel.maxTokens
  const effectiveMaxTokens =
    longDecode === false && typeof requestedMaxTokens === 'number' && requestedMaxTokens > MAX_SINGLE_CALL_TOKENS
      ? MAX_SINGLE_CALL_TOKENS
      : requestedMaxTokens
  const tracker = createArgonDiagnosticTracker(
    {
      model: requestModel?.id,
      route: requestModel?.api,
      apiVersion: longDecode === false ? 'v1' : 'v1beta1',
      thinkingLevel: level.toUpperCase(),
      longDecode: longDecode !== false,
      maxTokens: effectiveMaxTokens,
      sessionId: options.sessionId,
      requestedServiceTier: servicePolicy.tier,
    },
    recordDiagnostic,
    captureOptions,
  )
  const signatures = createGoogleSignatureBridge(context, requestModel)
  return wrapGemini4Stream(
    signatures.stream(nativeStream(requestModel, signatures.context, {
      ...rest,
      maxTokens: effectiveMaxTokens,
      async onProviderStreamEvent(chunk, model) { signatures.observe(chunk); await priorEvent?.(chunk, model) },
      async onPayload(payload, payloadModel) {
        const replacement = await prior?.(payload, payloadModel)
        let body = replacement === undefined ? payload : replacement
        if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.contents) || !body.config || typeof body.config !== 'object' || Array.isArray(body.config)) {
          throw new LlmError('Gemini 4 Argon received an incompatible native payload.', 'INVALID_REQUEST')
        }
        if (body.model !== requestModel.id && body.model !== upstreamModelId && body.model !== resolvedUpstreamModelId) {
          throw new LlmError('Gemini 4 Argon received an incompatible model payload.', 'INVALID_REQUEST')
        }
        body = signatures.restorePayload(body)
        if (structuredOutput) body = structuredOutput.generateContent(body)
        const { temperature: _t, topP: _tp, topK: _tk, candidateCount: _cc, frequencyPenalty: _fp, presencePenalty: _pp, ...cleanConfig } = body.config
        const prevHttpOptions =
          cleanConfig.httpOptions && typeof cleanConfig.httpOptions === 'object' && !Array.isArray(cleanConfig.httpOptions)
            ? cleanConfig.httpOptions
            : {}
        return {
          ...body,
          model: resolvedUpstreamModelId,
          config: {
            ...cleanConfig,
            ...(cleanConfig.tools?.some(tool => tool.functionDeclarations?.length) ? {
              toolConfig: {
                ...cleanConfig.toolConfig,
                functionCallingConfig: { ...cleanConfig.toolConfig?.functionCallingConfig, mode: 'VALIDATED' },
              },
            } : {}),
            automaticContinuation: false,
            thinkingConfig: { thinkingLevel: level.toUpperCase(), includeThoughts: true },
            httpOptions: {
              ...prevHttpOptions,
              ...(Object.keys(servicePolicy.headers).length ? { headers: mergeServiceHeaders(prevHttpOptions.headers, servicePolicy) } : {}),
              [ARGON_LONG_DECODE_SYMBOL]: {
                enabled: longDecode !== false,
                serviceTier: requestModel.api === 'google-generative-ai' ? servicePolicy.tier : undefined,
                tracker,
              },
            },
          },
        }
      },
    })),
    tracker,
    options.signal,
  )
}

export function installGemini4PiAiPatch(recordDiagnostic, configInput = {}, responseHub) {
  const unpatchApiClient = ensureGemini4ApiClientPatch()
  const proto = PiAiAdapter?.prototype
  if (!proto || typeof proto.current !== 'function') return unpatchApiClient
  const origCurrent = proto.current
  const patchedProviders = new Map()
  let active = true
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
    function patchedStreamSimple(requestModel, context, options = {}) {
      if (active && isGemini4Model(requestModel)) {
        const cfg = resolveConfigValues(configInput)
        return gemini4StreamSimple(
          (m, c, o) => piProvider.stream(m, c, o), requestModel, context, options,
          defaultReasoning, requestModel.id, cfg.longDecode, recordDiagnostic,
          resolveServicePolicy(cfg, requestModel.api, 'generate-content'),
          { responseHub, retainRawResponses: cfg.retainRawResponses },
        )
      }
      return origStreamSimple.call(this, requestModel, context, options)
    }
    patchedProviders.set(piProvider, { origStreamSimple, patchedStreamSimple })
    piProvider.streamSimple = patchedStreamSimple
  }
  function patchedCurrent() {
    const snapshot = origCurrent.call(this)
    if (active && snapshot?.profiles instanceof Map) {
      for (const profile of snapshot.profiles.values()) {
        if (profile?.piProvider) wrapProvider(profile.piProvider, profile.reasoning)
      }
    }
    return snapshot
  }
  proto.current = patchedCurrent
  return () => {
    if (!active) return
    active = false
    unpatchApiClient()
    if (proto.current === patchedCurrent) proto.current = origCurrent
    for (const [piProvider, { origStreamSimple, patchedStreamSimple }] of patchedProviders) {
      if (piProvider.streamSimple === patchedStreamSimple) piProvider.streamSimple = origStreamSimple
    }
    patchedProviders.clear()
  }
}

export function resolveConfigValues(raw = {}) {
  const source = typeof raw === 'function' ? raw() : raw
  const showInModelPicker = readVal(source?.showInModelPicker) ?? true
  const reasoning = readVal(source?.reasoning) ?? 'medium'
  const longDecode = readVal(source?.longDecode) ?? true
  const contextWindow = readVal(source?.contextWindow) ?? 1048576
  const rawMaxTokens = readVal(source?.maxTokens) ?? MAX_SINGLE_CALL_TOKENS
  const googleProtocol = readVal(source?.googleProtocol) ?? 'generate-content'
  const vertexProtocol = readVal(source?.vertexProtocol) ?? 'generate-content'
  const googleServiceTier = readVal(source?.googleServiceTier) ?? 'standard'
  const vertexServiceTier = readVal(source?.vertexServiceTier) ?? 'standard'
  const vertexPaygoOnly = readVal(source?.vertexPaygoOnly) ?? false
  const proxyEnabled = readVal(source?.proxyEnabled) ?? false
  const proxyBaseUrl = normalizeProxyBaseUrl(readVal(source?.proxyBaseUrl))
  const proxyApiKey = readVal(source?.proxyApiKey) ?? ''
  if (typeof proxyEnabled !== 'boolean' || typeof proxyApiKey !== 'string') throw new LlmError('Invalid Antigravity proxy configuration.', 'INVALID_CONFIG')
  const retainRawResponses = readVal(source?.retainRawResponses) ?? false
  if (typeof retainRawResponses !== 'boolean') throw new LlmError('Raw response retention consent must be an explicit boolean.', 'INVALID_CONFIG')
  if (![googleServiceTier, vertexServiceTier].every(tier => SERVICE_TIERS.includes(tier))) throw new LlmError('Invalid Argon service tier.', 'INVALID_CONFIG')
  if (typeof vertexPaygoOnly !== 'boolean') throw new LlmError('Vertex PayGo-only selection must be a boolean.', 'INVALID_CONFIG')
  const interactionsBackground = readVal(source?.interactionsBackground) ?? false
  const allowInteractionStorage = readVal(source?.allowInteractionStorage) ?? false
  if (typeof interactionsBackground !== 'boolean' || typeof allowInteractionStorage !== 'boolean') throw new LlmError('Interactions background/storage consent must be explicit booleans.', 'INVALID_CONFIG')
  for (const protocol of [googleProtocol, vertexProtocol]) {
    if (!['generate-content', 'interactions'].includes(protocol)) throw new LlmError('Invalid Argon protocol.', 'INVALID_CONFIG')
  }
  if (!LEVELS.includes(reasoning)) throw new LlmError('Invalid default Argon effort.', 'INVALID_CONFIG')
  for (const [key, val] of [['contextWindow', contextWindow], ['maxTokens', rawMaxTokens]]) {
    if (!Number.isSafeInteger(val) || val <= 0 || val > MAX_LONG_DECODE_TOKENS) throw new LlmError('Invalid Argon ' + key, 'INVALID_CONFIG')
  }
  const enabledLongDecode = Boolean(longDecode)
  const capByMode = enabledLongDecode ? Math.min(rawMaxTokens, MAX_LONG_DECODE_TOKENS) : Math.min(rawMaxTokens, MAX_SINGLE_CALL_TOKENS)
  const safeCompactionCap = contextWindow > COMPACTION_HEADROOM_FLOOR ? contextWindow - COMPACTION_HEADROOM_FLOOR : contextWindow
  const maxTokens = Math.max(1, Math.min(capByMode, safeCompactionCap))
  return {
    showInModelPicker: Boolean(showInModelPicker),
    reasoning,
    longDecode: enabledLongDecode,
    contextWindow,
    maxTokens,
    googleProtocol,
    vertexProtocol,
    googleServiceTier,
    vertexServiceTier,
    vertexPaygoOnly,
    proxyEnabled,
    proxyBaseUrl,
    proxyApiKey: proxyApiKey.trim(),
    retainRawResponses,
    interactionsBackground,
    allowInteractionStorage,
    routes: source?.routes,
  }
}

/** Serve Vertex AI, Gemini API and isolated Antigravity proxy models in one plugin group. */
export function argonProvider(nativeVertex, models, defaultLevel = 'medium', nativeGoogle = googleProvider(), longDecode = true, recordDiagnostic, serviceConfig = {}, responseHub, structuredOutput) {
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
      const { env: rawEnv, apiKey: vertexApiKey, ...restOptions } = options
      const cleanEnv = rawEnv ? { ...rawEnv } : undefined
      if (cleanEnv) {
        delete cleanEnv.__GOOGLE_API_KEY__
        delete cleanEnv.__ANTIGRAVITY_API_KEY__
      }
      if (configured.api === 'google-generative-ai') {
        const proxy = configured.id === PROXY_MODEL
        const apiKey = proxy ? rawEnv?.__ANTIGRAVITY_API_KEY__ : rawEnv?.__GOOGLE_API_KEY__
        if (!apiKey) throw new LlmError(proxy ? 'Antigravity proxy requires its dedicated API key.' : 'Gemini API credentials are not configured.', 'MISSING_CREDENTIAL')
        return gemini4StreamSimple(
          (m, c, o) => nativeGoogle.stream(m, c, o),
          requestModel,
          context,
          { ...restOptions, ...(cleanEnv ? { env: cleanEnv } : {}), ...(apiKey ? { apiKey } : {}), maxTokens: options.maxTokens ?? configured.maxTokens },
          defaultLevel,
          MODEL,
          longDecode,
          recordDiagnostic,
          resolveServicePolicy(serviceConfig, 'google-generative-ai', 'generate-content'),
          { responseHub, retainRawResponses: serviceConfig.retainRawResponses }, structuredOutput,
        )
      }
      if (requestModel.api !== 'google-vertex') {
        throw new LlmError('Vertex Argon only serves google-vertex or google-generative-ai.', 'UNSUPPORTED_OPTION')
      }
      return gemini4StreamSimple(
        (m, c, o) => nativeVertex.stream(m, c, o),
        requestModel,
        context,
        { ...restOptions, ...(cleanEnv ? { env: cleanEnv } : {}), ...(vertexApiKey ? { apiKey: vertexApiKey } : {}), maxTokens: options.maxTokens ?? configured.maxTokens },
        defaultLevel,
        MODEL,
        longDecode,
        recordDiagnostic,
        resolveServicePolicy(serviceConfig, 'google-vertex', 'generate-content'),
        { responseHub, retainRawResponses: serviceConfig.retainRawResponses }, structuredOutput,
      )
    },
  }
}

export class ArgonAdapter extends LlmAdapter {
  constructor(inner, isVisible = () => true, interactionHandler, configSnapshot) {
    super()
    this.inner = inner
    this.isVisible = isVisible
    this.interactionHandler = interactionHandler
    this.configSnapshot = configSnapshot
  }
  providerInfo(provider) { return this.inner.providerInfo(provider) }
  providerRetryPolicy(provider) { return this.inner.providerRetryPolicy(provider) }
  imageRequestPricing(provider, model) { return this.inner.imageRequestPricing?.(provider, model) }
  imageRequestTarget(provider, model, image) {
    const cfg = this.configSnapshot?.()
    const protocol = (model === GOOGLE_API_MODEL || model === PROXY_MODEL) ? cfg?.googleProtocol : cfg?.vertexProtocol
    if (provider === PROVIDER && protocol === 'interactions' && this.interactionHandler) return interactionImageRequestTarget(image)
    return this.inner.imageRequestTarget(provider, model, image)
  }
  async listModels(provider) {
    if (!this.isVisible()) return []
    return this.inner.listModels(provider)
  }
  resolveModel(provider, model, signal) { return this.inner.resolveModel(provider, model, signal) }
  async prepareCall(provider, model, signal) {
    const cfg = this.configSnapshot?.()
    if (provider === PROVIDER && cfg) resolveServicePolicy(cfg, (model === GOOGLE_API_MODEL || model === PROXY_MODEL) ? 'google-generative-ai' : 'google-vertex', (model === GOOGLE_API_MODEL || model === PROXY_MODEL) ? cfg.googleProtocol : cfg.vertexProtocol)
    const prepared = await this.inner.prepareCall(provider, model, signal)
    const protocol = (model === GOOGLE_API_MODEL || model === PROXY_MODEL) ? cfg?.googleProtocol : cfg?.vertexProtocol
    if (provider === PROVIDER && protocol === 'interactions' && this.interactionHandler) {
      return { model: prepared.model, stream: options => this.interactionHandler(options, cfg) }
    }
    return { ...prepared, stream: options => prepared.stream(generateContentHistory(options)) }
  }
  async *stream(options) {
    const prepared = await this.prepareCall(options.provider, options.model, options.signal)
    yield* prepared.stream(options)
  }
}

export function createConfiguredInteractionQuery(ctx, configInput) {
  const environment = launchEnvironmentOf(ctx)
  return createInteractionQuery({
    GoogleGenAI,
    getRoutes: () => {
      const source = typeof configInput === 'function' ? configInput() : configInput
      return detectPiAiArgonRoutes(ctx, readVal(source?.routes))
    },
    // Same credential precedence as generation, but a store failure must not
    // silently select a different ambient account for an arbitrary-ID lookup.
    resolveSecret: async name => (await ctx?.get?.('credentials')?.resolve?.(name))?.value || environment.get(name)?.value,
  })
}

// Optional constructor-owned format is for an explicit auxiliary result request;
// it is not a user default or a hidden extension of Host GenerateOptions.
export function createArgonAdapter(ctx, configInput, nativeVertex = googleVertexProvider(), nativeGoogle = googleProvider(), recordDiagnostic, taskHub, responseHub, structuredOutput) {
  assertPreparedStructuredOutput(structuredOutput)
  resolveConfigValues(configInput)
  const environment = launchEnvironmentOf(ctx)
  const resolveSecret = async name => {
    // A failed credential store must never silently select an ambient account.
    const cred = await ctx?.get?.('credentials')?.resolve?.(name)
    if (cred?.value) return cred.value
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
      ld: cfg.longDecode,
      cw: cfg.contextWindow,
      mt: cfg.maxTokens,
      visible: cfg.showInModelPicker,
      gp: cfg.googleProtocol,
      vp: cfg.vertexProtocol,
      background: cfg.interactionsBackground,
      storage: cfg.allowInteractionStorage,
      gt: cfg.googleServiceTier,
      vt: cfg.vertexServiceTier,
      paygo: cfg.vertexPaygoOnly,
      raw: cfg.retainRawResponses,
      pe: cfg.proxyEnabled,
      pb: cfg.proxyBaseUrl,
      pk: cfg.proxyApiKey,
      p: detected.hasProxy,
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
          const proxyKey = cfg.proxyApiKey || await input.ctx.env(PROXY_API_KEY_ENV)
          if (googleKey) env.__GOOGLE_API_KEY__ = googleKey
          if (proxyKey) env.__ANTIGRAVITY_API_KEY__ = proxyKey
          if (vertexRes) {
            return { ...vertexRes, env: { ...env, ...vertexRes.env } }
          }
          if (googleKey || proxyKey) {
            return { auth: {}, env, source: googleKey ? (detected.googleApiKeyEnv || 'GOOGLE_API_KEY') : PROXY_API_KEY_ENV }
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
    if (cfg.proxyEnabled || detected.hasProxy) {
      models.push({
        id: PROXY_MODEL,
        name: 'Gemini 4 Argon (Antigravity)',
        provider: PROVIDER,
        api: 'google-generative-ai',
        baseUrl: cfg.proxyBaseUrl,
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: cfg.contextWindow,
        maxTokens: cfg.maxTokens,
        thinkingLevelMap: { ...DEFAULT_THINKING_MAP },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      })
    }
    const configuredMaxTokens = new Map(models.map(m => [m.id, cfg.maxTokens]))
    const provider = argonProvider({ ...nativeVertex, auth }, models, cfg.reasoning, nativeGoogle, cfg.longDecode, recordDiagnostic, cfg, responseHub, structuredOutput)
    cachedKey = key
    cachedProfiles = new Map([[PROVIDER, {
      provider: PROVIDER,
      displayName: 'Vertex Argon',
      piProvider: provider,
      reasoning: cfg.reasoning,
      streamIdleTimeoutMs: cfg.longDecode ? STREAM_READ_TIMEOUT_MS + 60000 : 300000,
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
  const configSnapshot = () => {
    const cfg = resolveConfigValues(configInput)
    return { ...cfg, routes: detectPiAiArgonRoutes(ctx, cfg.routes) }
  }
  const interactionHandler = createInteractionsHandler({ ctx, GoogleGenAI, resolveSecret, getRoutes: cfg => cfg.routes, taskHub, recordDiagnostic, responseHub, structuredOutput })
  return new ArgonAdapter(inner, () => configSnapshot().showInModelPicker, interactionHandler, configSnapshot)
}
