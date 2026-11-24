import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { readBoundedJson, abortable } from './bounded-json.js'
import { normalizeUpstreamErrorCode } from './diagnostics.js'

export const GEMINI_FILES_MAX_BYTES = 2 * 1024 * 1024 * 1024
export const GEMINI_FILES_CHUNK_BYTES = 8 * 1024 * 1024

const DEFAULT_FILES_ENDPOINT = 'https://generativelanguage.googleapis.com'
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const FILE_NAME_RE = /^files\/[A-Za-z0-9_-]+$/
const FILE_URI_RE = /^https?:\/\//
const MAX_JSON_BYTES = 65536
const ERROR_BODY_TIMEOUT_MS = 10_000
const RESERVED_VERTEX_ENV_KEYS = new Set([
  'GOOGLE_CLOUD_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GCLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
])

export function geminiApiPrincipalHash(apiKey) {
  if (typeof apiKey !== 'string' || !apiKey) return undefined
  return createHash('sha256')
    .update(JSON.stringify(['google-generative-ai', apiKey, undefined, 'global']))
    .digest('hex')
}

export function filesBaseEndpoint({ baseURL } = {}) {
  if (baseURL !== undefined && baseURL !== null && typeof baseURL !== 'string') {
    throw new Error('Gemini Files API base URL must be a string.')
  }
  const raw = typeof baseURL === 'string' && baseURL.trim() ? baseURL.trim() : DEFAULT_FILES_ENDPOINT
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Invalid Gemini Files API base URL.')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Gemini Files API base URL must not contain credentials, a query, or a fragment.')
  }
  const isLoopback = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)
  if (url.protocol !== 'https:' && !isLoopback) {
    throw new Error('Gemini Files API requires HTTPS (except loopback test endpoints).')
  }
  let pathname = url.pathname.replace(/\/+$/, '')
  let prev
  do {
    prev = pathname
    pathname = pathname
      .replace(/\/(?:interactions|files)$/i, '')
      .replace(/\/+$/, '')
      .replace(/\/v1(?:beta1|beta)?$/i, '')
      .replace(/\/+$/, '')
  } while (pathname !== prev)
  return `${url.origin}${pathname}`
}

class FilesTransportError extends Error {}

function createAbortError() {
  const err = new FilesTransportError('Gemini Files API operation was aborted.')
  err.name = 'AbortError'
  err.code = 'ABORT_ERR'
  return err
}

function sanitizedError(message, code, extra = {}) {
  const err = new FilesTransportError(message)
  if (code) err.code = code
  if (extra.status !== undefined) err.status = extra.status
  if (extra.upstreamCode !== undefined) err.upstreamCode = extra.upstreamCode
  if (extra.upstreamCodes !== undefined) err.upstreamCodes = extra.upstreamCodes
  return err
}

function assertConsent(shouldContinue) {
  if (typeof shouldContinue === 'function' && shouldContinue() === false) {
    throw sanitizedError('Gemini Files API upload halted because consent was revoked.', 'ARGON_FILE_SLICING_DISABLED')
  }
}

function createRequestSignal(signal, timeoutMs) {
  if (signal?.aborted) throw createAbortError()
  if (timeoutMs !== undefined && timeoutMs !== null) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  }
  return signal ?? new AbortController().signal
}

async function resolveAuthHeaders(getHeaders, signal, reqSignal, operation) {
  if (typeof getHeaders !== 'function') {
    throw sanitizedError('Gemini Files API requires a getHeaders callback.', 'INVALID_REQUEST')
  }
  if (signal?.aborted) throw createAbortError()
  if (reqSignal?.aborted) throw sanitizedError(`Gemini Files API ${operation} timed out.`, 'ETIMEDOUT')
  let raw
  try {
    raw = reqSignal
      ? await abortable(Promise.resolve().then(() => getHeaders()), reqSignal)
      : await Promise.resolve().then(() => getHeaders())
  } catch (error) {
    throw wrapFetchError(error, operation, signal, reqSignal)
  }
  if (signal?.aborted) throw createAbortError()
  if (reqSignal?.aborted) throw sanitizedError(`Gemini Files API ${operation} timed out.`, 'ETIMEDOUT')
  return new Headers(raw)
}

