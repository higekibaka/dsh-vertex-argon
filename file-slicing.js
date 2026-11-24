import { randomBytes } from 'node:crypto'
import { extname } from 'node:path'

export const SLICE_TOOL_NAME = 'argon_slice_file'

const DEFAULT_ENDPOINT_BASE = 'https://generativelanguage.googleapis.com'

export const EXTENSION_TO_MIME = Object.freeze({
  // document
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.dotx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  // spreadsheet
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  // video
  '.mp4': 'video/mp4',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.mov': 'video/mov',
  '.avi': 'video/avi',
  '.flv': 'video/x-flv',
  '.webm': 'video/webm',
  '.wmv': 'video/wmv',
  '.3gp': 'video/3gpp',
  // audio
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.aiff': 'audio/aiff',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
})

export const SUPPORTED_SLICE_MIME_TYPES = Object.freeze({
  // document
  'application/pdf': 'document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
  'application/msword': 'document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template': 'document',
  'application/vnd.oasis.opendocument.text': 'document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'document',
  'application/vnd.ms-powerpoint': 'document',
  'application/vnd.oasis.opendocument.presentation': 'document',
  // spreadsheet
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'spreadsheet',
  'application/vnd.ms-excel': 'spreadsheet',
  'application/vnd.oasis.opendocument.spreadsheet': 'spreadsheet',
  // video
  'video/mp4': 'video',
  'video/mpeg': 'video',
  'video/mov': 'video',
  'video/avi': 'video',
  'video/x-flv': 'video',
  'video/webm': 'video',
  'video/wmv': 'video',
  'video/3gpp': 'video',
  // audio
  'audio/wav': 'audio',
  'audio/mpeg': 'audio',
  'audio/mp3': 'audio',
  'audio/aiff': 'audio',
  'audio/aac': 'audio',
  'audio/ogg': 'audio',
  'audio/flac': 'audio',
  'audio/mp4': 'audio',
})

const VALID_RESOLUTIONS = new Set(['low', 'medium', 'high', 'ultra_high'])
const VISIBLE_CELLS_RE = /^[A-Z]{1,3}[1-9]\d{0,6}(?::[A-Z]{1,3}[1-9]\d{0,6})?$/i
const OFFSET_STRING_RE = /^\d+(?:\.\d+)?s$/

const CATEGORY_ALLOWED_KEYS = Object.freeze({
  document: new Set(['startPage', 'endPage', 'contentLayers', 'resolution']),
  spreadsheet: new Set(['sheetIndex', 'visibleCells', 'contentLayers', 'resolution']),
  video: new Set(['startOffset', 'endOffset', 'fps', 'contentLayers', 'resolution']),
  audio: new Set(['startOffset', 'endOffset']),
})

const CATEGORY_CONTENT_LAYERS = Object.freeze({
  document: new Set(['page_text', 'page_image']),
  spreadsheet: new Set(['data', 'formulas', 'visual']),
  video: new Set(['frames', 'audio', 'transcript']),
})

function sliceError(message, code = 'INVALID_SLICE_SPEC') {
  return Object.assign(new Error(message), { code })
}

function abortError(message = 'File slice upload aborted.') {
  return Object.assign(new Error(message), { name: 'AbortError', code: 'ABORT_ERR' })
}

export function inferSliceMimeType(filePath, explicitMimeType) {
  if (explicitMimeType !== undefined && explicitMimeType !== null && explicitMimeType !== '') {
    if (typeof explicitMimeType !== 'string') {
      throw sliceError('MIME type must be a string.', 'UNSUPPORTED_MIME_TYPE')
    }
    const normalized = explicitMimeType.split(';')[0].trim().toLowerCase()
    if (!Object.hasOwn(SUPPORTED_SLICE_MIME_TYPES, normalized)) {
      throw sliceError(`Unsupported file slicing MIME type: ${normalized || '(empty)'}.`, 'UNSUPPORTED_MIME_TYPE')
    }
    return { mimeType: normalized, category: SUPPORTED_SLICE_MIME_TYPES[normalized] }
  }
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw sliceError('File path is required to infer MIME type.', 'UNSUPPORTED_MIME_TYPE')
  }
  const ext = extname(filePath.trim()).toLowerCase()
  if (!ext || !Object.hasOwn(EXTENSION_TO_MIME, ext)) {
    throw sliceError(`Unsupported or missing file extension for slicing: ${ext || '(none)'}.`, 'UNSUPPORTED_MIME_TYPE')
  }
  const mimeType = EXTENSION_TO_MIME[ext]
  return { mimeType, category: SUPPORTED_SLICE_MIME_TYPES[mimeType] }
}

