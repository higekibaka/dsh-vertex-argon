import { shared } from './runtime.js'
import { createInteractionStateHub, interactionStateDomain } from './interaction-state.js'
import { SERVICE_TIERS } from './service-level.js'
import { createResponseHub, responseDomain } from './response-store.js'
import { inspectorInvocations } from './inspector-service.js'
import { createInspectorTool } from './inspector-tool.js'
import { createRequestAssociationHub } from './request-association.js'
const { default: z } = await shared('@deepseek-ai/schemastery')
import {
  createArgonAdapter,
  createConfiguredInteractionQuery,
  installGemini4PiAiPatch,
  resolveConfigValues,
  detectPiAiArgonRoutes,
  PROVIDER,
  NATIVE_PROVIDER,
  LEVELS,
  MAX_SINGLE_CALL_TOKENS,
  MAX_LONG_DECODE_TOKENS,
} from './adapter.js'
import {
  diagnosticDomain,
  diagnosticWriter,
  createDiagnosticHub,
  diagnosticsInvocation,
  recoveryInvocations,
  ArgonDiagnosticsService,
} from './diagnostic-store.js'

export const name = 'local-vertex-argon'
export const inject = ['llm']
export const Config = z.object({
  showInModelPicker: z.boolean().default(true).volatile(),
  reasoning: z.union(LEVELS).default('medium').volatile(),
  longDecode: z.boolean().default(true).volatile(),
  googleProtocol: z.union(['generate-content', 'interactions']).default('generate-content').volatile(),
  vertexProtocol: z.union(['generate-content', 'interactions']).default('generate-content').volatile(),
  googleServiceTier: z.union(SERVICE_TIERS).default('standard').volatile(),
  vertexServiceTier: z.union(SERVICE_TIERS).default('standard').volatile(),
  vertexPaygoOnly: z.boolean().default(false).volatile(),
  retainRawResponses: z.boolean().default(false).volatile(),
  interactionsBackground: z.boolean().default(false).volatile(),
  allowInteractionStorage: z.boolean().default(false).volatile(),
  contextWindow: z.number().step(1).min(1).max(1048576).default(1048576).volatile(),
  maxTokens: z.number().step(1).min(1).max(MAX_LONG_DECODE_TOKENS).default(MAX_SINGLE_CALL_TOKENS).volatile(),
})

