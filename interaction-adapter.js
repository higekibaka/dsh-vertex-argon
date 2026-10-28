import { createGoogleConnection } from './google-connection.js'
import { interactionImageRequestTarget } from './interaction-image.js'
import { durableInteractionTransport } from './interaction-state.js'
import { createArgonDiagnosticTracker } from './diagnostics.js'
import { interactionExitReason } from './interaction-lifecycle.js'
import { resolveServicePolicy } from './service-level.js'
// 循环导入：adapter.js 只在本模块的函数被调用时才读取这些绑定，函数声明本身已提升。
import { isProxyModel, resolveProxyUpstreamModel } from './adapter.js'

const terminalStates = new Set(['completed', 'requires_action', 'incomplete', 'failed', 'cancelled', 'budget_exceeded'])
export function assertInteractionOptions(options, cfg, route) {
  const max = options.maxTokens ?? cfg.maxTokens
  if (!Number.isSafeInteger(max) || max <= 0 || max > cfg.maxTokens) throw new Error('Interactions output budget must be a positive integer within the configured effective cap.')
  const level = options.reasoningEffort ?? cfg.reasoning
  if (!['low', 'medium', 'high'].includes(level)) throw new Error('Argon requires low, medium, or high thinking.')
  if (cfg.interactionsBackground && !cfg.allowInteractionStorage) throw new Error('Background Interactions requires explicit cloud-storage consent in Vertex Argon settings.')
  if (max > 65536 && !cfg.interactionsBackground) throw new Error('Interactions above 65,536 tokens requires background execution; no request was sent.')
  if (route === 'google-vertex' && max > 65536) throw new Error('Vertex Interactions long decode is not verified; choose GenerateContent or explicitly lower the budget to 65,536.')
  return { maxTokens: max, reasoning: level }
}