function canonicalDecimalDigits(rawDigits) {
  let [intPart, fracPart] = rawDigits.split('.')
  intPart = intPart.replace(/^0+(?=\d)/, '') || '0'
  if (fracPart !== undefined) {
    fracPart = fracPart.replace(/0+$/, '')
    return fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart
  }
  return intPart
}

function numberToDecimalString(num) {
  if (Object.is(num, -0) || num === 0) return '0'
  const s = String(num)
  if (!/[eE]/.test(s)) return s
  const [coeff, expStr] = s.toLowerCase().split('e')
  const exp = Number(expStr)
  const [intPart, fracPart = ''] = coeff.split('.')
  const digits = intPart + fracPart
  const decimalPos = intPart.length + exp
  let out
  if (decimalPos <= 0) {
    out = '0.' + '0'.repeat(-decimalPos) + digits
  } else if (decimalPos >= digits.length) {
    out = digits + '0'.repeat(decimalPos - digits.length)
  } else {
    out = digits.slice(0, decimalPos) + '.' + digits.slice(decimalPos)
  }
  if (out.includes('.')) out = out.replace(/\.?0+$/, '')
  return out || '0'
}

function parseOffset(raw, fieldName) {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) {
      throw sliceError(`${fieldName} must be a finite number >= 0.`)
    }
    return { numeric: raw, formatted: `${numberToDecimalString(raw)}s` }
  }
  if (typeof raw === 'string') {
    if (!OFFSET_STRING_RE.test(raw)) {
      throw sliceError(`${fieldName} must be a non-negative number of seconds or "<seconds>s".`)
    }
    const digits = raw.slice(0, -1)
    const numeric = Number(digits)
    if (!Number.isFinite(numeric) || numeric < 0) {
      throw sliceError(`${fieldName} must be a finite non-negative offset.`)
    }
    return { numeric, formatted: `${canonicalDecimalDigits(digits)}s` }
  }
  throw sliceError(`${fieldName} must be a number or "<seconds>s" string.`)
}

function normalizeLayers(raw, allowedSet, category) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw sliceError(`contentLayers for ${category} must be a non-empty array.`)
  }
  const deduped = []
  const seen = new Set()
  for (const item of raw) {
    if (typeof item !== 'string' || !allowedSet.has(item)) {
      throw sliceError(`Invalid contentLayers value "${String(item)}" for ${category}.`)
    }
    if (!seen.has(item)) {
      seen.add(item)
      deduped.push(item)
    }
  }
  return deduped
}

function normalizeResolution(raw) {
  if (typeof raw !== 'string' || !VALID_RESOLUTIONS.has(raw)) {
    throw sliceError(`Invalid resolution "${String(raw)}". Must be one of low, medium, high, ultra_high.`)
  }
  return raw
}

