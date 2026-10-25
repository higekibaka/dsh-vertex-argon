// GenerateContent manual continuation contract (reviewed 2026-10-16):
// https://ai.google.dev/gemini-api/docs/generate-content/long-decode#option-2-loop
// https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-argon
// Stream chunks directly before the first 32K checkpoint token; once a checkpoint
// is active, only checkpoint-confirmed chunks escape. Never append partial output.
import { SERVICE_TIERS, serviceTierFromHeader, serviceTierFromTraffic } from './service-level.js'
export const MAX_CONTINUATION_HOPS = 32
export const RECONNECT_INITIAL_DELAY_MS = 500
export const RECONNECT_MAX_DELAY_MS = 10000
export const RECONNECT_JITTER_RATIO = 0.1
export const STREAM_READ_TIMEOUT_MS = 20 * 60 * 1000
export const MAX_SERVER_RETRY_DELAY_MS = 60_000
export const STREAM_INITIAL_TTFT_TIMEOUT_MS = 180_000
export const STREAM_THINKING_TIMEOUT_MS = 180_000
export const STREAM_TRANSITION_TIMEOUT_MS = 180_000
export const STREAM_SLIDING_TIMEOUT_MS = 120_000
export const MAX_SAME_TOKEN_RETRIES = 3
export const MAX_THINKING_DROPOUT_HEALS = 1
export const LONG_DECODE_SYMBOL = Symbol.for('dsh.vertexArgon.longDecode')
const MAX_PENDING_BYTES = 64 * 1024 * 1024

function streamError(message, code = 'ARGON_INCOMPLETE_STREAM') {
  return Object.assign(new Error(message), { code })
}
// An HTTP-successful SSE body may contain a Google-shaped error, including one
// emitted by a proxy. Never echo arbitrary message/details into session logs.
const STREAM_ERROR_REASONS = new Set(['CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS', 'PERMISSION_DENIED', 'UNAUTHENTICATED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS'])
function inBandStreamError(detail, headers) {
  const status = Number.isInteger(detail?.code) && detail.code >= 400 && detail.code <= 599 ? detail.code : undefined
  const reason = STREAM_ERROR_REASONS.has(detail?.status) ? detail.status : undefined
  const label = [status, reason].filter(v => v !== undefined).join(' ')
  return Object.assign(streamError('Argon GenerateContent received an in-band stream error' + (label ? ' (' + label + ')' : '') + '. The service or a proxy reported this inside the response; it is not the HTTP response status.', 'ARGON_STREAM_ERROR'), {
    ...(status === undefined ? {} : { status }), phase: 'stream', requestSubmitted: true,
    retryDelayMs: parseUpstreamRetryDelayMs({ error: detail, headers, message: detail?.message }),
  })
}
function throwIfAborted(signal) {
  if (signal?.aborted) throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
}
function retryable(error) {
  if (parseUpstreamRetryDelayMs(error) > MAX_SERVER_RETRY_DELAY_MS) return false
  const status = error?.status
  if (typeof status === 'number') return status === 408 || status === 429 || status >= 500
  return !String(error?.code ?? '').startsWith('ARGON_')
}
// Parse only a bounded set of known retry hints; arbitrary error details never
// enter diagnostics. The longest valid hint wins if a proxy supplies several.
export function parseUpstreamRetryDelayMs(error) {
  if (Number.isFinite(error?.retryDelayMs) && error.retryDelayMs >= 0) return error.retryDelayMs
  const delays = []
  const add = ms => { if (Number.isFinite(ms) && ms >= 0) delays.push(ms) }
  const duration = raw => {
    if (raw && typeof raw === 'object' && (raw.seconds !== undefined || raw.nanos !== undefined)) {
      const seconds = Number(raw.seconds ?? 0), nanos = Number(raw.nanos ?? 0)
      if (seconds >= 0 && nanos >= 0) add(seconds * 1000 + nanos / 1e6)
    } else if (typeof raw === 'string') {
      const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s)$/i)
      if (match) add(Number(match[1]) * (match[2].toLowerCase() === 'ms' ? 1 : 1000))
    }
  }
  for (const headers of [error?.headers, error?.response?.headers]) {
    try {
      const raw = headers?.get?.('retry-after') ?? headers?.['retry-after'] ?? headers?.['Retry-After']
      if (raw !== undefined && raw !== null && String(raw).trim()) {
        const text = String(raw).trim()
        if (/^\d+(?:\.\d+)?$/.test(text)) add(Number(text) * 1000)
        else if (!/^-/.test(text)) { const date = Date.parse(text); if (Number.isFinite(date)) add(Math.max(0, date - Date.now())) }
      }
    } catch { /* A malformed optional header is not a generation error. */ }
  }
  let nested = error?.error
  // Google SDK ApiError.message can contain the serialized error envelope.
  if (!nested && typeof error?.message === 'string' && error.message.length <= 65536) {
    try { nested = JSON.parse(error.message)?.error } catch {}
  }
  for (const owner of [error, nested]) {
    duration(owner?.retryDelay)
    duration(owner?.quotaResetDelay)
    duration(owner?.metadata?.quotaResetDelay)
    const details = Array.isArray(owner?.details) ? owner.details.slice(0, 64) : []
    for (const detail of details) {
      duration(detail?.retryDelay)
      duration(detail?.quotaResetDelay)
      duration(detail?.metadata?.quotaResetDelay)
    }
    if (typeof owner?.message === 'string') {
      const match = owner.message.slice(0, 65536).match(/retry\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds)\b/i)
      if (match) add(Number(match[1]) * (match[2].toLowerCase() === 'ms' ? 1 : 1000))
    }
  }
  return delays.length ? Math.ceil(Math.max(...delays) + 200) : undefined
}

