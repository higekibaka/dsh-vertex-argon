import { createHash, randomBytes } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { shared } from './runtime.js'
import { PROVIDER, isGoogleApiModel } from './adapter.js'
import { interactionsEndpoint, inferInteractionsApiVersion } from './interaction-transport.js'
import { GEMINI_FILES_MAX_BYTES, createGeminiFilesClient } from './files-transport.js'
import { SLICE_TOOL_NAME, inferSliceMimeType, normalizeSliceSpec } from './file-slicing.js'

const { z } = await shared('zod')

const sliceArgsSchema = z.object({
  path: z.string().min(1).max(4096).refine(v => !v.includes('\0') && v.trim().length > 0),
  mimeType: z.string().min(1).max(256).optional(),
  startPage: z.number().int().min(1).optional(),
  endPage: z.number().int().min(1).optional(),
  sheetIndex: z.number().int().min(1).optional(),
  visibleCells: z.string().min(1).max(64).optional(),
  startOffset: z.union([z.number().finite().min(0), z.string().min(1).max(64)]).optional(),
  endOffset: z.union([z.number().finite().min(0), z.string().min(1).max(64)]).optional(),
  fps: z.number().finite().gt(0).lte(24).optional(),
  contentLayers: z.array(z.string().min(1).max(32)).min(1).max(8).optional(),
  resolution: z.enum(['low', 'medium', 'high', 'ultra_high']).optional(),
}).strict()

const failure = (code, error) => ({ ok: false, code, error })
const cancelled = () => failure('ARGON_SLICE_CANCELLED', 'File slicing was cancelled.')
const disabledFailure = () => failure(
  'ARGON_FILE_SLICING_DISABLED',
  'Gemini Files API file slicing is disabled. Enable allowGeminiFilesApi in Gemini 4 Adapter settings to allow uploading local files.',
)

