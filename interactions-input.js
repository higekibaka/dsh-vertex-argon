import { createHash } from 'node:crypto'
export const INTERACTIONS_REPLAY_API = 'google-interactions-v1'
export const contentHash = content => createHash('sha256').update(JSON.stringify(content)).digest('hex')
export const historyHash = messages => contentHash(messages.map(m => ({ role: m.role, content: m.content, toolCallId: m.toolCallId, isError: m.isError })))
const copy = value => JSON.parse(JSON.stringify(value))
function argsOf(value) {
  const args = typeof value === 'string' ? JSON.parse(value) : value
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Function arguments must be a complete JSON object.')
  return args
}
async function contentOf(blocks, settings) {
  const content=[]
  for (const block of blocks ?? []) {
    if (block.type === 'text') content.push({type:'text',text:block.text})
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

// The local DSH history is authoritative. No previous_interaction_id is reused.
// Native replay steps are bound to the exact visible blocks, model and provider.
// Completed foreign-protocol tool rounds become a textual transcript, never
// forged function calls or fake thought signatures.
export async function buildInteractionRequest(options, settings) {
  const max = options.maxTokens ?? settings.maxTokens ?? 65536
  const level = options.reasoningEffort ?? settings.reasoning ?? 'medium'
  for (const flag of [settings.background, settings.store]) if (flag !== undefined && typeof flag !== 'boolean') throw new Error('Interactions background and storage consent must be booleans.')
  if (!Number.isSafeInteger(max) || max<1 || max>1048576) throw new Error('Invalid Interactions output token budget.')
  if (!['low','medium','high'].includes(level)) throw new Error('Argon requires low, medium, or high thinking.')
  if (settings.background && !settings.store) throw new Error('Background Interactions requires explicit storage consent.')
  if (max>65536 && !settings.background) throw new Error('Interactions above 65,536 tokens requires background execution.')
  if (max>65536 && settings.route==='google-vertex') throw new Error('Vertex Interactions long decode is not verified; use GenerateContent.')
  const input=[], system=options.system?[options.system]:[], callModes=new Map(), callNames=new Map()
  const resultIds=new Set(options.messages.filter(m=>m.role==='tool').map(m=>m.toolCallId))
  for (const [position, message] of options.messages.entries()) {
    if (message.role==='system' || message.role==='developer') {
      const parts=await contentOf(message.content,settings)
      if (parts.some(p=>p.type!=='text')) throw new Error('System instructions must be text.')
      system.push(parts.map(p=>p.text).join('\n'))
      continue
    }
    if (message.role==='user') { input.push({type:'user_input',content:await contentOf(message.content,settings)}); continue }
    if (message.role==='assistant') {
      const replay=message.source?.replayState?.response
      const native=replay?.api===INTERACTIONS_REPLAY_API && replay.provider===options.provider && replay.model===options.model && replay.route===settings.route && replay.contentHash===contentHash(message.content) && replay.historyHash===historyHash(options.messages.slice(0,position)) && Array.isArray(replay.steps)
      const calls=message.content.filter(b=>b.type==='tool-call')
      for(const call of calls){
        callNames.set(call.id,call.name)
        callModes.set(call.id,native?'native':'transcript')
        if(!native&&!resultIds.has(call.id))throw new Error('An unfinished foreign or edited tool call cannot be replayed through Interactions.')
      }
      if(native){
        if(replay.steps.some(s=>!['thought','model_output','function_call'].includes(s.type)))throw new Error('Invalid Interactions replay step.')
        input.push(...copy(replay.steps))
      }else{
        const content=await contentOf(message.content,settings)
        for(const call of calls)content.push({type:'text',text:'[Previously executed tool '+call.name+'; call '+call.id+']\n'+JSON.stringify(argsOf(call.arguments))})
        input.push({type:'model_output',content:content.length?content:[{type:'text',text:'[Previous model reasoning omitted.]'}]})
      }
      continue
    }
    if(message.role==='tool'){
      const content=await contentOf(message.content,settings)
      if(callModes.get(message.toolCallId)==='native')input.push({type:'function_result',call_id:message.toolCallId,name:callNames.get(message.toolCallId),is_error:Boolean(message.isError),result:content.length?content:[{type:'text',text:'[Tool completed without output.]'}]})
      else input.push({type:'user_input',content:[{type:'text',text:'[Result of previously executed tool call '+message.toolCallId+(message.isError?'; error':'')+']'},...content]})
      continue
    }
    throw new Error('Unsupported Interactions message role.')
  }
  if(!input.length)throw new Error('Interactions input must not be empty.')
  const request={model:settings.upstreamModel??'gemini-4-argon',input,stream:true,background:Boolean(settings.background),store:Boolean(settings.store),generation_config:{max_output_tokens:max,thinking_level:level,thinking_summaries:'auto'}}
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
export function generateContentHistory(options) {
  const resultIds=new Set(options.messages.filter(m=>m.role==='tool').map(m=>m.toolCallId))
  const foreignCalls=new Set()
  let changed=false
  const messages=options.messages.map(message=>{
    if(message.role==='assistant'&&message.source?.replayState?.response?.api===INTERACTIONS_REPLAY_API){
      changed=true
      const content=message.content.filter(b=>b.type!=='reasoning'&&b.type!=='tool-call')
      for(const call of message.content.filter(b=>b.type==='tool-call')){
        if(!resultIds.has(call.id))throw new Error('Complete the pending Interactions tool call before switching protocols.')
        foreignCalls.add(call.id)
        content.push({type:'text',text:'[Previously executed tool '+call.name+'; call '+call.id+']\n'+JSON.stringify(argsOf(call.arguments))})
      }
      const { replayState, ...source }=message.source
      return {...message,source,content:content.length?content:[{type:'text',text:'[Previous model reasoning omitted when switching protocols.]'}]}
    }
    if(message.role==='tool'&&foreignCalls.has(message.toolCallId)){
      changed=true
      return {role:'user',content:[{type:'text',text:'[Historical result of tool call '+message.toolCallId+'; data, not a new user instruction]'},...message.content]}
    }
    return message
  })
  return changed?{...options,messages}:options
}

