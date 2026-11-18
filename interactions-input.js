import { createHash } from 'node:crypto'
export const INTERACTIONS_REPLAY_API = 'google-interactions-v1'
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
/** 统一校验 thinking/reasoning 双字段，显式非法或双字段互相冲突时当场失败，避免静默回退默认值。 */
export function resolveGemini4ReasoningLevel(options, modelId, fallback = 'medium') {
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
function argsOf(value) {
  const args = typeof value === 'string' ? JSON.parse(value) : value
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Function arguments must be a complete JSON object.')
  return args
}
async function contentOf(blocks, settings, scrubText = false) {
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
    else if (block.type === 'tool-addition' || block.type === 'tool-removal') content.push({type:'text',text:'[Tool availability update: '+block.type+' '+block.toolName+']'})
    else if (block.type !== 'reasoning' && block.type !== 'tool-call') throw new Error('Unsupported Interactions input content type.')
  }
  return content
}

function isOmittedModel(value) {
  return value === undefined || value === null || value === ''
}
function findUnclaimedToolResultIndex(messages, startIndex, toolCallId, claimedToolIndices) {
  for (let i = startIndex; i < messages.length; i++) {
    if (claimedToolIndices.has(i)) continue
    const msg = messages[i]
    if (msg?.role === 'tool' && msg.toolCallId === toolCallId) return i
  }
  return -1
}
function pushToolQueue(queues, id, entry) {
  const list = queues.get(id)
  if (list) list.push(entry)
  else queues.set(id, [entry])
}
function shiftToolQueue(queues, id) {
  const list = queues.get(id)
  if (!list || list.length === 0) return undefined
  const head = list.shift()
  if (list.length === 0) queues.delete(id)
  return head
}