export function normalizeSliceSpec(category, rawOptions = {}) {
  if (typeof category !== 'string' || !Object.hasOwn(CATEGORY_ALLOWED_KEYS, category)) {
    throw sliceError(`Unsupported file slicing category: ${String(category)}.`)
  }
  if (rawOptions === null || rawOptions === undefined) rawOptions = {}
  if (typeof rawOptions !== 'object' || Array.isArray(rawOptions)) {
    throw sliceError('Slice options must be a plain object.')
  }
  const allowedKeys = CATEGORY_ALLOWED_KEYS[category]
  for (const [key, value] of Object.entries(rawOptions)) {
    if (value === undefined) continue
    if (!allowedKeys.has(key)) {
      throw sliceError(`Option "${key}" is not allowed for ${category} slicing.`)
    }
  }

  const out = {}

  if (category === 'document') {
    if (rawOptions.startPage !== undefined) {
      if (!Number.isSafeInteger(rawOptions.startPage) || rawOptions.startPage < 1) {
        throw sliceError('startPage must be an integer >= 1.')
      }
      out.startPage = rawOptions.startPage
    }
    if (rawOptions.endPage !== undefined) {
      if (!Number.isSafeInteger(rawOptions.endPage) || rawOptions.endPage < 1) {
        throw sliceError('endPage must be an integer >= 1.')
      }
      out.endPage = rawOptions.endPage
    }
    if (out.startPage !== undefined && out.endPage !== undefined && out.endPage < out.startPage) {
      throw sliceError('endPage must be greater than or equal to startPage.')
    }
    if (rawOptions.contentLayers !== undefined) {
      out.contentLayers = normalizeLayers(rawOptions.contentLayers, CATEGORY_CONTENT_LAYERS.document, 'document')
    }
    if (rawOptions.resolution !== undefined) {
      const res = normalizeResolution(rawOptions.resolution)
      if (out.contentLayers && out.contentLayers.length === 1 && out.contentLayers[0] === 'page_text') {
        throw sliceError('resolution cannot be set for document slicing when contentLayers is ["page_text"].')
      }
      out.resolution = res
    }
    return out
  }

  if (category === 'spreadsheet') {
    if (rawOptions.sheetIndex !== undefined) {
      if (!Number.isSafeInteger(rawOptions.sheetIndex) || rawOptions.sheetIndex < 1) {
        throw sliceError('sheetIndex must be an integer >= 1.')
      }
      out.sheetIndex = rawOptions.sheetIndex
    }
    if (rawOptions.visibleCells !== undefined) {
      if (typeof rawOptions.visibleCells !== 'string' || !VISIBLE_CELLS_RE.test(rawOptions.visibleCells)) {
        throw sliceError('visibleCells must be a valid A1 cell or range (e.g. "A1:D20").')
      }
      out.visibleCells = rawOptions.visibleCells.toUpperCase()
    }
    if (rawOptions.contentLayers !== undefined) {
      out.contentLayers = normalizeLayers(rawOptions.contentLayers, CATEGORY_CONTENT_LAYERS.spreadsheet, 'spreadsheet')
    }
    if (rawOptions.resolution !== undefined) {
      const res = normalizeResolution(rawOptions.resolution)
      if (!out.contentLayers || !out.contentLayers.includes('visual')) {
        throw sliceError('resolution for spreadsheet slicing requires contentLayers to include "visual".')
      }
      out.resolution = res
    }
    return out
  }

  if (category === 'video') {
    let start, end
    if (rawOptions.startOffset !== undefined) {
      start = parseOffset(rawOptions.startOffset, 'startOffset')
      out.startOffset = start.formatted
    }
    if (rawOptions.endOffset !== undefined) {
      end = parseOffset(rawOptions.endOffset, 'endOffset')
      out.endOffset = end.formatted
    }
    if (start && end && end.numeric <= start.numeric) {
      throw sliceError('endOffset must be strictly greater than startOffset.')
    }
    if (rawOptions.fps !== undefined) {
      if (typeof rawOptions.fps !== 'number' || !Number.isFinite(rawOptions.fps) || rawOptions.fps <= 0 || rawOptions.fps > 24) {
        throw sliceError('fps must be a finite number > 0 and <= 24.')
      }
      out.fps = rawOptions.fps
    }
    if (rawOptions.contentLayers !== undefined) {
      out.contentLayers = normalizeLayers(rawOptions.contentLayers, CATEGORY_CONTENT_LAYERS.video, 'video')
    }
    if (rawOptions.resolution !== undefined) {
      const res = normalizeResolution(rawOptions.resolution)
      if (out.contentLayers && !out.contentLayers.includes('frames')) {
        throw sliceError('resolution for video slicing requires contentLayers to include "frames".')
      }
      out.resolution = res
    }
    return out
  }

  // audio
  let start, end
  if (rawOptions.startOffset !== undefined) {
    start = parseOffset(rawOptions.startOffset, 'startOffset')
    out.startOffset = start.formatted
  }
  if (rawOptions.endOffset !== undefined) {
    end = parseOffset(rawOptions.endOffset, 'endOffset')
    out.endOffset = end.formatted
  }
  if (start && end && end.numeric <= start.numeric) {
    throw sliceError('endOffset must be strictly greater than startOffset.')
  }
  return out
}

