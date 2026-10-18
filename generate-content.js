// GenerateContent manual continuation contract (reviewed 2026-10-16):
// https://ai.google.dev/gemini-api/docs/generate-content/long-decode#option-2-loop
// https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-argon
// Only checkpoint-confirmed chunks may escape a resumable stream. Never append
// partial output to the request, decrease its total budget, or retry committed text.
import { SERVICE_TIERS, serviceTierFromHeader, serviceTierFromTraffic } from './service-level.js'
import { classifyRequestRegion } from './pricing.js'
export const MAX_CONTINUATION_HOPS = 32
export const RECONNECT_INITIAL_DELAY_MS = 500
export const RECONNECT_MAX_DELAY_MS = 10000
export const RECONNECT_JITTER_RATIO = 0.1
export const STREAM_READ_TIMEOUT_MS = 20 * 60 * 1000
export const LONG_DECODE_SYMBOL = Symbol.for('dsh.vertexArgon.longDecode')
const MAX_RETRIES_WITHOUT_PROGRESS = 3
const MAX_PENDING_BYTES = 64 * 1024 * 1024

function streamError(message, code = 'ARGON_INCOMPLETE_STREAM') {
  return Object.assign(new Error(message), { code })
}
// An HTTP-successful SSE body may contain a Google-shaped error, including one
// emitted by a proxy. Never echo arbitrary message/details into session logs.
const STREAM_ERROR_REASONS = new Set(['CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS', 'PERMISSION_DENIED', 'UNAUTHENTICATED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS'])
function inBandStreamError(detail) {
  const status = Number.isInteger(detail?.code) && detail.code >= 400 && detail.code <= 599 ? detail.code : undefined
  const reason = STREAM_ERROR_REASONS.has(detail?.status) ? detail.status : undefined
  const label = [status, reason].filter(v => v !== undefined).join(' ')
  return Object.assign(streamError('Argon GenerateContent received an in-band stream error' + (label ? ' (' + label + ')' : '') + '. The service or a proxy reported this inside the response; it is not the HTTP response status.', 'ARGON_STREAM_ERROR'), {
    ...(status === undefined ? {} : { status }), phase: 'stream', requestSubmitted: true,
  })
}
function aborted(signal, error) {
  return Boolean(signal?.aborted) || error?.name === 'AbortError'
}
function throwIfAborted(signal) {
  if (signal?.aborted) throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
}
function retryable(error) {
  const status = error?.status
  if (typeof status === 'number') return status === 408 || status === 429 || status >= 500
  return !String(error?.code ?? '').startsWith('ARGON_')
}
export function computeReconnectDelayMs(attempt, options = {}) {
  const initial = options.initialDelayMs ?? RECONNECT_INITIAL_DELAY_MS
  if (!(initial > 0)) return 0
  const max = options.maxDelayMs ?? RECONNECT_MAX_DELAY_MS
  const jitter = options.jitterRatio ?? RECONNECT_JITTER_RATIO
  const random = options.random ?? Math.random
  const delay = Math.min(initial * (2 ** Math.min(Math.max(attempt - 1, 0), 10)), max)
  return Math.round(Math.min(delay * (1 - jitter + 2 * jitter * random()), max))
}
export function waitWithAbort(ms, signal) {
  throwIfAborted(signal)
  if (!(ms > 0)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer)
      reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
    }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve() }, ms)
    signal?.addEventListener('abort', stop, { once: true })
  })
}