function isJsonContentType(headers) {
  const type = headers?.get?.('content-type')?.split(';')[0].trim().toLowerCase()
  return Boolean(type && (type === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/.test(type)))
}

function extractSafeErrorEnvelope(parsed) {
  const root = Array.isArray(parsed) && parsed.length === 1 && parsed[0] && typeof parsed[0] === 'object' ? parsed[0] : parsed
  if (!root || typeof root !== 'object' || Array.isArray(root)) return undefined
  return root.error && typeof root.error === 'object' && !Array.isArray(root.error) ? root.error : root
}

async function cancelBodyQuietly(response) {
  try {
    await response?.body?.cancel?.()
  } catch {}
}

async function buildSanitizedHttpError(response, operation, signal) {
  const status = response.status
  let parsed
  if (isJsonContentType(response.headers)) {
    const errTimeout = AbortSignal.timeout(ERROR_BODY_TIMEOUT_MS)
    const errSignal = signal ? AbortSignal.any([signal, errTimeout]) : errTimeout
    try {
      parsed = await readBoundedJson(response, MAX_JSON_BYTES, errSignal)
    } catch {
      await cancelBodyQuietly(response)
    }
  } else {
    await cancelBodyQuietly(response)
  }
  const errorObj = extractSafeErrorEnvelope(parsed)
  const statusCode = normalizeUpstreamErrorCode(errorObj?.status)
  const bodyCode = normalizeUpstreamErrorCode(errorObj?.code)
  const upstreamCodes = []
  if (statusCode) upstreamCodes.push(statusCode)
  if (bodyCode && !upstreamCodes.includes(bodyCode)) upstreamCodes.push(bodyCode)
  const primaryUpstreamCode = upstreamCodes[0]
  const fallbackCode = status === 401 || status === 403
    ? 'AUTHENTICATION'
    : status === 402
      ? 'PAYMENT_REQUIRED'
      : status === 404
        ? 'NOT_FOUND'
        : status === 429
          ? 'RATE_LIMIT'
          : status >= 500
            ? 'SERVER'
            : 'INVALID_REQUEST'
  const message = `Gemini Files API ${operation} failed (HTTP ${status}${primaryUpstreamCode ? ' ' + primaryUpstreamCode : ''}).`
  return sanitizedError(message, fallbackCode, {
    status,
    ...(primaryUpstreamCode ? { upstreamCode: primaryUpstreamCode } : {}),
    ...(upstreamCodes.length ? { upstreamCodes } : {}),
  })
}

function validateFileName(name) {
  if (typeof name !== 'string' || !FILE_NAME_RE.test(name)) {
    throw sanitizedError('Invalid Gemini file resource name.', 'INVALID_REQUEST')
  }
  return name
}

