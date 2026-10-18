import { shared } from './runtime.js'
import { readBoundedJson } from './bounded-json.js'
const { attributionHeaders } = await shared('@deepseek-ai/dsh-llm')

// Raw REST avoids stale generated Interactions schemas; auth is refreshed per call.
// https://ai.google.dev/api/interactions-api
// https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/interactions/developer-guide#rest-endpoint
export const INTERACTIONS_REVISION = '2026-05-20'
const READ_TIMEOUT_MS = 20 * 60 * 1000
const MAX_EVENT_BYTES = 2 * 1024 * 1024

export function interactionsEndpoint({ route, baseURL, project, location = 'global', apiKey = false }) {
  const vertex = route === 'google-vertex'
  if (!vertex && route !== 'google-generative-ai') throw new Error('Unsupported Argon route.')
  const fallback = vertex ? (location === 'us' || location === 'eu' ? 'https://aiplatform.' + location + '.rep.googleapis.com' : 'https://aiplatform.googleapis.com') : 'https://generativelanguage.googleapis.com'
  const url = new URL(!baseURL || baseURL.includes('{location}') ? fallback : baseURL)
  if (vertex && /^[a-z0-9-]+-aiplatform[.]googleapis[.]com$/i.test(url.hostname)) throw new Error('A regional GenerateContent base URL cannot be reused for Interactions; configure the documented global or multi-region endpoint explicitly.')
  if (url.username || url.password || url.search || url.hash) throw new Error('Interactions base URL must not contain credentials, a query, or a fragment.')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Interactions requires HTTPS (except loopback test endpoints).')
  let prefix = url.pathname.replace(/\/+$/, '').replace(/\/v1(?:beta\d*)?$/, '')
  if (vertex) {
    if (!project && !apiKey) throw new Error('Vertex Interactions requires a project or an express-mode API key.')
    if (!['global', 'us', 'eu'].includes(location)) throw new Error('Vertex Interactions requires global, us, or eu; regional GenerateContent routes are not interchangeable.')
    if (/\/interactions$/.test(prefix)) { url.pathname = prefix; return url.href }
    if (project) prefix += '/v1beta1/projects/' + encodeURIComponent(project) + '/locations/' + encodeURIComponent(location)
    else prefix += '/v1beta1/locations/global'
  } else {
    if (/\/interactions$/.test(prefix)) { url.pathname = prefix; return url.href }
    prefix += '/v1beta'
  }
  url.pathname = prefix + '/interactions'
  return url.href
}

// Never retain upstream messages/stacks or arbitrary properties: they may echo credentials or input.
class TransportError extends Error {}
function diagnosticCause(error, seen = new Set()) {
  if (error == null || seen.has(error)) return undefined
  seen.add(error)
  const safe = new Error('Underlying Interactions failure.')
  if (typeof error.name === 'string') safe.name = error.name
  if (typeof error.code === 'string' || typeof error.code === 'number') safe.code = error.code
  if (error.cause !== undefined) safe.cause = diagnosticCause(error.cause, seen)
  return safe
}
function transportError(error, phase, status, message) {
  if (error instanceof TransportError && error.phase === phase && error.status === status) return error
  const cause = diagnosticCause(error)
  const wrapped = new TransportError(message ?? ('Google Interactions ' + phase + ' failed' + (status === undefined ? '' : ' (HTTP ' + status + ')') + '.'), cause ? { cause } : undefined)
  wrapped.name = cause?.name ?? 'Error'
  if (cause?.code !== undefined) wrapped.code = cause.code
  wrapped.phase = phase
  if (status !== undefined) wrapped.status = status
  if (phase === 'pre-dispatch') wrapped.requestSubmitted = false
  return wrapped
}

function protocolFailure(message, phase, status, cause) {
  return Object.assign(transportError(cause, phase, status, message), { code: 'ARGON_INTERACTIONS_PROTOCOL' })
}

