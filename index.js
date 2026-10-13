import { shared } from './runtime.js'
const { default: z } = await shared('@deepseek-ai/schemastery')
import { createArgonAdapter, installGemini4PiAiPatch, resolveConfigValues, detectPiAiArgonRoutes, PROVIDER, NATIVE_PROVIDER, LEVELS } from './adapter.js'

export const name = 'local-vertex-argon'
export const inject = ['llm']
export const Config = z.object({
  showInModelPicker: z.boolean().default(true).volatile(),
  reasoning: z.union(LEVELS).default('medium').volatile(),
  contextWindow: z.number().step(1).min(1).max(1048576).default(1048576).volatile(),
  maxTokens: z.number().step(1).min(1).max(65536).default(65536).volatile(),
})

export function apply(ctx, config) {
  const adapter = createArgonAdapter(ctx, () => config)
  const unpatchPiAi = installGemini4PiAiPatch()
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  ctx.effect(() => () => {
    unpatchPiAi()
    registration?.()
  })
  if (typeof ctx.on === 'function') {
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