function normalizeFileRecord(raw, fallbackMimeType, fallbackSizeBytes, { expectedName, endpointBase } = {}) {
  const payload = raw && typeof raw === 'object' && !Array.isArray(raw) && raw.file && typeof raw.file === 'object' && !Array.isArray(raw.file)
    ? raw.file
    : raw
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw sanitizedError('Gemini Files API returned an invalid file metadata response.', 'GEMINI_FILE_PROTOCOL')
  }
  if (typeof payload.name !== 'string' || !FILE_NAME_RE.test(payload.name)) {
    throw sanitizedError('Gemini Files API returned an invalid file name.', 'GEMINI_FILE_PROTOCOL')
  }
  if (expectedName !== undefined && payload.name !== expectedName) {
    throw sanitizedError('Gemini Files API returned a mismatched file resource name.', 'GEMINI_FILE_PROTOCOL')
  }
  if (typeof payload.uri !== 'string' || !FILE_URI_RE.test(payload.uri)) {
    throw sanitizedError('Gemini Files API returned an invalid file URI.', 'GEMINI_FILE_PROTOCOL')
  }
  let parsedUri
  try {
    parsedUri = new URL(payload.uri)
  } catch {
    throw sanitizedError('Gemini Files API returned a malformed file URI.', 'GEMINI_FILE_PROTOCOL')
  }
  if (parsedUri.username || parsedUri.password) {
    throw sanitizedError('Gemini Files API returned a file URI with embedded credentials.', 'GEMINI_FILE_PROTOCOL')
  }
  const normalizedUriPath = parsedUri.pathname.replace(/\/+$/, '')
  if (!normalizedUriPath.endsWith(`/${payload.name}`)) {
    throw sanitizedError('Gemini Files API returned a file URI that does not match its resource name.', 'GEMINI_FILE_PROTOCOL')
  }
  if (endpointBase) {
    const baseOrigin = new URL(filesBaseEndpoint({ baseURL: endpointBase })).origin
    if (parsedUri.origin !== baseOrigin) {
      throw sanitizedError('Gemini Files API returned a file URI with an untrusted origin.', 'GEMINI_FILE_PROTOCOL')
    }
  }
  if (payload.state !== undefined && typeof payload.state !== 'string') {
    throw sanitizedError('Gemini Files API returned an invalid file state.', 'GEMINI_FILE_PROTOCOL')
  }
  const state = typeof payload.state === 'string' && payload.state.length > 0
    ? payload.state
    : 'STATE_UNSPECIFIED'
  const size = payload.sizeBytes !== undefined ? Number(payload.sizeBytes) : Number(fallbackSizeBytes)
  return {
    name: payload.name,
    uri: payload.uri,
    mimeType: (typeof payload.mimeType === 'string' && payload.mimeType) || fallbackMimeType,
    sizeBytes: Number.isFinite(size) ? size : Number(fallbackSizeBytes ?? 0),
    state,
    expirationTime: payload.expirationTime,
    createTime: payload.createTime,
  }
}

function validateResumableUploadUrl(rawUrl, baseUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw sanitizedError('Gemini Files API did not return a resumable upload URL.', 'GEMINI_FILE_PROTOCOL')
  }
  let uploadUrl
  try {
    uploadUrl = new URL(rawUrl.trim())
  } catch {
    throw sanitizedError('Gemini Files API returned a malformed resumable upload URL.', 'GEMINI_FILE_PROTOCOL')
  }
  if (uploadUrl.username || uploadUrl.password || uploadUrl.hash) {
    throw sanitizedError('Gemini Files API resumable upload URL contains disallowed credentials or fragment.', 'GEMINI_FILE_PROTOCOL')
  }
  const isLoopback = uploadUrl.protocol === 'http:' && LOOPBACK_HOSTS.has(uploadUrl.hostname)
  if (uploadUrl.protocol !== 'https:' && !isLoopback) {
    throw sanitizedError('Gemini Files API resumable upload URL requires HTTPS (except loopback).', 'GEMINI_FILE_PROTOCOL')
  }
  if (uploadUrl.origin !== baseUrl.origin) {
    throw sanitizedError('Gemini Files API resumable upload URL origin does not match configured endpoint.', 'GEMINI_FILE_PROTOCOL')
  }
  return uploadUrl
}

function wrapFetchError(error, operation, signal, reqSignal) {
  if (error instanceof FilesTransportError) return error
  if (signal?.aborted) {
    if (signal.reason?.code === 'ARGON_FILE_SLICING_DISABLED') {
      return sanitizedError('Gemini Files API upload halted because consent was revoked.', 'ARGON_FILE_SLICING_DISABLED')
    }
    return createAbortError()
  }
  if (reqSignal?.aborted || error?.name === 'TimeoutError' || reqSignal?.reason?.name === 'TimeoutError') {
    return sanitizedError(`Gemini Files API ${operation} timed out.`, 'ETIMEDOUT')
  }
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
    return createAbortError()
  }
  const safeCode = typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code)
    ? error.code
    : 'FETCH_FAILED'
  return sanitizedError(`Gemini Files API ${operation} transport failed.`, safeCode)
}

async function readExactChunk(fh, length, position) {
  const buf = Buffer.allocUnsafe(length)
  let total = 0
  while (total < length) {
    const { bytesRead } = await fh.read(buf, total, length - total, position + total)
    if (bytesRead <= 0) {
      throw sanitizedError('Local file truncated while uploading to Gemini Files API.', 'GEMINI_FILE_READ_FAILED')
    }
    total += bytesRead
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, total)
}