async function* decodeSSE(response, status) {
  try { yield* decodeSSEEvents(response, status) }
  catch (error) { throw transportError(error, 'stream', status) }
}
async function* decodeSSEEvents(response, status) {
  if (!response.body) throw protocolFailure('Interactions stream has no response body.', 'stream', status)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = '', data = [], type, id, bytes = 0
  const event = () => {
    if (!data.length) { type = undefined; id = undefined; return undefined }
    const text = data.join('\n')
    data = []; bytes = 0
    if (text === '[DONE]') { type = undefined; id = undefined; return undefined }
    let parsed
    try { parsed = JSON.parse(text) } catch (error) { throw protocolFailure('Interactions returned invalid SSE JSON.', 'stream', status, error) }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw protocolFailure('Interactions returned an invalid SSE event.', 'stream', status)
    if (id && !parsed.event_id) parsed.event_id = id
    if (type && !parsed.event_type && !parsed.type) parsed.event_type = type
    type = undefined; id = undefined
    return parsed
  }
  const line = text => {
    if (text.endsWith('\r')) text = text.slice(0, -1)
    if (!text) return event()
    if (text.startsWith(':')) return
    const at = text.indexOf(':')
    const key = at < 0 ? text : text.slice(0, at)
    let val = at < 0 ? '' : text.slice(at + 1)
    if (val.startsWith(' ')) val = val.slice(1)
    if (key === 'data') { data.push(val); bytes += Buffer.byteLength(val); if (bytes > MAX_EVENT_BYTES) throw protocolFailure('Interactions SSE event exceeded the size limit.', 'stream', status) }
    else if (key === 'event') type = val
    else if (key === 'id' && !val.includes('\0')) id = val
  }
  try {
    for (;;) {
      const { value, done } = await reader.read()
      pending += decoder.decode(value, { stream: !done })
      let end
      while ((end = pending.indexOf('\n')) >= 0) {
        const out = line(pending.slice(0, end)); pending = pending.slice(end + 1)
        if (out) yield out
      }
      if (Buffer.byteLength(pending) > MAX_EVENT_BYTES) throw protocolFailure('Interactions SSE line exceeded the size limit.', 'stream', status)
      if (done) { if (pending) { const out = line(pending); if (out) yield out } const out = event(); if (out) yield out; break }
    }
  } finally {
    try { await reader.cancel() } catch {}
    reader.releaseLock()
  }
}

