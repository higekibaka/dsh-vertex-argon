// Official steps/event protocol, not the legacy content.* stream:
// https://ai.google.dev/api/interactions-api#Resource:InteractionSseStreamEvent
// https://ai.google.dev/gemini-api/docs/long-decode#stream-long-decode
import { buildInteractionRequest, contentHash, historyHash, INTERACTIONS_REPLAY_API } from './interactions-input.js'
import { computeReconnectDelayMs, waitWithAbort, parseUpstreamRetryDelayMs, MAX_SERVER_RETRY_DELAY_MS } from './generate-content.js'
import { fetchErrorCodes } from './diagnostics.js'
import { interactionExitReason, cancelsRemoteInteraction, isRecoverableStreamErrorCode, normalizeStreamErrorCode } from './interaction-lifecycle.js'
export { buildInteractionRequest } from './interactions-input.js'
const terminal = new Set(['completed','requires_action','incomplete','failed','cancelled','budget_exceeded'])
const MAX_BYTES = 64*1024*1024
const MAX_EVENTS = 65536
function protocolError(message) { return Object.assign(new Error(message),{code:'ARGON_INTERACTIONS_PROTOCOL'}) }
const retryable = e => {
  // A server asking for a longer wait than GenerateContent allows fails fast.
  if(parseUpstreamRetryDelayMs(e) > MAX_SERVER_RETRY_DELAY_MS)return false
  return e?.recoverableStreamError === true || !String(e?.code??'').startsWith('ARGON_') && (e?.status===undefined || e.status===408 || e.status===429 || e.status>=500 || (e.status>=200 && e.status<300 && ['stream','response-body'].includes(e.phase) && fetchErrorCodes(e).length>0))
}
function validObject(value) { return value && typeof value==='object' && !Array.isArray(value) }
function usageOf(raw) {
  const count=k=>Number.isSafeInteger(raw?.[k])&&raw[k]>=0?raw[k]:0
  const cached=count('total_cached_tokens'), input=count('total_input_tokens'), output=count('total_output_tokens'), thoughts=count('total_thought_tokens'), tool=count('total_tool_use_tokens')
  return {inputTokens:Math.max(0,input-cached)+tool,cacheReadTokens:cached,outputTokens:output+thoughts,reasoningTokens:thoughts,totalTokens:count('total_tokens')||(input+output+thoughts+tool)}
}

