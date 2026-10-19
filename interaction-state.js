import { createHash, randomUUID } from 'node:crypto'
import { shared } from './runtime.js'
import { HOST_SHUTDOWN_CODE, interactionExitReason, cancelsRemoteInteraction } from './interaction-lifecycle.js'
const { z } = await shared('zod')
const hash = value => createHash('sha256').update(value).digest('hex')
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const interactionStateDomain = {
  name: 'vertex_argon_interactions', version: 2, compatibleVersions: [1], layout: 'per-record',
  tables: { tasks: { valueSchema: z.object({
    key: digest, sessionHash: digest, endpointHash: digest, principalHash: digest,
    stage: z.enum(['creating', 'accepted', 'unknown', 'cancel-failed']),
    interactionId: z.string().min(1).max(4096).nullable(),
    lastEventId: z.string().max(4096).nullable(),
    updatedAt: z.string().datetime(),
    requestKey: digest.optional(),
    releasedAt: z.string().datetime().optional(),
    uncertainAt: z.string().datetime().optional(),
  }).strict() } },
}

// Only opaque remote handles and hashes are persisted, never messages or keys.
// On a cold resume, replay the remote event stream from its beginning into a
// fresh DSH turn accumulator. A saved cursor alone cannot reconstruct lost text.
export const BACKGROUND_CREATE_TIMEOUT_MS = 60000
export const REMOTE_CANCEL_TIMEOUT_MS = 30000