function sanitizeBasename(rawName) {
  const cleaned = String(rawName ?? '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
  return cleaned || 'file'
}

async function hashHandleSha256(fh, expectedSize, signal) {
  if (signal?.aborted) {
    throw Object.assign(new Error('Aborted'), { name: 'AbortError', code: 'ABORT_ERR' })
  }
  const hash = createHash('sha256')
  const buf = Buffer.allocUnsafe(Math.min(64 * 1024, expectedSize))
  let offset = 0
  while (offset < expectedSize) {
    if (signal?.aborted) {
      throw Object.assign(new Error('Aborted'), { name: 'AbortError', code: 'ABORT_ERR' })
    }
    const toRead = Math.min(buf.length, expectedSize - offset)
    const { bytesRead } = await fh.read(buf, 0, toRead, offset)
    if (bytesRead <= 0) {
      throw Object.assign(new Error('Target file truncated during hashing.'), { code: 'ARGON_SLICE_FILE_CHANGED' })
    }
    hash.update(buf.subarray(0, bytesRead))
    offset += bytesRead
  }
  const probe = Buffer.allocUnsafe(1)
  const { bytesRead: extraBytes } = await fh.read(probe, 0, 1, expectedSize)
  if (extraBytes > 0) {
    throw Object.assign(new Error('Target file grew during hashing.'), { code: 'ARGON_SLICE_FILE_CHANGED' })
  }
  return hash.digest('hex')
}

async function resolveLocalFilePath(ctx, rawPath) {
  const fsSvc = ctx?.get?.('fs')
  if (typeof fsSvc?.hostPathFromProcessPath === 'function') {
    let mapped
    try {
      mapped = await fsSvc.hostPathFromProcessPath(rawPath)
    } catch {
      return { ok: false, error: failure('ARGON_SLICE_PATH_DENIED', 'Target file path is not permitted by the host filesystem.') }
    }
    if (typeof mapped !== 'string' || !mapped.trim() || mapped.includes('\0')) {
      return { ok: false, error: failure('ARGON_SLICE_PATH_DENIED', 'Target file path could not be resolved by the host filesystem.') }
    }
    return { ok: true, path: mapped }
  }
  return { ok: true, path: resolve(rawPath) }
}

function isAbortError(error, signal) {
  return Boolean(signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR')
}

export function createFileSlicingTool({
  ctx,
  getConfig,
  getRoutes,
  resolveSecret,
  GoogleGenAI,
  fileSliceHub,
  fetchImpl,
  sleepImpl,
  statImpl = stat,
  openImpl = open,
} = {}) {
  const isConsentEnabled = () => {
    try {
      return getConfig?.()?.allowGeminiFilesApi === true
    } catch {
      return false
    }
  }

  return {
    name: SLICE_TOOL_NAME,
    deferLoading: true,
    timeoutMs: 180_000,
    isConcurrencySafe: () => true,
    description:
      'Upload a local PDF, Office document, spreadsheet, video, or audio file via the Gemini Files API (Gemini API *-google models only; requires user opt-in) and attach a targeted slice (pages, spreadsheet range, time offsets, fps, content layers, resolution) to the tool result.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: {
          type: 'string',
          description: 'Local path to the document, spreadsheet, video, or audio file.',
        },
        mimeType: {
          type: 'string',
          description: 'Optional explicit MIME type; inferred from file extension when omitted.',
        },
        startPage: {
          type: 'integer',
          minimum: 1,
          description: 'Document only: 1-based start page.',
        },
        endPage: {
          type: 'integer',
          minimum: 1,
          description: 'Document only: 1-based inclusive end page (>= startPage).',
        },
        sheetIndex: {
          type: 'integer',
          minimum: 1,
          description: 'Spreadsheet only: 1-based worksheet index.',
        },
        visibleCells: {
          type: 'string',
          description: 'Spreadsheet only: A1 cell or range (e.g. "A1:F40").',
        },
        startOffset: {
          anyOf: [
            { type: 'number', minimum: 0 },
            { type: 'string' },
          ],
          description: 'Video/audio only: start offset in seconds (number >= 0 or "<seconds>s").',
        },
        endOffset: {
          anyOf: [
            { type: 'number', minimum: 0 },
            { type: 'string' },
          ],
          description: 'Video/audio only: end offset in seconds (strictly greater than startOffset).',
        },
        fps: {
          type: 'number',
          exclusiveMinimum: 0,
          maximum: 24,
          description: 'Video only: frame sampling rate (> 0 and <= 24).',
        },
        contentLayers: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'string',
            enum: ['page_text', 'page_image', 'data', 'formulas', 'visual', 'frames', 'audio', 'transcript'],
          },
          description: 'Document (page_text, page_image), spreadsheet (data, formulas, visual), or video (frames, audio, transcript) layers.',
        },
        resolution: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'ultra_high'],
          description: 'Visual media resolution for document images, spreadsheet visual layer, or video frames.',
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec = {}) {
      const signal = exec?.signal
      // 1. Abort check
      if (signal?.aborted) return cancelled()

      // 2. Explicit opt-in check
      let cfg
      try {
        cfg = typeof getConfig === 'function' ? getConfig() : undefined
      } catch {
        cfg = undefined
      }
      if (cfg?.allowGeminiFilesApi !== true) {
        return disabledFailure()
      }

      // 3. Session & callId checks
      const sessionId = exec?.agent?.id
      const callId = exec?.callId
      if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256 || typeof callId !== 'string' || !callId || callId.length > 256) {
        return failure('ARGON_SLICE_SESSION', 'An executing session and tool call ID are required.')
      }

      // 4. Authoritative route gate (zero disk/network I/O if unsupported)
      const hasModelSelection = typeof exec?.agent?.modelSelection?.current === 'function'
      let routeSource
      if (hasModelSelection) {
        try {
          routeSource = exec.agent.modelSelection.current()
        } catch {
          return failure(
            'ARGON_FILE_SLICING_UNSUPPORTED_ROUTE',
            'Unable to read active model route from session model selection.',
          )
        }
      } else {
        const agentOptions = exec?.agent?.options
        const hasRoute = r => Boolean(r && typeof r === 'object' && (r.provider || r.model))
        routeSource = hasRoute(agentOptions) ? agentOptions : fileSliceHub?.getSessionRoute?.(sessionId)
      }
      const provider = routeSource?.provider
      const model = routeSource?.model
      if (provider === PROVIDER && typeof model === 'string' && model.length > 0 && !isGoogleApiModel(model)) {
        return failure(
          'ARGON_FILE_SLICING_VERTEX_UNSUPPORTED',
          'File slicing currently supports Gemini API (*-google) models only; Vertex AI does not expose the Gemini Files API.',
        )
      }
      if (provider !== PROVIDER || !isGoogleApiModel(model)) {
        return failure(
          'ARGON_FILE_SLICING_UNSUPPORTED_ROUTE',
          'File slicing requires an active Gemini 4 Adapter Gemini API (*-google) model route.',
        )
      }

      // 5. Interactions v1beta gate (pre-I/O)
      const routes = typeof getRoutes === 'function' ? getRoutes() : undefined
      if (cfg?.googleProtocol === 'interactions') {
        let apiVersion
        try {
          const endpoint = interactionsEndpoint({ route: 'google-generative-ai', baseURL: routes?.googleBaseUrl })
          apiVersion = inferInteractionsApiVersion(endpoint, 'google-generative-ai')
        } catch {
          apiVersion = undefined
        }
        if (apiVersion === 'v1') {
          return failure(
            'ARGON_FILE_SLICING_API_VERSION_UNSUPPORTED',
            'File slicing on Interactions requires a v1beta endpoint; explicit /v1/interactions gateways are unsupported.',
          )
        }
      }

      // 6. Validate args, infer MIME, normalize slice spec
      let input, mimeType, category, slice
      try {
        input = sliceArgsSchema.parse(args)
        const inferred = inferSliceMimeType(input.path, input.mimeType)
        mimeType = inferred.mimeType
        category = inferred.category
        const { path: _p, mimeType: _m, ...sliceOptions } = input
        slice = normalizeSliceSpec(category, sliceOptions)
      } catch (err) {
        const msg = err?.code === 'UNSUPPORTED_MIME_TYPE' || err?.code === 'INVALID_SLICE_SPEC'
          ? err.message
          : 'Invalid file slicing arguments.'
        return failure('ARGON_SLICE_INVALID', msg)
      }

      if (!fileSliceHub || typeof fileSliceHub.getOrUpload !== 'function' || typeof fileSliceHub.registerSlice !== 'function') {
        return failure('ARGON_SLICE_UNAVAILABLE', 'File slicing service is unavailable.')
      }

      // 7. Fail-closed host path mapping
      const mapped = await resolveLocalFilePath(ctx, input.path)
      if (!mapped.ok) return mapped.error
      const resolvedPath = mapped.path
      if (signal?.aborted) return cancelled()
      if (!isConsentEnabled()) return disabledFailure()

      // 8. Pre-open stat rejects non-regular files (e.g. POSIX FIFOs/directories) before open('r')
      let preStat
      try {
        preStat = await statImpl(resolvedPath)
      } catch {
        return failure('ARGON_SLICE_FILE_NOT_FOUND', 'Target file does not exist or cannot be accessed.')
      }
      if (!preStat.isFile()) {
        return failure('ARGON_SLICE_NOT_A_FILE', 'Target path must be a regular file.')
      }
      if (signal?.aborted) return cancelled()
      if (!isConsentEnabled()) return disabledFailure()

      // 9. Open single file handle (TOCTOU-safe across stat, hash, and upload)
      let fh
      try {
        fh = await openImpl(resolvedPath, 'r')
      } catch (err) {
        if (err?.code === 'EISDIR') {
          return failure('ARGON_SLICE_NOT_A_FILE', 'Target path must be a regular file.')
        }
        return failure('ARGON_SLICE_FILE_NOT_FOUND', 'Target file does not exist or cannot be accessed.')
      }

      let handleRefs = 1
      let handleClosed = false
      const releaseHandle = async () => {
        handleRefs -= 1
        if (handleRefs <= 0 && !handleClosed) {
          handleClosed = true
          await fh.close().catch(() => {})
        }
      }

      try {
        let st
        try {
          st = await fh.stat()
        } catch {
          return failure('ARGON_SLICE_FILE_NOT_FOUND', 'Target file metadata could not be read.')
        }
        if (!st.isFile()) {
          return failure('ARGON_SLICE_NOT_A_FILE', 'Target path must be a regular file.')
        }
        if (st.size <= 0) {
          return failure('ARGON_SLICE_EMPTY_FILE', 'Target file is empty and cannot be uploaded.')
        }
        if (st.size > GEMINI_FILES_MAX_BYTES) {
          return failure('ARGON_SLICE_FILE_TOO_LARGE', 'Target file exceeds the 2 GiB Gemini Files API size limit.')
        }

        // 9. Stream SHA-256 directly from open handle
        let sha256
        try {
          sha256 = await hashHandleSha256(fh, st.size, signal)
        } catch (err) {
          if (isAbortError(err, signal)) return cancelled()
          if (err?.code === 'ARGON_SLICE_FILE_CHANGED') {
            return failure('ARGON_SLICE_FILE_CHANGED', 'Target file changed while reading.')
          }
          return failure('ARGON_SLICE_READ_FAILED', 'Failed to read target file for hashing.')
        }
        if (signal?.aborted) return cancelled()
        if (!isConsentEnabled()) return disabledFailure()

        // 10. Create Gemini Files client (Gemini Developer API only)
        let client
        try {
          client = await createGeminiFilesClient({
            GoogleGenAI,
            resolveSecret,
            apiKeyEnv: routes?.googleApiKeyEnv ?? 'GOOGLE_API_KEY',
            baseURL: routes?.googleBaseUrl,
            fetchImpl,
          })
        } catch (err) {
          if (err?.code === 'MISSING_CREDENTIAL') {
            return failure('ARGON_SLICE_CREDENTIAL_MISSING', 'Gemini API credentials are not configured.')
          }
          return failure('ARGON_SLICE_CONFIG_ERROR', 'Gemini Files API client configuration is invalid.')
        }
        if (signal?.aborted) return cancelled()
        if (!isConsentEnabled()) return disabledFailure()

        // 11. Unique displayName per call (random nonce prevents $ref collision even if callId is reused)
        const displayNonce = randomBytes(4).toString('hex')
        const displayName = `slice_${sha256.slice(0, 8)}_${displayNonce}_${sanitizeBasename(basename(resolvedPath))}`
        let uploaded
        try {
          uploaded = await fileSliceHub.getOrUpload({
            principalHash: client.principalHash,
            endpointBase: client.endpointBase,
            sha256,
            mimeType,
            signal,
            uploadFn: async sharedSignal => {
              // Ref-count handle so detaching initiator on abort never closes fh while another waiter still needs it.
              handleRefs += 1
              try {
                const file = await client.uploadFile({
                  fileHandle: fh,
                  mimeType,
                  displayName,
                  sizeBytes: st.size,
                  expectedSha256: sha256,
                  shouldContinue: isConsentEnabled,
                  signal: sharedSignal,
                })
                return await client.waitForActive({
                  file,
                  signal: sharedSignal,
                  ...(sleepImpl ? { sleepImpl } : {}),
                })
              } finally {
                await releaseHandle()
              }
            },
          })
        } catch (err) {
          if (err?.code === 'ARGON_FILE_SLICING_DISABLED') {
            return disabledFailure()
          }
          if (isAbortError(err, signal)) return cancelled()
          if (err?.code === 'ARGON_SLICE_TOO_MANY_UPLOADS') {
            return failure('ARGON_SLICE_TOO_MANY_UPLOADS', 'Too many concurrent file uploads in progress; retry shortly.')
          }
          if (err?.code === 'ARGON_SLICE_CLOSED') {
            return failure('ARGON_SLICE_UNAVAILABLE', 'File slicing service is closed.')
          }
          if (err?.code === 'GEMINI_FILE_READ_FAILED') {
            return failure('ARGON_SLICE_FILE_CHANGED', 'Target file changed during upload.')
          }
          if (err?.code === 'GEMINI_FILE_PROCESSING_FAILED') {
            return failure('ARGON_SLICE_PROCESSING_FAILED', 'Gemini Files API failed while processing the uploaded file.')
          }
          if (err?.code === 'GEMINI_FILE_PROCESSING_TIMEOUT') {
            return failure('ARGON_SLICE_PROCESSING_TIMEOUT', 'Timed out waiting for Gemini Files API to finish processing the file.')
          }
          if (typeof err?.status === 'number') {
            const codeSuffix = typeof err.upstreamCode === 'string' ? ` ${err.upstreamCode}` : ''
            return failure('ARGON_SLICE_UPLOAD_FAILED', `Gemini Files API upload failed (HTTP ${err.status}${codeSuffix}).`)
          }
          return failure('ARGON_SLICE_UPLOAD_FAILED', 'Gemini Files API upload failed.')
        }

        if (signal?.aborted) return cancelled()
        if (!isConsentEnabled()) return disabledFailure()

        // 12. Register slice in hub
        const record = fileSliceHub.registerSlice({
          sessionId,
          callId,
          route: 'google-generative-ai',
          principalHash: client.principalHash,
          endpointBase: client.endpointBase,
          uri: uploaded.uri,
          name: uploaded.name,
          mimeType: uploaded.mimeType || mimeType,
          category,
          displayName,
          slice,
          expirationTimeMs: uploaded.expirationTimeMs,
        })

        // 13. Final abort & consent re-check before returning
        if (signal?.aborted) return cancelled()
        return {
          ok: true,
          sliceId: record.sliceId,
          fileName: uploaded.name,
          mimeType: uploaded.mimeType || mimeType,
          category,
          sizeBytes: Number.isFinite(uploaded.sizeBytes) ? uploaded.sizeBytes : st.size,
          slice,
          reusedUpload: Boolean(uploaded.reusedUpload),
          expiresAt: new Date(record.expirationTimeMs).toISOString(),
        }
      } finally {
        await releaseHandle()
      }
    },
  }
}