export function createInteractionsTransport({ endpoint, getHeaders, fetchImpl = globalThis.fetch, revision = INTERACTIONS_REVISION, timeoutMs = READ_TIMEOUT_MS, onResponse }) {
  const base = new URL(endpoint)
  if (revision !== null && !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(revision)) throw new Error('Invalid Interactions API revision.')
  async function request(method, url, body, stream, signal, timeout = timeoutMs, preDispatchSignal, maxResponseBytes) {
    let effective, preparing, headers, serialized, onAbort
    try {
      signal?.throwIfAborted()
      preDispatchSignal?.throwIfAborted()
      const timeoutSignal = AbortSignal.timeout(timeout)
      effective = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
      // Stop can cancel preparation, but must not abandon a dispatched create before its ID arrives.
      preparing = preDispatchSignal ? AbortSignal.any([effective, preDispatchSignal]) : effective
      const auth = Promise.resolve().then(() => { preparing.throwIfAborted(); return getHeaders() })
      const stopped = new Promise((_, reject) => {
        onAbort = () => reject(preparing.reason)
        preparing.addEventListener('abort', onAbort, { once: true })
        if (preparing.aborted) onAbort()
      })
      const authHeaders = await Promise.race([auth, stopped])
      preparing.throwIfAborted()
      headers = new Headers(authHeaders)
      // Headers normalizes casing, so SDK spelling cannot duplicate attribution.
      // The host attribution contract owns product identity, not authentication.
      for (const [name, value] of new Headers(attributionHeaders())) headers.set(name, value)
      headers.set('Content-Type', 'application/json')
      headers.set('Accept', stream ? 'text/event-stream' : 'application/json')
      if (revision === null) headers.delete('Api-Revision')
      else headers.set('Api-Revision', revision)
      preparing.throwIfAborted()
      serialized = body === undefined ? undefined : JSON.stringify(body)
      if (body !== undefined && serialized === undefined) throw new TypeError('Interactions request body is not JSON serializable.')
      preparing.throwIfAborted()
    } catch (error) {
      throw transportError(error, 'pre-dispatch')
    } finally { if (onAbort) preparing.removeEventListener('abort', onAbort) }
    let response, status
    try {
      // Once fetch is invoked, even ECONNRESET leaves submission uncertain. Never retry here.
      response = await fetchImpl(url, { method, headers, body: serialized, signal: effective, redirect: 'error' })
      status = response.status
      if (!response.ok) {
        // Provider errors can echo prompts; do not propagate their untrusted body.
        try { await response.body?.cancel() } catch {}
        const code = status === 402 ? 'PAYMENT_REQUIRED' : status === 429 ? 'RATE_LIMIT' : status >= 500 ? 'SERVER' : 'INVALID_REQUEST'
        const message = status === 402
          ? 'Google Interactions request rejected for billing (HTTP 402 Payment Required). Check your Google prepaid credit balance and add credits if depleted. Do not retry automatically; requests cannot succeed until credits are added.'
          : 'Google Interactions request failed (HTTP ' + status + ').'
        throw transportError({ name: 'ApiError', code }, 'fetch', status, message)
      }
      if (stream && !response.headers.get('content-type')?.includes('text/event-stream')) {
        try { await response.body?.cancel() } catch {}
        throw protocolFailure('Interactions stream returned a non-SSE content type.', 'fetch', status)
      }
    } catch (error) { throw transportError(error, 'fetch', status) }
    if (typeof onResponse === 'function') {
      try {
        const tier = response.headers?.get?.('x-gemini-service-tier')
        if (['standard', 'flex', 'priority'].includes(tier)) onResponse({ operation: method === 'GET' ? 'get' : method === 'DELETE' ? 'delete' : url.href === base.href ? 'create' : 'cancel', serviceTier: tier })
      } catch (_error) { /* Optional diagnostic observation cannot change request execution. */ }
    }
    if (stream) return decodeSSE(response, status)
    try { return status === 204 ? undefined : maxResponseBytes === undefined ? await response.json() : await readBoundedJson(response, maxResponseBytes, effective) }
    catch (error) { throw transportError(error, 'response-body', status) }
  }
  const resource = id => {
    if (typeof id !== 'string' || !id || id.length > 4096 || id === '.' || id === '..') throw new Error('Invalid interaction ID.')
    return new URL(base.href.replace(/\/+$/, '') + '/' + encodeURIComponent(id))
  }
  return {
    async create(body, { signal, preDispatchSignal } = {}) {
      let stream, timeout
      try {
        signal?.throwIfAborted()
        preDispatchSignal?.throwIfAborted()
        stream = body.stream === true
        timeout = body.background && !stream ? 60000 : timeoutMs
      } catch (error) { throw transportError(error, 'pre-dispatch') }
      return request('POST', base, body, stream, signal, timeout, preDispatchSignal)
    },
    get(id, { stream = false, last_event_id, signal, maxResponseBytes } = {}) {
      const url = resource(id)
      if (stream) url.searchParams.set('stream', 'true')
      if (last_event_id) url.searchParams.set('last_event_id', last_event_id)
      return request('GET', url, undefined, stream, signal, timeoutMs, undefined, maxResponseBytes)
    },
    cancel(id, { signal } = {}) { return request('POST', new URL(resource(id).href + '/cancel'), {}, false, signal, 30000) },
    delete(id, { signal } = {}) { return request('DELETE', resource(id), undefined, false, signal, 30000) },
  }
}