export async function uploadGeminiFile({
  filePath,
  fileHandle,
  expectedSha256,
  shouldContinue,
  mimeType,
  displayName,
  sizeBytes,
  endpointBase,
  getHeaders,
  fetchImpl = globalThis.fetch,
  signal,
  chunkBytes = GEMINI_FILES_CHUNK_BYTES,
  timeoutMs = 120_000,
}) {
  const hasHandle = Boolean(fileHandle && typeof fileHandle.read === 'function' && typeof fileHandle.stat === 'function')
  if (!hasHandle && (typeof filePath !== 'string' || !filePath || filePath.includes('\0'))) {
    throw sanitizedError('A valid local file path or file handle is required for Gemini Files upload.', 'INVALID_REQUEST')
  }
  if (typeof mimeType !== 'string' || !mimeType.trim()) {
    throw sanitizedError('A valid MIME type is required for Gemini Files upload.', 'INVALID_REQUEST')
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > GEMINI_FILES_MAX_BYTES) {
    throw sanitizedError('File size must be between 1 byte and 2 GiB.', 'INVALID_REQUEST')
  }
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes > GEMINI_FILES_CHUNK_BYTES) {
    throw sanitizedError('Resumable upload chunk size must be between 1 byte and 8 MiB.', 'INVALID_REQUEST')
  }
  if (typeof fetchImpl !== 'function') {
    throw sanitizedError('Gemini Files API transport requires a fetch implementation.', 'INVALID_REQUEST')
  }
  const base = filesBaseEndpoint({ baseURL: endpointBase })
  const baseUrl = new URL(base)

  assertConsent(shouldContinue)

  // Step 1: Start resumable upload session.
  const startUrl = `${base}/upload/v1beta/files`
  let uploadUrl
  {
    const reqSignal = createRequestSignal(signal, timeoutMs)
    const headers = await resolveAuthHeaders(getHeaders, signal, reqSignal, 'upload-start')
    assertConsent(shouldContinue)
    headers.set('X-Goog-Upload-Protocol', 'resumable')
    headers.set('X-Goog-Upload-Command', 'start')
    headers.set('X-Goog-Upload-Header-Content-Length', String(sizeBytes))
    headers.set('X-Goog-Upload-Header-Content-Type', mimeType)
    headers.set('Content-Type', 'application/json')
    const startBody = JSON.stringify({
      file: displayName ? { display_name: String(displayName) } : {},
    })
    let startRes
    try {
      startRes = await fetchImpl(startUrl, {
        method: 'POST',
        headers,
        body: startBody,
        signal: reqSignal,
        redirect: 'error',
      })
    } catch (error) {
      throw wrapFetchError(error, 'upload-start', signal, reqSignal)
    }
    if (!startRes.ok) {
      throw await buildSanitizedHttpError(startRes, 'upload-start', reqSignal)
    }
    const rawUploadUrl = startRes.headers?.get?.('x-goog-upload-url')
    await cancelBodyQuietly(startRes)
    uploadUrl = validateResumableUploadUrl(rawUploadUrl, baseUrl)
  }

  // Step 2: Stream file in bounded chunks <= chunkBytes from a single handle with SHA-256 & EOF verification.
  const fh = hasHandle ? fileHandle : await open(filePath, 'r')
  const ownedHandle = !hasHandle
  try {
    const st = await fh.stat()
    if (!st.isFile() || st.size !== sizeBytes) {
      throw sanitizedError('Local file changed before upload could complete.', 'GEMINI_FILE_READ_FAILED')
    }
    const hasher = createHash('sha256')
    let offset = 0
    while (offset < sizeBytes) {
      assertConsent(shouldContinue)
      const reqSignal = createRequestSignal(signal, timeoutMs)
      const chunkLen = Math.min(chunkBytes, sizeBytes - offset)
      const isLast = offset + chunkLen >= sizeBytes
      const chunkData = await readExactChunk(fh, chunkLen, offset)
      hasher.update(chunkData)

      if (isLast) {
        const probe = Buffer.allocUnsafe(1)
        const { bytesRead: extraBytes } = await fh.read(probe, 0, 1, sizeBytes)
        if (extraBytes > 0) {
          throw sanitizedError('Local file grew while uploading to Gemini Files API.', 'GEMINI_FILE_READ_FAILED')
        }
        if (typeof expectedSha256 === 'string' && expectedSha256) {
          const actualDigest = hasher.digest('hex')
          if (actualDigest !== expectedSha256) {
            throw sanitizedError('Local file content changed before upload finalization.', 'GEMINI_FILE_READ_FAILED')
          }
        }
      }

      if (signal?.aborted) {
        if (signal.reason?.code === 'ARGON_FILE_SLICING_DISABLED') {
          throw sanitizedError('Gemini Files API upload halted because consent was revoked.', 'ARGON_FILE_SLICING_DISABLED')
        }
        throw createAbortError()
      }
      if (reqSignal.aborted) {
        throw sanitizedError('Gemini Files API upload-chunk timed out.', 'ETIMEDOUT')
      }

      // uploadUrl.origin === baseUrl.origin is verified above, so auth headers stay on the same origin.
      const headers = await resolveAuthHeaders(getHeaders, signal, reqSignal, 'upload-chunk')
      assertConsent(shouldContinue)
      headers.set('X-Goog-Upload-Offset', String(offset))
      headers.set('X-Goog-Upload-Command', isLast ? 'upload, finalize' : 'upload')
      headers.set('Content-Length', String(chunkLen))
      headers.set('Content-Type', mimeType)
      let chunkRes
      try {
        chunkRes = await fetchImpl(uploadUrl.href, {
          method: 'POST',
          headers,
          body: chunkData,
          signal: reqSignal,
          redirect: 'error',
        })
      } catch (error) {
        throw wrapFetchError(error, 'upload-chunk', signal, reqSignal)
      }
      if (!chunkRes.ok) {
        throw await buildSanitizedHttpError(chunkRes, 'upload-chunk', reqSignal)
      }
      if (!isLast) {
        const uploadStatus = chunkRes.headers?.get?.('x-goog-upload-status')?.trim().toLowerCase()
        await cancelBodyQuietly(chunkRes)
        if (uploadStatus && uploadStatus !== 'active') {
          throw sanitizedError('Gemini Files API interrupted resumable upload before completion.', 'GEMINI_FILE_PROTOCOL')
        }
        offset += chunkLen
      } else {
        let parsed
        try {
          parsed = await readBoundedJson(chunkRes, MAX_JSON_BYTES, reqSignal)
        } catch (error) {
          throw wrapFetchError(error, 'upload-finalize', signal, reqSignal)
        }
        return normalizeFileRecord(parsed, mimeType, sizeBytes, { endpointBase: base })
      }
    }
    throw sanitizedError('Gemini Files API upload finalized without a response.', 'GEMINI_FILE_PROTOCOL')
  } finally {
    if (ownedHandle) await fh.close()
  }
}

