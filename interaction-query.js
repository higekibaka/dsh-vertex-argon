import {createGoogleConnection} from './google-connection.js'
import {abortable} from './bounded-json.js'

export const INTERACTION_QUERY_LIMITS = Object.freeze({timeoutMs:30000, maxResponseBytes:8*1024*1024, maxActive:4})
const messages = {
  ARGON_QUERY_INVALID: 'Select a supported route and provide only an opaque Interaction ID.',
  ARGON_QUERY_CANCELLED: 'Interaction lookup stopped locally; no remote cancellation was requested.',
  ARGON_QUERY_TIMEOUT: 'Interaction lookup exceeded its deadline; remote task status is unverified.',
  ARGON_QUERY_TOO_LARGE: 'Interaction response exceeded the query size limit.',
  ARGON_QUERY_RESPONSE: 'Interaction lookup returned an invalid JSON object.',
  ARGON_QUERY_ID_MISMATCH: 'Interaction response ID did not match the requested ID.',
  ARGON_QUERY_UNAVAILABLE: 'Interaction lookup failed with the selected route and credentials.',
  ARGON_QUERY_BUSY: 'Too many Interaction lookups are active; try after an existing lookup finishes.',
}
function fail(code, status) {
  return Object.assign(new Error(messages[code]), {code}, Number.isInteger(status) && status >= 100 && status <= 599 ? {status} : {})
}
export function interactionQueryErrorResult(error, signal) {
  const code = signal?.aborted ? 'ARGON_QUERY_CANCELLED' : Object.hasOwn(messages,error?.code) ? error.code : 'ARGON_QUERY_UNAVAILABLE'
  return {ok:false,code,error:messages[code],...(Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? {status:error.status} : {})}
}
export function parseInteractionQuery(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => k !== 'route' && k !== 'id') ||
    !['google-generative-ai','google-vertex'].includes(value.route) || typeof value.id !== 'string' ||
    !/^[A-Za-z0-9._~+=-]{1,4096}$/.test(value.id) || value.id === '.' || value.id === '..') throw fail('ARGON_QUERY_INVALID')
  return {route:value.route,id:value.id}
}

// Separate from durable generation/recovery: no POST, tools, history import, retry,
// or automatic account/endpoint fallback. Caller authorization stays in the Host RPC.
export function createInteractionQuery({GoogleGenAI,resolveSecret,getRoutes,fetchImpl,
  timeoutMs=INTERACTION_QUERY_LIMITS.timeoutMs,maxResponseBytes=INTERACTION_QUERY_LIMITS.maxResponseBytes}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > INTERACTION_QUERY_LIMITS.maxResponseBytes) throw fail('ARGON_QUERY_INVALID')
  const lifetime = new AbortController()
  let active = 0
  const query = async (request, callerSignal) => {
    const {route,id} = parseInteractionQuery(request)
    if (active >= INTERACTION_QUERY_LIMITS.maxActive) throw fail('ARGON_QUERY_BUSY')
    const deadline = new AbortController()
    const signal = AbortSignal.any([lifetime.signal,deadline.signal,...(callerSignal?[callerSignal]:[])])
    const timer = setTimeout(() => deadline.abort(), timeoutMs)
    active++
    try {
      signal.throwIfAborted()
      const routes = {...getRoutes()}
      const connection = await abortable(createGoogleConnection(GoogleGenAI, {
        route, apiKeyEnv:routes.googleApiKeyEnv,
        baseURL:route === 'google-vertex' ? routes.vertexBaseUrl : routes.googleBaseUrl,
        resolveSecret:async name => {
          signal.throwIfAborted()
          const value = await abortable(Promise.resolve().then(() => {signal.throwIfAborted();return resolveSecret(name)}), signal)
          signal.throwIfAborted()
          return value
        }, ...(fetchImpl?{fetchImpl}:{})
      }), signal)
      signal.throwIfAborted()
      const interaction = await abortable(connection.transport.get(id, {stream:false,signal,maxResponseBytes}), signal)
      signal.throwIfAborted()
      if (!interaction || typeof interaction !== 'object' || Array.isArray(interaction)) throw fail('ARGON_QUERY_RESPONSE')
      if (interaction.id !== id) throw fail('ARGON_QUERY_ID_MISMATCH')
      return {identity:{route,credentialBinding:'current-configuration'}, interaction}
    } catch (error) {
      const code = callerSignal?.aborted || lifetime.signal.aborted ? 'ARGON_QUERY_CANCELLED' : deadline.signal.aborted ? 'ARGON_QUERY_TIMEOUT' : Object.hasOwn(messages,error?.code) ? error.code : 'ARGON_QUERY_UNAVAILABLE'
      throw fail(code,error?.status)
    } finally { active--;clearTimeout(timer) }
  }
  query.close = () => lifetime.abort()
  return query
}
