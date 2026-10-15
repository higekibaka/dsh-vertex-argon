import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { shared } from './runtime.js'
import { createArgonDiagnosticTracker } from './diagnostics.js'
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
export const LEVELS = ['low', 'medium', 'high']
export const MAX_SINGLE_CALL_TOKENS = 65536
export const MAX_LONG_DECODE_TOKENS = 524288
export const MAX_CONTINUATION_HOPS = 32
export const RECONNECT_INITIAL_DELAY_MS = 500
export const RECONNECT_MAX_DELAY_MS = 10000
export const RECONNECT_JITTER_RATIO = 0.1
const MAX_STREAM_RECONNECTS_WITHOUT_PROGRESS = 3
const COMPACTION_HEADROOM_FLOOR = 131072
const ENV_KEYS = ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_CLOUD_API_KEY']
const DEFAULT_THINKING_MAP = { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null }
const ARGON_LONG_DECODE_SYMBOL = Symbol.for('dsh.vertexArgon.longDecode')

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

function isEmptyPlaceholderPart(part) {
  return Boolean(
    part &&
    typeof part === 'object' &&
    part.text === '' &&
    !part.thought &&
    !part.thoughtSignature &&
    !part.functionCall,
  )
}

function hasMeaningfulPart(parts) {
  return Array.isArray(parts) && parts.some(p =>
    p &&
    typeof p === 'object' &&
    (p.thought || p.thoughtSignature || p.functionCall || (typeof p.text === 'string' && p.text.length > 0)),
  )
}

function isAbortedError(err, signal) {
  return Boolean(signal?.aborted) || (err instanceof Error && err.name === 'AbortError')
}

function isNonRetryableApiRejection(err, receivedAnyChunk, hopCount, hasCheckpointToken) {
  if (receivedAnyChunk) return false
  if (!(err instanceof Error && (err.name === 'ApiError' || ('status' in err && typeof err.status === 'number')))) {
    return false
  }
  if (!hasCheckpointToken || hopCount <= 1) return true
  const status = typeof err.status === 'number' ? err.status : 0
  if (status === 408 || status === 429 || (status >= 500 && status < 600)) return false
  return true
}

export function computeReconnectDelayMs(attempt, options = {}) {
  const initialDelayMs = options?.initialDelayMs ?? RECONNECT_INITIAL_DELAY_MS
  if (!(initialDelayMs > 0)) return 0
  const maxDelayMs = options?.maxDelayMs ?? RECONNECT_MAX_DELAY_MS
  const jitterRatio = options?.jitterRatio ?? RECONNECT_JITTER_RATIO
  const random = options?.random ?? Math.random
  const exponent = Math.min(Math.max(0, attempt - 1), 10)
  const exponential = Math.min(initialDelayMs * (2 ** exponent), maxDelayMs)
  const jitter = 1 - jitterRatio + 2 * jitterRatio * random()
  return Math.round(Math.min(exponential * jitter, maxDelayMs))
}