// transport.create(body,{signal}) -> AsyncIterable<Event>
// transport.get(id,{stream:true,last_event_id,signal}) -> AsyncIterable<Event>
// transport.cancel(id,{signal?}) -> response (must accept a fresh signal).
export async function* streamInteractions(options, settings) {
  const signal=options.signal, transport=settings.transport
  const steps=new Map(), blocks=new Map(), seenEvents=new Set(), emittedToolIds=new Set()
  let exitReason='consumer-abandoned'
  let blockIndex=0, bytes=0, interactionId, lastEventId, status, usage, cancelled=false, finishedNormally=false, emitted=false, completedEvent=false, progressVersion=0
  const observeUsage=event=>{const u=event.interaction?.usage??event.usage??event.metadata?.total_usage;if(validObject(u)){const before=(usage?.total_output_tokens??0)+(usage?.total_thought_tokens??0);usage={...usage,...u};if((usage.total_output_tokens??0)+(usage.total_thought_tokens??0)>before)progressVersion++}}
  const checkBytes=text=>{bytes+=Buffer.byteLength(text??'');if(bytes>MAX_BYTES)throw protocolError('Interactions output exceeded the bounded response buffer.')}
  function* appendText(state, text, reasoning=false) {
    if(typeof text!=='string')throw protocolError('Interactions text delta is not a string.')
    if(!text)return
    if(state.closed)throw protocolError('Received a delta for an already closed step.')
    checkBytes(text)
    if(state.blockIndex===undefined){state.blockIndex=blockIndex++;yield{type:'block-start',index:state.blockIndex,blockType:reasoning?'reasoning':'text'}}
    state.text+=text;emitted=true;progressVersion++
    yield{type:reasoning?'reasoning-delta':'text-delta',index:state.blockIndex,text}
  }
  function* closeText(state) {
    if(state.blockIndex!==undefined&&!state.blockClosed){
      const block={type:state.kind==='thought'?'reasoning':'text',text:state.text}
      state.blockClosed=true;blocks.set(state.blockIndex,block)
      yield{type:'block-end',index:state.blockIndex,block}
    }
  }
  function stateFor(index) {
    if(!Number.isSafeInteger(index)||index<0||index>4095)throw protocolError('Invalid Interactions step index.')
    const state=steps.get(index)
    if(!state)throw protocolError('Interactions delta arrived before its step.start.')
    return state
  }
  function* handle(event) {
    if(!validObject(event))throw protocolError('Invalid Interactions event.')
    if(event.event_id){
      if(typeof event.event_id!=='string')throw protocolError('Invalid event ID.')
      if(seenEvents.has(event.event_id))return
      if(seenEvents.size>=MAX_EVENTS)throw protocolError('Interactions event retention limit reached.')
      seenEvents.add(event.event_id);lastEventId=event.event_id
    }
    settings.onEvent?.(event)
    const type=event.event_type??event.type
    const id=event.interaction?.id??event.interaction_id
    if(id){if(interactionId&&interactionId!==id)throw protocolError('Interaction ID changed mid-stream.');interactionId=id}
    observeUsage(event)
    if(type==='interaction.created'||type==='interaction.status_update'||type==='interaction.completed'){
      const nextStatus=event.interaction?.status??event.status??(type==='interaction.completed'?'completed':status)
      // A confirmed terminal status is never rolled back by a later notice.
      if(!terminal.has(status)||terminal.has(nextStatus))status=nextStatus
      // A status_update carrying a failed/cancelled/over-budget state is itself the
      // end of the stream: EOF must finalize it rather than retrying the hop.
      // A plain completed status still waits for the dedicated completed event.
      if(type==='interaction.completed'||(type==='interaction.status_update'&&['failed','cancelled','budget_exceeded'].includes(status)))completedEvent=true
      return
    }
    // 2026-05-20 emits dedicated terminal lifecycle events instead of only
    // interaction.completed; each one closes the stream on its own.
    if(type==='interaction.in_progress'||type==='interaction.requires_action'||type==='interaction.failed'||type==='interaction.cancelled'||type==='interaction.incomplete'||type==='interaction.budget_exceeded'){
      const implied=type.slice('interaction.'.length)
      const nextStatus=event.interaction?.status??event.status??implied
      // The same guard as status updates: a lifecycle notice for a task that has
      // already reached a confirmed terminal state never rolls it back.
      if(!terminal.has(status)||terminal.has(nextStatus))status=nextStatus
      if(type!=='interaction.in_progress')completedEvent=true
      return
    }
    if(type==='error'){
      const code=normalizeStreamErrorCode(event.error?.code)
      const error=protocolError('Interactions returned an error event ('+code+').')
      // Only retry the existing stored task, never create another paid task.
      error.recoverableStreamError=isRecoverableStreamErrorCode(code)
      if(!error.recoverableStreamError){
        // An unclassified error frame is not proof that the cloud task ended:
        // nothing is reported as terminal until the cloud state is re-probed.
        error.remoteTerminalError=true
        status='failed'
      }
      throw error
    }
    if(type==='step.start'){
      if(!Number.isSafeInteger(event.index)||event.index<0||event.index>4095||steps.has(event.index))throw protocolError('Invalid or duplicate step.start.')
      const step=event.step
      // Replayed user-input steps are structural markers with no model output.
      if(validObject(step)&&step.type==='user_input'){steps.set(event.index,{kind:'user_input',closed:false});progressVersion++;return}
      if(!validObject(step)||!['thought','model_output','function_call'].includes(step.type))throw protocolError('Unsupported Interactions step type; this adapter executes only DSH-declared local tools.')
      const state={kind:step.type,text:'',signature:step.signature,callId:step.id,name:step.name,argsValue:step.arguments,argsText:'',closed:false}
      steps.set(event.index,state);progressVersion++
      if(step.type==='model_output')for(const content of step.content??[]){if(content.type!=='text')throw protocolError('Unsupported output modality.');yield*appendText(state,content.text)}
      if(step.type==='thought')for(const content of step.summary??[]){if(content.type==='text')yield*appendText(state,content.text,true)}
      return
    }
    if(type==='step.delta'){
      const state=stateFor(event.index),delta=event.delta
      if(!validObject(delta))throw protocolError('Invalid step delta.')
      if(state.kind==='user_input'){
        if(state.closed)throw protocolError('Received a delta for an already closed step.')
        return
      }
      if(delta.type==='text_annotation_delta'&&state.kind==='model_output')return // additive citations; no DSH annotation block type
      if(delta.type==='text'&&state.kind==='model_output')yield*appendText(state,delta.text)
      else if(delta.type==='thought_summary'&&state.kind==='thought'){
        if(delta.content?.type==='text')yield*appendText(state,delta.content.text,true)
        else if(delta.content!==undefined)throw protocolError('Unsupported thought summary modality.')
      }else if(delta.type==='thought_signature'&&state.kind==='thought'){
        if(typeof delta.signature!=='string')throw protocolError('Invalid thought signature.')
        checkBytes(delta.signature);if(state.signature!==delta.signature)progressVersion++;state.signature=delta.signature
      }else if(state.kind==='function_call'&&['arguments_delta','arguments','function_call'].includes(delta.type)){
        if(state.closed)throw protocolError('Function arguments arrived after step.stop.')
        if(delta.id)state.callId=delta.id;if(delta.name)state.name=delta.name
        const args=delta.partial_arguments??delta.arguments
        if(typeof args==='string'){checkBytes(args);state.argsText+=args;if(args)progressVersion++}
        else if(validObject(args)){const encoded=JSON.stringify(args);checkBytes(encoded);if(encoded!==JSON.stringify(state.argsValue))progressVersion++;state.argsValue=args}
        else throw protocolError('Invalid function argument delta.')
      }else throw protocolError('Unexpected Interactions delta for this step.')
      return
    }
    if(type==='step.stop'){
      const state=stateFor(event.index)
      if(state.closed)throw protocolError('Duplicate step.stop without a replay cursor.')
      state.closed=true;progressVersion++
      if(state.kind==='user_input')return
      if(state.kind==='function_call'){
        try{state.args=state.argsText?JSON.parse(state.argsText):(state.argsValue??{})}catch{state.invalidArguments=true}
        if(!validObject(state.args))state.invalidArguments=true
      }else yield*closeText(state)
      return
    }
    // Usage/status extensions may be added without rendering; unknown semantic
    // output events fail closed rather than silently losing generated content.
    if(typeof type==='string'&&type.startsWith('interaction.')){
      // Future non-content lifecycle notices and heartbeats must never abort a
      // paid task; only an explicit error event is fatal. Their payload is
      // unknown, so it must never overwrite an already confirmed status.
      return
    }
    throw protocolError('Unknown Interactions stream event.')
  }
  const cancel=async()=>{
    if(settings.background&&interactionId&&!terminal.has(status)&&!cancelled){
      cancelled=true // one attempt per unwind, even if confirmation fails
      await transport.cancel(interactionId,{signal:AbortSignal.timeout(30000)})
    }
  }
  try{
    signal?.throwIfAborted()
    const body=await buildInteractionRequest(options,settings)
    let stream=await transport.create(body,{signal})
    let reconnects=0,connections=1,replayingWithoutCursor=false
    const deadline=Date.now()+24*60*60*1000
    for(;;){
      const beforeProgress=progressVersion
      let failure
      try{
        if(!stream?.[Symbol.asyncIterator])throw protocolError('Interactions create/get returned no event stream.')
        for await(const event of stream){signal?.throwIfAborted();yield*handle(event)}
      }catch(e){failure=e}
      // A terminal frame or an unrecoverable failure decides the outcome before a
      // simultaneous local abort: aborting must not rewrite it as a user stop and
      // must not send /cancel to a remote task that already ended.
      if(!failure&&completedEvent&&terminal.has(status))break
      if(failure&&!retryable(failure))throw failure
      signal?.throwIfAborted()
      if((!replayingWithoutCursor||lastEventId)&&progressVersion>beforeProgress)reconnects=0
      if(connections>=64||Date.now()>=deadline)throw Object.assign(new Error('Interactions recovery reached its connection or runtime bound.'),{code:'ARGON_INTERACTIONS_INTERRUPTED'})
      if(!settings.store||!interactionId||reconnects>=3)throw failure??Object.assign(new Error('Interactions stream ended without a terminal status or safe recovery cursor.'),{code:'ARGON_INTERACTIONS_INTERRUPTED'})
      if(!lastEventId){
        if(emitted)throw protocolError('The stored Interactions read stream omitted event_id after visible output; refusing unsafe replay. The remote task will be explicitly terminated, not resubmitted.')
        // No visible blocks or tool calls have escaped: discard cursor-free
        // partial steps before replaying this same stored interaction from zero.
        replayingWithoutCursor=true
        steps.clear();blocks.clear();seenEvents.clear();emittedToolIds.clear()
        blockIndex=0;bytes=0;status=undefined;usage=undefined;completedEvent=false
      }else replayingWithoutCursor=false
      const delayMs=computeReconnectDelayMs(++reconnects,settings.reconnectBackoff,parseUpstreamRetryDelayMs(failure))
      await waitWithAbort(delayMs,signal)
      // The transport options of get() stay byte-for-byte unchanged; hops only
      // observe the suggested wait for diagnostics.
      settings.onReconnectDelay?.(delayMs)
      connections++
      // Reconnect even if an early status said completed: drain the replayed
      // events through EOF before finalizing, as required by the long-decode guide.
      try{stream=await transport.get(interactionId,{stream:true,...(lastEventId?{last_event_id:lastEventId}:{}),signal})}
      catch(e){
        if(!retryable(e)||reconnects>=3)throw e
        stream=(async function*(){throw e})()
      }
    }
    for(const state of steps.values())if(state.kind!=='function_call'&&state.kind!=='user_input')yield*closeText(state)
    const toolStates=[...steps.values()].filter(s=>s.kind==='function_call')
    if(status==='completed'||status==='requires_action'){
      if([...steps.values()].some(state=>!state.closed))throw protocolError('Interactions completed before every step.stop was received.')
      if(status==='requires_action'&&!toolStates.length)throw protocolError('requires_action contained no supported local function call.')
      for(const state of toolStates){
        if(!state.closed||state.invalidArguments||typeof state.callId!=='string'||!state.callId||typeof state.name!=='string'||!state.name)throw protocolError('Interactions tool call was incomplete or contained invalid JSON.')
        if(emittedToolIds.has(state.callId))throw protocolError('Duplicate function call ID.')
        emittedToolIds.add(state.callId)
      }
      // Validate all calls before committing any one of them to the host.
      for(const state of toolStates){
        const index=blockIndex++,argumentsText=JSON.stringify(state.args)
        const block={type:'tool-call',id:state.callId,name:state.name,arguments:argumentsText}
        blocks.set(index,block)
        yield{type:'block-start',index,blockType:'tool-call'}
        yield{type:'tool-call-delta',index,id:state.callId,name:state.name,argumentsDelta:argumentsText}
        yield{type:'block-end',index,block}
      }
    }
    if(usage)yield{type:'usage',usage:usageOf(usage)}
    const content=[...blocks.entries()].sort((a,b)=>a[0]-b[0]).map(([,block])=>block)
    const replaySteps=[]
    if(status==='completed'||status==='requires_action')for(const [,state]of [...steps.entries()].sort((a,b)=>a[0]-b[0])){
      if(state.kind==='user_input')continue
      if(state.kind==='thought')replaySteps.push({type:'thought',...(state.signature?{signature:state.signature}:{}),...(state.text?{summary:[{type:'text',text:state.text}]}:{})})
      else if(state.kind==='model_output')replaySteps.push({type:'model_output',content:[{type:'text',text:state.text}]})
      else replaySteps.push({type:'function_call',id:state.callId,name:state.name,arguments:state.args})
    }
    const kind=status==='requires_action'||(status==='completed'&&toolStates.length)?'tool-calls':status==='completed'?'stop':(status==='incomplete'||status==='budget_exceeded')?'max-tokens':status==='cancelled'?'aborted':'error'
    const reason=['aborted','error'].includes(kind)?{kind,failure:{code:kind==='aborted'?'ABORTED':'ARGON_INTERACTIONS_FAILED',message:'Remote interaction '+status+'.'}}:{kind}
    finishedNormally=true
    exitReason='completed'
    settings.onTerminal?.(status)
    yield{type:'finish',reason,...(replaySteps.length?{replayState:{response:{api:INTERACTIONS_REPLAY_API,provider:options.provider,model:options.model,route:settings.route,contentHash:contentHash(content),historyHash:historyHash(options.messages),steps:replaySteps}}}:{})}
  }catch(error){
    exitReason=interactionExitReason(error,signal)
    const aborted=exitReason==='user-stop'||exitReason==='host-shutdown'
    const retained=settings.background&&interactionId&&!terminal.has(status)&&!cancelsRemoteInteraction(exitReason)
    let cancellationError=false
    if(cancelsRemoteInteraction(exitReason)){try{await cancel()}catch{cancellationError=true}}
    for(const state of steps.values())if(state.kind!=='function_call')yield*closeText(state)
    if(usage)yield{type:'usage',usage:usageOf(usage)}
    yield{type:'finish',reason:{kind:aborted?'aborted':'error',failure:{code:retained?'ARGON_BACKGROUND_READ_INTERRUPTED':aborted?'ABORTED':error.code??'ARGON_INTERACTIONS',message:(error.message??'Interactions request failed.')+(retained?' The remote task ID is retained; cloud status is unverified. Query or resume this task instead of creating another.':'')+(cancellationError?' Remote cancellation is unconfirmed; the host retains its recovery record.':''),...(error.status?{status:error.status}:{})}}}
  }finally{
    if(!finishedNormally&&cancelsRemoteInteraction(exitReason)){try{await cancel()}catch{}}
    settings.onExit?.(exitReason)
  }
}