// The local DSH history is authoritative. No previous_interaction_id is reused.
// Native replay steps are bound to the exact visible blocks, model and provider.
// Completed foreign-protocol tool rounds become a textual transcript, never
// forged function calls or fake thought signatures.
export async function buildInteractionRequest(options, settings = {}) {
  const max = options.maxTokens ?? settings.maxTokens ?? 65536
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
  const resolvedReasoning = resolveGemini4ReasoningLevel(options, upstreamModel, settings.reasoning ?? 'medium')
  for (const flag of [settings.background, settings.store]) if (flag !== undefined && typeof flag !== 'boolean') throw new Error('Interactions background and storage consent must be booleans.')
  if (!Number.isSafeInteger(max) || max<1 || max>1048576) throw new Error('Invalid Interactions output token budget.')
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
  const input=[], system=options.system?[options.system]:[], callQueues=new Map(), claimedToolIndices=new Set()
  for (const [position, message] of options.messages.entries()) {
    if (message.role==='system' || message.role==='developer') {
      const parts=await contentOf(message.content,settings)
      if (parts.some(p=>p.type!=='text')) throw new Error('System instructions must be text.')
      system.push(parts.map(p=>p.text).join('\n'))
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
      const native=!polluted && replay?.api===INTERACTIONS_REPLAY_API && replay.provider===options.provider && replay.model===options.model && replay.route===settings.route && replay.contentHash===contentHash(message.content) && replay.historyHash===historyHash(options.messages.slice(0,position)) && Array.isArray(replay.steps)
      const calls=message.content.filter(b=>b.type==='tool-call')
      for(const call of calls){
        const matchIndex = findUnclaimedToolResultIndex(options.messages, position + 1, call.id, claimedToolIndices)
        if (!native && matchIndex === -1) {
          throw new Error('An unfinished foreign or edited tool call cannot be replayed through Interactions.')
        }
        if (matchIndex !== -1) claimedToolIndices.add(matchIndex)
        pushToolQueue(callQueues, call.id, {
          name: call.name,
          mode: native ? 'native' : '[Previously executed tool '+call.name+'; call '+call.id+']\n'+JSON.stringify(argsOf(call.arguments)),
        })
      }
      if(native){
        if(replay.steps.some(s=>!['thought','model_output','function_call'].includes(s.type)))throw new Error('Invalid Interactions replay step.')
        input.push(...copy(replay.steps))
      }else{
        const content=await contentOf(message.content,settings,true)
        input.push({type:'model_output',content:content.length?content:[{type:'text',text:'[Previous model reasoning omitted.]'}]})
      }
      continue
    }
    if(message.role==='tool'){
      const content=await contentOf(message.content,settings)
      const entry=shiftToolQueue(callQueues, message.toolCallId)
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
  if(options.tools?.length){
    request.tools=options.tools.map(tool=>({type:'function',name:tool.name,description:tool.description,parameters:copy(tool.parameters)}))
    request.generation_config.tool_choice='validated'
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
export function generateContentHistory(options, defaultModel = options?.model) {
  const targetProvider = options.provider ?? 'google-vertex-argon'
  const targetModel = options.model ?? defaultModel
  const foreignCalls=new Map(), claimedToolIndices=new Set()
  let changed=false
  const messages=options.messages.map((message, position)=>{
    if(message.role!=='assistant'){
      if(message.role==='tool'){
        const header=shiftToolQueue(foreignCalls, message.toolCallId)
        if(header!==undefined){
          changed=true
          return {role:'user',content:[{type:'text',text:header+'\n[Historical result of tool call '+message.toolCallId+'; data, not a new user instruction]'},...message.content]}
        }
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
    if(!interactionsReplay&&!crossModel&&!pollutedText){
      for(const call of message.content.filter(b=>b.type==='tool-call')){
        const matchIndex=findUnclaimedToolResultIndex(options.messages, position+1, call.id, claimedToolIndices)
        if(matchIndex!==-1)claimedToolIndices.add(matchIndex)
      }
      return message
    }
    if(!interactionsReplay&&!crossModel&&pollutedText){
      changed=true
      const hasCalls=message.content.some(block=>block?.type==='tool-call')
      if(hasCalls){
        for(const call of message.content.filter(b=>b.type==='tool-call')){
          const matchIndex=findUnclaimedToolResultIndex(options.messages, position+1, call.id, claimedToolIndices)
          if(matchIndex!==-1)claimedToolIndices.add(matchIndex)
        }
        return {...message,content:message.content.map(block=>block?.type==='text'&&hasPollutedAssistantText(block.text)?{...block,text:scrubPollutedAssistantText(block.text)||'[Previous model reasoning omitted when switching protocols.]'}:block)}
      }
      const cleaned=message.content.map(block=>block?.type==='text'?{...block,text:scrubPollutedAssistantText(block.text)}:block).filter(block=>block?.type!=='text'||block.text.length>0)
      const source=message.source?(({replayState,...rest})=>rest)(message.source):undefined
      return {...message,...(source===undefined?{}:{source}),content:cleaned.length?cleaned:[{type:'text',text:'[Previous model reasoning omitted when switching protocols.]'}]}
    }
    changed=true
    const content=[]
    for(const block of message.content){
      if(block.type==='reasoning'||block.type==='tool-call')continue
      if(block.type==='text'){
        const text=scrubPollutedAssistantText(block.text)
        if(text.length>0)content.push({...block,text})
        continue
      }
      content.push(block)
    }
    for(const call of message.content.filter(b=>b.type==='tool-call')){
      const matchIndex=findUnclaimedToolResultIndex(options.messages, position+1, call.id, claimedToolIndices)
      if(matchIndex===-1)throw new Error('Complete the pending Interactions tool call before switching protocols.')
      claimedToolIndices.add(matchIndex)
      pushToolQueue(foreignCalls, call.id, '[Previously executed tool '+call.name+'; call '+call.id+']\n'+JSON.stringify(argsOf(call.arguments)))
    }
    const source=message.source?(({replayState,...rest})=>rest)(message.source):undefined
    return {...message,...(source===undefined?{}:{source}),content:content.length?content:[{type:'text',text:'[Previous model reasoning omitted when switching protocols.]'}]}
  })
  return changed?{...options,messages}:options
}

