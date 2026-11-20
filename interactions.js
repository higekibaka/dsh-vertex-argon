// Official steps/event protocol, not the legacy content.* stream:
// https://ai.google.dev/api/interactions-api#Resource:InteractionSseStreamEvent
// https://ai.google.dev/gemini-api/docs/long-decode#stream-long-decode
import { buildInteractionRequest, contentHash, historyHash, downgradeToolChoiceToAuto, INTERACTIONS_REPLAY_API } from './interactions-input.js'
import {
  computeReconnectDelayMs,
  waitWithAbort,
  parseUpstreamRetryDelayMs,
  MAX_SERVER_RETRY_DELAY_MS,
  STREAM_INITIAL_TTFT_TIMEOUT_MS,
  STREAM_THINKING_TIMEOUT_MS,
  STREAM_TRANSITION_TIMEOUT_MS,
  STREAM_SLIDING_TIMEOUT_MS,
} from './generate-content.js'
import { fetchErrorCodes } from './diagnostics.js'
import { interactionExitReason, cancelsRemoteInteraction, isRecoverableStreamErrorCode, normalizeStreamErrorCode } from './interaction-lifecycle.js'
export { buildInteractionRequest } from './interactions-input.js'

const terminal = new Set(['completed', 'requires_action', 'incomplete', 'failed', 'cancelled', 'budget_exceeded'])
const SUPPORTED_STEP_TYPES = new Set([
  'thought', 'model_output', 'function_call',
  'tool_search_call', 'tool_search_result',
  'processing_call', 'processing_result',
])
const MEDIA_CONTENT_TYPES = new Set(['image', 'audio', 'document', 'video'])
const MAX_BYTES = 64 * 1024 * 1024
const MAX_EVENTS = 65536
const MAX_WATCHDOG_SIGNATURES = 8192
const MAX_INITIAL_CREATE_RETRIES = 3

const PERMANENT_TLS_CODE_RE = /^(?:CERT_|SELF_SIGNED_|UNABLE_TO_VERIFY_|UNABLE_TO_GET_ISSUER_|DEPTH_ZERO_|ERR_TLS_|ERR_SSL_|UND_ERR_PRX_TLS$)/
const PRE_CONNECT_NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
  'ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
])
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE',
  'EAI_AGAIN', 'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'UND_ERR_ABORTED', 'UND_ERR_DESTROYED', 'UND_ERR_CLOSED',
  'FETCH_FAILED', 'STREAM_PHASE_TIMEOUT',
])

function protocolError(message) { return Object.assign(new Error(message), { code: 'ARGON_INTERACTIONS_PROTOCOL' }) }

function collectRawErrorCodes(error) {
  const out = []
  const seen = new Set()
  const queue = [error]
  for (let i = 0; i < queue.length && i < 16; i++) {
    const cur = queue[i]
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue
    seen.add(cur)
    if (typeof cur.code === 'string' && cur.code) out.push(cur.code)
    if (cur.cause && queue.length < 16) queue.push(cur.cause)
    if (Array.isArray(cur.errors)) {
      for (const item of cur.errors) if (queue.length < 16) queue.push(item)
    }
  }
  return out
}

function retryableStatelessCreate(e) {
  if (!e) return false
  if (parseUpstreamRetryDelayMs(e) > MAX_SERVER_RETRY_DELAY_MS) return false
  if (e.phase === 'pre-dispatch' || e.requestSubmitted === false) return false
  if (e.phase !== undefined && e.phase !== 'fetch') return false
  if (String(e.code ?? '').startsWith('ARGON_')) return false
  const rawCodes = collectRawErrorCodes(e)
  const diagCodes = fetchErrorCodes(e)
  const allCodes = [...rawCodes, ...diagCodes]
  if (allCodes.some(c => PERMANENT_TLS_CODE_RE.test(c))) return false
  if (typeof e.status === 'number') {
    return e.status === 408 || e.status === 429 || e.status >= 500
  }
  return allCodes.some(c => PRE_CONNECT_NETWORK_CODES.has(c))
}

function retryable(e, { allowUncodedStreamResume = false } = {}) {
  if (!e) return false
  // A server asking for a longer wait than GenerateContent allows fails fast.
  if (parseUpstreamRetryDelayMs(e) > MAX_SERVER_RETRY_DELAY_MS) return false
  if (e.phase === 'pre-dispatch' || e.requestSubmitted === false) return false
  if (e.recoverableStreamError === true || e.code === 'STREAM_PHASE_TIMEOUT') return true
  if (String(e.code ?? '').startsWith('ARGON_')) return false
  const rawCodes = collectRawErrorCodes(e)
  const diagCodes = fetchErrorCodes(e)
  const allCodes = [...rawCodes, ...diagCodes]
  if (allCodes.some(c => PERMANENT_TLS_CODE_RE.test(c))) return false
  if (typeof e.status === 'number') {
    if (e.status === 408 || e.status === 429 || e.status >= 500) return true
    if (e.status >= 200 && e.status < 300 && ['stream', 'response-body'].includes(e.phase)) {
      return allCodes.some(c => TRANSIENT_NETWORK_CODES.has(c) || c.startsWith('UND_ERR_'))
    }
    return false
  }
  if (allCodes.some(c => TRANSIENT_NETWORK_CODES.has(c) || c.startsWith('UND_ERR_'))) return true
  // For read-only GET resumption of an already-stored cloud task, allow uncoded
  // stream transport interruptions (excluding programming errors).
  if (allowUncodedStreamResume && rawCodes.length === 0 && e.phase === undefined) {
    if (e instanceof TypeError || e instanceof SyntaxError || e instanceof RangeError || e instanceof ReferenceError) return false
    return true
  }
  return false
}

