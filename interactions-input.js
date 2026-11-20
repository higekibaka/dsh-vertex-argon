import { createHash } from 'node:crypto'
export const INTERACTIONS_REPLAY_API = 'google-interactions-v1'
export const TOOL_RETRIEVAL_MODES = Object.freeze(['off', 'explicit', 'auto'])
export const DEFAULT_TOOL_RETRIEVAL_MODE = 'explicit'
export const CORE_RESIDENT_TOOLS = Object.freeze([
  'bash', 'read', 'write', 'edit', 'apply_patch', 'glob', 'grep', 'ls',
  'view_image', 'todo_write', 'ask_user', 'subagent', 'task', 'skill',
  'run_code', 'web_search', 'web_fetch',
])
const CORE_RESIDENT_TOOL_SET = new Set(CORE_RESIDENT_TOOLS)
const TOOL_RETRIEVAL_FAMILIES = new Set(['argon', 'carbon', 'hydrogen', 'neon'])
const ALLOWED_TOOL_CHOICES = new Set(['auto', 'any', 'none', 'validated'])
const ALLOWED_REPLAY_STEP_TYPES = new Set([
  'thought', 'model_output', 'function_call',
  'tool_search_call', 'tool_search_result',
  'processing_call', 'processing_result',
])
const MEDIA_CONTENT_TYPES = new Set(['image', 'audio', 'document', 'video'])

export const OFFICIAL_GEMINI4_MODEL_RE = /^(?:models\/)?(gemini-4-(argon|carbon|hydrogen|neon))(-google)?$/i
export function resolveOfficialGemini4Model(modelId) {
  if (typeof modelId !== 'string') return null
  const match = OFFICIAL_GEMINI4_MODEL_RE.exec(modelId)
  if (!match) return null
  const upstreamModel = match[1].toLowerCase()
  const family = match[2].toLowerCase()
  const isGoogleApi = Boolean(match[3])
  return {
    canonicalId: `${upstreamModel}${isGoogleApi ? '-google' : ''}`,
    upstreamModel,
    family,
    isGoogleApi,
    supportsXhigh: family === 'hydrogen' || family === 'neon',
  }
}

