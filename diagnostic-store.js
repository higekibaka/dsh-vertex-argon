import { shared } from './runtime.js'
import { transportErrorCodes, MAX_RECORDED_HOPS } from './diagnostics.js'

const { z } = await shared('zod')
const { TypertRemoteService, Remote } = await shared('@deepseek-ai/dsh-typert-protocol')

const nullableId = z.string().regex(/^[A-Za-z0-9._:/-]{1,160}$/).nullable()
const nullableFinishReason = z.string().regex(/^[A-Z0-9_]{1,64}$/).nullable()
const count = z.number().int().nonnegative()
const positiveInt = z.number().int().positive()

const hopSchema = z.object({
  hopIndex: positiveInt,
  trigger: z.enum(['initial', 'continuation', 'checkpoint-reconnect', 'retry-same-checkpoint']),
  usedContinuationToken: z.boolean(),
  backoffDelayMs: count,
  bodyBytes: count.nullable(),
  status: z.number().int().min(100).max(599).nullable(),
  durationMs: count,
  chunkCount: count,
  hasCheckpoint: z.boolean(),
  finishReason: nullableFinishReason,
  outcome: z.enum(['pending', 'done', 'continued', 'dropped', 'transport-error', 'api-error', 'aborted']),
  errorCodes: z.array(z.enum(transportErrorCodes)).max(8),
}).strict()

const tokenUsageSchema = z.object({
  reportedInputTokens: count.nullable(),
  reportedCacheTokens: count.nullable(),
  outputTokens: count.nullable(),
  thoughtsTokens: count.nullable(),
  billedPromptTokens: count.nullable(),
  billedCachedTokens: count.nullable(),
  billedTotalTokens: count.nullable(),
}).strict()

export const recordSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  startedAt: z.string().datetime(),
  sessionHash: z.string().regex(/^[0-9a-f]{24}$/).nullable(),
  route: z.enum(['google-vertex', 'google-generative-ai']),
  model: nullableId,
  apiVersion: z.enum(['v1', 'v1beta1', 'v1beta']),
  thinkingLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  longDecodeEnabled: z.boolean(),
  configuredMaxTokens: positiveInt.nullable(),
  hopCount: count,
  continuationCount: count,
  reconnectCount: count,
  recoveredFromDrop: z.boolean(),
  hops: z.array(hopSchema).max(MAX_RECORDED_HOPS),
  hopsDropped: count,
  tokenUsage: tokenUsageSchema,
  outcome: z.enum(['unknown', 'done', 'max-tokens', 'tool-calls', 'error', 'aborted', 'incomplete']),
  failureCategory: z.enum([
    'initial-connect-error',
    'mid-stream-drop',
    'api-status-error',
    'transient-finish-reason',
    'other',
  ]).nullable(),
  durationMs: count,
}).strict()

export const diagnosticDomain = {
  name: 'vertex_argon_diagnostics',
  version: 1,
  layout: 'per-record',
  tables: { requests: { valueSchema: recordSchema } },
}

export function diagnosticWriter(domain, warn = () => {}, limit = 200) {
  let tail = Promise.resolve()
  let pending = 0
  let closed = false
  let warned = false
  let failed = false
  const notify = () => {
    if (!warned) {
      warned = true
      try {
        warn('Vertex Argon diagnostic storage unavailable or overloaded; some metadata was not saved.')
      } catch {}
    }
  }
  const table = domain.table('requests')
  return {
    record(value) {
      if (closed || failed || pending >= 32) {
        notify()
        return
      }
      const parsed = recordSchema.safeParse(value)
      if (!parsed.success) {
        notify()
        return
      }
      pending++
      tail = tail
        .then(async () => {
          if (failed) return
          const oldest = [...table.entries()].sort((a, b) => a[1].startedAt.localeCompare(b[1].startedAt))
          for (const [id] of oldest.slice(0, Math.max(0, oldest.length - limit + 1))) {
            if (!(await table.delete(id))) throw new Error('diagnostic retention failed')
          }
          await table.put(parsed.data.id, parsed.data)
        })
        .catch(() => {
          failed = true
          notify()
        })
        .finally(() => {
          pending--
        })
    },
    list(max = 20) {
      try {
        const cap = Math.min(Math.max(1, Number(max) || 20), limit)
        return [...table.entries()]
          .map(([, v]) => v)
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
          .slice(0, cap)
      } catch {
        return []
      }
    },
    async close() {
      closed = true
      await tail
      await domain.close()
    },
    async flush() {
      await tail
    },
  }
}