export async function getGeminiFile({
  name,
  endpointBase,
  getHeaders,
  fetchImpl = globalThis.fetch,
  signal,
  timeoutMs = 30_000,
}) {
  const validName = validateFileName(name)
  if (typeof fetchImpl !== 'function') {
    throw sanitizedError('Gemini Files API transport requires a fetch implementation.', 'INVALID_REQUEST')
  }
  const base = filesBaseEndpoint({ baseURL: endpointBase })
  const reqSignal = createRequestSignal(signal, timeoutMs)
  const headers = await resolveAuthHeaders(getHeaders, signal, reqSignal, 'get')
  headers.set('Accept', 'application/json')
  let res
  try {
    res = await fetchImpl(`${base}/v1beta/${validName}`, {
      method: 'GET',
      headers,
      signal: reqSignal,
      redirect: 'error',
    })
  } catch (error) {
    throw wrapFetchError(error, 'get', signal, reqSignal)
  }
  if (!res.ok) {
    throw await buildSanitizedHttpError(res, 'get', reqSignal)
  }
  let parsed
  try {
    parsed = await readBoundedJson(res, MAX_JSON_BYTES, reqSignal)
  } catch (error) {
    throw wrapFetchError(error, 'get', signal, reqSignal)
  }
  return normalizeFileRecord(parsed, undefined, undefined, { expectedName: validName, endpointBase: base })
}

function defaultAbortableSleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(createAbortError())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(createAbortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function runAbortableSleep(ms, signal, sleepImpl) {
  if (signal?.aborted) throw createAbortError()
  if (typeof sleepImpl === 'function') {
    const p = Promise.resolve().then(() => sleepImpl(ms, signal))
    return signal ? abortable(p, signal) : p
  }
  return defaultAbortableSleep(ms, signal)
}

export async function waitForGeminiFileActive({
  file,
  endpointBase,
  getHeaders,
  fetchImpl = globalThis.fetch,
  signal,
  pollIntervalMs = 1500,
  maxWaitMs = 120_000,
  sleepImpl,
}) {
  if (signal?.aborted) {
    if (signal.reason?.code === 'ARGON_FILE_SLICING_DISABLED') {
      throw sanitizedError('Gemini Files API upload halted because consent was revoked.', 'ARGON_FILE_SLICING_DISABLED')
    }
    throw createAbortError()
  }
  if (!file || typeof file !== 'object') {
    throw sanitizedError('A valid Gemini file object is required.', 'INVALID_REQUEST')
  }
  // Only short-circuit when explicitly ACTIVE; missing or STATE_UNSPECIFIED must be confirmed via GET.
  if (file.state === 'ACTIVE') return file
  if (file.state === 'FAILED') {
    throw sanitizedError('Gemini Files API file processing failed.', 'GEMINI_FILE_PROCESSING_FAILED')
  }
  if (file.state !== undefined && file.state !== '' && file.state !== 'PROCESSING' && file.state !== 'STATE_UNSPECIFIED') {
    throw sanitizedError('Gemini Files API file entered an unexpected terminal state.', 'GEMINI_FILE_PROCESSING_FAILED')
  }
  validateFileName(file.name)

  const startedAt = Date.now()
  let virtualElapsedMs = 0
  let current = file
  const interval = Number.isFinite(pollIntervalMs) && pollIntervalMs > 0 ? pollIntervalMs : 1500
  const maxWait = Number.isFinite(maxWaitMs) && maxWaitMs >= 0 ? maxWaitMs : 120_000

  while (!current.state || current.state === 'PROCESSING' || current.state === 'STATE_UNSPECIFIED') {
    if (signal?.aborted) {
      if (signal.reason?.code === 'ARGON_FILE_SLICING_DISABLED') {
        throw sanitizedError('Gemini Files API upload halted because consent was revoked.', 'ARGON_FILE_SLICING_DISABLED')
      }
      throw createAbortError()
    }
    const elapsed = Math.max(Date.now() - startedAt, virtualElapsedMs)
    const remaining = maxWait - elapsed
    if (remaining <= 0) {
      throw sanitizedError('Timed out waiting for Gemini Files API file processing.', 'GEMINI_FILE_PROCESSING_TIMEOUT')
    }
    const waitMs = Math.min(interval, remaining)
    try {
      await runAbortableSleep(waitMs, signal, sleepImpl)
    } catch (error) {
      throw wrapFetchError(error, 'wait', signal)
    }
    virtualElapsedMs += waitMs
    if (signal?.aborted) {
      if (signal.reason?.code === 'ARGON_FILE_SLICING_DISABLED') {
        throw sanitizedError('Gemini Files API upload halted because consent was revoked.', 'ARGON_FILE_SLICING_DISABLED')
      }
      throw createAbortError()
    }
    const remainingAfterSleep = maxWait - Math.max(Date.now() - startedAt, virtualElapsedMs)
    if (remainingAfterSleep <= 0) {
      throw sanitizedError('Timed out waiting for Gemini Files API file processing.', 'GEMINI_FILE_PROCESSING_TIMEOUT')
    }
    current = await getGeminiFile({
      name: current.name,
      endpointBase,
      getHeaders,
      fetchImpl,
      signal,
      timeoutMs: Math.min(30_000, remainingAfterSleep),
    })
    if (current.state === 'ACTIVE') return current
    if (current.state === 'FAILED') {
      throw sanitizedError('Gemini Files API file processing failed.', 'GEMINI_FILE_PROCESSING_FAILED')
    }
    if (current.state !== 'PROCESSING' && current.state !== 'STATE_UNSPECIFIED') {
      throw sanitizedError('Gemini Files API file entered an unexpected terminal state.', 'GEMINI_FILE_PROCESSING_FAILED')
    }
  }
  return current
}

export async function deleteGeminiFile({
  name,
  endpointBase,
  getHeaders,
  fetchImpl = globalThis.fetch,
  signal,
  timeoutMs = 30_000,
}) {
  const validName = validateFileName(name)
  if (typeof fetchImpl !== 'function') {
    throw sanitizedError('Gemini Files API transport requires a fetch implementation.', 'INVALID_REQUEST')
  }
  const base = filesBaseEndpoint({ baseURL: endpointBase })
  const reqSignal = createRequestSignal(signal, timeoutMs)
  const headers = await resolveAuthHeaders(getHeaders, signal, reqSignal, 'delete')
  let res
  try {
    res = await fetchImpl(`${base}/v1beta/${validName}`, {
      method: 'DELETE',
      headers,
      signal: reqSignal,
      redirect: 'error',
    })
  } catch (error) {
    throw wrapFetchError(error, 'delete', signal, reqSignal)
  }
  if (res.ok || res.status === 404) {
    await cancelBodyQuietly(res)
    return true
  }
  throw await buildSanitizedHttpError(res, 'delete', reqSignal)
}

export async function createGeminiFilesClient({
  GoogleGenAI: _GoogleGenAI,
  resolveSecret,
  apiKey,
  apiKeyEnv = 'GOOGLE_API_KEY',
  baseURL,
  fetchImpl,
} = {}) {
  // Strictly Gemini Developer API ONLY: reject Vertex/ADC env var names and never read them.
  let resolvedApiKey
  if (apiKey !== undefined) {
    resolvedApiKey = typeof apiKey === 'string' ? apiKey.trim() : ''
  } else {
    const configuredEnv = typeof apiKeyEnv === 'string' ? apiKeyEnv.trim() : ''
    if (configuredEnv && RESERVED_VERTEX_ENV_KEYS.has(configuredEnv.toUpperCase())) {
      throw sanitizedError('Vertex AI / ADC environment variables cannot be used for the Gemini Files API.', 'INVALID_REQUEST')
    }
    if (typeof resolveSecret === 'function') {
      const candidates = []
      if (configuredEnv) candidates.push(configuredEnv)
      if (!candidates.includes('GOOGLE_API_KEY')) candidates.push('GOOGLE_API_KEY')
      if (!candidates.includes('GEMINI_API_KEY')) candidates.push('GEMINI_API_KEY')
      for (const envName of candidates) {
        const value = await resolveSecret(envName)
        if (typeof value === 'string' && value.trim()) {
          resolvedApiKey = value.trim()
          break
        }
      }
    }
  }
  if (!resolvedApiKey) {
    throw sanitizedError('Gemini API credentials are not configured.', 'MISSING_CREDENTIAL')
  }
  const endpointBase = filesBaseEndpoint({ baseURL })
  const getHeaders = async () => ({ 'x-goog-api-key': resolvedApiKey })
  const principalHash = geminiApiPrincipalHash(resolvedApiKey)
  return {
    endpointBase,
    getHeaders,
    principalHash,
    uploadFile: opts => uploadGeminiFile({
      ...opts,
      endpointBase,
      getHeaders,
      ...(fetchImpl && !opts?.fetchImpl ? { fetchImpl } : {}),
    }),
    getFile: opts => getGeminiFile({
      ...opts,
      endpointBase,
      getHeaders,
      ...(fetchImpl && !opts?.fetchImpl ? { fetchImpl } : {}),
    }),
    waitForActive: opts => waitForGeminiFileActive({
      ...opts,
      endpointBase,
      getHeaders,
      ...(fetchImpl && !opts?.fetchImpl ? { fetchImpl } : {}),
    }),
    deleteFile: opts => deleteGeminiFile({
      ...opts,
      endpointBase,
      getHeaders,
      ...(fetchImpl && !opts?.fetchImpl ? { fetchImpl } : {}),
    }),
  }
}