export function supportsInteractionsToolRetrieval({ model, route, protocol, mode = DEFAULT_TOOL_RETRIEVAL_MODE, apiVersion } = {}) {
  if (mode !== 'explicit' && mode !== 'auto') return false
  if (protocol !== 'interactions') return false
  if (route !== 'google-generative-ai') return false
  if (typeof apiVersion === 'string' && apiVersion.toLowerCase() === 'v1') return false
  const official = resolveOfficialGemini4Model(model)
  return Boolean(official && TOOL_RETRIEVAL_FAMILIES.has(official.family))
}
export function defaultReasoningForModel(modelId) {
  const official = resolveOfficialGemini4Model(modelId)
  if (official) return official.supportsXhigh ? 'high' : 'medium'
  return /cyber-permissive/i.test(String(modelId ?? '')) ? 'high' : 'medium'
}
/** 统一校验 thinking/reasoning 双字段，显式非法或双字段互相冲突时当场失败，避免静默回退默认值。 */
export function resolveGemini4ReasoningLevel(options, modelId, fallback = defaultReasoningForModel(modelId)) {
  const supportsXhigh = Boolean(resolveOfficialGemini4Model(modelId)?.supportsXhigh)
  const allowed = supportsXhigh ? ['low', 'medium', 'high', 'xhigh'] : ['low', 'medium', 'high']
  const validInputs = new Set([...allowed, 'max'])
  const normalize = value => {
    if (value === undefined) return undefined
    if (typeof value !== 'string') return null
    const lower = value.toLowerCase()
    return validInputs.has(lower) ? lower : null
  }
  const hasEffort = options?.reasoningEffort !== undefined
  const hasReasoning = options?.reasoning !== undefined
  const effort = hasEffort ? normalize(options.reasoningEffort) : undefined
  const reasoning = hasReasoning ? normalize(options.reasoning) : undefined
  if (hasEffort && effort === null) return { ok: false, errorType: 'unsupported', effort: options.reasoningEffort, supportsXhigh }
  if (hasReasoning && reasoning === null) return { ok: false, errorType: 'unsupported', effort: options.reasoning, supportsXhigh }
  if (effort !== undefined && reasoning !== undefined && effort !== 'max' && reasoning !== 'max' && effort !== reasoning) {
    return { ok: false, errorType: 'conflict', reasoning, reasoningEffort: effort, supportsXhigh }
  }
  const requested = effort === 'max' || reasoning === 'max'
    ? 'max'
    : (effort ?? reasoning ?? (typeof fallback === 'string' ? fallback.toLowerCase() : fallback))
  const level = requested === 'max' ? (supportsXhigh ? 'xhigh' : 'high') : requested
  if (!allowed.includes(level)) return { ok: false, errorType: 'unsupported', effort: requested, supportsXhigh }
  return { ok: true, level, supportsXhigh }
}
export const contentHash = content => createHash('sha256').update(JSON.stringify(content)).digest('hex')
export const historyHash = messages => contentHash(messages.map(m => ({ role: m.role, content: m.content, toolCallId: m.toolCallId, isError: m.isError })))
const copy = value => JSON.parse(JSON.stringify(value))
const FORGED_THINKING_PREFIX_RE = /^\s*(?:\[:thinking:\]|\[thinking\]|思考过程[:：]\r?\n)\s*/i
const FORGED_PASS_SUFFIX_RE = /^[\s\S]*?(\[\s*PASS\s*\])\s*$/i
const FORGED_TOOL_CALL_TAIL_RE = /(?:\r?\n)?(?<!`)\[Previously executed tool [\w.-]+; call [^\]]+\](?: \([^)\r\n]*\))?\r?\n\{[\s\S]*$/
const THINKING_TRANSITION_RE = /^[\s\S]*?(?:(?:来，(?:我们)?|让我们|我们先)?(?:先发一句简短(?:提示|回复|确认)|用一句话说明要[^\n。！]*|先在群里(?:回复|回)一句短话|先调一次 `ops_bash`[^\n。！]*|不需要调工具，直接简明扼要回复群聊|无需在这里自己调工具[^\n。！]*|直接把这份完整诊断报告发出来[^\n。！]*|让我组织好清晰、简明的话术[^\n。！]*|开始撰写回复)[^\n。！]*[。！]|Let's (?:run|call|update) [^\n!]+!)\s*/
const CHECKPOINT_THINKING_TEST_RE = /(\[Checkpoint \d+\]\r?\n)\s*(?:\[:thinking:\]|\[thinking\]|思考过程[:：]\r?\n)[\s\S]*?(?=##\s)/
const CHECKPOINT_THINKING_RE = /(\[Checkpoint \d+\]\r?\n)\s*(?:\[:thinking:\]|\[thinking\]|思考过程[:：]\r?\n)[\s\S]*?(?=##\s)/g
export function hasPollutedAssistantText(text) {
  return typeof text === 'string' && (FORGED_THINKING_PREFIX_RE.test(text) || FORGED_TOOL_CALL_TAIL_RE.test(text))
}
export function hasPollutedCheckpointText(text) {
  return typeof text === 'string' && text.includes('[Checkpoint ') && CHECKPOINT_THINKING_TEST_RE.test(text)
}
export function scrubPollutedCheckpointText(text) {
  if (typeof text !== 'string' || !text.includes('[Checkpoint ')) return text
  return text.replace(CHECKPOINT_THINKING_RE, '$1')
}
export function scrubPollutedAssistantText(text) {
  if (typeof text !== 'string') return text
  let next = text
  if (FORGED_TOOL_CALL_TAIL_RE.test(next)) next = next.replace(FORGED_TOOL_CALL_TAIL_RE, '').trimEnd()
  if (FORGED_THINKING_PREFIX_RE.test(next)) {
    const passMatch = next.match(FORGED_PASS_SUFFIX_RE)
    if (passMatch) return passMatch[1]
    const stripped = next.replace(FORGED_THINKING_PREFIX_RE, '')
    const afterTransition = stripped.replace(THINKING_TRANSITION_RE, '').trimStart()
    next = afterTransition.length > 0 && afterTransition.length < stripped.length ? afterTransition : stripped
  }
  return next
}
function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === null || proto === Object.prototype
}
function isValidReplayContentBlock(block) {
  if (!isPlainObject(block) || typeof block.type !== 'string') return false
  if (block.type === 'text') return typeof block.text === 'string'
  if (MEDIA_CONTENT_TYPES.has(block.type)) {
    const hasData = block.data !== undefined
    const hasUri = block.uri !== undefined
    if (!hasData && !hasUri) return false
    if (hasData && (typeof block.data !== 'string' || !block.data.length)) return false
    if (hasUri && (typeof block.uri !== 'string' || !block.uri.length)) return false
    if (block.mime_type !== undefined && (typeof block.mime_type !== 'string' || !block.mime_type.length)) return false
    return true
  }
  return false
}
function isValidReplayStep(step) {
  if (!isPlainObject(step) || !ALLOWED_REPLAY_STEP_TYPES.has(step.type)) return false
  if (step.signature !== undefined && typeof step.signature !== 'string') return false
  if (step.type === 'tool_search_call' || step.type === 'processing_call') {
    if (typeof step.id !== 'string' || !step.id.length) return false
    if (step.type === 'tool_search_call' && step.arguments !== undefined) {
      if (!isPlainObject(step.arguments)) return false
      if (step.arguments.function_names !== undefined && (!Array.isArray(step.arguments.function_names) || step.arguments.function_names.some(n => typeof n !== 'string'))) return false
    }
    return true
  }
  if (step.type === 'tool_search_result' || step.type === 'processing_result') {
    if (typeof step.call_id !== 'string' || !step.call_id.length) return false
    if (step.type === 'tool_search_result' && step.result !== undefined) {
      if (!Array.isArray(step.result) || step.result.some(item => !isPlainObject(item))) return false
    }
    return true
  }
  if (step.type === 'model_output' && step.content !== undefined) {
    if (!Array.isArray(step.content) || step.content.some(block => !isValidReplayContentBlock(block))) return false
  }
  if (step.type === 'thought' && step.summary !== undefined) {
    if (!Array.isArray(step.summary) || step.summary.some(block => !isValidReplayContentBlock(block))) return false
  }
  return true
}
function normalizeToolChoiceMode(mode) {
  if (typeof mode !== 'string') return null
  if (mode === 'required') return 'any'
  return ALLOWED_TOOL_CHOICES.has(mode) ? mode : null
}
function normalizeToolChoice(toolChoice) {
  if (toolChoice === undefined) return undefined
  if (typeof toolChoice === 'string') {
    const mode = normalizeToolChoiceMode(toolChoice)
    if (mode) return mode
    throw new Error('Invalid Interactions toolChoice option.')
  }
  if (isPlainObject(toolChoice)) {
    if (Object.hasOwn(toolChoice, 'allowed_tools')) {
      const allowed = toolChoice.allowed_tools
      if (isPlainObject(allowed)) {
        const cloned = copy(toolChoice)
        if (allowed.mode !== undefined) {
          const mode = normalizeToolChoiceMode(allowed.mode)
          if (!mode) throw new Error('Invalid Interactions toolChoice.allowed_tools.mode option.')
          cloned.allowed_tools.mode = mode
        }
        if (allowed.tools !== undefined && (!Array.isArray(allowed.tools) || allowed.tools.some(name => typeof name !== 'string' || !name))) {
          throw new Error('Invalid Interactions toolChoice.allowed_tools.tools option.')
        }
        return cloned
      }
      if (Array.isArray(allowed) && allowed.every(name => typeof name === 'string' && name.length > 0)) {
        return copy(toolChoice)
      }
      throw new Error('Invalid Interactions toolChoice option.')
    }
    if ((toolChoice.type === 'function' || toolChoice.type === 'tool') && typeof toolChoice.name === 'string' && toolChoice.name.trim().length > 0) {
      return { allowed_tools: { mode: 'any', tools: [toolChoice.name] } }
    }
    if (toolChoice.type === 'function' && isPlainObject(toolChoice.function) && typeof toolChoice.function.name === 'string' && toolChoice.function.name.trim().length > 0) {
      return { allowed_tools: { mode: 'any', tools: [toolChoice.function.name] } }
    }
    if (typeof toolChoice.toolName === 'string' && toolChoice.toolName.trim().length > 0) {
      return { allowed_tools: { mode: 'any', tools: [toolChoice.toolName] } }
    }
  }
  throw new Error('Invalid Interactions toolChoice option.')
}
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}'
}
function isConsistentNativeReplaySteps(steps, visibleCalls) {
  if (!Array.isArray(steps)) return false
  const seenToolSearchCalls = new Set()
  const seenProcessingCalls = new Set()
  const replayFnCalls = []
  for (const step of steps) {
    if (!isValidReplayStep(step)) return false
    if (step.type === 'tool_search_call') {
      seenToolSearchCalls.add(step.id)
    } else if (step.type === 'tool_search_result') {
      if (!seenToolSearchCalls.has(step.call_id)) return false
    } else if (step.type === 'processing_call') {
      seenProcessingCalls.add(step.id)
    } else if (step.type === 'processing_result') {
      if (!seenProcessingCalls.has(step.call_id)) return false
    } else if (step.type === 'function_call') {
      replayFnCalls.push(step)
    }
  }
  if (replayFnCalls.length !== visibleCalls.length) return false
  for (let i = 0; i < visibleCalls.length; i++) {
    const rc = replayFnCalls[i]
    const vc = visibleCalls[i]
    const rcId = rc.id ?? rc.call_id
    if (typeof rcId !== 'string' || !rcId || rcId !== vc.id) return false
    if (typeof rc.name !== 'string' || !rc.name || rc.name !== vc.name) return false
    let rcArgs, vcArgs
    try {
      rcArgs = argsOf(rc.arguments ?? {})
      vcArgs = argsOf(vc.arguments ?? {})
    } catch {
      return false
    }
    if (canonicalJson(rcArgs) !== canonicalJson(vcArgs)) return false
  }
  return true
}
function prepareInteractionTools(rawTools, { model, route, retrievalMode, effectiveToolChoice, apiVersion }) {
  const deferredToolNames = new Set()
  if (!rawTools?.length) return { tools: undefined, deferredToolNames }
  let toolSearchCount = 0
  let hasExplicitServerToolSearch = false
  const nonSearchTools = []
  for (const tool of rawTools) {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
      throw new Error('Invalid Interactions tool declaration.')
    }
    if (tool.type === 'tool_search') {
      toolSearchCount++
      if (toolSearchCount > 1) throw new Error('Interactions request allows at most one tool_search tool.')
      if (tool.execution === 'client') {
        throw new Error('Client-side tool_search execution is not supported; only server-side tool_search is supported.')
      }
      if (tool.execution !== undefined && tool.execution !== 'server') {
        throw new Error('Invalid tool_search execution mode.')
      }
      const extraKeys = Object.keys(tool).filter(k => k !== 'type' && k !== 'execution' && tool[k] !== undefined)
      if (extraKeys.length > 0) {
        throw new Error('Server-side tool_search must not specify name, description, parameters, or other client fields.')
      }
      hasExplicitServerToolSearch = true
      continue
    }
    if (tool.type === 'mcp_server') {
      throw new Error('Remote mcp_server tools are not supported in Interactions; declare local function tools instead.')
    }
    nonSearchTools.push(tool)
  }
  const disablesServerRetrieval =
    effectiveToolChoice === 'auto' ||
    effectiveToolChoice === 'none' ||
    (isPlainObject(effectiveToolChoice) && ['auto', 'none'].includes(effectiveToolChoice.allowed_tools?.mode))
  const pinnedTools = new Set(
    isPlainObject(effectiveToolChoice)
      ? (Array.isArray(effectiveToolChoice.allowed_tools)
          ? effectiveToolChoice.allowed_tools
          : Array.isArray(effectiveToolChoice.allowed_tools?.tools) ? effectiveToolChoice.allowed_tools.tools : [])
      : [],
  )
  const serverRetrievalEnabled = !disablesServerRetrieval && supportsInteractionsToolRetrieval({
    model,
    route,
    protocol: 'interactions',
    mode: retrievalMode,
    apiVersion,
  })
  const totalTools = nonSearchTools.length
  const serializedNonSearch = nonSearchTools.map(tool => {
    const explicitDefer = tool.deferLoading !== undefined ? tool.deferLoading : tool.defer_loading
    const isPinned = typeof tool.name === 'string' && pinnedTools.has(tool.name)
    const shouldDefer = serverRetrievalEnabled && !isPinned && (
      retrievalMode === 'auto'
        ? (explicitDefer === true || (explicitDefer !== false && totalTools >= 2 && !CORE_RESIDENT_TOOL_SET.has(tool.name)))
        : explicitDefer === true
    )
    const rawShort = tool.shortDescription ?? tool.short_description
    const shortDescription = shouldDefer && typeof rawShort === 'string' && rawShort.trim().length > 0 ? rawShort : undefined
    if (shouldDefer && typeof tool.name === 'string') deferredToolNames.add(tool.name)
    return {
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: copy(tool.parameters),
      ...(shouldDefer ? { defer_loading: true } : {}),
      ...(shortDescription !== undefined ? { short_description: shortDescription } : {}),
    }
  })
  if (deferredToolNames.size > 0 || (hasExplicitServerToolSearch && serverRetrievalEnabled)) {
    return { tools: [{ type: 'tool_search' }, ...serializedNonSearch], deferredToolNames }
  }
  return { tools: serializedNonSearch.length ? serializedNonSearch : undefined, deferredToolNames }
}
function degradeToolSearchInputSteps(input) {
  if (!Array.isArray(input) || !input.some(s => s?.type === 'tool_search_call' || s?.type === 'tool_search_result')) return input
  const degraded = []
  const degradedCalls = new Map()
  let idx = 0
  while (idx < input.length) {
    const step = input[idx]
    if (step?.type === 'user_input') {
      degraded.push(step)
      idx++
      continue
    }
    if (step?.type === 'function_result') {
      const header = degradedCalls.get(step.call_id)
      if (header !== undefined) {
        degradedCalls.delete(step.call_id)
        const resultParts = Array.isArray(step.result) ? step.result : [{ type: 'text', text: '[Tool completed without output.]' }]
        degraded.push({
          type: 'user_input',
          content: [{ type: 'text', text: header + '\n[Result of previously executed tool call ' + step.call_id + (step.is_error ? '; error' : '') + ']' }, ...resultParts],
        })
      } else {
        degraded.push(step)
      }
      idx++
      continue
    }
    const turnStart = idx
    while (idx < input.length && input[idx]?.type !== 'user_input' && input[idx]?.type !== 'function_result') idx++
    const turnSteps = input.slice(turnStart, idx)
    if (!turnSteps.some(s => s?.type === 'tool_search_call' || s?.type === 'tool_search_result')) {
      degraded.push(...turnSteps)
      continue
    }
    const textContent = []
    for (const s of turnSteps) {
      if (s?.type === 'model_output' && Array.isArray(s.content)) {
        for (const block of s.content) if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) textContent.push({ type: 'text', text: block.text })
      } else if (s?.type === 'function_call') {
        const callId = s.id ?? s.call_id
        if (callId) degradedCalls.set(callId, '[Previously executed tool ' + s.name + '; call ' + callId + ']\n' + JSON.stringify(s.arguments ?? {}))
      }
    }
    degraded.push({ type: 'model_output', content: textContent.length ? textContent : [{ type: 'text', text: '[Previous model reasoning omitted.]' }] })
  }
  return degraded
}
export function downgradeToolChoiceToAuto(requestBody) {
  const next = copy(requestBody)
  if (!isPlainObject(next.generation_config)) next.generation_config = {}
  if (Array.isArray(next.tools)) {
    next.tools = next.tools
      .filter(tool => !(tool?.type === 'tool_search' && tool?.execution !== 'client'))
      .map(tool => {
        if (!tool || typeof tool !== 'object') return tool
        const { defer_loading: _dl, short_description: _sd, ...clean } = tool
        return clean
      })
    if (next.tools.length === 0) {
      delete next.tools
      delete next.generation_config.tool_choice
      if (Array.isArray(next.input)) next.input = degradeToolSearchInputSteps(next.input)
      return next
    }
  }
  if (Array.isArray(next.input)) next.input = degradeToolSearchInputSteps(next.input)
  next.generation_config.tool_choice = 'auto'
  return next
}
function argsOf(value) {
  const args = typeof value === 'string' ? JSON.parse(value) : value
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Function arguments must be a complete JSON object.')
  return args
}
async function contentOf(blocks, settings, scrubText = false, deferredToolNames = null) {
  const content=[]
  for (const block of blocks ?? []) {
    if (block.type === 'text') {
      const text = scrubText ? scrubPollutedAssistantText(block.text) : block.text
      if (!scrubText || text.length > 0) content.push({type:'text',text})
    }
    else if (block.type === 'image') {
      if (!settings.resolveImage) throw new Error('Interactions image input needs the host attachment resolver.')
      const image=await settings.resolveImage(block)
      if (!image || image.type !== 'image' || !image.mime_type || (!image.data && !image.uri)) throw new Error('Invalid resolved Interactions image.')
      content.push(image)
    } else if (block.type === 'file') throw new Error('File references must be resolved by the host before Interactions dispatch.')
    else if (block.type === 'tool-addition') {
      if (deferredToolNames?.has(block.toolName)) continue
      content.push({type:'text',text:'[Tool availability update: '+block.type+' '+block.toolName+']'})
    } else if (block.type === 'tool-removal') {
      content.push({type:'text',text:'[Tool availability update: '+block.type+' '+block.toolName+']'})
    }
    else if (block.type !== 'reasoning' && block.type !== 'tool-call') throw new Error('Unsupported Interactions input content type.')
  }
  return content
}

function isOmittedModel(value) {
  return value === undefined || value === null || value === ''
}
function hasFollowingAssistant(messages, position) {
  for (let i = position + 1; i < messages.length; i++) {
    if (messages[i]?.role === 'assistant') return true
  }
  return false
}
function findUnclaimedToolResultIndex(messages, startIndex, toolCallId, claimedToolIndices) {
  for (let i = startIndex; i < messages.length; i++) {
    const msg = messages[i]
    if (msg?.role === 'assistant') break
    if (claimedToolIndices.has(i)) continue
    if (msg?.role === 'tool' && msg.toolCallId === toolCallId) return i
  }
  return -1
}

// The local DSH history is authoritative. No previous_interaction_id is reused.
// Native replay steps are bound to the exact visible blocks, model and provider.
// Completed foreign-protocol tool rounds become a textual transcript, never
// forged function calls or fake thought signatures.
export async function buildInteractionRequest(options, settings = {}) {
  const rawMax = options.maxTokens !== undefined
    ? options.maxTokens
    : (settings.maxTokens !== undefined ? settings.maxTokens : 65536)
  const hasExplicitUpstream = !isOmittedModel(settings.upstreamModel)
  const hasExplicitOption = !isOmittedModel(options.model)
  const resolvedUpstream = hasExplicitUpstream ? resolveOfficialGemini4Model(settings.upstreamModel) : null
  if (hasExplicitUpstream && !resolvedUpstream) {
    throw new Error(`Unknown Gemini 4 official model: ${String(settings.upstreamModel)}`)
  }
  const resolvedOption = hasExplicitOption ? resolveOfficialGemini4Model(options.model) : null
  if (hasExplicitOption && !resolvedOption) {
    throw new Error(`Unknown Gemini 4 official model: ${String(options.model)}`)
  }
  if (resolvedUpstream && resolvedOption && resolvedUpstream.upstreamModel !== resolvedOption.upstreamModel) {
    throw new Error('Conflicting Gemini 4 models in Interactions request.')
  }
  const upstreamModel = resolvedUpstream?.upstreamModel ?? resolvedOption?.upstreamModel ?? 'gemini-4-argon'
  const resolvedReasoning = resolveGemini4ReasoningLevel(options, upstreamModel, settings.reasoning ?? defaultReasoningForModel(upstreamModel))
  for (const flag of [settings.background, settings.store]) if (flag !== undefined && typeof flag !== 'boolean') throw new Error('Interactions background and storage consent must be booleans.')
  if (!Number.isSafeInteger(rawMax) || rawMax<1 || rawMax>1048576) throw new Error('Invalid Interactions output token budget.')
  const max = settings.longDecode === false ? Math.min(rawMax, 65536) : rawMax
  if (!resolvedReasoning.ok) {
    if (resolvedReasoning.errorType === 'conflict') {
      throw new Error('Conflicting reasoning and reasoningEffort options in Interactions request.')
    }
    throw new Error(resolvedReasoning.supportsXhigh ? 'Gemini 4 (Hydrogen / Neon) requires low, medium, high, or xhigh thinking.' : 'Argon requires low, medium, or high thinking.')
  }
  const level = resolvedReasoning.level
  if (settings.background && !settings.store) throw new Error('Background Interactions requires explicit storage consent.')
  if (max>65536 && !settings.background) throw new Error('Interactions above 65,536 tokens requires background execution.')
  if (max>65536 && settings.route==='google-vertex') throw new Error('Vertex Interactions long decode is not verified; use GenerateContent.')
  const explicitToolChoice = normalizeToolChoice(options.toolChoice)
  const effectiveToolChoice = explicitToolChoice ?? 'validated'
  const rawRetrievalMode = settings.interactionsToolRetrieval ?? settings.toolRetrieval
  const retrievalMode = TOOL_RETRIEVAL_MODES.includes(rawRetrievalMode) ? rawRetrievalMode : DEFAULT_TOOL_RETRIEVAL_MODE
  const { tools: preparedTools, deferredToolNames } = prepareInteractionTools(options.tools, {
    model: options.model || upstreamModel,
    route: settings.route,
    retrievalMode,
    effectiveToolChoice,
    apiVersion: settings.apiVersion,
  })
  const hasServerToolSearch = Boolean(preparedTools?.some(t => t?.type === 'tool_search' && t?.execution !== 'client'))
  const input=[], system=options.system?[options.system]:[], toolPlansByIndex=new Map(), claimedToolIndices=new Set()
  for (const [position, message] of options.messages.entries()) {
    if (message.role==='system' || message.role==='developer') {
      const parts=await contentOf(message.content,settings,false,deferredToolNames)
      if (parts.some(p=>p.type!=='text')) throw new Error('System instructions must be text.')
      if (parts.length > 0) system.push(parts.map(p=>p.text).join('\n'))
      continue
    }
    if (message.role==='user') {
      const blocks = Array.isArray(message.content)
        ? message.content.map(b => b?.type === 'text' && hasPollutedCheckpointText(b.text) ? { ...b, text: scrubPollutedCheckpointText(b.text) } : b)
        : message.content
      input.push({type:'user_input',content:await contentOf(blocks,settings)})
      continue
    }
    if (message.role==='assistant') {
      const replay=message.source?.replayState?.response
      const polluted=message.content.some(b=>b?.type==='text'&&hasPollutedAssistantText(b.text))
      const calls=message.content.filter(b=>b.type==='tool-call')
      const hasReplayToolSearch=Array.isArray(replay?.steps)&&replay.steps.some(s=>s?.type==='tool_search_call'||s?.type==='tool_search_result')
      const native=!polluted && replay?.api===INTERACTIONS_REPLAY_API && replay.provider===options.provider && replay.model===options.model && replay.route===settings.route && replay.contentHash===contentHash(message.content) && replay.historyHash===historyHash(options.messages.slice(0,position)) && (hasServerToolSearch || !hasReplayToolSearch) && isConsistentNativeReplaySteps(replay.steps, calls)
      for(const call of calls){
        const matchIndex = findUnclaimedToolResultIndex(options.messages, position + 1, call.id, claimedToolIndices)
        if (!native && matchIndex === -1) {
          throw new Error('An unfinished foreign or edited tool call cannot be replayed through Interactions.')
        }
        if (native && matchIndex === -1 && hasFollowingAssistant(options.messages, position)) {
          throw new Error('An incomplete Interactions tool turn cannot precede another assistant turn.')
        }
        if (matchIndex !== -1) {
          claimedToolIndices.add(matchIndex)
          toolPlansByIndex.set(matchIndex, {
            name: call.name,
            mode: native ? 'native' : '[Previously executed tool '+call.name+'; call '+call.id+']\n'+JSON.stringify(argsOf(call.arguments)),
          })
        }
      }
      if(native){
        input.push(...copy(replay.steps))
      }else{
        const content=await contentOf(message.content,settings,true)
        input.push({type:'model_output',content:content.length?content:[{type:'text',text:'[Previous model reasoning omitted.]'}]})
      }
      continue
    }
    if(message.role==='tool'){
      const content=await contentOf(message.content,settings)
      const entry=toolPlansByIndex.get(position)
      if(entry) toolPlansByIndex.delete(position)
      if(entry?.mode==='native')input.push({type:'function_result',call_id:message.toolCallId,name:entry.name,is_error:Boolean(message.isError),result:content.length?content:[{type:'text',text:'[Tool completed without output.]'}]})
      else input.push({type:'user_input',content:[{type:'text',text:(typeof entry?.mode==='string'?entry.mode+'\n':'')+'[Result of previously executed tool call '+message.toolCallId+(message.isError?'; error':'')+']'},...content]})
      continue
    }
    throw new Error('Unsupported Interactions message role.')
  }
  if(!input.length)throw new Error('Interactions input must not be empty.')
  const request={model:upstreamModel,input,stream:true,background:Boolean(settings.background),store:Boolean(settings.store),generation_config:{max_output_tokens:max,thinking_level:level,thinking_summaries:'auto'}}
  if (options.stop !== undefined) {
    if (!Array.isArray(options.stop) || options.stop.some(s => typeof s !== 'string' || s.length === 0)) throw new Error('Stop sequences must be nonempty strings.')
    request.generation_config.stop_sequences = [...options.stop]
  }
  if(settings.serviceTier && settings.serviceTier !== 'standard') request.service_tier=settings.serviceTier
  if(system.length)request.system_instruction=system.join('\n\n')
  if(preparedTools?.length){
    request.tools=preparedTools
    request.generation_config.tool_choice=effectiveToolChoice
  }
  return settings.structuredOutput ? settings.structuredOutput.interactions(request) : request
}

// Switching back to GenerateContent must not feed its SDK Interactions replay
// envelopes or unsigned function calls under the same DSH provider/model alias.
// 同插件内换官方模型（Argon <-> Carbon、Vertex <-> Gemini API）同样是跨路由：pi-ai 按
// provider/model 判定不一致时会摘掉 thoughtSignature，却仍把旧 functionCall 发出去，并把旧思考转成正文。
//
// 降级后的工具头绝不写回 assistant 正文：那会让模型在 role:"model" 历史里看到
// 自己连续手写该标签，形成 few-shot 模仿。头部改存起来，拼到后续 tool 回执里。
const isStandaloneSignatureCodec = value => typeof value === 'string' && value.startsWith('{')

export function generateContentHistory(options, defaultModel = options?.model) {
  const targetProvider = options.provider ?? 'google-vertex-argon'
  const targetModel = options.model ?? defaultModel
  const foreignHeadersByIndex=new Map(), claimedToolIndices=new Set()
  let changed=false
  const messages=options.messages.map((message, position)=>{
    if(message.role!=='assistant'){
      if(message.role==='tool'&&foreignHeadersByIndex.has(position)){
        changed=true
        const header=foreignHeadersByIndex.get(position)
        foreignHeadersByIndex.delete(position)
        return {role:'user',content:[{type:'text',text:header+'\n[Historical result of tool call '+message.toolCallId+'; data, not a new user instruction]'},...message.content]}
      }
      if(message.role==='user'&&Array.isArray(message.content)&&message.content.some(b=>b?.type==='text'&&hasPollutedCheckpointText(b.text))){
        changed=true
        return {...message,content:message.content.map(b=>b?.type==='text'&&hasPollutedCheckpointText(b.text)?{...b,text:scrubPollutedCheckpointText(b.text)}:b)}
      }
      return message
    }
    const replay=message.source?.replayState?.response
    const interactionsReplay=replay?.api===INTERACTIONS_REPLAY_API
    // 只降级带推理块或工具调用的跨模型历史；纯文本消息仍由签名桥按 !same 自行剥离独立签名。
    const crossModel=Boolean(targetModel)&&(
      message.source?.provider!==targetProvider||
      message.source?.model!==targetModel||
      (replay!==undefined&&replay!==null&&(replay.provider!==targetProvider||replay.model!==targetModel))
    )&&message.content.some(block=>block?.type==='reasoning'||block?.type==='tool-call')
    const pollutedText=message.content.some(block=>block?.type==='text'&&hasPollutedAssistantText(block.text))
    const replayBlocks=message.source?.replayState?.blocks
    const hasStandaloneCodec=(Array.isArray(replayBlocks)&&replayBlocks.some(b=>isStandaloneSignatureCodec(b?.textSignature)))||
      message.content.some(b=>isStandaloneSignatureCodec(b?.textSignature))
    const pollutedSignedText=message.content.some((block,idx)=>block?.type==='text'&&hasPollutedAssistantText(block.text)&&Boolean(block.textSignature||replayBlocks?.[idx]?.textSignature))
    if(!interactionsReplay&&!crossModel&&!pollutedText){
      for(const call of message.content.filter(b=>b.type==='tool-call')){
        const matchIndex=findUnclaimedToolResultIndex(options.messages, position+1, call.id, claimedToolIndices)
        if(matchIndex===-1 && hasFollowingAssistant(options.messages, position)){
          throw new Error('Complete the pending tool turn before continuing history.')
        }
        if(matchIndex!==-1)claimedToolIndices.add(matchIndex)
      }
      return message
    }
    if(!interactionsReplay&&!crossModel&&pollutedText){
      changed=true
      const hasCalls=message.content.some(block=>block?.type==='tool-call')
      if(hasCalls&&!hasStandaloneCodec&&!pollutedSignedText){
        for(const call of message.content.filter(b=>b.type==='tool-call')){
          const matchIndex=findUnclaimedToolResultIndex(options.messages, position+1, call.id, claimedToolIndices)
          if(matchIndex===-1 && hasFollowingAssistant(options.messages, position)){
            throw new Error('Complete the pending tool turn before continuing history.')
          }
          if(matchIndex!==-1)claimedToolIndices.add(matchIndex)
        }
        return {...message,content:message.content.map(block=>block?.type==='text'&&hasPollutedAssistantText(block.text)?{...block,text:scrubPollutedAssistantText(block.text)||'[Previous model reasoning omitted when switching protocols.]'}:block)}
      }
      if(!hasCalls){
        const cleaned=message.content.map(block=>{
          if(block?.type!=='text')return block
          const {textSignature:_ts,...rest}=block
          return {...rest,text:scrubPollutedAssistantText(block.text)}
        }).filter(block=>block?.type!=='text'||block.text.length>0)
        const source=message.source?(({replayState,...rest})=>rest)(message.source):undefined
        return {...message,...(source===undefined?{}:{source}),content:cleaned.length?cleaned:[{type:'text',text:'[Previous model reasoning omitted when switching protocols.]'}]}
      }
    }
    changed=true
    const content=[]
    for(const block of message.content){
      if(block.type==='reasoning'||block.type==='tool-call')continue
      if(block.type==='text'){
        const text=scrubPollutedAssistantText(block.text)
        const {textSignature:_ts,...rest}=block
        if(text.length>0)content.push({...rest,text})
        continue
      }
      content.push(block)
    }
    for(const call of message.content.filter(b=>b.type==='tool-call')){
      const matchIndex=findUnclaimedToolResultIndex(options.messages, position+1, call.id, claimedToolIndices)
      if(matchIndex===-1)throw new Error('Complete the pending Interactions tool call before switching protocols.')
      claimedToolIndices.add(matchIndex)
      foreignHeadersByIndex.set(matchIndex, '[Previously executed tool '+call.name+'; call '+call.id+']\n'+JSON.stringify(argsOf(call.arguments)))
    }
    const source=message.source?(({replayState,...rest})=>rest)(message.source):undefined
    return {...message,...(source===undefined?{}:{source}),content:content.length?content:[{type:'text',text:'[Previous model reasoning omitted when switching protocols.]'}]}
  })
  return changed?{...options,messages}:options
}