export function normalizePiAiToolCallId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
}

export function toInteractionSliceBlock(record) {
  const slice = record?.slice ?? {}
  if (record?.category === 'document') {
    const pageOptions = {}
    if (slice.startPage !== undefined) pageOptions.start_page = slice.startPage
    if (slice.endPage !== undefined) pageOptions.end_page = slice.endPage
    if (slice.contentLayers?.length) pageOptions.content_layers = [...slice.contentLayers]
    return {
      type: 'document',
      uri: record.uri,
      mime_type: record.mimeType,
      ...(slice.resolution ? { resolution: slice.resolution } : {}),
      processing: {
        type: 'static',
        ...(Object.keys(pageOptions).length ? { page_options: pageOptions } : {}),
      },
    }
  }
  if (record?.category === 'spreadsheet') {
    const sheetOptions = {}
    if (slice.sheetIndex !== undefined) sheetOptions.sheet_index = slice.sheetIndex
    if (slice.visibleCells !== undefined) sheetOptions.visible_cells = slice.visibleCells
    if (slice.contentLayers?.length) sheetOptions.content_layers = [...slice.contentLayers]
    return {
      type: 'document',
      uri: record.uri,
      mime_type: record.mimeType,
      ...(slice.resolution ? { resolution: slice.resolution } : {}),
      processing: {
        type: 'static',
        ...(Object.keys(sheetOptions).length ? { spreadsheet_options: sheetOptions } : {}),
      },
    }
  }
  if (record?.category === 'video') {
    const processing = { type: 'static' }
    if (slice.startOffset !== undefined) processing.start_offset = slice.startOffset
    if (slice.endOffset !== undefined) processing.end_offset = slice.endOffset
    if (slice.fps !== undefined) processing.fps = slice.fps
    if (slice.contentLayers?.length) processing.content_layers = [...slice.contentLayers]
    return {
      type: 'video',
      uri: record.uri,
      mime_type: record.mimeType,
      ...(slice.resolution ? { resolution: slice.resolution } : {}),
      processing,
    }
  }
  if (record?.category === 'audio') {
    const processing = { type: 'static' }
    if (slice.startOffset !== undefined) processing.start_offset = slice.startOffset
    if (slice.endOffset !== undefined) processing.end_offset = slice.endOffset
    return {
      type: 'audio',
      uri: record.uri,
      mime_type: record.mimeType,
      processing,
    }
  }
  throw sliceError(`Cannot serialize unknown slice category: ${String(record?.category)}.`)
}

export function toGenerateContentSlicePart(record) {
  const slice = record?.slice ?? {}
  const displayName = typeof record?.displayName === 'string' && record.displayName
    ? record.displayName
    : 'slice_file'
  const part = {
    fileData: {
      fileUri: record.uri,
      mimeType: record.mimeType,
      displayName,
    },
  }
  if (record?.category === 'document') {
    const meta = {}
    if (slice.startPage !== undefined) meta.startPage = slice.startPage
    if (slice.endPage !== undefined) meta.endPage = slice.endPage
    if (slice.contentLayers?.length) meta.contentLayers = slice.contentLayers.map(l => l.toUpperCase())
    if (Object.keys(meta).length) part.documentMetadata = meta
  } else if (record?.category === 'spreadsheet') {
    const meta = {}
    if (slice.sheetIndex !== undefined) meta.sheetIndex = slice.sheetIndex
    if (slice.visibleCells !== undefined) meta.visibleCells = slice.visibleCells
    if (slice.contentLayers?.length) meta.contentLayers = slice.contentLayers.map(l => l.toUpperCase())
    if (Object.keys(meta).length) part.spreadsheetMetadata = meta
  } else if (record?.category === 'video') {
    const meta = {}
    if (slice.startOffset !== undefined) meta.startOffset = slice.startOffset
    if (slice.endOffset !== undefined) meta.endOffset = slice.endOffset
    if (slice.fps !== undefined) meta.fps = slice.fps
    if (slice.contentLayers?.length) meta.contentLayers = slice.contentLayers.map(l => l.toUpperCase())
    if (Object.keys(meta).length) part.videoMetadata = meta
  } else if (record?.category === 'audio') {
    const meta = {}
    if (slice.startOffset !== undefined) meta.startOffset = slice.startOffset
    if (slice.endOffset !== undefined) meta.endOffset = slice.endOffset
    if (Object.keys(meta).length) part.audioMetadata = meta
  } else {
    throw sliceError(`Cannot serialize unknown slice category: ${String(record?.category)}.`)
  }
  if (slice.resolution) {
    part.mediaResolution = { level: `MEDIA_RESOLUTION_${slice.resolution.toUpperCase()}` }
  }
  return { part, displayName }
}

