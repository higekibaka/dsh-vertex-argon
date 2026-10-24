import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { captureRequestAssociation } from './request-association.js'

export const diagnosticSessionHash = value =>
  typeof value === 'string' && value.length > 0
    ? createHash('sha256').update(value).digest('hex').slice(0, 24)
    : null

const safeId = value =>
  typeof value === 'string' && /^[A-Za-z0-9._:/-]{1,160}$/.test(value) ? value : null

const safeFinishReason = value =>
  typeof value === 'string' && /^[A-Z0-9_]{1,64}$/.test(value) ? value : null

const guarded = fn => {
  try {
    return fn()
  } catch {
    return undefined
  }
}

// Strict allowlist: never persist arbitrary error messages, URLs, credentials, or stack traces.
export const transportErrorCodes = Object.freeze([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED',
  'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'UND_ERR_ABORTED', 'UND_ERR_DESTROYED', 'UND_ERR_CLOSED',
  'UND_ERR_PRX_TLS', 'ABORT_ERR', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER',
  'FETCH_FAILED', 'ARGON_STREAM_ERROR', 'STREAM_PHASE_TIMEOUT',
])

const allowedErrorCodes = new Set(transportErrorCodes)
const ownValue = (object, key) => guarded(() => Object.getOwnPropertyDescriptor(object, key)?.value)

export function fetchErrorCodes(error) {
  const pending = [error]
  const seen = new Set()
  const codes = []
  for (let index = 0; index < pending.length && index < 16 && codes.length < 8; index++) {
    const current = pending[index]
    if (!current || typeof current !== 'object' || seen.has(current)) continue
    seen.add(current)
    const code = ownValue(current, 'code')
    if (allowedErrorCodes.has(code) && !codes.includes(code)) codes.push(code)
    const cause = ownValue(current, 'cause')
    if (cause && pending.length < 16) pending.push(cause)
    const errors = ownValue(current, 'errors')
    if (Array.isArray(errors)) {
      for (let i = 0; i < ownValue(errors, 'length') && pending.length < 16; i++) {
        pending.push(ownValue(errors, String(i)))
      }
    }
  }
  if (codes.length === 0 && error instanceof Error && /fetch failed/i.test(error.message)) {
    codes.push('FETCH_FAILED')
  }
  return codes
}

export function bodyBytes(body) {
  if (typeof body === 'string') return Buffer.byteLength(body)
  if (ArrayBuffer.isView(body)) return body.byteLength
  if (body instanceof ArrayBuffer) return body.byteLength
  if (typeof Blob !== 'undefined' && body instanceof Blob) return body.size
  return null
}

export const MAX_RECORDED_HOPS = 16