const fields = ['promptTokenCount', 'cachedContentTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'toolUsePromptTokenCount', 'totalTokenCount']
function readUsage(raw, previous) {
  const result = { ...previous }
  for (const key of fields) {
    if (Number.isSafeInteger(raw[key]) && raw[key] >= 0) result[key] = raw[key]
  }
  for (const key of ['promptTokensDetails', 'cacheTokensDetails', 'candidatesTokensDetails', 'toolUsePromptTokensDetails', 'trafficType']) {
    if (Object.hasOwn(raw, key)) result[key] = raw[key]
  }
  return result
}
const value = (usage, key) => usage?.[key] ?? 0

export async function continueArgonRequestStream(apiClient, original, request, meta = {}) {
  const { [LONG_DECODE_SYMBOL]: _, ...httpOptions } = request.httpOptions ?? {}
  const enabled = meta.enabled !== false
  if (enabled && apiClient.isVertexAI?.()) httpOptions.apiVersion = 'v1beta1'
  if (enabled && httpOptions.timeout === undefined) httpOptions.timeout = STREAM_READ_TIMEOUT_MS
  const tracker = meta.tracker
  try {
    if (apiClient.isVertexAI?.()) tracker?.recordRegionClass?.(classifyRequestRegion(apiClient.getLocation?.() ?? (apiClient.clientOptions?.apiKey && !apiClient.getProject?.() ? 'global' : undefined)))
  } catch { /* Optional pricing metadata never changes generation. */ }
  tracker?.setApiVersion(httpOptions.apiVersion || apiClient.clientOptions?.httpOptions?.apiVersion || (apiClient.isVertexAI?.() ? 'v1beta1' : 'v1beta'))

  return (async function* () {
    const baseBody = JSON.parse(request.body)
    let initialBody = request.body
    // Google documents a top-level service_tier. Apply after SDK conversion so
    // older converters cannot silently discard it; every hop uses this snapshot.
    if (!apiClient.isVertexAI?.() && meta.serviceTier !== undefined) {
      if (!SERVICE_TIERS.includes(meta.serviceTier)) throw streamError('Invalid Argon service tier.', 'INVALID_CONFIG')
      if (meta.serviceTier === 'standard') delete baseBody.service_tier
      else baseBody.service_tier = meta.serviceTier
      initialBody = JSON.stringify(baseBody)
      // SDK 2.21 merges extraBody (including client defaults) AFTER request.body.
      // Override that second write path too. Explicit undefined removes a default
      // tier for Standard at JSON serialization, without losing JSON responseFormat.
      httpOptions.extraBody = { ...httpOptions.extraBody, service_tier: meta.serviceTier === 'standard' ? undefined : meta.serviceTier }
    }
    let token = baseBody.continuationToken
    let retriesWithoutProgress = 0
    let retryAttempt = 0
    let trigger = 'initial'
    let delayMs = 0
    let initialPrompt
    let initialCached
    const totals = Object.fromEntries(fields.map(key => [key, 0]))

    for (let hop = 1; hop <= MAX_CONTINUATION_HOPS; hop++) {
      throwIfAborted(request.abortSignal)
      await waitWithAbort(delayMs, request.abortSignal)
      const startToken = token
      const body = hop === 1 ? initialBody : JSON.stringify({ ...baseBody, ...(token ? { continuationToken: token } : {}) })
      const hopTracker = tracker?.beginHop({ hopIndex: hop, trigger, usedContinuationToken: Boolean(token), backoffDelayMs: delayMs, body })
      let pending = []
      let pendingBytes = 0
      let latestUsage
      let observedServiceTier = null
      let committedUsage
      let finishReason
      let blocked = false
      let failure
      let terminal = false
      let pendingHasContent = false
      let streamSettled = false
      let usageAccounted = false

      const wrap = (raw, headers, usageSnapshot) => {
        let out = raw
        if (raw.candidates?.[0]?.finishReason === 'CONTINUATION' && enabled) {
          const first = { ...raw.candidates[0] }
          delete first.finishReason
          if (first.content?.parts) first.content = { ...first.content, parts: first.content.parts.filter(p => !(p.text === '' && !p.thought && !p.thoughtSignature && !p.functionCall)) }
          out = { ...out, candidates: [first, ...raw.candidates.slice(1)] }
        }
        if (raw.usageMetadata) {
          const u = readUsage(raw.usageMetadata, usageSnapshot)
          const merged = key => totals[key] + value(u, key)
          const prompt = initialPrompt ?? value(u, 'promptTokenCount')
          const candidates = merged('candidatesTokenCount')
          const thoughts = merged('thoughtsTokenCount')
          const tool = merged('toolUsePromptTokenCount')
          out = { ...out, usageMetadata: {
            ...raw.usageMetadata,
            promptTokenCount: prompt,
            cachedContentTokenCount: initialCached ?? value(u, 'cachedContentTokenCount'),
            candidatesTokenCount: candidates,
            thoughtsTokenCount: thoughts,
            toolUsePromptTokenCount: tool,
            totalTokenCount: prompt + candidates + thoughts + tool,
            initialPromptTokenCount: prompt,
            billedPromptTokenCount: merged('promptTokenCount'),
            billedCachedContentTokenCount: merged('cachedContentTokenCount'),
            billedTotalTokenCount: merged('totalTokenCount'),
          } }
        }
        return { headers, json: async () => out }
      }

      const refreshOriginalUsage = () => {
        if ((initialPrompt === undefined || !startToken) && latestUsage?.promptTokenCount !== undefined) initialPrompt = latestUsage.promptTokenCount
        if ((initialCached === undefined || !startToken) && initialPrompt !== undefined) initialCached = value(latestUsage, 'cachedContentTokenCount')
      }
      const accountCommitted = () => {
        if (usageAccounted) return
        usageAccounted = true
        tracker?.recordUsageRow?.('gc-hop', hop, 'generate-content', latestUsage, Boolean(streamSettled && !failure && (terminal || finishReason === 'CONTINUATION')), apiClient.isVertexAI?.() ? serviceTierFromTraffic(latestUsage?.trafficType) : observedServiceTier)
      if (committedUsage) {
        for (const key of fields) totals[key] += value(committedUsage, key)
        tracker?.recordTokenUsage({
          reportedInputTokens: initialPrompt, reportedCacheTokens: initialCached ?? 0,
          outputTokens: totals.candidatesTokenCount, thoughtsTokens: totals.thoughtsTokenCount,
          billedPromptTokens: totals.promptTokenCount, billedCachedTokens: totals.cachedContentTokenCount,
          billedTotalTokens: totals.totalTokenCount,
        })
      }
      }
      try {
        const stream = await original.call(apiClient, { ...request, body, httpOptions })
        for await (const chunk of stream) {
          throwIfAborted(request.abortSignal)
          const raw = await chunk.json()
          tracker?.observeResponse?.('gc-chunk', hop, raw)
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw streamError('Invalid Argon stream response.', 'ARGON_INVALID_RESPONSE')
          if (Object.hasOwn(raw, 'error')) {
            hopTracker?.onChunk({ status: 200 })
            throw inBandStreamError(raw.error)
          }
          if (apiClient.isVertexAI?.()) tracker?.recordServiceTier?.(serviceTierFromTraffic(raw.usageMetadata?.trafficType), 'traffic-type')
          else {
            // SDK HttpResponse.headers is a plain header record; test doubles may
            // also supply Headers. Missing/unknown receipts never imply Standard.
            try {
              const tier = serviceTierFromHeader(new Headers(chunk.headers).get('x-gemini-service-tier'))
              if (tier) { observedServiceTier = tier; tracker?.recordServiceTier?.(tier, 'response-header') }
            } catch { /* Observability cannot fail a generation. */ }
          }
          const candidate = raw.candidates?.[0]
          const nextToken = candidate?.continuationToken
          const newCheckpoint = typeof nextToken === 'string' && nextToken.length > 0 && nextToken !== token
          if (candidate?.finishReason !== undefined) finishReason = candidate.finishReason
          blocked ||= Boolean(raw.promptFeedback?.blockReason)
          terminal ||= blocked || (finishReason !== undefined && finishReason !== 'CONTINUATION')
          hopTracker?.onChunk({ status: 200, hasCheckpoint: typeof nextToken === 'string' && nextToken.length > 0, finishReason: candidate?.finishReason })
          if (raw.usageMetadata && typeof raw.usageMetadata === 'object') {
            latestUsage = readUsage(raw.usageMetadata, latestUsage)

          }
          if (!enabled) {
            committedUsage = latestUsage
            refreshOriginalUsage()
            yield wrap(raw, chunk.headers, latestUsage)
            continue
          }
          pendingBytes += Buffer.byteLength(JSON.stringify(raw))
          if (pendingBytes > MAX_PENDING_BYTES) throw streamError('Argon uncommitted stream exceeded the bounded checkpoint buffer.', 'ARGON_BUFFER_LIMIT')
          pending.push({ raw, headers: chunk.headers, usage: latestUsage ? { ...latestUsage } : undefined })
          pendingHasContent ||= (candidate?.content?.parts ?? []).some(part => typeof part.text === 'string' ? part.text.length > 0 || Boolean(part.thoughtSignature) : Object.keys(part).length > 0)
          const finalMetadata = finishReason === 'CONTINUATION' && token && token !== startToken && !pendingHasContent
          if (newCheckpoint || terminal || finalMetadata) {
            if (newCheckpoint) token = nextToken
            committedUsage = latestUsage ? { ...latestUsage } : undefined
            refreshOriginalUsage()
            for (const saved of pending) yield wrap(saved.raw, saved.headers, saved.usage)
            pending = []
            pendingBytes = 0
            pendingHasContent = false
          }
        }
        streamSettled = true
      } catch (error) {
        failure = error
        streamSettled = true
      } finally {
        if (!streamSettled) {
          accountCommitted()
          hopTracker?.finish({ aborted: Boolean(request.abortSignal?.aborted), finishReason: terminal ? finishReason : undefined })
        }
      }
      // Only usage at the last committed checkpoint (or terminal) is billable
      // progress. Uncommitted tail usage must roll back together with its text.
      accountCommitted()

      if (aborted(request.abortSignal, failure)) {
        hopTracker?.finish({ error: failure, aborted: true, finishReason, continued: false })
        throwIfAborted(request.abortSignal)
        throw failure
      }
      // A late explicit error is not success, but committed output must not be replayed.
      if (terminal && failure?.code === 'ARGON_STREAM_ERROR') {
        hopTracker?.finish({ error: failure, aborted: false, finishReason, continued: false })
        throw failure
      }
      if (terminal) {
        hopTracker?.finish({ aborted: false, finishReason, continued: false })
        return
      }
      if (!enabled) {
        hopTracker?.finish({ error: failure, aborted: false, finishReason, continued: false })
        if (failure) throw failure
        if (finishReason !== undefined) return
        throw failure ?? streamError('Argon stream ended without a terminal finishReason.')
      }
      if (!failure && finishReason === 'CONTINUATION' && (!token || token === startToken)) {
        failure = streamError('Argon CONTINUATION did not provide a new checkpoint token.', 'ARGON_INVALID_CONTINUATION')
      }
      if (failure && !retryable(failure)) {
        hopTracker?.finish({ error: failure, aborted: false, finishReason, continued: false })
        throw failure
      }
      const progress = token !== startToken
      const cleanContinuation = finishReason === 'CONTINUATION' && !failure && progress
      hopTracker?.finish({ error: failure, aborted: false, finishReason, continued: cleanContinuation })
      if (hop === MAX_CONTINUATION_HOPS) throw streamError('Argon continuation hop limit reached without a terminal response.', 'ARGON_HOP_LIMIT')
      retriesWithoutProgress = progress ? 0 : retriesWithoutProgress + 1
      if (retriesWithoutProgress > MAX_RETRIES_WITHOUT_PROGRESS) throw failure ?? streamError('Argon stream repeatedly ended before making checkpoint progress.')
      retryAttempt = cleanContinuation ? 0 : (progress ? 1 : retryAttempt + 1)
      delayMs = computeReconnectDelayMs(retryAttempt, meta.reconnectBackoff)
      if (cleanContinuation) delayMs = 0
      trigger = cleanContinuation ? 'continuation' : progress ? 'checkpoint-reconnect' : token ? 'retry-same-checkpoint' : 'retry-original'
      // pending deliberately goes out of scope; the checkpoint contains its predecessor.
    }
  })()
}