function validObject(value) { return value && typeof value === 'object' && !Array.isArray(value) }
function isPlainObject(value) {
  if (!validObject(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === null || proto === Object.prototype
}

function validateMediaContent(block, contextLabel) {
  if (!isPlainObject(block) || !MEDIA_CONTENT_TYPES.has(block.type)) {
    throw protocolError('Unsupported ' + contextLabel + ' modality.')
  }
  const hasData = block.data !== undefined
  const hasUri = block.uri !== undefined
  if (!hasData && !hasUri) throw protocolError('Malformed ' + contextLabel + ' content block.')
  if (hasData && (typeof block.data !== 'string' || !block.data.length)) throw protocolError('Malformed ' + contextLabel + ' content data.')
  if (hasUri && (typeof block.uri !== 'string' || !block.uri.length)) throw protocolError('Malformed ' + contextLabel + ' content uri.')
  if (block.mime_type !== undefined && (typeof block.mime_type !== 'string' || !block.mime_type.length)) {
    throw protocolError('Malformed ' + contextLabel + ' content mime_type.')
  }
  const encoded = JSON.stringify(block)
  return { cloned: JSON.parse(encoded), encoded }
}

function usageOf(raw) {
  const count = k => Number.isSafeInteger(raw?.[k]) && raw[k] >= 0 ? raw[k] : 0
  const cached = count('total_cached_tokens'), input = count('total_input_tokens'), output = count('total_output_tokens'), thoughts = count('total_thought_tokens'), tool = count('total_tool_use_tokens')
  return { inputTokens: Math.max(0, input - cached) + tool, cacheReadTokens: cached, outputTokens: output + thoughts, reasoningTokens: thoughts, totalTokens: count('total_tokens') || (input + output + thoughts + tool) }
}

function closeIterator(iterator) {
  try { Promise.resolve(iterator?.return?.()).catch(() => {}) } catch {}
}

function createInteractionsHopWatchdog(userSignal, overrides = {}) {
  const controller = new AbortController()
  const defaults = {
    'initial-ttft': STREAM_INITIAL_TTFT_TIMEOUT_MS,
    thinking: STREAM_THINKING_TIMEOUT_MS,
    transition: STREAM_TRANSITION_TIMEOUT_MS,
    streaming: STREAM_SLIDING_TIMEOUT_MS,
  }
  const timeouts = Object.fromEntries(Object.entries(defaults).map(([phase, fallback]) => {
    const key = phase === 'initial-ttft' ? 'initialTtft' : phase
    const proposed = overrides[phase] ?? overrides[key] ?? overrides[key + 'Ms']
    return [phase, Number.isFinite(proposed) && proposed > 0 ? proposed : fallback]
  }))
  let phase = 'initial-ttft', remaining = timeouts[phase]
  let enteredThinking = false, enteredTransition = false
  const seenSignatures = new Set()
  let timeoutError
  const userAbortReason = () => userSignal?.reason !== undefined
    ? userSignal.reason
    : Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
  const userAbort = () => controller.abort(userAbortReason())
  userSignal?.addEventListener('abort', userAbort, { once: true })
  if (userSignal?.aborted) userAbort()
  const makeTimeoutError = () => Object.assign(
    new Error('Argon Interactions stream phase timed out: ' + phase),
    { code: 'STREAM_PHASE_TIMEOUT', recoverableStreamError: true, status: 504, phase: 'stream', requestSubmitted: true },
  )
  const recordSignature = sig => {
    if (typeof sig === 'string' && sig.length > 0 && !seenSignatures.has(sig) && seenSignatures.size < MAX_WATCHDOG_SIGNATURES) {
      seenSignatures.add(sig)
      return true
    }
    return false
  }
  return {
    signal: controller.signal,
    recordProgress({ phaseHint, visible = false, productiveThought = false, signature, isNewEventId = false, isTerminal = false } = {}) {
      const newSignature = recordSignature(signature)
      const nextPhase = (visible || phase === 'streaming')
        ? 'streaming'
        : phaseHint === 'thinking'
          ? 'thinking'
          : phaseHint === 'transition'
            ? 'transition'
            : phase
      phase = nextPhase
      const firstEntry = (nextPhase === 'thinking' && !enteredThinking) || (nextPhase === 'transition' && !enteredTransition)
      if (nextPhase === 'thinking') enteredThinking = true
      if (nextPhase === 'transition') enteredTransition = true
      if (firstEntry || visible || productiveThought || newSignature || isNewEventId || isTerminal) {
        remaining = timeouts[phase]
      }
    },
    async run(operation) {
      userSignal?.throwIfAborted()
      if (timeoutError) throw timeoutError
      if (remaining <= 0) {
        timeoutError = makeTimeoutError()
        controller.abort(timeoutError)
        throw timeoutError
      }
      const started = performance.now()
      let timer, rejectAbort
      const interruption = new Promise((_, reject) => {
        rejectAbort = () => reject(userSignal?.aborted ? userAbortReason() : (timeoutError ?? controller.signal.reason))
        controller.signal.addEventListener('abort', rejectAbort, { once: true })
        timer = setTimeout(() => {
          if (userSignal?.aborted) return
          timeoutError = makeTimeoutError()
          controller.abort(timeoutError)
        }, remaining)
        timer.unref?.()
      })
      try { return await Promise.race([Promise.resolve().then(operation), interruption]) }
      catch (error) {
        if (userSignal?.aborted) throw userAbortReason()
        if (timeoutError) throw timeoutError
        throw error
      }
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

// transport.create(body,{signal}) -> AsyncIterable<Event>
// transport.get(id,{stream:true,last_event_id,signal}) -> AsyncIterable<Event>
// transport.cancel(id,{signal?}) -> response (must accept a fresh signal).
export async function* streamInteractions(options, settings) {
  const signal = options.signal, transport = settings.transport
  const phaseTimeouts = { ...(options.phaseTimeouts ?? {}), ...(settings.phaseTimeouts ?? {}) }
  const steps = new Map(), blocks = new Map(), seenEvents = new Set(), emittedToolIds = new Set()
  let exitReason = 'consumer-abandoned'
  let blockIndex = 0, bytes = 0, interactionId, lastEventId, status, usage, cancelled = false, finishedNormally = false, emitted = false, unindexedVisibleOutput = false, completedEvent = false, progressVersion = 0, indexedSnapshot
  const cloneStepState = state => ({
    ...state,
    ...(state.argsValue !== undefined ? { argsValue: structuredClone(state.argsValue) } : {}),
    ...(state.args !== undefined ? { args: structuredClone(state.args) } : {}),
    ...(state.contents !== undefined ? { contents: state.contents.map(c => ({ ...c })) } : {}),
    ...(state.functionNames !== undefined ? { functionNames: [...state.functionNames] } : {}),
    ...(state.extraArgs !== undefined ? { extraArgs: structuredClone(state.extraArgs) } : {}),
    ...(state.results !== undefined ? { results: [...state.results] } : {}),
    ...(state.resultKeys !== undefined ? { resultKeys: new Set(state.resultKeys) } : {}),
  })
  const captureSnapshot = () => ({
    steps: new Map([...steps.entries()].map(([k, v]) => [k, cloneStepState(v)])),
    blocks: new Map([...blocks.entries()].map(([k, v]) => [k, structuredClone(v)])),
    blockIndex, bytes, status,
    usage: usage ? structuredClone(usage) : undefined,
    completedEvent,
    observerSnapshot: settings.onCaptureSnapshot?.(),
  })
  const restoreSnapshot = snap => {
    steps.clear(); for (const [k, v] of snap.steps.entries()) steps.set(k, cloneStepState(v))
    blocks.clear(); for (const [k, v] of snap.blocks.entries()) blocks.set(k, structuredClone(v))
    blockIndex = snap.blockIndex; bytes = snap.bytes; status = snap.status
    usage = snap.usage ? structuredClone(snap.usage) : undefined; completedEvent = snap.completedEvent
    settings.onRestoreSnapshot?.(snap.observerSnapshot)
  }
  const resetLocalState = () => {
    steps.clear(); blocks.clear(); seenEvents.clear(); emittedToolIds.clear()
    blockIndex = 0; bytes = 0; status = undefined; usage = undefined; completedEvent = false
    unindexedVisibleOutput = false; indexedSnapshot = undefined
    settings.onResetObserver?.()
  }
  const observeUsage = event => {
    const raw = event.interaction?.usage ?? event.usage ?? event.metadata?.total_usage
    if (validObject(raw)) {
      let u
      try { u = JSON.parse(JSON.stringify(raw)) } catch { throw protocolError('Malformed Interactions usage payload.') }
      if (!validObject(u)) return
      const before = (usage?.total_output_tokens ?? 0) + (usage?.total_thought_tokens ?? 0)
      usage = { ...usage, ...u }
      if ((usage.total_output_tokens ?? 0) + (usage.total_thought_tokens ?? 0) > before) progressVersion++
    }
  }
  const checkBytes = text => { bytes += Buffer.byteLength(text ?? ''); if (bytes > MAX_BYTES) throw protocolError('Interactions output exceeded the bounded response buffer.') }
  function appendContentText(state, text) {
    if (!state.contents) state.contents = []
    const last = state.contents.at(-1)
    if (last && last.type === 'text') state.contents[state.contents.length - 1] = { ...last, text: last.text + text }
    else state.contents.push({ type: 'text', text })
  }
  function* appendText(state, text, reasoning = false, indexed = false, progress) {
    if (typeof text !== 'string') throw protocolError('Interactions text delta is not a string.')
    if (!text) return
    if (state.closed) throw protocolError('Received a delta for an already closed step.')
    checkBytes(text)
    if (state.blockIndex === undefined) { state.blockIndex = blockIndex++; yield { type: 'block-start', index: state.blockIndex, blockType: reasoning ? 'reasoning' : 'text' } }
    state.text += text
    appendContentText(state, text)
    emitted = true; if (!indexed) unindexedVisibleOutput = true; progressVersion++
    if (progress) {
      if (reasoning) progress.productiveThought = true
      else progress.visible = true
    }
    yield { type: reasoning ? 'reasoning-delta' : 'text-delta', index: state.blockIndex, text }
  }
  function* closeText(state, indexed = true) {
    if (state.blockIndex !== undefined && !state.blockClosed) {
      if (!indexed) unindexedVisibleOutput = true
      const block = { type: state.kind === 'thought' ? 'reasoning' : 'text', text: state.text }
      state.blockClosed = true; blocks.set(state.blockIndex, block)
      yield { type: 'block-end', index: state.blockIndex, block }
    }
  }
  function stateFor(index) {
    if (!Number.isSafeInteger(index) || index < 0 || index > 4095) throw protocolError('Invalid Interactions step index.')
    const state = steps.get(index)
    if (!state) throw protocolError('Interactions delta arrived before its step.start.')
    return state
  }
  function mergeToolSearchArgs(state, rawArgs) {
    if (!validObject(rawArgs)) throw protocolError('Invalid tool_search_call arguments.')
    if (rawArgs.function_names !== undefined) {
      if (!Array.isArray(rawArgs.function_names) || rawArgs.function_names.some(n => typeof n !== 'string')) {
        throw protocolError('Invalid tool_search_call function_names.')
      }
    }
    const encoded = JSON.stringify(rawArgs)
    checkBytes(encoded)
    const parsed = JSON.parse(encoded)
    let changed = false
    if (Array.isArray(parsed.function_names)) {
      for (const name of parsed.function_names) {
        if (!state.functionNames.includes(name)) { state.functionNames.push(name); changed = true }
      }
    }
    const { function_names: _fn, ...extras } = parsed
    if (Object.keys(extras).length > 0) {
      const nextExtra = { ...(state.extraArgs ?? {}), ...extras }
      if (JSON.stringify(nextExtra) !== JSON.stringify(state.extraArgs)) {
        state.extraArgs = nextExtra
        changed = true
      }
    }
    if (changed) progressVersion++
    return changed
  }
  function mergeToolSearchResult(state, rawResult) {
    if (!Array.isArray(rawResult) || rawResult.some(item => !validObject(item))) {
      throw protocolError('Invalid tool_search_result payload.')
    }
    const encoded = JSON.stringify(rawResult)
    checkBytes(encoded)
    const parsed = JSON.parse(encoded)
    state.hasResult = true
    if (!state.resultKeys) state.resultKeys = new Set(state.results.map(item => JSON.stringify(item)))
    let changed = false
    for (const item of parsed) {
      const key = JSON.stringify(item)
      if (!state.resultKeys.has(key)) {
        state.resultKeys.add(key)
        state.results.push(item)
        changed = true
      }
    }
    if (changed) progressVersion++
    return changed
  }
  function* handleBody(event, indexed, progress) {
    settings.onEvent?.(event)
    const type = event.event_type ?? event.type
    const id = event.interaction?.id ?? event.interaction_id
    if (id) { if (interactionId && interactionId !== id) throw protocolError('Interaction ID changed mid-stream.'); interactionId = id }
    observeUsage(event)
    if (type === 'interaction.created' || type === 'interaction.status_update' || type === 'interaction.completed') {
      const nextStatus = event.interaction?.status ?? event.status ?? (type === 'interaction.completed' ? 'completed' : status)
      // A confirmed terminal status is never rolled back by a later notice.
      if (!terminal.has(status) || terminal.has(nextStatus)) status = nextStatus
      // A status_update carrying a failed/cancelled/over-budget state is itself the
      // end of the stream: finalize immediately rather than waiting for EOF.
      // A plain completed status still waits for the dedicated completed event.
      if (type === 'interaction.completed' || (type === 'interaction.status_update' && ['failed', 'cancelled', 'budget_exceeded'].includes(status))) {
        completedEvent = true
        progress.isTerminal = true
      } else if (type === 'interaction.status_update' && steps.size > 0) {
        progress.phaseHint = 'transition'
      }
      return
    }
    // 2026-05-20 emits dedicated terminal lifecycle events instead of only
    // interaction.completed; each one closes the stream on its own.
    if (type === 'interaction.in_progress' || type === 'interaction.requires_action' || type === 'interaction.failed' || type === 'interaction.cancelled' || type === 'interaction.incomplete' || type === 'interaction.budget_exceeded') {
      const implied = type.slice('interaction.'.length)
      const nextStatus = event.interaction?.status ?? event.status ?? implied
      if (!terminal.has(status) || terminal.has(nextStatus)) status = nextStatus
      if (type !== 'interaction.in_progress') {
        completedEvent = true
        progress.isTerminal = true
      }
      return
    }
    if (type === 'error') {
      const code = normalizeStreamErrorCode(event.error?.code)
      const error = protocolError('Interactions returned an error event (' + code + ').')
      // Only retry the existing stored task, never create another paid task.
      error.recoverableStreamError = isRecoverableStreamErrorCode(code)
      if (!error.recoverableStreamError) {
        // An unclassified error frame is not proof that the cloud task ended:
        // nothing is reported as terminal until the cloud state is re-probed.
        error.remoteTerminalError = true
        status = 'failed'
      }
      throw error
    }
    if (type === 'step.start') {
      if (!Number.isSafeInteger(event.index) || event.index < 0 || event.index > 4095 || steps.has(event.index)) throw protocolError('Invalid or duplicate step.start.')
      const step = event.step
      // Replayed user-input steps are structural markers with no model output.
      if (validObject(step) && step.type === 'user_input') { steps.set(event.index, { kind: 'user_input', closed: false }); progressVersion++; return }
      if (!validObject(step) || !SUPPORTED_STEP_TYPES.has(step.type)) throw protocolError('Unsupported Interactions step type; this adapter executes only DSH-declared local tools.')
      let stepBytes = 0
      if (step.signature !== undefined) {
        if (typeof step.signature !== 'string') throw protocolError('Invalid thought signature.')
        stepBytes += Buffer.byteLength(step.signature)
      }
      if (step.id !== undefined) {
        if (typeof step.id !== 'string') throw protocolError('Invalid function call ID.')
        stepBytes += Buffer.byteLength(step.id)
      }
      if (step.call_id !== undefined) {
        if (typeof step.call_id !== 'string') throw protocolError('Invalid step call_id.')
        stepBytes += Buffer.byteLength(step.call_id)
      }
      if (step.name !== undefined) {
        if (typeof step.name !== 'string') throw protocolError('Invalid function call name.')
        stepBytes += Buffer.byteLength(step.name)
      }
      const initialContentItems = []
      if (step.type === 'model_output') {
        if (step.content !== undefined && !Array.isArray(step.content)) throw protocolError('Invalid model_output content.')
        for (const content of step.content ?? []) {
          if (!validObject(content)) throw protocolError('Unsupported output modality.')
          if (content.type === 'text') {
            if (typeof content.text !== 'string') throw protocolError('Interactions text delta is not a string.')
            stepBytes += Buffer.byteLength(content.text)
            initialContentItems.push({ kind: 'text', text: content.text })
          } else {
            const media = validateMediaContent(content, 'output')
            stepBytes += Buffer.byteLength(media.encoded)
            initialContentItems.push({ kind: 'media', cloned: media.cloned, encoded: media.encoded })
          }
        }
      }
      if (step.type === 'thought') {
        if (step.summary !== undefined && !Array.isArray(step.summary)) throw protocolError('Invalid thought summary.')
        for (const content of step.summary ?? []) {
          if (!validObject(content)) throw protocolError('Unsupported thought summary modality.')
          if (content.type === 'text') {
            if (typeof content.text !== 'string') throw protocolError('Interactions text delta is not a string.')
            stepBytes += Buffer.byteLength(content.text)
            initialContentItems.push({ kind: 'text', text: content.text })
          } else {
            const media = validateMediaContent(content, 'thought summary')
            stepBytes += Buffer.byteLength(media.encoded)
            initialContentItems.push({ kind: 'media', cloned: media.cloned, encoded: media.encoded })
          }
        }
      }
      let initialArgsText = '', initialArgsValue = step.arguments, initialArgsEncoded = ''
      if (step.type === 'function_call' && step.arguments != null) {
        if (typeof step.arguments === 'string') {
          stepBytes += Buffer.byteLength(step.arguments)
          initialArgsText = step.arguments
          initialArgsValue = undefined
        } else if (validObject(step.arguments)) {
          initialArgsEncoded = JSON.stringify(step.arguments)
          stepBytes += Buffer.byteLength(initialArgsEncoded)
          initialArgsValue = JSON.parse(initialArgsEncoded)
        } else throw protocolError('Invalid function argument delta.')
      }
      let initialSearchArgsEncoded = '', initialSearchArgsParsed
      if (step.type === 'tool_search_call' && step.arguments != null) {
        if (!validObject(step.arguments)) throw protocolError('Invalid tool_search_call arguments.')
        if (step.arguments.function_names !== undefined && (!Array.isArray(step.arguments.function_names) || step.arguments.function_names.some(n => typeof n !== 'string'))) {
          throw protocolError('Invalid tool_search_call function_names.')
        }
        initialSearchArgsEncoded = JSON.stringify(step.arguments)
        stepBytes += Buffer.byteLength(initialSearchArgsEncoded)
        initialSearchArgsParsed = JSON.parse(initialSearchArgsEncoded)
      }
      let initialSearchResultEncoded = '', initialSearchResultParsed
      if (step.type === 'tool_search_result' && step.result !== undefined) {
        if (!Array.isArray(step.result) || step.result.some(item => !validObject(item))) {
          throw protocolError('Invalid tool_search_result payload.')
        }
        initialSearchResultEncoded = JSON.stringify(step.result)
        stepBytes += Buffer.byteLength(initialSearchResultEncoded)
        initialSearchResultParsed = JSON.parse(initialSearchResultEncoded)
      }
      if (bytes + stepBytes > MAX_BYTES) throw protocolError('Interactions output exceeded the bounded response buffer.')
      if (step.signature) { checkBytes(step.signature); progress.signature = step.signature }
      if (step.id) checkBytes(step.id)
      if (step.call_id) checkBytes(step.call_id)
      if (step.name) checkBytes(step.name)
      if (initialArgsText) checkBytes(initialArgsText)
      else if (initialArgsEncoded) checkBytes(initialArgsEncoded)
      if (initialSearchArgsEncoded) checkBytes(initialSearchArgsEncoded)
      if (initialSearchResultEncoded) checkBytes(initialSearchResultEncoded)
      let state
      if (step.type === 'tool_search_call') {
        const functionNames = []
        let extraArgs
        if (initialSearchArgsParsed) {
          for (const name of initialSearchArgsParsed.function_names ?? []) {
            if (!functionNames.includes(name)) functionNames.push(name)
          }
          const { function_names: _fn, ...extras } = initialSearchArgsParsed
          if (Object.keys(extras).length > 0) extraArgs = extras
        }
        state = { kind: 'tool_search_call', callId: step.id, signature: step.signature, functionNames, extraArgs, closed: false }
        progress.phaseHint = 'transition'
        if ((typeof step.id === 'string' && step.id.length > 0) || functionNames.length > 0) progress.visible = true
      } else if (step.type === 'tool_search_result') {
        const results = initialSearchResultParsed ?? []
        const resultKeys = new Set(results.map(item => JSON.stringify(item)))
        state = { kind: 'tool_search_result', callId: step.call_id, signature: step.signature, hasResult: step.result !== undefined, results, resultKeys, closed: false }
        progress.phaseHint = 'transition'
        if ((typeof step.call_id === 'string' && step.call_id.length > 0) || results.length > 0) progress.visible = true
      } else if (step.type === 'processing_call') {
        state = { kind: 'processing_call', callId: step.id, signature: step.signature, closed: false }
        progress.phaseHint = 'transition'
        if (typeof step.id === 'string' && step.id.length > 0) progress.visible = true
      } else if (step.type === 'processing_result') {
        state = { kind: 'processing_result', callId: step.call_id, signature: step.signature, closed: false }
        progress.phaseHint = 'transition'
        if (typeof step.call_id === 'string' && step.call_id.length > 0) progress.visible = true
      } else {
        state = { kind: step.type, text: '', contents: [], signature: step.signature, callId: step.id, name: step.name, argsValue: initialArgsValue, argsText: initialArgsText, closed: false }
        progress.phaseHint = step.type === 'thought' ? 'thinking' : 'transition'
        if (step.type === 'function_call' && ((typeof step.name === 'string' && step.name.length > 0) || initialArgsText.length > 0 || (initialArgsValue && Object.keys(initialArgsValue).length > 0))) {
          progress.visible = true
        }
      }
      steps.set(event.index, state); progressVersion++
      if (step.type === 'model_output' || step.type === 'thought') {
        const isReasoning = step.type === 'thought'
        for (const item of initialContentItems) {
          if (item.kind === 'text') yield* appendText(state, item.text, isReasoning, indexed, progress)
          else {
            checkBytes(item.encoded)
            state.contents.push(item.cloned)
            progressVersion++
            if (isReasoning) progress.productiveThought = true
            else progress.visible = true
          }
        }
      }
      return
    }
    if (type === 'step.delta') {
      const state = stateFor(event.index), delta = event.delta
      if (!validObject(delta)) throw protocolError('Invalid step delta.')
      if (state.kind === 'user_input') {
        if (state.closed) throw protocolError('Received a delta for an already closed step.')
        return
      }
      if (delta.type === 'text_annotation_delta' && state.kind === 'model_output') return // additive citations; no DSH annotation block type
      if (delta.type === 'text' && state.kind === 'model_output') {
        if (delta.signature !== undefined) {
          if (state.closed) throw protocolError('Received a delta for an already closed step.')
          if (typeof delta.signature !== 'string') throw protocolError('Invalid model_output signature.')
          if (delta.signature !== state.signature) { checkBytes(delta.signature); progressVersion++ }
          state.signature = delta.signature
          progress.signature = delta.signature
        }
        yield* appendText(state, delta.text, false, indexed, progress)
      } else if ((delta.type === 'model_output' || delta.type === 'signature' || delta.type === 'thought_signature') && state.kind === 'model_output' && delta.signature !== undefined) {
        if (state.closed) throw protocolError('Received a delta for an already closed step.')
        if (typeof delta.signature !== 'string') throw protocolError('Invalid model_output signature.')
        if (delta.signature !== state.signature) { checkBytes(delta.signature); progressVersion++ }
        state.signature = delta.signature
        progress.signature = delta.signature
      } else if (MEDIA_CONTENT_TYPES.has(delta.type) && state.kind === 'model_output') {
        if (state.closed) throw protocolError('Received a delta for an already closed step.')
        const media = validateMediaContent(delta, 'output')
        checkBytes(media.encoded)
        state.contents.push(media.cloned)
        progressVersion++
        progress.visible = true
      } else if (delta.type === 'thought_summary' && state.kind === 'thought') {
        progress.phaseHint = 'thinking'
        if (delta.content !== undefined) {
          if (!validObject(delta.content)) throw protocolError('Unsupported thought summary modality.')
          if (delta.content.type === 'text') {
            yield* appendText(state, delta.content.text, true, indexed, progress)
          } else {
            if (state.closed) throw protocolError('Received a delta for an already closed step.')
            const media = validateMediaContent(delta.content, 'thought summary')
            checkBytes(media.encoded)
            state.contents.push(media.cloned)
            progressVersion++
            progress.productiveThought = true
          }
        }
      } else if (delta.type === 'thought_signature' && state.kind === 'thought') {
        progress.phaseHint = 'thinking'
        if (typeof delta.signature !== 'string') throw protocolError('Invalid thought signature.')
        if (state.signature !== delta.signature) { checkBytes(delta.signature); progressVersion++ }
        state.signature = delta.signature
        progress.signature = delta.signature
      } else if (state.kind === 'function_call' && ['arguments_delta', 'arguments', 'function_call'].includes(delta.type)) {
        if (state.closed) throw protocolError('Function arguments arrived after step.stop.')
        if (delta.id !== undefined) {
          if (typeof delta.id !== 'string') throw protocolError('Invalid function call ID.')
          if (delta.id && delta.id !== state.callId) { checkBytes(delta.id); progressVersion++; state.callId = delta.id; progress.visible = true }
        }
        if (delta.name !== undefined) {
          if (typeof delta.name !== 'string') throw protocolError('Invalid function call name.')
          if (delta.name && delta.name !== state.name) { checkBytes(delta.name); progressVersion++; state.name = delta.name; progress.visible = true }
        }
        if (delta.signature !== undefined) {
          if (typeof delta.signature !== 'string') throw protocolError('Invalid function call signature.')
          if (delta.signature !== state.signature) { checkBytes(delta.signature); progressVersion++ }
          state.signature = delta.signature
          progress.signature = delta.signature
        }
        const args = delta.partial_arguments ?? delta.arguments
        if (typeof args === 'string') {
          checkBytes(args)
          state.argsText += args
          if (args.length > 0) { progressVersion++; progress.visible = true }
        } else if (validObject(args)) {
          const encoded = JSON.stringify(args), parsedArgs = JSON.parse(encoded)
          checkBytes(encoded)
          if (encoded !== JSON.stringify(state.argsValue)) { progressVersion++; progress.visible = true }
          state.argsValue = parsedArgs
        } else throw protocolError('Invalid function argument delta.')
      } else if (state.kind === 'tool_search_call' && delta.type === 'tool_search_call') {
        if (state.closed) throw protocolError('Received a delta for an already closed step.')
        if (delta.id !== undefined) {
          if (typeof delta.id !== 'string') throw protocolError('Invalid tool_search_call ID.')
          if (delta.id && delta.id !== state.callId) { checkBytes(delta.id); progressVersion++; state.callId = delta.id; progress.visible = true }
        }
        if (delta.signature !== undefined) {
          if (typeof delta.signature !== 'string') throw protocolError('Invalid tool_search_call signature.')
          if (delta.signature !== state.signature) { checkBytes(delta.signature); progressVersion++ }
          state.signature = delta.signature
          progress.signature = delta.signature
        }
        if (delta.arguments !== undefined && mergeToolSearchArgs(state, delta.arguments)) progress.visible = true
      } else if (state.kind === 'tool_search_result' && delta.type === 'tool_search_result') {
        if (state.closed) throw protocolError('Received a delta for an already closed step.')
        if (delta.call_id !== undefined) {
          if (typeof delta.call_id !== 'string') throw protocolError('Invalid tool_search_result call_id.')
          if (delta.call_id && delta.call_id !== state.callId) { checkBytes(delta.call_id); progressVersion++; state.callId = delta.call_id; progress.visible = true }
        }
        if (delta.signature !== undefined) {
          if (typeof delta.signature !== 'string') throw protocolError('Invalid tool_search_result signature.')
          if (delta.signature !== state.signature) { checkBytes(delta.signature); progressVersion++ }
          state.signature = delta.signature
          progress.signature = delta.signature
        }
        if (delta.result !== undefined && mergeToolSearchResult(state, delta.result)) progress.visible = true
      } else if (state.kind === 'processing_call' && delta.type === 'processing_call') {
        if (state.closed) throw protocolError('Received a delta for an already closed step.')
        if (delta.id !== undefined) {
          if (typeof delta.id !== 'string') throw protocolError('Invalid processing_call ID.')
          if (delta.id && delta.id !== state.callId) { checkBytes(delta.id); progressVersion++; state.callId = delta.id; progress.visible = true }
        }
        if (delta.signature !== undefined) {
          if (typeof delta.signature !== 'string') throw protocolError('Invalid processing_call signature.')
          if (delta.signature !== state.signature) { checkBytes(delta.signature); progressVersion++ }
          state.signature = delta.signature
          progress.signature = delta.signature
        }
      } else if (state.kind === 'processing_result' && delta.type === 'processing_result') {
        if (state.closed) throw protocolError('Received a delta for an already closed step.')
        if (delta.call_id !== undefined) {
          if (typeof delta.call_id !== 'string') throw protocolError('Invalid processing_result call_id.')
          if (delta.call_id && delta.call_id !== state.callId) { checkBytes(delta.call_id); progressVersion++; state.callId = delta.call_id; progress.visible = true }
        }
        if (delta.signature !== undefined) {
          if (typeof delta.signature !== 'string') throw protocolError('Invalid processing_result signature.')
          if (delta.signature !== state.signature) { checkBytes(delta.signature); progressVersion++ }
          state.signature = delta.signature
          progress.signature = delta.signature
        }
      } else throw protocolError('Unexpected Interactions delta for this step.')
      return
    }
    if (type === 'step.stop') {
      const state = stateFor(event.index)
      if (state.closed) throw protocolError('Duplicate step.stop without a replay cursor.')
      state.closed = true; progressVersion++
      if (state.kind !== 'user_input') progress.phaseHint = 'transition'
      if (state.kind === 'user_input' || state.kind === 'tool_search_call' || state.kind === 'tool_search_result' || state.kind === 'processing_call' || state.kind === 'processing_result') return
      if (state.kind === 'function_call') {
        try { state.args = state.argsText ? JSON.parse(state.argsText) : (state.argsValue ?? {}) } catch { state.invalidArguments = true }
        if (!validObject(state.args)) state.invalidArguments = true
      } else yield* closeText(state, indexed)
      return
    }
    // Usage/status extensions may be added without rendering; unknown semantic
    // output events fail closed rather than silently losing generated content.
    if (typeof type === 'string' && type.startsWith('interaction.')) {
      return
    }
    throw protocolError('Unknown Interactions stream event.')
  }
  function* handle(event, watchdog) {
    if (!validObject(event)) throw protocolError('Invalid Interactions event.')
    const indexed = Boolean(event.event_id)
    if (indexed) {
      if (typeof event.event_id !== 'string') throw protocolError('Invalid event ID.')
      if (seenEvents.has(event.event_id)) return
      if (seenEvents.size >= MAX_EVENTS) throw protocolError('Interactions event retention limit reached.')
    }
    const progress = { phaseHint: undefined, visible: false, productiveThought: false, signature: undefined, isTerminal: false }
    const gen = handleBody(event, indexed, progress)
    let yieldedAny = false
    for (;;) {
      let next
      try { next = gen.next() } catch (err) {
        if (yieldedAny) unindexedVisibleOutput = true
        if (err?.recoverableStreamError === true || String(err?.code ?? '').startsWith('ARGON_')) throw err
        throw protocolError(err?.message || 'Malformed Interactions event payload.')
      }
      if (next.done) break
      yieldedAny = true
      yield next.value
    }
    if (indexed) {
      if (settings.store === true) {
        let snap
        try { snap = captureSnapshot() } catch (err) {
          if (yieldedAny) unindexedVisibleOutput = true
          if (String(err?.code ?? '').startsWith('ARGON_')) throw err
          throw protocolError(err?.message || 'Failed to snapshot Interactions stream state.')
        }
        indexedSnapshot = snap
      }
      seenEvents.add(event.event_id)
      lastEventId = event.event_id
      unindexedVisibleOutput = false
    }
    watchdog?.recordProgress({ ...progress, isNewEventId: indexed })
  }
  const cancel = async () => {
    if (settings.background && interactionId && !terminal.has(status) && !cancelled) {
      cancelled = true // one attempt per unwind, even if confirmation fails
      await transport.cancel(interactionId, { signal: AbortSignal.timeout(30000) })
    }
  }
  try {
    signal?.throwIfAborted()
    const resolvedImages = new WeakMap()
    const cachedResolveImage = typeof settings.resolveImage === 'function'
      ? block => {
          if (block && typeof block === 'object') {
            if (!resolvedImages.has(block)) resolvedImages.set(block, Promise.resolve().then(() => settings.resolveImage(block)))
            return resolvedImages.get(block)
          }
          return settings.resolveImage(block)
        }
      : settings.resolveImage
    const buildSettings = cachedResolveImage === settings.resolveImage ? settings : { ...settings, resolveImage: cachedResolveImage }
    let currentBody = await buildInteractionRequest(options, buildSettings)
    let validatedFallbackUsed = false
    let initialRetries = 0
    let reconnects = 0, connections = 0, replayingWithoutCursor = false, lastDropFingerprint
    let nextMode = 'create'
    const deadline = Date.now() + 24 * 60 * 60 * 1000
    for (;;) {
      const beforeProgress = progressVersion, beforeLastEventId = lastEventId
      const watchdog = createInteractionsHopWatchdog(signal, phaseTimeouts)
      let stream, iterator, sourceDone = false, failure, createFailedAtFetch = false, receivedStreamEvent = false
      try {
        connections++
        if (nextMode === 'create') {
          try {
            if (settings.background) {
              // Background durable.create shields post-dispatch aborts until the remote
              // interaction ID is captured and persisted (bounded by its own 60s ack timer),
              // so the hub claim stays active across Stop/shutdown until ID discovery settles.
              stream = await transport.create(currentBody, { signal: watchdog.signal })
            } else {
              stream = await watchdog.run(() => Promise.resolve(transport.create(currentBody, { signal: watchdog.signal })).then(source => {
                if (watchdog.signal.aborted) closeIterator(source?.[Symbol.asyncIterator]?.() ?? source)
                return source
              }))
            }
          } catch (e) {
            createFailedAtFetch = true
            throw e
          }
        } else {
          stream = await watchdog.run(() => Promise.resolve(transport.get(interactionId, { stream: true, ...(lastEventId ? { last_event_id: lastEventId } : {}), signal: watchdog.signal })).then(source => {
            if (watchdog.signal.aborted) closeIterator(source?.[Symbol.asyncIterator]?.() ?? source)
            return source
          }))
        }
        if (!stream?.[Symbol.asyncIterator]) throw protocolError('Interactions create/get returned no event stream.')
        iterator = stream[Symbol.asyncIterator]()
        for (;;) {
          const item = await watchdog.run(() => iterator.next())
          if (item.done) { sourceDone = true; break }
          const event = item.value
          receivedStreamEvent = true
          signal?.throwIfAborted()
          yield* handle(event, watchdog)
          // Authoritative terminal events finalize immediately without waiting for
          // chunked EOF, preventing post-terminal hang/drop from causing false errors
          // or duplicate stateless retries.
          if (completedEvent && terminal.has(status)) {
            sourceDone = true
            closeIterator(iterator)
            break
          }
        }
      } catch (e) {
        failure = e
      } finally {
        watchdog.close()
        if (!sourceDone) closeIterator(iterator)
      }
      // A terminal frame or an unrecoverable failure decides the outcome before a
      // simultaneous local abort: aborting must not rewrite it as a user stop and
      // must not send /cancel to a remote task that already ended.
      if (!failure && completedEvent && terminal.has(status)) break
      if (failure?.remoteTerminalError) throw failure
      const isModelNotFound =
        failure?.upstreamCode === 'MODEL_NOT_FOUND' ||
        (Array.isArray(failure?.upstreamCodes) && failure.upstreamCodes.includes('MODEL_NOT_FOUND')) ||
        failure?.code === 'MODEL_NOT_FOUND' ||
        failure?.cause?.code === 'MODEL_NOT_FOUND' ||
        fetchErrorCodes(failure).includes('MODEL_NOT_FOUND')
      if (
        nextMode === 'create' &&
        connections === 1 &&
        createFailedAtFetch &&
        !validatedFallbackUsed &&
        options.toolChoice === undefined &&
        currentBody.generation_config?.tool_choice === 'validated' &&
        !interactionId &&
        !emitted &&
        failure?.status === 400 &&
        failure?.phase === 'fetch' &&
        !isModelNotFound
      ) {
        signal?.throwIfAborted()
        validatedFallbackUsed = true
        const hasToolSearchInput = Array.isArray(currentBody.input) && currentBody.input.some(s => s?.type === 'tool_search_call' || s?.type === 'tool_search_result')
        currentBody = hasToolSearchInput
          ? await buildInteractionRequest({ ...options, toolChoice: 'auto' }, { ...buildSettings, interactionsToolRetrieval: 'off' })
          : downgradeToolChoiceToAuto(currentBody)
        resetLocalState()
        interactionId = undefined
        lastEventId = undefined
        settings.onCreateRetry?.({ trigger: 'retry-original', delayMs: 0 })
        nextMode = 'create'
        continue
      }
      const isStatelessCreate = !settings.store && !settings.background
      const allowUncodedStreamResume = Boolean(settings.store && interactionId && !createFailedAtFetch)
      if (failure && !(isStatelessCreate ? (createFailedAtFetch && retryableStatelessCreate(failure)) : retryable(failure, { allowUncodedStreamResume }))) throw failure
      signal?.throwIfAborted()
      if (connections >= 64 || Date.now() >= deadline) throw Object.assign(new Error('Interactions recovery reached its connection or runtime bound.'), { code: 'ARGON_INTERACTIONS_INTERRUPTED' })
      if (isStatelessCreate) {
        // Once HTTP 200 text/event-stream is returned (createFailedAtFetch === false),
        // cloud generation/billing may already be active: never resubmit stateless POST.
        if (!createFailedAtFetch || !failure || !retryableStatelessCreate(failure) || emitted || receivedStreamEvent || initialRetries >= MAX_INITIAL_CREATE_RETRIES) {
          throw failure ?? Object.assign(new Error('Interactions stream ended without a terminal status or safe recovery cursor.'), { code: 'ARGON_INTERACTIONS_INTERRUPTED' })
        }
        const delayMs = computeReconnectDelayMs(++initialRetries, settings.reconnectBackoff, parseUpstreamRetryDelayMs(failure))
        await waitWithAbort(delayMs, signal)
        settings.onReconnectDelay?.(delayMs)
        settings.onCreateRetry?.({ trigger: 'retry-initial', delayMs })
        resetLocalState()
        interactionId = undefined
        lastEventId = undefined
        nextMode = 'create'
        continue
      }
      const attemptFingerprint = JSON.stringify({ lastEventId, status, usage, steps: [...steps.entries()].sort((a, b) => a[0] - b[0]) })
      const madeProgress = lastEventId !== beforeLastEventId || ((!replayingWithoutCursor || Boolean(lastEventId)) && progressVersion > beforeProgress && attemptFingerprint !== lastDropFingerprint)
      if (madeProgress) reconnects = 0
      lastDropFingerprint = attemptFingerprint
      if (!settings.store || !interactionId || reconnects >= 3) throw failure ?? Object.assign(new Error('Interactions stream ended without a terminal status or safe recovery cursor.'), { code: 'ARGON_INTERACTIONS_INTERRUPTED' })
      if (unindexedVisibleOutput) throw protocolError('The stored Interactions read stream omitted event_id on a visible output frame; refusing unsafe replay. The remote task will be explicitly terminated, not resubmitted.')
      if (!lastEventId) {
        if (emitted) throw protocolError('The stored Interactions read stream omitted event_id after visible output; refusing unsafe replay. The remote task will be explicitly terminated, not resubmitted.')
        // No visible blocks or tool calls have escaped: discard cursor-free
        // partial steps before replaying this same stored interaction from zero.
        replayingWithoutCursor = true
        resetLocalState()
      } else {
        replayingWithoutCursor = false
        if (indexedSnapshot) restoreSnapshot(indexedSnapshot)
      }
      const delayMs = computeReconnectDelayMs(++reconnects, settings.reconnectBackoff, parseUpstreamRetryDelayMs(failure))
      await waitWithAbort(delayMs, signal)
      // The transport options of get() stay byte-for-byte unchanged; hops only
      // observe the suggested wait for diagnostics.
      settings.onReconnectDelay?.(delayMs)
      nextMode = 'get'
    }
    for (const state of steps.values()) if (state.kind === 'thought' || state.kind === 'model_output') yield* closeText(state)
    const toolStates = [...steps.values()].filter(s => s.kind === 'function_call')
    if (status === 'completed' || status === 'requires_action') {
      if ([...steps.values()].some(state => !state.closed)) throw protocolError('Interactions completed before every step.stop was received.')
      for (const state of steps.values()) {
        if (state.kind === 'tool_search_call' || state.kind === 'processing_call') {
          if (typeof state.callId !== 'string' || !state.callId) throw protocolError('Interactions ' + state.kind + ' step is missing a valid id.')
        } else if (state.kind === 'tool_search_result' || state.kind === 'processing_result') {
          if (typeof state.callId !== 'string' || !state.callId) throw protocolError('Interactions ' + state.kind + ' step is missing a valid call_id.')
        }
      }
      if (status === 'requires_action' && !toolStates.length) throw protocolError('requires_action contained no supported local function call.')
      for (const state of toolStates) {
        if (!state.closed || state.invalidArguments || typeof state.callId !== 'string' || !state.callId || typeof state.name !== 'string' || !state.name) throw protocolError('Interactions tool call was incomplete or contained invalid JSON.')
        if (emittedToolIds.has(state.callId)) throw protocolError('Duplicate function call ID.')
        emittedToolIds.add(state.callId)
      }
      // Validate all calls before committing any one of them to the host.
      for (const state of toolStates) {
        const index = blockIndex++, argumentsText = JSON.stringify(state.args)
        const block = { type: 'tool-call', id: state.callId, name: state.name, arguments: argumentsText }
        blocks.set(index, block)
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index, id: state.callId, name: state.name, argumentsDelta: argumentsText }
        yield { type: 'block-end', index, block }
      }
    }
    if (usage) yield { type: 'usage', usage: usageOf(usage) }
    const content = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block)
    const replaySteps = []
    if (status === 'completed' || status === 'requires_action') for (const [, state] of [...steps.entries()].sort((a, b) => a[0] - b[0])) {
      if (state.kind === 'user_input') continue
      if (state.kind === 'thought') replaySteps.push({ type: 'thought', ...(state.signature ? { signature: state.signature } : {}), ...(state.contents?.length ? { summary: structuredClone(state.contents) } : {}) })
      else if (state.kind === 'model_output') replaySteps.push({ type: 'model_output', content: state.contents?.length ? structuredClone(state.contents) : [{ type: 'text', text: state.text }], ...(state.signature ? { signature: state.signature } : {}) })
      else if (state.kind === 'function_call') replaySteps.push({ type: 'function_call', id: state.callId, name: state.name, arguments: state.args, ...(state.signature ? { signature: state.signature } : {}) })
      else if (state.kind === 'tool_search_call') replaySteps.push({ type: 'tool_search_call', id: state.callId, arguments: { ...(state.extraArgs ? structuredClone(state.extraArgs) : {}), function_names: [...state.functionNames] }, ...(state.signature ? { signature: state.signature } : {}) })
      else if (state.kind === 'tool_search_result') replaySteps.push({ type: 'tool_search_result', call_id: state.callId, ...(state.hasResult ? { result: structuredClone(state.results) } : {}), ...(state.signature ? { signature: state.signature } : {}) })
      else if (state.kind === 'processing_call') replaySteps.push({ type: 'processing_call', id: state.callId, ...(state.signature ? { signature: state.signature } : {}) })
      else if (state.kind === 'processing_result') replaySteps.push({ type: 'processing_result', call_id: state.callId, ...(state.signature ? { signature: state.signature } : {}) })
    }
    const kind = status === 'requires_action' || (status === 'completed' && toolStates.length) ? 'tool-calls' : status === 'completed' ? 'stop' : (status === 'incomplete' || status === 'budget_exceeded') ? 'max-tokens' : status === 'cancelled' ? 'aborted' : 'error'
    const reason = ['aborted', 'error'].includes(kind) ? { kind, failure: { code: kind === 'aborted' ? 'ABORTED' : 'ARGON_INTERACTIONS_FAILED', message: 'Remote interaction ' + status + '.' } } : { kind }
    finishedNormally = true
    exitReason = 'completed'
    settings.onTerminal?.(status)
    yield { type: 'finish', reason, ...(replaySteps.length ? { replayState: { response: { api: INTERACTIONS_REPLAY_API, provider: options.provider, model: options.model, route: settings.route, contentHash: contentHash(content), historyHash: historyHash(options.messages), steps: replaySteps } } } : {}) }
  } catch (error) {
    exitReason = interactionExitReason(error, signal)
    const aborted = exitReason === 'user-stop' || exitReason === 'host-shutdown'
    const retained = settings.background && interactionId && !terminal.has(status) && !cancelsRemoteInteraction(exitReason)
    let cancellationError = false
    if (cancelsRemoteInteraction(exitReason)) { try { await cancel() } catch { cancellationError = true } }
    for (const state of steps.values()) if (state.kind === 'thought' || state.kind === 'model_output') yield* closeText(state)
    if (usage) yield { type: 'usage', usage: usageOf(usage) }
    yield { type: 'finish', reason: { kind: aborted ? 'aborted' : 'error', failure: { code: retained ? 'ARGON_BACKGROUND_READ_INTERRUPTED' : aborted ? 'ABORTED' : error.code ?? 'ARGON_INTERACTIONS', message: (error.message ?? 'Interactions request failed.') + (retained ? ' The remote task ID is retained; cloud status is unverified. Query or resume this task instead of creating another.' : '') + (cancellationError ? ' Remote cancellation is unconfirmed; the host retains its recovery record.' : ''), ...(error.status ? { status: error.status } : {}) } } }
  } finally {
    if (!finishedNormally && exitReason === 'consumer-abandoned' && signal?.aborted) {
      exitReason = interactionExitReason(signal.reason, signal)
    }
    if (!finishedNormally && cancelsRemoteInteraction(exitReason)) { try { await cancel() } catch {} }
    settings.onExit?.(exitReason)
  }
}