export function createArgonDiagnosticTracker(meta, record, captureOptions = {}) {
  if (typeof record !== 'function') return undefined
  const associate = captureRequestAssociation(meta?.sessionId)
  const startedWall = Date.now()
  const startedMono = performance.now()
  const state = {
    schemaVersion: 2,
    id: randomUUID(),
    startedAt: new Date(startedWall).toISOString(),
    sessionHash: diagnosticSessionHash(meta?.sessionId),
    route: meta?.route === 'google-generative-ai' ? 'google-generative-ai' : 'google-vertex',
    model: safeId(meta?.model) ?? 'gemini-4-argon',
    protocol: meta?.protocol === 'interactions' ? 'interactions' : 'generate-content',
    background: meta?.background === true,
    remoteCancellation: 'not-requested',
    serviceTier: { requested: ['standard', 'flex', 'priority'].includes(meta?.requestedServiceTier) ? meta.requestedServiceTier : 'standard', observed: null, source: null },
    apiVersion: meta?.apiVersion === 'v1' ? 'v1' : 'v1beta1',
    thinkingLevel: ['LOW', 'MEDIUM', 'HIGH'].includes(meta?.thinkingLevel) ? meta.thinkingLevel : 'MEDIUM',
    longDecodeEnabled: meta?.longDecode !== false,
    configuredMaxTokens: Number.isSafeInteger(meta?.maxTokens) && meta.maxTokens > 0 ? meta.maxTokens : null,
    hopCount: 0,
    continuationCount: 0,
    reconnectCount: 0,
    recoveredFromDrop: false,
    hops: [],
    hopsDropped: 0,
    tokenUsage: {
      reportedInputTokens: null,
      reportedCacheTokens: null,
      outputTokens: null,
      thoughtsTokens: null,
      totalTokens: null,
      billedOutputTokens: null,
      billedThoughtsTokens: null,
      billedToolTokens: null,
      billedPromptTokens: null,
      billedCachedTokens: null,
      billedTotalTokens: null,
    },
    outcome: 'unknown',
    failureCategory: null,
    durationMs: 0,
  }

  const responseCapture = guarded(() => captureOptions.responseHub?.begin({ id: state.id, sessionHash: state.sessionHash, startedAt: state.startedAt, protocol: state.protocol }, captureOptions.retainRawResponses === true))
  let finished = false
  let sawAbnormalDrop = false

  const emit = () => {
    if (finished) return
    finished = true
    guarded(() => {
      const durationMs = Math.max(0, Math.round(performance.now() - startedMono))
      const recoveredFromDrop =
        sawAbnormalDrop &&
        (state.outcome === 'done' || state.outcome === 'tool-calls' || state.outcome === 'max-tokens')
      const snapshot = {
        ...state,
        recoveredFromDrop,
        durationMs,
        hops: state.hops.map(h => ({ ...h, errorCodes: [...h.errorCodes] })),
        tokenUsage: { ...state.tokenUsage },
        serviceTier: { ...state.serviceTier },
        responseCapture: guarded(() => responseCapture?.finish(state.outcome)) ?? { status: captureOptions.retainRawResponses ? 'unavailable' : 'disabled', frames: 0, omittedFrames: 0, bytes: 0, captureError: false },
      }
      const recorded = record(snapshot)
      if (recorded?.then) Promise.resolve(recorded).then(() => associate?.(state.id)).catch(() => {})
      else associate?.(state.id)
    })
  }

  return {
    observeResponse(kind, hop, value) { guarded(() => responseCapture?.observe(kind, hop, value)) },
    recordServiceTier(tier, source) {
      if (['standard', 'flex', 'priority', 'provisioned'].includes(tier) && ['response-header', 'traffic-type'].includes(source)) {
        state.serviceTier.observed = state.serviceTier.observed && state.serviceTier.observed !== tier ? 'mixed' : tier
        state.serviceTier.source = source
      }
    },
    setRemoteCancellation(value) {
      if (['not-requested', 'confirmed', 'unconfirmed'].includes(value)) state.remoteCancellation = value
    },
    setApiVersion(v) {
      guarded(() => {
        if (v === 'v1' || v === 'v1beta1' || v === 'v1beta') state.apiVersion = v
      })
    },
    beginHop({ hopIndex, trigger, usedContinuationToken, backoffDelayMs, body }) {
      const hopStarted = performance.now()
      const validTrigger = ['initial', 'continuation', 'checkpoint-reconnect', 'retry-same-checkpoint', 'retry-original', 'retry-initial', 'thinking-dropout-heal', 'interaction-create', 'interaction-resume'].includes(trigger)
        ? trigger
        : 'initial'
      const hop = {
        hopIndex: Number.isSafeInteger(hopIndex) && hopIndex > 0 ? hopIndex : state.hopCount + 1,
        trigger: validTrigger,
        usedContinuationToken: Boolean(usedContinuationToken),
        backoffDelayMs: Number.isSafeInteger(backoffDelayMs) && backoffDelayMs >= 0 ? backoffDelayMs : 0,
        bodyBytes: bodyBytes(body),
        status: null,
        durationMs: 0,
        chunkCount: 0,
        hasCheckpoint: false,
        finishReason: null,
        outcome: 'pending',
        errorCodes: [],
        promptTokens: null, cachedTokens: null, outputTokens: null, thoughtsTokens: null, totalTokens: null,
      }
      guarded(() => {
        state.hopCount += 1
        if (validTrigger === 'continuation') state.continuationCount += 1
        else if (validTrigger === 'checkpoint-reconnect' || validTrigger === 'retry-same-checkpoint' || validTrigger === 'retry-original' || validTrigger === 'retry-initial' || validTrigger === 'thinking-dropout-heal' || validTrigger === 'interaction-resume') {
          state.reconnectCount += 1
          sawAbnormalDrop = true
        }
        if (state.hops.length < MAX_RECORDED_HOPS) state.hops.push(hop)
        else state.hopsDropped += 1
      })
      let hopClosed = false
      return {
        recordTokenUsage(usage = {}) {
          guarded(() => {
            for (const key of ['promptTokens', 'cachedTokens', 'outputTokens', 'thoughtsTokens', 'totalTokens']) {
              if (Object.hasOwn(usage, key)) hop[key] = Number.isSafeInteger(usage[key]) && usage[key] >= 0 ? usage[key] : null
            }
          })
        },
        onChunk({ status, hasCheckpoint, finishReason }) {
          guarded(() => {
            hop.chunkCount += 1
            if (Number.isInteger(status) && status >= 100 && status <= 599) hop.status = status
            else if (hop.status === null) hop.status = 200
            if (hasCheckpoint) hop.hasCheckpoint = true
            const fr = safeFinishReason(finishReason)
            if (fr) hop.finishReason = fr
          })
        },
        finish({ error, aborted, finishReason, continued } = {}) {
          if (hopClosed) return
          hopClosed = true
          guarded(() => {
            hop.durationMs = Math.max(0, Math.round(performance.now() - hopStarted))
            const fr = safeFinishReason(finishReason)
            if (fr) hop.finishReason = fr
            if (['pre-dispatch', 'fetch', 'response-body', 'stream'].includes(error?.phase)) hop.errorPhase = error.phase
            if (typeof error?.requestSubmitted === 'boolean') hop.requestSubmitted = error.requestSubmitted
            if (aborted) {
              hop.outcome = 'aborted'
              hop.errorCodes = fetchErrorCodes(error)
            } else if (error) {
              const status = typeof error?.status === 'number' && error.status >= 100 && error.status <= 599 ? error.status : null
              const inBand = error.code === 'ARGON_STREAM_ERROR'
              // Keep the observed HTTP status separate from a service/proxy error frame.
              if (inBand && Number.isInteger(status) && status >= 400) hop.streamErrorStatus = status
              else if (!inBand && status !== null) hop.status = status
              hop.outcome = inBand || (status !== null && status >= 400) ? 'api-error' : hop.chunkCount > 0 || (status !== null && status < 400) ? 'dropped' : 'transport-error'
              hop.errorCodes = fetchErrorCodes(error)
              sawAbnormalDrop = true
            } else if (continued) {
              hop.outcome = 'continued'
            } else if (hop.finishReason === null) {
              hop.outcome = 'dropped'
              sawAbnormalDrop = true
            } else {
              hop.outcome = 'done'
            }
          })
        },
      }
    },
    recordTokenUsage(usage = {}) {
      guarded(() => {
        for (const key of Object.keys(state.tokenUsage)) {
          if (Object.hasOwn(usage, key)) state.tokenUsage[key] = Number.isSafeInteger(usage[key]) && usage[key] >= 0 ? usage[key] : null
        }
      })
    },
    finishStream({ outcome, error, transientFinishReason } = {}) {
      guarded(() => {
        if ( ['done', 'max-tokens', 'tool-calls', 'error', 'aborted', 'incomplete'].includes(outcome)) {
          state.outcome = outcome
        }
        if (outcome === 'error') {
          if (transientFinishReason) {
            state.failureCategory = 'transient-finish-reason'
          } else if (state.hopCount <= 1 && (state.hops[0]?.chunkCount ?? 0) === 0) {
            state.failureCategory = state.hops[0]?.outcome === 'api-error' ? 'api-status-error' : state.hops[0]?.status !== null && state.hops[0]?.status !== undefined ? 'mid-stream-drop' : 'initial-connect-error'
          } else if (sawAbnormalDrop) {
            state.failureCategory = 'mid-stream-drop'
          } else {
            state.failureCategory = error ? 'other' : null
          }
        }
      })
      emit()
    },
    finalize(aborted = false) {
      if (finished) return
      guarded(() => {
        if (state.outcome === 'unknown') {
          state.outcome = aborted ? 'aborted' : 'incomplete'
        }
      })
      emit()
    },
  }
}