function waitWithAbort(delayMs, signal) {
  if (!(delayMs > 0)) return Promise.resolve()
  if (signal?.aborted) {
    const err = new Error('The operation was aborted')
    err.name = 'AbortError'
    return Promise.reject(err)
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, delayMs)
    function onAbort() {
      clearTimeout(timer)
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      reject(err)
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

async function continueArgonRequestStream(apiClient, origRequestStream, request, meta) {
  const { [ARGON_LONG_DECODE_SYMBOL]: _, ...restHttpOptions } = request?.httpOptions ?? {}
  const enableContinuation = meta?.enabled !== false
  const tracker = meta?.tracker
  if (
    enableContinuation &&
    typeof apiClient?.isVertexAI === 'function' &&
    apiClient.isVertexAI() &&
    !restHttpOptions.apiVersion &&
    apiClient?.clientOptions?.httpOptions?.apiVersion === 'v1'
  ) {
    restHttpOptions.apiVersion = 'v1beta1'
  }
  const effectiveApiVersion =
    restHttpOptions.apiVersion || apiClient?.clientOptions?.httpOptions?.apiVersion || 'v1beta1'
  tracker?.setApiVersion(effectiveApiVersion)
  const hopHttpOptions = Object.keys(restHttpOptions).length > 0 ? restHttpOptions : undefined
  const firstReq = { ...request, httpOptions: hopHttpOptions }
  const hop1Tracker = tracker?.beginHop({
    hopIndex: 1,
    trigger: 'initial',
    usedContinuationToken: false,
    backoffDelayMs: 0,
    body: firstReq.body,
  })
  let firstStream
  try {
    firstStream = await origRequestStream.call(apiClient, firstReq)
  } catch (error) {
    hop1Tracker?.finish({
      error,
      aborted: isAbortedError(error, request?.abortSignal),
    })
    throw error
  }
  if (!enableContinuation && !tracker) return firstStream

  return (async function* () {
    let baseBodyObj
    let resumeToken
    let reconnectsWithoutProgress = 0
    let consecutiveReconnectFailures = 0
    let lastError
    let hopCount = 0
    let nextHopTrigger = 'initial'
    let nextHopBackoffMs = 0
    let nextHopBody = firstReq.body
    let initialPromptTokens
    let initialCachedTokens
    let completedCandidatesTokens = 0
    let completedThoughtsTokens = 0
    let completedToolUsePromptTokens = 0
    let completedBilledPromptTokens = 0
    let completedBilledCachedTokens = 0
    let completedBilledTotalTokens = 0
    let openHop = async () => firstStream

    while (true) {
      hopCount += 1
      const hopStartToken = resumeToken
      const hopTracker =
        hopCount === 1
          ? hop1Tracker
          : tracker?.beginHop({
              hopIndex: hopCount,
              trigger: nextHopTrigger,
              usedContinuationToken: Boolean(hopStartToken),
              backoffDelayMs: nextHopBackoffMs,
              body: nextHopBody,
            })
      let hopToken
      let hopFinishReason
      let hopHasPromptFeedback = false
      let hopHasYieldedContent = false
      let hopReceivedAnyChunk = false
      let hopUsage
      let hopError

      try {
        for await (const httpChunk of await openHop()) {
          const raw = await httpChunk.json()
          if (!raw || typeof raw !== 'object') {
            yield { headers: httpChunk.headers, json: async () => raw }
            continue
          }
          hopReceivedAnyChunk = true
          if (raw.promptFeedback !== undefined && raw.promptFeedback !== null) {
            hopHasPromptFeedback = true
          }
          let outRaw = raw
          const candidate = Array.isArray(raw.candidates) ? raw.candidates[0] : undefined
          hopTracker?.onChunk({
            status: 200,
            hasCheckpoint: Boolean(
              candidate && typeof candidate.continuationToken === 'string' && candidate.continuationToken.length > 0,
            ),
            finishReason: candidate?.finishReason,
          })
          if (candidate && typeof candidate === 'object') {
            if (typeof candidate.continuationToken === 'string' && candidate.continuationToken.length > 0) {
              hopToken = candidate.continuationToken
            } else if (candidate.finishReason !== undefined && candidate.finishReason !== 'CONTINUATION') {
              hopToken = undefined
            }
            if (candidate.finishReason !== undefined) {
              hopFinishReason = candidate.finishReason
            }
            if (hasMeaningfulPart(candidate.content?.parts)) {
              hopHasYieldedContent = true
            }
            const canContinueHop =
              enableContinuation &&
              !hopHasPromptFeedback &&
              Boolean(hopToken) &&
              hopToken !== hopStartToken &&
              hopCount < MAX_CONTINUATION_HOPS
            if (candidate.finishReason === 'CONTINUATION' && canContinueHop) {
              const nextCandidate = { ...candidate }
              delete nextCandidate.finishReason
              if (Array.isArray(nextCandidate.content?.parts)) {
                const filteredParts = nextCandidate.content.parts.filter(p => !isEmptyPlaceholderPart(p))
                nextCandidate.content = { ...nextCandidate.content, parts: filteredParts }
              }
              const nextCandidates = [...raw.candidates]
              nextCandidates[0] = nextCandidate
              outRaw = { ...outRaw, candidates: nextCandidates }
            }
          }
          if (raw.usageMetadata && typeof raw.usageMetadata === 'object') {
            const prompt = raw.usageMetadata.promptTokenCount ?? 0
            const cached = raw.usageMetadata.cachedContentTokenCount ?? 0
            const candidates = raw.usageMetadata.candidatesTokenCount ?? 0
            const thoughts = raw.usageMetadata.thoughtsTokenCount ?? 0
            const toolUsePrompt = raw.usageMetadata.toolUsePromptTokenCount ?? 0
            const total = raw.usageMetadata.totalTokenCount ?? (prompt + candidates + thoughts + toolUsePrompt)
            if (initialPromptTokens === undefined) initialPromptTokens = prompt
            if (initialCachedTokens === undefined) initialCachedTokens = cached
            hopUsage = { prompt, cached, candidates, thoughts, toolUsePrompt, total }
            if (hopCount === 1) {
              outRaw = {
                ...outRaw,
                usageMetadata: {
                  ...raw.usageMetadata,
                  initialPromptTokenCount: initialPromptTokens,
                },
              }
            } else {
              const mergedCandidates = completedCandidatesTokens + candidates
              const mergedThoughts = completedThoughtsTokens + thoughts
              const mergedToolUsePrompt = completedToolUsePromptTokens + toolUsePrompt
              const mergedTotal = initialPromptTokens + mergedCandidates + mergedThoughts + mergedToolUsePrompt
              outRaw = {
                ...outRaw,
                usageMetadata: {
                  ...raw.usageMetadata,
                  promptTokenCount: initialPromptTokens,
                  ...(initialCachedTokens > 0 || raw.usageMetadata.cachedContentTokenCount !== undefined
                    ? { cachedContentTokenCount: initialCachedTokens }
                    : {}),
                  candidatesTokenCount: mergedCandidates,
                  ...(mergedThoughts > 0 || raw.usageMetadata.thoughtsTokenCount !== undefined
                    ? { thoughtsTokenCount: mergedThoughts }
                    : {}),
                  ...(mergedToolUsePrompt > 0 || raw.usageMetadata.toolUsePromptTokenCount !== undefined
                    ? { toolUsePromptTokenCount: mergedToolUsePrompt }
                    : {}),
                  totalTokenCount: mergedTotal,
                  initialPromptTokenCount: initialPromptTokens,
                  billedPromptTokenCount: completedBilledPromptTokens + prompt,
                  billedCachedContentTokenCount: completedBilledCachedTokens + cached,
                  billedTotalTokenCount: completedBilledTotalTokens + total,
                },
              }
            }
          }
          yield { headers: httpChunk.headers, json: async () => outRaw }
        }
      } catch (error) {
        hopError = { error }
      }

      if (hopUsage) {
        completedCandidatesTokens += hopUsage.candidates
        completedThoughtsTokens += hopUsage.thoughts
        completedToolUsePromptTokens += hopUsage.toolUsePrompt
        completedBilledPromptTokens += hopUsage.prompt
        completedBilledCachedTokens += hopUsage.cached
        completedBilledTotalTokens += hopUsage.total
        tracker?.recordTokenUsage({
          reportedInputTokens: initialPromptTokens,
          reportedCacheTokens: initialCachedTokens ?? 0,
          outputTokens: completedCandidatesTokens,
          thoughtsTokens: completedThoughtsTokens,
          billedPromptTokens: completedBilledPromptTokens,
          billedCachedTokens: completedBilledCachedTokens,
          billedTotalTokens: completedBilledTotalTokens,
        })
      }

      const abortedHop = Boolean(hopError && isAbortedError(hopError.error, request?.abortSignal))
      if (
        hopError &&
        (abortedHop ||
          isNonRetryableApiRejection(hopError.error, hopReceivedAnyChunk, hopCount, Boolean(hopToken || hopStartToken)))
      ) {
        hopTracker?.finish({
          error: hopError.error,
          aborted: abortedHop,
          finishReason: hopFinishReason,
          continued: false,
        })
        throw hopError.error
      }

      const hasNewToken = Boolean(hopToken) && hopToken !== hopStartToken
      const madeProgress = hopHasYieldedContent || hasNewToken
      if (hopError) lastError = hopError
      else if (madeProgress) lastError = undefined

      if (!enableContinuation || hopCount >= MAX_CONTINUATION_HOPS || hopHasPromptFeedback) {
        resumeToken = undefined
      } else if (hopFinishReason !== undefined) {
        if (hopFinishReason === 'CONTINUATION' && hasNewToken) {
          resumeToken = hopToken
          reconnectsWithoutProgress = 0
          consecutiveReconnectFailures = hopError ? 1 : 0
          nextHopTrigger = hopError ? 'checkpoint-reconnect' : 'continuation'
        } else {
          resumeToken = undefined
          reconnectsWithoutProgress = 0
          consecutiveReconnectFailures = 0
        }
      } else if (hasNewToken) {
        resumeToken = hopToken
        reconnectsWithoutProgress = 0
        consecutiveReconnectFailures = 1
        nextHopTrigger = 'checkpoint-reconnect'
      } else if (!hopHasYieldedContent && hopStartToken && reconnectsWithoutProgress < MAX_STREAM_RECONNECTS_WITHOUT_PROGRESS) {
        resumeToken = hopStartToken
        reconnectsWithoutProgress += 1
        consecutiveReconnectFailures += 1
        nextHopTrigger = 'retry-same-checkpoint'
      } else {
        resumeToken = undefined
      }

      const canResume =
        enableContinuation &&
        Boolean(resumeToken) &&
        !hopHasPromptFeedback &&
        (hopFinishReason === 'CONTINUATION' || hopFinishReason === undefined)

      hopTracker?.finish({
        error: hopError?.error,
        aborted: false,
        finishReason: hopFinishReason,
        continued: canResume && hopFinishReason === 'CONTINUATION' && !hopError,
      })

      if (canResume) {
        let delayMs = 0
        if (consecutiveReconnectFailures > 0) {
          delayMs = computeReconnectDelayMs(consecutiveReconnectFailures, meta?.reconnectBackoff)
          await waitWithAbort(delayMs, request?.abortSignal)
        }
        if (!baseBodyObj) baseBodyObj = JSON.parse(request.body)
        const nextBody = JSON.stringify({ ...baseBodyObj, continuationToken: resumeToken })
        nextHopBackoffMs = delayMs
        nextHopBody = nextBody
        const nextReq = {
          ...request,
          body: nextBody,
          httpOptions: hopHttpOptions,
        }
        openHop = () => origRequestStream.call(apiClient, nextReq)
        continue
      }

      if (hopError) throw hopError.error
      if (hopFinishReason === undefined && !hopHasPromptFeedback && lastError) throw lastError.error
      return
    }
  })()
}

let apiClientProtoRef = null
let origApiClientRequestStream = null

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
  if (origApiClientRequestStream) {
    return () => {
      if (proto.requestStream !== origApiClientRequestStream && origApiClientRequestStream) {
        proto.requestStream = origApiClientRequestStream
        origApiClientRequestStream = null
      }
    }
  }
  const orig = proto.requestStream
  origApiClientRequestStream = orig
  function patchedRequestStream(request) {
    const meta = request?.httpOptions?.[ARGON_LONG_DECODE_SYMBOL]
    if (!meta) return orig.call(this, request)
    return continueArgonRequestStream(this, orig, request, meta)
  }
  proto.requestStream = patchedRequestStream
  return () => {
    if (proto.requestStream === patchedRequestStream) {
      proto.requestStream = orig
    }
    origApiClientRequestStream = null
  }
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
) {
  ensureGemini4ApiClientPatch()
  const fallback = defaultLevel ?? (/cyber-permissive/i.test(requestModel?.id ?? '') ? 'high' : 'medium')
  const rawLevel = options.reasoning ?? fallback
  const mapped = requestModel?.thinkingLevelMap?.[rawLevel] ?? rawLevel
  const level = typeof mapped === 'string' ? mapped.toLowerCase() : fallback
  if (!LEVELS.includes(level)) throw new LlmError('Gemini 4 Argon requires low, medium or high.', 'UNSUPPORTED_REASONING_EFFORT')
  const { reasoning, thinking, thinkingBudgets, temperature, onPayload: prior, ...rest } = options
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
    },
    recordDiagnostic,
  )
  return wrapGemini4Stream(
    nativeStream(requestModel, context, {
      ...rest,
      maxTokens: effectiveMaxTokens,
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
        const prevHttpOptions =
          cleanConfig.httpOptions && typeof cleanConfig.httpOptions === 'object' && !Array.isArray(cleanConfig.httpOptions)
            ? cleanConfig.httpOptions
            : {}
        return {
          ...body,
          model: upstreamModelId,
          config: {
            ...cleanConfig,
            automaticContinuation: false,
            thinkingConfig: { thinkingLevel: level.toUpperCase(), includeThoughts: true },
            httpOptions: {
              ...prevHttpOptions,
              [ARGON_LONG_DECODE_SYMBOL]: {
                enabled: longDecode !== false,
                tracker,
              },
            },
          },
        }
      },
    }),
    tracker,
    options.signal,
  )
}