export function computeReconnectDelayMs(attempt, options = {}, serverRetryDelayMs) {
  if (typeof options === 'function') options = { random: options }
  serverRetryDelayMs ??= options.serverRetryDelayMs

  const initial = options.initialDelayMs ?? RECONNECT_INITIAL_DELAY_MS
  const server = serverRetryDelayMs > 0 && serverRetryDelayMs <= MAX_SERVER_RETRY_DELAY_MS ? serverRetryDelayMs : 0
  if (!(initial > 0)) return server
  const max = options.maxDelayMs ?? RECONNECT_MAX_DELAY_MS
  const jitter = options.jitterRatio ?? RECONNECT_JITTER_RATIO
  const random = options.random ?? Math.random
  const delay = Math.min(initial * (2 ** Math.min(Math.max(attempt - 1, 0), 10)), max)
  return Math.max(Math.round(Math.min(delay * (1 - jitter + 2 * jitter * random()), max)), server)
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


// Only awaited upstream work consumes the idle budget. No timer survives a
// yield to the consumer, and every hop owns an isolated abort signal.
function createHopWatchdog(userSignal, overrides = {}) {
  const controller = new AbortController()
  const defaults = {
    'initial-ttft': STREAM_INITIAL_TTFT_TIMEOUT_MS, thinking: STREAM_THINKING_TIMEOUT_MS,
    transition: STREAM_TRANSITION_TIMEOUT_MS, streaming: STREAM_SLIDING_TIMEOUT_MS,
  }
  const timeouts = Object.fromEntries(Object.entries(defaults).map(([phase, fallback]) => {
    const key = phase === 'initial-ttft' ? 'initialTtft' : phase
    const proposed = overrides[phase] ?? overrides[key] ?? overrides[key + 'Ms']
    return [phase, Number.isFinite(proposed) && proposed > 0 ? proposed : fallback]
  }))
  let phase = 'initial-ttft', remaining = timeouts[phase]
  let enteredThinking = false, enteredTransition = false
  // Adjacent-only dedupe would let A/B/A/B alternation or a repeated two-signature
  // frame look like fresh output. Remember every signature seen in this hop, with a
  // bound so a hostile stream cannot grow the set without limit.
  const seenSignatures = new Set()
  let timeoutError
  const userAbort = () => controller.abort(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
  userSignal?.addEventListener('abort', userAbort, { once: true })
  if (userSignal?.aborted) userAbort()
  return {
    signal: controller.signal,
    update(parts, hasProgress = false) {
      // A named function call or non-empty text is real output. An empty
      // {} functionCall, an empty thought frame and a re-used thought signature
      // are all pseudo progress that must never renew the idle budget.
      const visible = parts.some(part => (part.functionCall && typeof part.functionCall === 'object' && typeof part.functionCall.name === 'string' && part.functionCall.name.length > 0) || (!part.thought && typeof part.text === 'string' && part.text.length > 0))
      const anyThought = parts.some(part => part.thought === true)
      const productiveThought = parts.some(part => part.thought === true && typeof part.text === 'string' && part.text.length > 0)
      let newSignature = false
      for (const part of parts) {
        const sig = part.thoughtSignature ?? part.thought_signature
        if (typeof sig === 'string' && sig.length > 0 && !seenSignatures.has(sig) && seenSignatures.size < 8192) {
          seenSignatures.add(sig)
          newSignature = true
        }
      }
      const nextPhase = (visible || phase === 'streaming') ? 'streaming' : anyThought ? 'thinking' : 'transition'
      phase = nextPhase
      // Entering a phase counts once, so alternating empty frames cannot ping-pong
      // between thinking and transition and keep resetting the budget.
      const firstEntry = (nextPhase === 'thinking' && !enteredThinking) || (nextPhase === 'transition' && !enteredTransition)
      if (nextPhase === 'thinking') enteredThinking = true
      if (nextPhase === 'transition') enteredTransition = true
      if (firstEntry || visible || productiveThought || newSignature || hasProgress) remaining = timeouts[phase]
    },
    async run(operation) {
      throwIfAborted(userSignal)
      if (timeoutError) throw timeoutError
      const started = performance.now()
      let timer, rejectAbort
      const interruption = new Promise((_, reject) => {
        rejectAbort = () => reject(timeoutError ?? controller.signal.reason)
        controller.signal.addEventListener('abort', rejectAbort, { once: true })
        timer = setTimeout(() => {
          timeoutError = Object.assign(streamError('Argon stream phase timed out: ' + phase, 'STREAM_PHASE_TIMEOUT'), { status: 504, phase: 'stream', requestSubmitted: true })
          controller.abort(timeoutError)
        }, Math.max(0, remaining))
      })
      try { return await Promise.race([Promise.resolve().then(operation), interruption]) }
      finally {
        clearTimeout(timer)
        controller.signal.removeEventListener('abort', rejectAbort)
        remaining = Math.max(0, remaining - (performance.now() - started))
      }
    },
    close() {
      userSignal?.removeEventListener('abort', userAbort)
      controller.abort()
    },
  }
}

function closeIterator(iterator) {
  // A stalled next() may prevent return() from settling. Abort the transport
  // first and observe cleanup errors without waiting forever for a broken peer.
  try { Promise.resolve(iterator?.return?.()).catch(() => {}) } catch {}
}

const fields = ['promptTokenCount', 'cachedContentTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'toolUsePromptTokenCount', 'totalTokenCount']
function readUsage(raw, previous) {
  const result = { ...previous }
  for (const key of fields) {
    // Keep invalid observed counts as null, never persist the upstream bad value.
    if (raw[key] !== undefined) result[key] = Number.isSafeInteger(raw[key]) && raw[key] >= 0 ? raw[key] : null
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
    let continuationBody = baseBody
    let token = baseBody.continuationToken
    let retriesWithoutProgress = 0
    let retryAttempt = 0
    let trigger = 'initial'
    let delayMs = 0
    let initialPrompt, initialCached
    let initialUsageLocked = false
    let thinkingDropoutHeals = 0
    const totals = Object.fromEntries(fields.map(key => [key, 0]))
    const billed = Object.fromEntries(fields.map(key => [key, 0]))

    for (let hop = 1; hop <= MAX_CONTINUATION_HOPS; hop++) {
      throwIfAborted(request.abortSignal)
      await waitWithAbort(delayMs, request.abortSignal)
      const startToken = token
      const body = hop === 1 ? initialBody : JSON.stringify({ ...continuationBody, ...(token ? { continuationToken: token } : {}) })
      const hopTracker = tracker?.beginHop({ hopIndex: hop, trigger, usedContinuationToken: Boolean(token), backoffDelayMs: delayMs, body })
      const watchdog = createHopWatchdog(request.abortSignal, meta.phaseTimeouts)
      let iterator, sourceDone = false
      let pending = [], pendingBytes = 0, pendingHasContent = false
      let latestUsage, committedUsage, finishReason, failure
      let blocked = false, terminal = false, streamSettled = false, usageAccounted = false
      let hopChunks = 0, hopSawThought = false, hopSawVisibleOrTool = false
      let thoughtParts = [], thoughtBytes = 0, suppressedStop = false, hopToken
      const canHeal = () => enabled && thinkingDropoutHeals < MAX_THINKING_DROPOUT_HEALS && hopSawThought && !hopSawVisibleOrTool && !blocked && finishReason === 'STOP'

      const wrap = (raw, headers, usageSnapshot, hideStop = false) => {
        let out = raw
        if ((raw.candidates?.[0]?.finishReason === 'CONTINUATION' && enabled) || hideStop) {
          const first = { ...raw.candidates[0] }
          delete first.finishReason
          if (first.content?.parts) first.content = { ...first.content, parts: first.content.parts.filter(p => !(p.text === '' && !p.thought && !p.thoughtSignature && !p.thought_signature && !p.functionCall)) }
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
            candidatesTokenCount: candidates, thoughtsTokenCount: thoughts, toolUsePromptTokenCount: tool,
            totalTokenCount: prompt + candidates + thoughts + tool,
            initialPromptTokenCount: prompt,
            billedPromptTokenCount: billed.promptTokenCount + value(u, 'promptTokenCount'),
            billedCachedContentTokenCount: billed.cachedContentTokenCount + value(u, 'cachedContentTokenCount'),
            billedTotalTokenCount: billed.totalTokenCount + value(u, 'totalTokenCount'),
          } }
        }
        return { headers, json: async () => out }
      }
      const refreshOriginalUsage = () => {
        if (!initialUsageLocked && Number.isSafeInteger(latestUsage?.promptTokenCount)) initialPrompt = latestUsage.promptTokenCount
        if (!initialUsageLocked && initialPrompt !== undefined) initialCached = value(latestUsage, 'cachedContentTokenCount')
      }
      const accountUsage = () => {
        if (usageAccounted) return
        usageAccounted = true
        if (latestUsage) {
          hopTracker?.recordTokenUsage?.({
            promptTokens: latestUsage.promptTokenCount, cachedTokens: latestUsage.cachedContentTokenCount,
            outputTokens: latestUsage.candidatesTokenCount, thoughtsTokens: latestUsage.thoughtsTokenCount,
            totalTokens: latestUsage.totalTokenCount,
          })
          for (const key of fields) billed[key] += value(latestUsage, key)
        }
        if (committedUsage) {
          for (const key of fields) totals[key] += value(committedUsage, key)
          initialUsageLocked = true
        }
        if (latestUsage || committedUsage) tracker?.recordTokenUsage?.({
          reportedInputTokens: initialPrompt, reportedCacheTokens: initialCached ?? 0,
          outputTokens: totals.candidatesTokenCount, thoughtsTokens: totals.thoughtsTokenCount,
          totalTokens: initialPrompt === undefined ? null : initialPrompt + totals.candidatesTokenCount + totals.thoughtsTokenCount + totals.toolUsePromptTokenCount,
          billedPromptTokens: billed.promptTokenCount, billedCachedTokens: billed.cachedContentTokenCount,
          billedOutputTokens: billed.candidatesTokenCount, billedThoughtsTokens: billed.thoughtsTokenCount,
          billedToolTokens: billed.toolUsePromptTokenCount, billedTotalTokens: billed.totalTokenCount,
        })
      }
      try {
        const stream = await watchdog.run(() => Promise.resolve(original.call(apiClient, { ...request, body, httpOptions, abortSignal: watchdog.signal })).then(source => {
          if (watchdog.signal.aborted) closeIterator(source?.[Symbol.asyncIterator]?.() ?? source)
          return source
        }))
        iterator = stream[Symbol.asyncIterator]()
        while (true) {
          const item = await watchdog.run(() => iterator.next())
          if (item.done) { sourceDone = true; break }
          const chunk = item.value
          let raw
          try { raw = await watchdog.run(() => chunk.json()) }
          catch (error) { hopTracker?.onChunk({ status: 200 }); throw error }
          tracker?.observeResponse?.('gc-chunk', hop, raw)
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            hopTracker?.onChunk({ status: 200 })
            throw streamError('Invalid Argon stream response.', 'ARGON_INVALID_RESPONSE')
          }
          if (Object.hasOwn(raw, 'error')) {
            hopTracker?.onChunk({ status: 200 })
            throw inBandStreamError(raw.error, chunk.headers)
          }
          if (apiClient.isVertexAI?.()) tracker?.recordServiceTier?.(serviceTierFromTraffic(raw.usageMetadata?.trafficType), 'traffic-type')
          else {
            try {
              const tier = serviceTierFromHeader(new Headers(chunk.headers).get('x-gemini-service-tier'))
              if (tier) tracker?.recordServiceTier?.(tier, 'response-header')
            } catch { /* Optional observability cannot fail a generation. */ }
          }
          const candidate = raw.candidates?.[0]
          const parts = candidate?.content?.parts ?? []
          hopSawThought ||= parts.some(part => part.thought === true)
          hopSawVisibleOrTool ||= parts.some(part => part.functionCall || (!part.thought && typeof part.text === 'string' && part.text.length > 0))
          if (hopSawVisibleOrTool) { thoughtParts = []; thoughtBytes = 0 }
          else if (enabled && thinkingDropoutHeals < MAX_THINKING_DROPOUT_HEALS) {
            for (const part of parts) if (part.thought === true || part.thoughtSignature || part.thought_signature) {
              const encoded = JSON.stringify(part)
              thoughtBytes += Buffer.byteLength(encoded)
              if (thoughtBytes > MAX_PENDING_BYTES) throw streamError('Argon thought replay exceeded the bounded buffer.', 'ARGON_BUFFER_LIMIT')
              thoughtParts.push(JSON.parse(encoded))
            }
          }
          const nextToken = candidate?.continuationToken
          const hasToken = typeof nextToken === 'string' && nextToken.length > 0
          if (hasToken) hopToken = nextToken
          const newCheckpoint = hasToken && nextToken !== token
          // Renew the idle budget only for genuinely new progress: a repeated
          // continuation token, a repeated finishReason or an empty thought frame
          // must never extend a stalled hop.
          watchdog.update(parts, Boolean(newCheckpoint || (candidate?.finishReason !== undefined && candidate.finishReason !== finishReason) || (!blocked && raw.promptFeedback?.blockReason)))
          if (candidate?.finishReason !== undefined) finishReason = candidate.finishReason
          blocked ||= Boolean(raw.promptFeedback?.blockReason)
          terminal ||= blocked || (finishReason !== undefined && finishReason !== 'CONTINUATION')
          const hideStop = candidate?.finishReason === 'STOP' && canHeal()
          if (candidate?.finishReason !== undefined && candidate.finishReason !== 'CONTINUATION') suppressedStop = hideStop
          hopTracker?.onChunk({ status: 200, hasCheckpoint: hasToken, finishReason: candidate?.finishReason })
          if (raw.usageMetadata && typeof raw.usageMetadata === 'object') latestUsage = readUsage(raw.usageMetadata, latestUsage)
          if (!enabled || (!token && !newCheckpoint && !terminal && candidate?.finishReason !== 'CONTINUATION')) {
            refreshOriginalUsage()
            const outgoing = wrap(raw, chunk.headers, latestUsage, hideStop)
            committedUsage = latestUsage ? { ...latestUsage } : undefined
            hopChunks++
            yield outgoing
            continue
          }
          pendingBytes += Buffer.byteLength(JSON.stringify(raw))
          if (pendingBytes > MAX_PENDING_BYTES) throw streamError('Argon uncommitted stream exceeded the bounded checkpoint buffer.', 'ARGON_BUFFER_LIMIT')
          pending.push({ raw, headers: chunk.headers, usage: latestUsage ? { ...latestUsage } : undefined, hideStop })
          pendingHasContent ||= parts.some(part => typeof part.text === 'string' ? part.text.length > 0 || Boolean(part.thoughtSignature || part.thought_signature) : Object.keys(part).length > 0)
          const finalMetadata = finishReason === 'CONTINUATION' && token && token !== startToken && !pendingHasContent
          if (newCheckpoint || terminal || finalMetadata) {
            if (newCheckpoint) token = nextToken
            refreshOriginalUsage()
            // Commit each row when it actually escapes, including consumer-return
            // in the middle of a checkpoint flush.
            for (const saved of pending) {
              throwIfAborted(request.abortSignal)
              const outgoing = wrap(saved.raw, saved.headers, saved.usage, saved.hideStop)
              committedUsage = saved.usage
              hopChunks++
              yield outgoing
            }
            pending = []; pendingBytes = 0; pendingHasContent = false
          }
        }
        if (suppressedStop && finishReason === 'STOP' && !blocked && !canHeal()) {
          hopChunks++
          yield { headers: {}, json: async () => ({ candidates: [{ finishReason: 'STOP' }] }) }
        }
        streamSettled = true
      } catch (error) {
        failure = error
        streamSettled = true
      } finally {
        watchdog.close()
        if (!sourceDone) closeIterator(iterator)
        if (!streamSettled) {
          accountUsage()
          hopTracker?.finish({ aborted: Boolean(request.abortSignal?.aborted), finishReason: terminal ? finishReason : undefined })
        }
      }

      if (request.abortSignal?.aborted) {
        accountUsage()
        hopTracker?.finish({ error: failure, aborted: true, finishReason, continued: false })
        throwIfAborted(request.abortSignal)
      }
      if (terminal) {
        if (!failure && canHeal()) {
          accountUsage()
          hopTracker?.finish({ finishReason, continued: true })
          if (hop === MAX_CONTINUATION_HOPS) throw streamError('Argon continuation hop limit reached without a terminal response.', 'ARGON_HOP_LIMIT')
          thinkingDropoutHeals++
          if (hopToken) token = hopToken
          else {
            token = undefined
            const { continuationToken: ignored, ...rest } = continuationBody
            continuationBody = { ...rest, contents: [...(rest.contents ?? []), { role: 'model', parts: thoughtParts }, { role: 'user', parts: [{ text: 'Continue and provide the final response or tool call.' }] }] }
          }
          retriesWithoutProgress = 0; retryAttempt = 0; delayMs = 0
          trigger = 'thinking-dropout-heal'
          continue
        }
        accountUsage()
        hopTracker?.finish({ error: failure, aborted: false, finishReason, continued: false })
        if (failure) throw failure
        return
      }
      accountUsage()
      if (!enabled && (finishReason !== undefined || hopChunks > 0)) {
        failure ??= finishReason === undefined ? streamError('Argon stream ended without a terminal finishReason.') : undefined
        hopTracker?.finish({ error: failure, aborted: false, finishReason, continued: false })
        if (failure) throw failure
        return
      }
      if (enabled && !failure && finishReason === 'CONTINUATION' && (!token || token === startToken)) {
        failure = streamError('Argon CONTINUATION did not provide a new checkpoint token.', 'ARGON_INVALID_CONTINUATION')
      }
      const progress = token !== startToken
      const cleanContinuation = enabled && finishReason === 'CONTINUATION' && !failure && progress
      const safeRetry = Boolean(token) || hopChunks === 0
      const recoverable = failure ? retryable(failure) : finishReason === undefined
      if (!cleanContinuation && (!safeRetry || !recoverable)) {
        failure ??= streamError('Argon stream ended without a terminal finishReason.')
        hopTracker?.finish({ error: failure, aborted: false, finishReason, continued: false })
        throw failure
      }
      hopTracker?.finish({ error: failure, aborted: false, finishReason, continued: cleanContinuation })
      if (hop === MAX_CONTINUATION_HOPS) throw streamError('Argon continuation hop limit reached without a terminal response.', 'ARGON_HOP_LIMIT')
      retriesWithoutProgress = progress ? 0 : retriesWithoutProgress + 1
      if (retriesWithoutProgress > MAX_SAME_TOKEN_RETRIES) throw failure ?? streamError('Argon stream repeatedly ended before making checkpoint progress.')
      retryAttempt = cleanContinuation ? 0 : (progress ? 1 : retryAttempt + 1)
      delayMs = cleanContinuation ? 0 : computeReconnectDelayMs(retryAttempt, meta.reconnectBackoff, parseUpstreamRetryDelayMs(failure))
      trigger = cleanContinuation ? 'continuation' : progress ? 'checkpoint-reconnect' : token ? 'retry-same-checkpoint' : 'retry-initial'
      // Pending rows belong to the failed tail and are never replayed to callers.
    }
  })()
}