export function createDiagnosticHub(limit = 200) {
  const memory = new Map()
  let activeWriter = null
  const trimMemory = () => {
    if (memory.size <= limit) return
    const sorted = [...memory.entries()].sort((a, b) => a[1].startedAt.localeCompare(b[1].startedAt))
    for (const [id] of sorted.slice(0, memory.size - limit)) {
      memory.delete(id)
    }
  }
  return {
    record(value) {
      const parsed = recordSchema.safeParse(value)
      if (!parsed.success) return
      memory.set(parsed.data.id, parsed.data)
      trimMemory()
      activeWriter?.record(parsed.data)
    },
    attachWriter(writer) {
      activeWriter = writer
      try {
        for (const item of writer.list(limit)) {
          if (!memory.has(item.id)) memory.set(item.id, item)
        }
        trimMemory()
      } catch {}
    },
    detachWriter(writer) {
      if (activeWriter === writer) activeWriter = null
    },
    listRecent(max = 20) {
      const cap = Math.min(Math.max(1, Number(max) || 20), limit)
      const merged = new Map(memory)
      if (activeWriter) {
        for (const item of activeWriter.list(limit)) {
          merged.set(item.id, item)
        }
      }
      return [...merged.values()]
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, cap)
    },
  }
}

function remoteMarker(prototype, name) {
  let initializer
  Remote(prototype[name], {
    name,
    private: false,
    static: false,
    addInitializer(fn) {
      initializer = fn
    },
  })
  return initializer
}

function parseListRecentRequest(value) {
  if (value === undefined || value === null) return { limit: 20 }
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid diagnostics request')
  const limit = value.limit === undefined ? 20 : Number(value.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid diagnostics limit')
  return { limit }
}

function parseListRecentResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid diagnostics response')
  if (value.ok === false) {
    if (typeof value.error !== 'string') throw new Error('Invalid diagnostics error response')
    return value
  }
  if (value.ok !== true || !Array.isArray(value.records)) throw new Error('Invalid diagnostics records response')
  return value
}

function diagnosticsCodec(direction) {
  const schema = {
    parse: value => (direction === 'request' ? parseListRecentRequest(value) : parseListRecentResult(value)),
  }
  return {
    mode: 'strict',
    typeSymbol: 'dsh-vertex-argon/listRecent' + (direction === 'request' ? 'Request' : 'Result'),
    schema,
    create: () => schema,
  }
}

export function diagnosticsInvocation() {
  return {
    id: 'dsh-vertex-argon#vertexArgonDiagnostics/listRecent',
    service: 'vertexArgonDiagnostics',
    namespace: 'vertexArgonDiagnostics',
    method: 'listRecent',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: diagnosticsCodec('request') }],
    result: diagnosticsCodec('result'),
  }
}

export const DIAGNOSTICS_REMOTE = {
  package: 'dsh-vertex-argon',
  descriptors: [diagnosticsInvocation()],
}

export class ArgonDiagnosticsService extends TypertRemoteService {
  constructor(ctx, hub) {
    super(ctx, 'vertexArgonDiagnostics')
    this.hub = hub
    remoteMarker(Object.getPrototypeOf(this), 'listRecent').call(this)
  }
  async listRecent(request) {
    try {
      const { limit } = parseListRecentRequest(request)
      return { ok: true, records: this.hub.listRecent(limit) }
    } catch {
      return { ok: false, error: 'Failed to read Vertex Argon diagnostics' }
    }
  }
}