export function createInteractionsHandler({ ctx, GoogleGenAI, resolveSecret, getRoutes, taskHub, recordDiagnostic, responseHub, structuredOutput }) {
  return async function* interactions(options, cfg) {
    const proxy = isProxyModel(options.model)
    const route = proxy || options.model === 'gemini-4-argon-google' ? 'google-generative-ai' : 'google-vertex'
    const requestController = new AbortController()
    const signal = options.signal ? AbortSignal.any([options.signal, requestController.signal]) : requestController.signal
    let tracker, durable, claim, complete = false, usage, firstInput, firstCached, hopIndex = 0
    let finalOutcome = 'incomplete', finalError, exitReason = 'consumer-abandoned'
    let originalPromptClosed = false, firstModelOutputStopped = false, pendingBackoffMs = 0
    const modelOutputs = new Set()
    const observed = event => {
      const type = event.event_type ?? event.type
      if (type === 'step.start' && event.step?.type === 'model_output') {
        // The original prompt closes only when the next model_output step opens,
        // which is the cross-hop (64K continuation) marker. A single-hop reply
        // stops its model_output first and then reports its one and only usage on
        // the following interaction.requires_action / interaction.completed; a
        // function_call step of the same hop must not close it early, or that
        // unique first-hop watermark would be discarded.
        if (firstModelOutputStopped) originalPromptClosed = true
        modelOutputs.add(event.index)
      }
      const u = event.interaction?.usage ?? event.usage ?? event.metadata?.total_usage
      if (u && typeof u === 'object') {
        usage = { ...usage, ...u }
        // The first-hop watermark is only captured before the original prompt
        // output closes; later 64K hops report cumulative inputs that must never
        // overwrite it. A single-hop reply without model_output keeps it open.
        if (!originalPromptClosed) {
          // A legitimate zero input watermark is still a first-hop observation.
          if (Number.isSafeInteger(u.total_input_tokens) && u.total_input_tokens >= 0) firstInput = u.total_input_tokens
          if (firstInput !== undefined) {
            if (Number.isSafeInteger(u.total_cached_tokens) && u.total_cached_tokens >= 0) firstCached = u.total_cached_tokens
            else if (firstCached === undefined) firstCached = usage.total_cached_tokens ?? 0
          }
        }
      }
      if (type === 'step.stop' && modelOutputs.has(event.index)) firstModelOutputStopped = true
    }
    const recordUsage = () => {
      // Only an observed first-hop input watermark may become a context value.
      // Without one, later hops report cumulative inputs and a single-hop reply
      // may report output tokens alone: an unknown input stays unknown instead of
      // being recorded as a known zero.
      const knownInitialInput = firstInput !== undefined ? firstInput + (usage?.total_tool_use_tokens ?? 0) : undefined
      const knownInitialCache = firstInput !== undefined ? (firstCached ?? 0) : undefined
      tracker?.recordTokenUsage({
        reportedInputTokens: knownInitialInput,
        reportedCacheTokens: knownInitialCache,
        outputTokens: usage?.total_output_tokens,
        thoughtsTokens: usage?.total_thought_tokens,
        totalTokens: knownInitialInput !== undefined && usage ? knownInitialInput + (usage.total_output_tokens ?? 0) + (usage.total_thought_tokens ?? 0) : undefined,
        billedOutputTokens: usage?.total_output_tokens,
        billedThoughtsTokens: usage?.total_thought_tokens,
        billedToolTokens: usage?.total_tool_use_tokens ?? 0,
        billedPromptTokens: usage?.total_input_tokens,
        billedCachedTokens: usage?.total_cached_tokens ?? 0,
        billedTotalTokens: usage?.total_tokens,
      })
    }
    try {
      signal.throwIfAborted()
      const controls = assertInteractionOptions(options, cfg, route)
      const servicePolicy = resolveServicePolicy(cfg, route, 'interactions')
      if (cfg.interactionsBackground) taskHub?.requireReady()
      if (cfg.interactionsBackground && !taskHub) throw new Error('Background recovery storage is not configured.')
      const routes = getRoutes(cfg)
      const connection = await createGoogleConnection(GoogleGenAI, { route, resolveSecret, apiKey: proxy ? cfg.proxyApiKey.trim() || undefined : undefined, apiKeyEnv: proxy ? 'ANTIGRAVITY_API_KEY' : routes.googleApiKeyEnv, baseURL: proxy ? cfg.proxyBaseUrl : route === 'google-vertex' ? routes.vertexBaseUrl : routes.googleBaseUrl, onResponse: receipt => { if (route === 'google-generative-ai' && receipt.operation === 'create') tracker?.recordServiceTier(receipt.serviceTier, 'response-header') } })
      tracker = createArgonDiagnosticTracker({ route, model: options.model, protocol: 'interactions', background: cfg.interactionsBackground, apiVersion: connection.apiVersion, thinkingLevel: controls.reasoning.toUpperCase(), longDecode: controls.maxTokens > 65536, maxTokens: controls.maxTokens, sessionId: options.sessionId, requestedServiceTier: servicePolicy.tier }, recordDiagnostic, { responseHub, retainRawResponses: cfg.retainRawResponses })
      tracker?.setApiVersion(connection.apiVersion)
      const observe = async (operation, args, trigger) => {
        // A reconnect hint observed by the stream belongs to the next resume hop.
        const backoffDelayMs = trigger === 'interaction-create' ? 0 : pendingBackoffMs
        pendingBackoffMs = 0
        const hop = tracker?.beginHop({ hopIndex: ++hopIndex, trigger, usedContinuationToken: trigger !== 'interaction-create', backoffDelayMs, body: operation === 'create' ? JSON.stringify(args[0]) : undefined })
        let status, hopUsage
        const recordHopUsage = response => {
          const u = response?.interaction?.usage ?? response?.usage ?? response?.metadata?.total_usage
          if (!u || typeof u !== 'object') return
          hopUsage = { ...hopUsage, ...u }
          hop?.recordTokenUsage({
            promptTokens: hopUsage.total_input_tokens,
            cachedTokens: hopUsage.total_cached_tokens,
            outputTokens: hopUsage.total_output_tokens,
            thoughtsTokens: hopUsage.total_thought_tokens,
            totalTokens: hopUsage.total_tokens,
          })
        }
        try {
          const response = await (durable ?? connection.transport)[operation](...args)
          if (!response?.[Symbol.asyncIterator]) { tracker?.observeResponse('interaction-object', hopIndex, response); recordHopUsage(response); hop?.finish({ finishReason: terminalStates.has(response?.status) ? response.status.toUpperCase() : undefined }); return response }
          return (async function* () {
            try {
              for await (const event of response) {
                tracker?.observeResponse('interaction-event', hopIndex, event)
                recordHopUsage(event)
                // Dedicated 2026-05-20 terminal lifecycle events imply their own state.
                const eventType = event.event_type ?? event.type
                const impliedStatus = eventType === 'interaction.completed' ? 'completed' : eventType === 'interaction.requires_action' ? 'requires_action' : eventType === 'interaction.failed' ? 'failed' : eventType === 'interaction.cancelled' ? 'cancelled' : eventType === 'interaction.incomplete' ? 'incomplete' : eventType === 'interaction.budget_exceeded' ? 'budget_exceeded' : undefined
                status = event.interaction?.status ?? event.status ?? impliedStatus ?? status
                hop?.onChunk({ status: 200, hasCheckpoint: Boolean(event.event_id), finishReason: terminalStates.has(status) ? status.toUpperCase() : undefined })
                yield event
              }
              hop?.finish({ finishReason: terminalStates.has(status) ? status.toUpperCase() : undefined })
            } catch (error) { hop?.finish({ error, aborted: signal.aborted }); throw error }
            finally { hop?.finish({ aborted: signal.aborted, finishReason: terminalStates.has(status) ? status.toUpperCase() : undefined }) }
          })()
        } catch (error) { hop?.finish({ error, aborted: signal.aborted }); throw error }
      }
      const transport = {
        async create(body, requestOptions) {
          if (cfg.interactionsBackground) {
            const identity = taskHub.identity({ sessionId: options.sessionId, purpose: options.purpose, endpoint: connection.endpoint, principalHash: connection.principalHash, body })
            claim = taskHub.claim(identity.key, requestController, identity.sessionHash)
            durable = durableInteractionTransport(connection.transport, taskHub, identity, { signal })
          }
          return observe('create', [body, { ...requestOptions, signal }], 'interaction-create')
        },
        get(id, requestOptions) { return observe('get', [id, { ...requestOptions, signal }], 'interaction-resume') },
        cancel(id, requestOptions) { return (durable ?? connection.transport).cancel(id, requestOptions) },
      }
      const resolveImage = async block => {
        const ref = block.attachment
        if (!ref) throw new Error('Interactions image has no durable attachment reference.')
        const target = interactionImageRequestTarget(ref)
        const attachments = ctx.get('attachments')
        if (!attachments) throw new Error('Image attachment service is unavailable.')
        const image = await attachments.readImageRequest(ref, target, signal)
        return { type: 'image', mime_type: image.mediaType, data: Buffer.from(image.data).toString('base64') }
      }
      const messages = options.messages.map(message => ({ ...message, content: message.content.map(block => {
        if (block.type === 'file') return { type: 'text', text: ctx.llm.fileRequestText(block.attachment) }
        if (block.type === 'image' && block.offloaded) return { type: 'text', text: '[Image offloaded from this request by the host.]' }
        return block
      }) }))
      const { streamInteractions } = await import('./interactions.js')
      for await (const chunk of streamInteractions({ ...options, messages, signal }, { route, upstreamModel: proxy ? resolveProxyUpstreamModel(options.model, controls.reasoning) : 'gemini-4-argon', ...controls, serviceTier: route === 'google-generative-ai' ? servicePolicy.tier : undefined, background: cfg.interactionsBackground, store: cfg.allowInteractionStorage, transport, resolveImage, structuredOutput, onEvent: observed, onReconnectDelay: ms => { pendingBackoffMs = ms }, onTerminal: () => { complete = true }, onExit: reason => { exitReason = reason } })) {
        if (chunk.type === 'usage') {
          recordUsage()
          // Only an observed first-hop input watermark can be normalized for the
          // host. Without one, neither cumulative cross-hop inputs nor a missing
          // single-hop input may be yielded: a fabricated zero would silently
          // understate the context. The observed values survive in billed fields.
          if (firstInput !== undefined) {
            const output = (usage?.total_output_tokens ?? 0) + (usage?.total_thought_tokens ?? 0)
            yield { ...chunk, usage: { ...chunk.usage, inputTokens: Math.max(0, firstInput - (firstCached ?? 0)) + (usage?.total_tool_use_tokens ?? 0), cacheReadTokens: firstCached ?? 0, outputTokens: output, reasoningTokens: usage?.total_thought_tokens ?? 0, totalTokens: firstInput + output + (usage?.total_tool_use_tokens ?? 0) } }
          }
          continue
        }
        if (chunk.type === 'finish') {
          complete ||= ['stop','tool-calls','max-tokens'].includes(chunk.reason.kind)
          recordUsage()
          finalOutcome = chunk.reason.kind === 'stop' ? 'done' : chunk.reason.kind
          finalError = chunk.reason.failure
        }
        yield chunk
      }
    } catch (error) {
      exitReason = interactionExitReason(error, signal)
      const kind = ['user-stop', 'host-shutdown'].includes(exitReason) ? 'aborted' : 'error'
      recordUsage()
      finalOutcome = kind
      finalError = error
      yield { type: 'finish', reason: { kind, failure: { code: kind === 'aborted' ? 'ABORTED' : 'ARGON_INTERACTIONS', message: error.message, ...(error.status ? { status: error.status } : {}) } } }
    } finally {
      try { await durable?.finish({ complete, reason: exitReason }) } catch { ctx.logger?.warn?.('Vertex Argon remote cancellation remains unresolved; its recovery handle was retained.') }
      claim?.release()
      recordUsage()
      if (durable) tracker?.setRemoteCancellation(durable.cancellationState)
      tracker?.finishStream({ outcome: signal.aborted && finalOutcome === 'incomplete' ? 'aborted' : finalOutcome, error: finalError })
      tracker?.finalize(signal.aborted)
    }
  }
}
