import { shared } from './runtime.js'
import { inspectorInvocations, INSPECTOR_SESSION_METHODS, createInspectorOperations } from './inspector-service.js'
import { transportErrorCodes, MAX_RECORDED_HOPS, diagnosticSessionHash } from './diagnostics.js'
import { USAGE_COUNT_KEYS, USAGE_DETAIL_KEYS, USAGE_MODALITIES, MAX_USAGE_ROWS } from './usage-details.js'

const { z } = await shared('zod')
const { TypertRemoteService, Remote } = await shared('@deepseek-ai/dsh-typert-protocol')

const nullableId = z.string().regex(/^[A-Za-z0-9._:/-]{1,160}$/).nullable()
const nullableFinishReason = z.string().regex(/^[A-Z0-9_]{1,64}$/).nullable()
const count = z.number().int().nonnegative()
const positiveInt = z.number().int().positive()

const hopSchema = z.object({
  hopIndex: positiveInt,
  trigger: z.enum(['initial', 'continuation', 'checkpoint-reconnect', 'retry-same-checkpoint', 'retry-original', 'interaction-create', 'interaction-resume']),
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
  errorPhase: z.enum(['pre-dispatch', 'fetch', 'response-body', 'stream']).optional(),
  streamErrorStatus: z.number().int().min(400).max(599).optional(),
  requestSubmitted: z.boolean().optional(),
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

const normalizedUsageSchema = z.object({
  ...Object.fromEntries(USAGE_COUNT_KEYS.map(key => [key, count.nullable()])),
  ...Object.fromEntries(USAGE_DETAIL_KEYS.map(key => [key, z.array(z.object({ modality: z.enum(USAGE_MODALITIES), tokens: count }).strict()).max(USAGE_MODALITIES.length).nullable()])),
}).strict()
const usageDetailsSchema = z.object({
  aggregate: normalizedUsageSchema.nullable(), aggregateComplete: z.boolean(), omittedRows: count,
  rows: z.array(z.object({ kind: z.enum(['gc-hop', 'interaction-step']), index: count.max(4095), usage: normalizedUsageSchema.nullable(), complete: z.boolean(), observedServiceTier: z.enum(['standard', 'flex', 'priority', 'provisioned']).nullable() }).strict()).max(MAX_USAGE_ROWS),
}).strict()

const associationSchema = z.object({
  version: z.literal(1), sessionId: z.string().min(1).max(256), settlementSeq: count,
  eventType: z.enum(['assistant/message','assistant/attempt']), turn: count, step: count,
  messageId: z.string().min(1).max(256).optional(), provider: z.string().min(1).max(256), model: z.string().min(1).max(256),
}).strict()

export const recordSchema = z.object({
  association: associationSchema.optional(),
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  id: z.string().uuid(),
  startedAt: z.string().datetime(),
  sessionHash: z.string().regex(/^[0-9a-f]{24}$/).nullable(),
  route: z.enum(['google-vertex', 'google-generative-ai']),
  model: nullableId,
  protocol: z.enum(['generate-content', 'interactions']).optional(),
  regionClass: z.enum(['global','non-global']).nullable().optional(),
  background: z.boolean().optional(),
  remoteCancellation: z.enum(['not-requested', 'confirmed', 'unconfirmed']).optional(),
  serviceTier: z.object({ requested: z.enum(['standard', 'flex', 'priority']), observed: z.enum(['standard', 'flex', 'priority', 'provisioned', 'mixed']).nullable(), source: z.enum(['response-header', 'traffic-type']).nullable() }).strict().optional(),
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
  usageDetails: usageDetailsSchema.optional(),
  responseCapture: z.object({ status: z.enum(['disabled','unavailable','captured','truncated']), frames: count, omittedFrames: count, bytes: count, captureError: z.boolean() }).strict().optional(),
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
  version: 2,
  compatibleVersions: [1],
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
          // Bolt ⚡: Optimized ISO 8601 date string sorting by replacing slow localeCompare with operators
          const oldest = [...table.entries()].filter(([id]) => id !== parsed.data.id).sort((a, b) => a[1].startedAt < b[1].startedAt ? -1 : (a[1].startedAt > b[1].startedAt ? 1 : 0))
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
          // Bolt ⚡: Optimized ISO 8601 date string sorting by replacing slow localeCompare with operators
          .sort((a, b) => b.startedAt < a.startedAt ? -1 : (b.startedAt > a.startedAt ? 1 : 0))
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
    // Bolt ⚡: Optimized ISO 8601 date string sorting by replacing slow localeCompare with operators
    const sorted = [...memory.entries()].sort((a, b) => a[1].startedAt < b[1].startedAt ? -1 : (a[1].startedAt > b[1].startedAt ? 1 : 0))
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
    link(id, association) {
      const current = memory.get(id)
      if (!current || current.association || current.sessionHash !== diagnosticSessionHash(association?.sessionId)) return
      const parsed = recordSchema.safeParse({ ...current, association })
      if (!parsed.success) return
      memory.set(id, parsed.data)
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
          if (!merged.has(item.id)) merged.set(item.id, item)
        }
      }
      return [...merged.values()]
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, cap)
    },
  }
}