export function createInteractionStateHub({ closeTimeoutMs = BACKGROUND_CREATE_TIMEOUT_MS + REMOTE_CANCEL_TIMEOUT_MS + 5000 } = {}) {
  let table, domain, failure, closed = false
  const active = new Map()
  return {
    attach(handle) { domain = handle; table = handle.table('tasks') },
    fail() { failure = true },
    requireReady() {
      if (closed || failure || !table) throw new Error('Persistent Interactions recovery storage is unavailable; background execution was not started.')
    },
    identity({ sessionId, endpoint, principalHash, body, purpose }) {
      if (!sessionId) throw new Error('Background Interactions requires a DSH session ID for durable recovery.')
      const sessionHash = hash(sessionId + ':' + (purpose ?? 'chat'))
      const endpointHash = hash(endpoint)
      const requestKey = hash(JSON.stringify([sessionHash, endpointHash, principalHash, body]))
      const attempts = table ? [...table.entries()].map(([, row]) => row).filter(row => (row.requestKey ?? row.key) === requestKey) : []
      const unresolved = attempts.find(row => !row.releasedAt)
      // A user-released attempt remains intact for audit; a new attempt gets a new key.
      const key = unresolved?.key ?? (attempts.length ? hash(requestKey + ':' + randomUUID()) : requestKey)
      return { key, sessionHash, endpointHash, principalHash, requestKey }
    },
    get(key) { this.requireReady(); return table.get(key) },
    entries() { this.requireReady(); return [...table.entries()].map(([, v]) => v) },
    async put(identity, fields) {
      this.requireReady()
      if (!table.get(identity.key) && table.size >= 200) {
        // Bound local audit history, but never evict an unresolved cloud attempt.
        const oldestReleased = [...table.entries()].map(([, row]) => row).filter(row => row.releasedAt).sort((a, b) => a.releasedAt < b.releasedAt ? -1 : (a.releasedAt > b.releasedAt ? 1 : 0))[0]
        if (!oldestReleased) throw new Error('Background recovery storage is full; resolve outstanding remote tasks before starting another.')
        await table.delete(oldestReleased.key)
      }
      const value = { ...identity, stage: 'creating', interactionId: null, lastEventId: null, ...fields, updatedAt: new Date().toISOString() }
      await table.put(identity.key, value)
      return value
    },
    async remove(key) { this.requireReady(); await table.delete(key) },
    claim(key, controller = new AbortController(), sessionHash) {
      this.requireReady()
      if (active.has(key) || (sessionHash && [...active.values()].some(value => value.sessionHash === sessionHash))) throw new Error('This background interaction or session is already being consumed.')
      const value = { controller, sessionHash }
      active.set(key, value)
      return { signal: controller.signal, release: () => { if (active.get(key) === value) active.delete(key) } }
    },
    isActive(key) { return active.has(key) },
    async releaseUnknown({ key, expectedUpdatedAt, acknowledgeRisk }) {
      this.requireReady()
      if (acknowledgeRisk !== true) throw new Error('Explicit acknowledgement of possible duplicate cloud charges is required.')
      const record = table.get(key)
      if (!record || record.updatedAt !== expectedUpdatedAt) throw new Error('The recovery record changed; refresh before confirming.')
      if (record.releasedAt) return record
      if (record.interactionId || !['creating', 'unknown'].includes(record.stage)) throw new Error('Only an unresolved creation without a remote ID can be released here.')
      const claim = this.claim(key, new AbortController(), record.sessionHash)
      try {
        const now = new Date().toISOString()
        const released = { ...record, uncertainAt: record.updatedAt, releasedAt: now, updatedAt: now }
        await table.put(key, released)
        return released
      } finally { claim.release() }
    },
    async close() {
      // Keep storage open until in-flight ID discovery and cleanup have settled.
      for (const { controller } of active.values()) controller.abort(Object.assign(new Error('Host shutdown interrupted local reading.'), { name: 'AbortError', code: HOST_SHUTDOWN_CODE }))
      const deadline = Date.now() + closeTimeoutMs
      while (active.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
      closed = true
      await domain?.close()
    },
  }
}

export function durableInteractionTransport(base, hub, identity, { signal, onEvent } = {}) {
  let task = hub.get(identity.key)
  if (task?.releasedAt) throw new Error('This attempt was released by the user; obtain a fresh request identity before creating another.')
  let terminal = false
  let lastEventId = task?.lastEventId ?? null
  let stopped = false
  let cancelPromise
  const isTerminal = status => ['completed', 'requires_action', 'incomplete', 'failed', 'cancelled'].includes(status)
  async function save(stage = 'accepted') {
    task = await hub.put(identity, { stage, interactionId: task?.interactionId ?? null, lastEventId })
  }
  async function* watch(events, initial) {
    if (initial) yield { event_type: 'interaction.created', interaction: initial }
    const source = typeof events === 'function' ? await events() : events
    for await (const event of source) {
      const id = event.interaction?.id ?? event.interaction_id
      if (id && task?.interactionId && id !== task.interactionId) throw Object.assign(new Error('Interaction ID changed during recovery.'), { code: 'ARGON_INTERACTIONS_PROTOCOL' })
      const status = event.interaction?.status ?? event.status
      if (isTerminal(status)) terminal = true
      if (event.event_id && event.event_id !== lastEventId) {
        lastEventId = event.event_id
        await save()
      }
      onEvent?.(event)
      yield event
    }
  }
  return {
    get interactionId() { return task?.interactionId },
    get cancellationState() { return stopped ? 'confirmed' : cancelPromise || task?.stage === 'unknown' || task?.stage === 'cancel-failed' ? 'unconfirmed' : 'not-requested' },
    async create(body) {
      signal?.throwIfAborted()
      if (task) {
        if (!task.interactionId) throw new Error('A previous background creation has an unknown outcome; refusing a duplicate billable POST. Open Vertex Argon settings > Background recovery to review and explicitly release the local block.')
        if (task.stage === 'cancel-failed') {
          await this.cancel(task.interactionId)
          throw new Error('The previous background task is now cancelled. Start the request again explicitly if still needed.')
        }
        return watch(() => base.get(task.interactionId, { stream: true, signal }), { id: task.interactionId, status: 'in_progress' })
      }
      // A changed prompt must not evade the unknown-create/active-task guard.
      for (const previous of hub.entries()) {
        if (previous.releasedAt || previous.key === identity.key || previous.sessionHash !== identity.sessionHash) continue
        if (hub.isActive(previous.key) || !previous.interactionId) throw new Error('This session has an active or unknown-outcome background task; resolve it before creating another.')
        if (previous.endpointHash !== identity.endpointHash || previous.principalHash !== identity.principalHash) throw new Error('This session has an outstanding task on another route or credential; cancel it with its original configuration first.')
        throw new Error('This session has an outstanding remote task for another request; explicitly resolve it before creating another.')
      }
      // Persist intent before POST. Fetch cancellation is shielded only after dispatch,
      // until the first created event gives us an addressable remote task.
      await save('creating')
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new DOMException('Background creation acknowledgement timed out.', 'TimeoutError')), BACKGROUND_CREATE_TIMEOUT_MS)
      timer.unref?.()
      let iterator
      try {
        if (signal?.aborted) throw Object.assign(new Error('Request stopped before dispatch.'), { name: 'AbortError', requestSubmitted: false })
        const source = await base.create({ ...body, background: true, store: true, stream: true }, { signal: controller.signal, preDispatchSignal: signal })
        if (!source?.[Symbol.asyncIterator]) throw new Error('Background creation returned no event stream.')
        iterator = source[Symbol.asyncIterator]()
        const first = await iterator.next()
        const created = first.value?.interaction
        if (first.done || (first.value?.event_type ?? first.value?.type) !== 'interaction.created' || typeof created?.id !== 'string' || !created.id || created.id.length > 4096) throw new Error('Background stream ended or returned an invalid first event before its interaction ID.')
        task = { ...task, interactionId: created.id }
        await save()
        clearTimeout(timer)
        if (signal?.aborted) {
          if (cancelsRemoteInteraction(interactionExitReason(signal.reason, signal))) await this.cancel(created.id)
          signal.throwIfAborted()
        }
        // The create stream is only an ID-discovery channel. Its deltas need not
        // have event_id; the documented resumable background stream is GET.
        // Background execution continues when this local POST response is closed.
        // No generated content has escaped, so GET can start from the beginning.
        return watch(() => base.get(created.id, { stream: true, signal }), { id: created.id, status: created.status ?? 'in_progress' })
      } catch (error) {
        if (task?.interactionId) {
          // Keep a known ID recoverable even if persisting/consuming the first event failed.
          if (signal?.aborted && cancelsRemoteInteraction(interactionExitReason(signal.reason, signal))) { try { await this.cancel(task.interactionId) } catch {} }
        } else if (error.requestSubmitted === false || [400, 401, 402, 403, 404, 405, 413, 415, 422, 429].includes(error.status)) {
          await hub.remove(identity.key); task = undefined
        } else {
          await save('unknown')
          error.message += ' Background creation outcome is unknown. Open Vertex Argon settings > Background recovery to review this record; no automatic resubmission was made.'
          error.code = 'ARGON_BACKGROUND_UNKNOWN'
        }
        throw error
      } finally {
        clearTimeout(timer)
        controller.abort()
        try { await iterator?.return?.() } catch {}
      }
    },
    async get(id, options) { return watch(() => base.get(id, options)) },
    async cancel(id, options = {}) {
      if (stopped) return
      if (cancelPromise) return cancelPromise
      const signal = options.signal ?? AbortSignal.timeout(REMOTE_CANCEL_TIMEOUT_MS)
      cancelPromise = (async () => {
      try {
        let response
        try { response = await base.cancel(id, { signal }) } catch (error) {
          if (error.status !== 409) throw error
        }
        for (let attempt = 0; !isTerminal(response?.status) && attempt < 3; attempt++) {
          if (attempt) await new Promise(resolve => setTimeout(resolve, 250 * (2 ** attempt)))
          response = await base.get(id, { signal })
        }
        if (!isTerminal(response?.status)) throw new Error('Remote cancellation did not reach a terminal status.')
        stopped = true
        await hub.remove(identity.key)
      } catch (error) {
        if (error.status === 404) { stopped = true; await hub.remove(identity.key); return }
        await save('cancel-failed')
        throw error
      }
      })()
      return cancelPromise
    },
    async finish({ complete = false, reason = 'consumer-abandoned' } = {}) {
      if (stopped || !task) return
      if (complete && terminal) { await hub.remove(identity.key); return }
      if (task.interactionId && !terminal && cancelsRemoteInteraction(reason)) await this.cancel(task.interactionId)
      // A completed remote task with an interrupted local replay is retained:
      // the next attempt can replay its missing output without another POST.
    },
  }
}