const MAX_RECORDS_PER_SESSION = 64

function cloneSlice(slice) {
  if (!slice || typeof slice !== 'object') return {}
  return {
    ...slice,
    ...(Array.isArray(slice.contentLayers) ? { contentLayers: [...slice.contentLayers] } : {}),
  }
}

function normalizeEndpointBase(value, fallback = DEFAULT_ENDPOINT_BASE) {
  if (typeof value === 'string' && value.trim()) {
    return value.trim().replace(/\/+$/, '')
  }
  return fallback
}

function appendToListMap(map, key, value) {
  let list = map.get(key)
  if (!list) {
    list = []
    map.set(key, list)
  }
  list.push(value)
}

function removeFromListMap(map, key, value) {
  const list = map.get(key)
  if (!list) return
  const idx = list.indexOf(value)
  if (idx >= 0) list.splice(idx, 1)
  if (list.length === 0) map.delete(key)
}

export function createFileSliceHub({
  maxActiveSlicesPerSession = 6,
  maxSessions = 64,
  maxUploads = 128,
  maxInFlightUploads = 4,
  safetyExpiryMarginMs = 5 * 60_000,
  defaultTtlMs = 48 * 3600_000,
  now = () => Date.now(),
} = {}) {
  const uploads = new Map()
  const inFlight = new Map()
  const sessions = new Map()
  const sessionRoutes = new Map()
  let closed = false
  let recordSeq = 0

  function touchLru(map, key, value, maxSize) {
    map.delete(key)
    while (map.size >= maxSize) {
      map.delete(map.keys().next().value)
    }
    map.set(key, value)
  }

  function evictFlight(flight) {
    if (inFlight.get(flight.key) === flight) inFlight.delete(flight.key)
  }

  async function awaitInFlightWithCallerSignal(entry, signal) {
    let settled = false
    let onAbort
    const releaseWaiter = () => {
      if (settled) return
      settled = true
      if (onAbort && signal) signal.removeEventListener('abort', onAbort)
      entry.waiters = Math.max(0, entry.waiters - 1)
      if (entry.waiters === 0) {
        evictFlight(entry)
        if (!entry.controller.signal.aborted) {
          entry.controller.abort(abortError('All callers aborted file upload.'))
        }
      }
    }

    if (signal?.aborted) {
      releaseWaiter()
      throw abortError()
    }

    try {
      if (!signal) {
        const res = await entry.promise
        settled = true
        entry.waiters = Math.max(0, entry.waiters - 1)
        return res
      }
      return await new Promise((resolvePromise, rejectPromise) => {
        onAbort = () => {
          releaseWaiter()
          rejectPromise(abortError())
        }
        signal.addEventListener('abort', onAbort, { once: true })
        entry.promise.then(
          val => {
            if (settled) return
            settled = true
            signal.removeEventListener('abort', onAbort)
            entry.waiters = Math.max(0, entry.waiters - 1)
            resolvePromise(val)
          },
          err => {
            if (settled) return
            settled = true
            signal.removeEventListener('abort', onAbort)
            entry.waiters = Math.max(0, entry.waiters - 1)
            rejectPromise(err)
          },
        )
      })
    } catch (err) {
      if (entry.revoked && !signal?.aborted) {
        throw sliceError('Gemini Files API upload cancelled because consent was revoked.', 'ARGON_FILE_SLICING_DISABLED')
      }
      throw err
    }
  }

  async function getOrUpload({
    principalHash,
    endpointBase = DEFAULT_ENDPOINT_BASE,
    sha256,
    mimeType,
    signal,
    uploadFn,
  }) {
    if (closed) {
      throw sliceError('File slice hub is closed.', 'ARGON_SLICE_CLOSED')
    }
    if (typeof principalHash !== 'string' || !principalHash) {
      throw sliceError('principalHash is required for upload deduplication.')
    }
    if (typeof sha256 !== 'string' || !sha256) {
      throw sliceError('sha256 is required for upload deduplication.')
    }
    if (typeof mimeType !== 'string' || !mimeType) {
      throw sliceError('mimeType is required for upload deduplication.')
    }
    if (typeof uploadFn !== 'function') {
      throw sliceError('uploadFn must be a function.')
    }
    if (signal?.aborted) {
      throw abortError()
    }

    const normalizedEndpoint = normalizeEndpointBase(endpointBase)
    const key = `${principalHash}\0${normalizedEndpoint}\0${sha256}\0${mimeType}`
    const cached = uploads.get(key)
    if (cached) {
      if (now() < cached.expirationTimeMs - safetyExpiryMarginMs) {
        touchLru(uploads, key, cached, maxUploads)
        return { ...cached, reusedUpload: true }
      }
      uploads.delete(key)
    }

    const existing = inFlight.get(key)
    if (existing && !existing.revoked && !existing.controller.signal.aborted) {
      existing.waiters += 1
      const entry = await awaitInFlightWithCallerSignal(existing, signal)
      return { ...entry, reusedUpload: true }
    }

    if (inFlight.size >= maxInFlightUploads) {
      throw sliceError('Too many concurrent file uploads in progress.', 'ARGON_SLICE_TOO_MANY_UPLOADS')
    }

    const controller = new AbortController()
    const flight = {
      key,
      controller,
      waiters: 1,
      revoked: false,
      promise: null,
    }

    flight.promise = (async () => {
      try {
        const uploaded = await uploadFn(controller.signal)
        if (flight.revoked) {
          throw sliceError('Gemini Files API upload cancelled because consent was revoked.', 'ARGON_FILE_SLICING_DISABLED')
        }
        if (closed) {
          throw sliceError('File slice hub is closed.', 'ARGON_SLICE_CLOSED')
        }
        if (!uploaded || typeof uploaded !== 'object' || typeof uploaded.uri !== 'string' || typeof uploaded.name !== 'string') {
          throw sliceError('Upload callback returned an invalid file record.', 'GEMINI_FILE_PROTOCOL')
        }
        const currentNow = now()
        const maxExpMs = currentNow + defaultTtlMs
        const parsedExp = uploaded.expirationTime ? Date.parse(uploaded.expirationTime) : NaN
        const rawExpMs = Number.isFinite(uploaded.expirationTimeMs)
          ? uploaded.expirationTimeMs
          : (Number.isFinite(parsedExp) ? parsedExp : maxExpMs)
        const expirationTimeMs = Math.min(rawExpMs, maxExpMs)
        const entry = {
          ...uploaded,
          endpointBase: normalizedEndpoint,
          expirationTimeMs,
        }
        if (!closed && !flight.revoked && !controller.signal.aborted) {
          touchLru(uploads, key, entry, maxUploads)
        }
        return entry
      } finally {
        if (inFlight.get(key) === flight) inFlight.delete(key)
      }
    })()

    // Prevent unhandled rejections if all callers detach via individual abort signals.
    flight.promise.catch(() => {})
    inFlight.set(key, flight)

    const entry = await awaitInFlightWithCallerSignal(flight, signal)
    return { ...entry, reusedUpload: false }
  }

  function registerSlice({
    sessionId,
    callId,
    route = 'google-generative-ai',
    principalHash,
    endpointBase = DEFAULT_ENDPOINT_BASE,
    uri,
    name,
    mimeType,
    category,
    displayName,
    slice,
    expirationTimeMs,
  }) {
    if (typeof sessionId !== 'string' || !sessionId) throw sliceError('sessionId is required.')
    if (typeof callId !== 'string' || !callId) throw sliceError('callId is required.')
    if (typeof principalHash !== 'string' || !principalHash) throw sliceError('principalHash is required.')
    if (typeof uri !== 'string' || !uri) throw sliceError('uri is required.')
    if (typeof name !== 'string' || !name) throw sliceError('name is required.')
    if (typeof mimeType !== 'string' || !mimeType) throw sliceError('mimeType is required.')
    if (typeof category !== 'string' || !Object.hasOwn(CATEGORY_ALLOWED_KEYS, category)) {
      throw sliceError('Valid slice category is required.')
    }
    const currentNow = now()
    const maxExpMs = currentNow + defaultTtlMs
    const expMs = Number.isFinite(expirationTimeMs) ? Math.min(expirationTimeMs, maxExpMs) : maxExpMs
    const normalizedCallId = normalizePiAiToolCallId(callId)
    const normalizedEndpoint = normalizeEndpointBase(endpointBase)
    const seq = ++recordSeq
    const sliceId = `sl_${randomBytes(6).toString('hex')}`
    const record = {
      seq,
      sliceId,
      sessionId,
      callId,
      normalizedCallId,
      route,
      principalHash,
      endpointBase: normalizedEndpoint,
      uri,
      name,
      mimeType,
      category,
      displayName: typeof displayName === 'string' && displayName ? displayName : name,
      slice: cloneSlice(slice),
      expirationTimeMs: expMs,
    }
    if (closed) return record

    let session = sessions.get(sessionId)
    if (!session) {
      session = {
        records: [],
        bySliceId: new Map(),
        byCallId: new Map(),
        byNormalizedCallId: new Map(),
      }
    }
    touchLru(sessions, sessionId, session, maxSessions)

    session.records.push(record)
    session.bySliceId.set(sliceId, record)
    appendToListMap(session.byCallId, callId, record)
    appendToListMap(session.byNormalizedCallId, normalizedCallId, record)

    while (session.records.length > MAX_RECORDS_PER_SESSION) {
      const evicted = session.records.shift()
      session.bySliceId.delete(evicted.sliceId)
      removeFromListMap(session.byCallId, evicted.callId, evicted)
      removeFromListMap(session.byNormalizedCallId, evicted.normalizedCallId, evicted)
    }
    return record
  }

  function resolveForRequest({
    sessionId,
    route,
    principalHash,
    endpointBase,
    allowGeminiFilesApi,
    protocol,
    toolCallIds = [],
    entries,
  } = {}) {
    const resolved = new Map()
    if (
      closed ||
      route !== 'google-generative-ai' ||
      typeof sessionId !== 'string' || !sessionId ||
      typeof principalHash !== 'string' || !principalHash
    ) {
      return resolved
    }
    const session = sessions.get(sessionId)
    const normalizedEntries = Array.isArray(entries)
      ? entries
      : (Array.isArray(toolCallIds) ? toolCallIds.map(id => ({ key: id, callId: id })) : [])
    if (!session || normalizedEntries.length === 0) {
      return resolved
    }
    touchLru(sessions, sessionId, session, maxSessions)

    const filterEndpoint = typeof endpointBase === 'string' && endpointBase.trim()
      ? normalizeEndpointBase(endpointBase)
      : undefined
    const currentNow = now()

    // Session-global active window: newest maxActiveSlicesPerSession non-expired records in the session.
    const eligibleRecords = session.records.filter(r =>
      r.sessionId === sessionId &&
      r.route === 'google-generative-ai' &&
      r.principalHash === principalHash &&
      (filterEndpoint === undefined || r.endpointBase === filterEndpoint) &&
      currentNow < r.expirationTimeMs - safetyExpiryMarginMs,
    )
    const activeSliceIds = new Set(
      eligibleRecords
        .slice(Math.max(0, eligibleRecords.length - maxActiveSlicesPerSession))
        .map(r => r.sliceId),
    )

    const consumedSliceIds = new Set()

    for (const entry of normalizedEntries) {
      if (!entry || typeof entry !== 'object') continue
      if (entry.isError === true) continue
      const callId = entry.callId
      const lookupKey = typeof entry.key === 'string' && entry.key ? entry.key : callId
      if (typeof callId !== 'string' || !callId || typeof lookupKey !== 'string' || !lookupKey) continue

      let record
      if (typeof entry.sliceId === 'string' && entry.sliceId) {
        const candidate = session.bySliceId.get(entry.sliceId)
        if (
          candidate &&
          (candidate.callId === callId || (protocol === 'generate-content' && candidate.normalizedCallId === callId))
        ) {
          record = candidate
        }
      } else if (protocol === 'interactions') {
        // Interactions: exact callId match ONLY (no normalized alias fallback), must be unambiguous.
        const exactList = session.byCallId.get(callId)
        if (exactList && exactList.length === 1) {
          record = exactList[0]
        }
      } else {
        // GenerateContent: check normalized collisions FIRST so e.g. 'a_b' vs 'a:b' refuses ambiguous injection without sliceId.
        const normList = session.byNormalizedCallId.get(normalizePiAiToolCallId(callId))
        if (!normList || normList.length <= 1) {
          const exactList = session.byCallId.get(callId)
          if (exactList && exactList.length > 0) {
            if (exactList.length === 1) record = exactList[0]
          } else if (normList && normList.length === 1) {
            record = normList[0]
          }
        }
      }

      if (!record) continue
      if (
        record.sessionId !== sessionId ||
        record.route !== 'google-generative-ai' ||
        record.principalHash !== principalHash ||
        (filterEndpoint !== undefined && record.endpointBase !== filterEndpoint)
      ) {
        continue
      }

      // Prevent duplicate injection of the same record across multiple entries in one request.
      if (consumedSliceIds.has(record.sliceId)) continue
      consumedSliceIds.add(record.sliceId)

      if (allowGeminiFilesApi !== true) {
        resolved.set(lookupKey, {
          status: 'disabled',
          record,
          notice: `[File slice "${record.displayName}" omitted because Gemini Files API uploads (allowGeminiFilesApi) are disabled.]`,
        })
      } else if (currentNow >= record.expirationTimeMs - safetyExpiryMarginMs) {
        resolved.set(lookupKey, {
          status: 'expired',
          record,
          notice: `[File slice "${record.displayName}" expired from Gemini Files API retention window; call ${SLICE_TOOL_NAME} again to re-upload if needed.]`,
        })
      } else if (!activeSliceIds.has(record.sliceId)) {
        resolved.set(lookupKey, {
          status: 'offloaded',
          record,
          notice: `[Older file slice "${record.displayName}" offloaded from the active window (limit ${maxActiveSlicesPerSession}); call ${SLICE_TOOL_NAME} again to reload if needed.]`,
        })
      } else if (protocol === 'interactions') {
        resolved.set(lookupKey, {
          status: 'active',
          record,
          block: toInteractionSliceBlock(record),
        })
      } else {
        resolved.set(lookupKey, {
          status: 'active',
          record,
          ...toGenerateContentSlicePart(record),
        })
      }
    }

    return resolved
  }

  function observeSessionRoute(sessionId, { provider, model } = {}) {
    if (closed || typeof sessionId !== 'string' || !sessionId) return
    if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !model) return
    touchLru(sessionRoutes, sessionId, { provider, model }, maxSessions)
  }

  function getSessionRoute(sessionId) {
    if (closed || typeof sessionId !== 'string' || !sessionId) return undefined
    const route = sessionRoutes.get(sessionId)
    if (!route) return undefined
    touchLru(sessionRoutes, sessionId, route, maxSessions)
    return { ...route }
  }

  function clearSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return
    sessions.delete(sessionId)
    sessionRoutes.delete(sessionId)
  }

  function revokeConsent() {
    const reason = sliceError('Gemini Files API consent revoked.', 'ARGON_FILE_SLICING_DISABLED')
    for (const flight of [...inFlight.values()]) {
      flight.revoked = true
      evictFlight(flight)
      if (!flight.controller.signal.aborted) {
        flight.controller.abort(reason)
      }
    }
  }

  function close() {
    revokeConsent()
    closed = true
    uploads.clear()
    inFlight.clear()
    sessions.clear()
    sessionRoutes.clear()
  }

  return {
    getOrUpload,
    registerSlice,
    resolveForRequest,
    observeSessionRoute,
    getSessionRoute,
    clearSession,
    revokeConsent,
    close,
  }
}