// Decorate once: Typert clones/freezes readers and compares that record by identity.
const inspectorSessionRemote = Remote({resources:{session:request=>request.sessionId}})

function remoteMarker(prototype, name) {
  let initializer
  const decorate = INSPECTOR_SESSION_METHODS.includes(name) ? inspectorSessionRemote : Remote
  decorate(prototype[name], {
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


function parseReleaseUnknown(value) {
  return z.object({ key: z.string().regex(/^[a-f0-9]{64}$/), expectedUpdatedAt: z.string().datetime(), acknowledgeRisk: z.literal(true) }).strict().parse(value)
}

export function recoveryInvocations() {
  return ['listRecovery', 'releaseUnknown'].map(method => {
    const makeCodec = direction => {
      const schema = { parse(value) {
        if (direction === 'request') return method === 'listRecovery' ? parseListRecentRequest(value) : parseReleaseUnknown(value)
        if (method === 'listRecovery') return parseListRecentResult(value)
        if (!value || typeof value !== 'object' || typeof value.ok !== 'boolean') throw new Error('Invalid recovery response')
        return value
      } }
      return { mode: 'strict', typeSymbol: 'dsh-vertex-argon/' + method + '/' + direction, schema, create: () => schema }
    }
    return { id: 'dsh-vertex-argon#vertexArgonDiagnostics/' + method, service: 'vertexArgonDiagnostics', namespace: 'vertexArgonDiagnostics', method,
      invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec: makeCodec('request') }], result: makeCodec('result') }
  })
}

export const DIAGNOSTICS_REMOTE = {
  package: 'dsh-vertex-argon',
  descriptors: [diagnosticsInvocation(), ...recoveryInvocations(), ...inspectorInvocations()],
}

export class ArgonDiagnosticsService extends TypertRemoteService {
  constructor(ctx, hub, taskHub, inspectorOptions) {
    super(ctx, 'vertexArgonDiagnostics')
    this.hub = hub
    this.taskHub = taskHub
    this.inspector = createInspectorOperations(hub, inspectorOptions)
    ctx.effect(() => () => this.inspector.close(), 'vertex-argon: inspector lookup lifetime')
    for (const method of ['listRecent', 'listRecovery', 'releaseUnknown', ...inspectorInvocations().map(d=>d.method)]) remoteMarker(Object.getPrototypeOf(this), method).call(this)
  }
  listRequests(request) { return this.inspector.listRequests(request) }
  getOverview(request) { return this.inspector.getOverview(request) }
  getRequest(request) { return this.inspector.getRequest(request) }
  readResponse(request) { return this.inspector.readResponse(request) }
  queryInteraction(request, signal) { return this.inspector.queryInteraction(request, signal) }
  readQueryResponse(request) { return this.inspector.readQueryResponse(request) }
  async listRecovery(request) {
    try {
      const { limit } = parseListRecentRequest(request)
      const records = this.taskHub.entries().sort((a, b) => Number(Boolean(a.releasedAt)) - Number(Boolean(b.releasedAt)) || b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit).map(row => ({
        key: row.key, sessionHash: row.sessionHash.slice(0, 12), stage: row.stage, updatedAt: row.updatedAt,
        releasedAt: row.releasedAt ?? null, uncertainAt: row.uncertainAt ?? null, hasRemoteId: Boolean(row.interactionId), active: this.taskHub.isActive(row.key),
      }))
      return { ok: true, records }
    } catch { return { ok: false, error: 'Background recovery storage is unavailable.' } }
  }
  // User-only risk acknowledgement: not exposed as an Agent tool. This neither
  // cancels/deletes a cloud task nor starts a new request.
  async releaseUnknown(request) {
    try {
      const parsed = parseReleaseUnknown(request)
      await this.taskHub.releaseUnknown(parsed)
      return { ok: true, released: true, remoteAction: 'none', newRequestStarted: false }
    } catch (error) { return { ok: false, error: error.message ?? 'Failed to release the local recovery block.' } }
  }
  async listRecent(request) {
    try {
      const { limit } = parseListRecentRequest(request)
      return { ok: true, records: this.hub.listRecent(limit).map(({association, ...record}) => record) }
    } catch {
      return { ok: false, error: 'Failed to read Vertex Argon diagnostics' }
    }
  }
}