export function apply(ctx, config) {
  const hub = createDiagnosticHub()
  const associations = createRequestAssociationHub((id, locator) => hub.link(id, locator))
  ctx.effect(() => () => associations.close(), 'vertex-argon: request association lifetime')
  const taskHub = createInteractionStateHub()
  const responseHub = createResponseHub()
  const query = createConfiguredInteractionQuery(ctx, () => config)
  ctx.effect(() => () => query.close(), 'vertex-argon: read-only query lifetime')
  ctx.effect(() => () => responseHub.close(), 'vertex-argon: raw response memory lifetime')
  ctx.inject?.(['storageDomain'], async storageCtx => {
    let disposed = false, domain
    storageCtx.effect(() => async () => { disposed = true; await responseHub.detach(domain) }, 'vertex-argon: opt-in raw response retention')
    try {
      domain = await storageCtx.storageDomain.open(responseDomain)
      if (disposed) { await domain.close(); return }
      responseHub.attach(domain)
    } catch {
      try { await domain?.close() } catch {}
      storageCtx.logger?.warn?.('Vertex Argon raw response storage unavailable; enabled captures are memory-only.')
    }
  })
  ctx.inject?.(['storageDomain'], async storageCtx => {
    let disposed = false
    storageCtx.effect(() => async () => { disposed = true; await taskHub.close() }, 'vertex-argon: background interaction recovery')
    try {
      const domain = await storageCtx.storageDomain.open(interactionStateDomain)
      if (disposed) { await domain.close(); return }
      taskHub.attach(domain)
    } catch {
      taskHub.fail()
      storageCtx.logger?.warn?.('Vertex Argon background recovery storage unavailable; background creation is disabled.')
    }
  })
  ctx.inject?.(['storageDomain'], async storageCtx => {
    let disposed = false
    let writer
    storageCtx.effect(() => async () => {
      disposed = true
      if (writer) hub.detachWriter(writer)
      await writer?.close()
    }, 'vertex-argon: bounded diagnostics')
    let domain
    try {
      domain = await storageCtx.storageDomain.open(diagnosticDomain)
      if (disposed) {
        await domain.close()
        return
      }
      writer = diagnosticWriter(domain, message => storageCtx.logger?.warn?.(message))
      hub.attachWriter(writer)
    } catch {
      try { await domain?.close() } catch {}
      storageCtx.logger?.warn?.('Vertex Argon diagnostic storage could not open; model requests remain available.')
    }
  })
  ctx.inject?.(['typert'], tctx => {
    tctx.effect(() => tctx.typert.register({
      package: 'dsh-vertex-argon',
      face: 'host',
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: [diagnosticsInvocation(), ...recoveryInvocations(), ...inspectorInvocations()],
    }), 'vertex-argon: diagnostics remote descriptor')
  })
  try {
    if (ctx.root && ctx.events) new ArgonDiagnosticsService(ctx, hub, taskHub, {responseHub, query, readEvent: request => ctx.get?.('sessionQuery')?.readEvent(request)})
  } catch {}
  ctx.inject?.(['tools', 'vertexArgonDiagnostics'], toolCtx => {
    toolCtx.effect(() => toolCtx.tools.register(createInspectorTool(toolCtx.vertexArgonDiagnostics)), 'vertex-argon: read-only inspection tool')
  })
  const recordDiagnostic = record => hub.record(record)
  const adapter = createArgonAdapter(ctx, () => config, undefined, undefined, recordDiagnostic, taskHub, responseHub)
  const unpatchPiAi = installGemini4PiAiPatch(recordDiagnostic, () => config, responseHub)
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  ctx.effect(() => () => {
    unpatchPiAi()
    registration?.()
  })
  if (typeof ctx.on === 'function') {
    ctx.on('llm/stream', (options, next) => associations.stream(options, next))
    ctx.on('agent/assistant-stream', payload => associations.frame(payload))
    ctx.on('session/event', (session, event) => associations.event(session, event))
    ctx.on('agent/disposed', ({agent}) => associations.dispose(agent))
    ctx.on('agent/request', async (_payload, next) => {
      const proposed = await next()
      if (
        (proposed?.provider === PROVIDER ||
          ((proposed?.provider === 'google' || proposed?.provider === 'google-vertex') &&
            /^(?:models\/)?gemini-4\b/i.test(proposed?.model ?? ''))) &&
        proposed.reasoningEffort === 'max'
      ) {
        return { ...proposed, reasoningEffort: 'high' }
      }
      return proposed
    })
    let moving = false
    let lastRoutesSnap = JSON.stringify(detectPiAiArgonRoutes(ctx))
    const followNativeAndSync = () => {
      if (moving || typeof ctx.llm.listProviders !== 'function') return
      const nextRoutesSnap = JSON.stringify(detectPiAiArgonRoutes(ctx))
      const routesChanged = nextRoutesSnap !== lastRoutesSnap
      lastRoutesSnap = nextRoutesSnap
      const ids = ctx.llm.listProviders().map(p => p.id)
      const nativeIdx = ids.indexOf(NATIVE_PROVIDER)
      const argonIdx = ids.indexOf(PROVIDER)
      const needsMove = nativeIdx >= 0 && argonIdx >= 0 && argonIdx < nativeIdx
      if (!needsMove && !routesChanged) return
      moving = true
      try {
        registration?.replace?.([PROVIDER])
      } finally {
        moving = false
      }
    }
    ctx.on('llm/adapters-updated', followNativeAndSync)
    ctx.on('settings/document-updated', followNativeAndSync)
    followNativeAndSync()
    let lastSnap = JSON.stringify(resolveConfigValues(config))
    ctx.on('loader/volatile-update', () => {
      const nextSnap = JSON.stringify(resolveConfigValues(config))
      if (nextSnap === lastSnap) return
      lastSnap = nextSnap
      if (typeof registration?.replace === 'function') registration.replace([PROVIDER])
      else ctx.emit?.('llm/adapters-updated')
    })
  }
  ctx.inject?.(['settings'], settingsCtx => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber), 'vertex-argon: dedicated settings page')
  })
}