export function installGemini4PiAiPatch(recordDiagnostic) {
  const unpatchApiClient = ensureGemini4ApiClientPatch()
  const proto = PiAiAdapter?.prototype
  if (!proto || typeof proto.current !== 'function') return unpatchApiClient
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
        return gemini4StreamSimple((m, c, o) => piProvider.stream(m, c, o), requestModel, context, options, defaultReasoning, requestModel.id, true, recordDiagnostic)
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
    unpatchApiClient()
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
  const longDecode = readVal(source?.longDecode) ?? true
  const contextWindow = readVal(source?.contextWindow) ?? 1048576
  const rawMaxTokens = readVal(source?.maxTokens) ?? MAX_SINGLE_CALL_TOKENS
  if (!LEVELS.includes(reasoning)) throw new LlmError('Invalid default Argon effort.', 'INVALID_CONFIG')
  for (const [key, val] of [['contextWindow', contextWindow], ['maxTokens', rawMaxTokens]]) {
    if (!Number.isSafeInteger(val) || val <= 0) throw new LlmError('Invalid Argon ' + key, 'INVALID_CONFIG')
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
    routes: source?.routes,
  }
}

/** Serve both Vertex AI Argon and Gemini API (google) Argon under the unified plugin group. */
export function argonProvider(nativeVertex, models, defaultLevel = 'medium', nativeGoogle = googleProvider(), longDecode = true, recordDiagnostic) {
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
          longDecode,
          recordDiagnostic,
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
        longDecode,
        recordDiagnostic,
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

export function createArgonAdapter(ctx, configInput, nativeVertex = googleVertexProvider(), nativeGoogle = googleProvider(), recordDiagnostic) {
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
      ld: cfg.longDecode,
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
    const provider = argonProvider({ ...nativeVertex, auth }, models, cfg.reasoning, nativeGoogle, cfg.longDecode, recordDiagnostic)
    cachedKey = key
    cachedProfiles = new Map([[PROVIDER, {
      provider: PROVIDER,
      displayName: 'Vertex Argon',
      piProvider: provider,
      reasoning: cfg.reasoning,
      streamIdleTimeoutMs: cfg.longDecode ? 600000 : 300000,
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
