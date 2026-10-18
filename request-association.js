import {AsyncLocalStorage} from 'node:async_hooks'
import {shared} from './runtime.js'
const {isAgentLoopRequest}=await shared('@deepseek-ai/dsh-llm')
const context=new AsyncLocalStorage()
const integer=value=>Number.isSafeInteger(value)&&value>=0
const identity=value=>typeof value==='string'&&value.length>0&&value.length<=256
const eventTypes=new Set(['assistant/message','assistant/attempt'])

// Only a diagnostic constructed inside this exact marked request may attach later.
export function captureRequestAssociation(sessionId) {
 const binding=context.getStore()
 return binding&&binding.sessionId===sessionId?binding.record:undefined
}

// This is an ephemeral join, not a second session log. Persisted locators are
// revalidated against sessionQuery on detail reads; bodies and attempt IDs stay out.
export function matchesSettlement(locator,event) {
 if(!event||event.type!==locator.eventType||event.seq!==locator.settlementSeq||event.data?.turn!==locator.turn||event.data?.step!==locator.step)return false
 if(event.type==='assistant/attempt')return locator.messageId===undefined
 const message=event.data.message
 return identity(message?.id)&&(!locator.messageId||message.id===locator.messageId)&&message.source?.provider===locator.provider&&message.source?.model===locator.model
}

export function createRequestAssociationHub(link) {
 const agents=new Map()
 let closed=false
 const invalidate=state=>{state.disposed=true;for(const a of state.attempts.values())a.valid=false;state.attempts.clear();state.events.clear()}
 const publish=(state,a,id)=>{if(!closed&&!state.disposed&&a.valid&&a.locator){try{link(id,{...a.locator})}catch{}}}
 const settle=(state,a)=>{
  if(!a.valid||!a.request||!a.outcome||a.outcome.kind!=='committed')return
  const event=state.events.get(a.outcome.seq)
  if(!event)return
  const locator={version:1,sessionId:state.sessionId,settlementSeq:a.outcome.seq,eventType:a.outcome.eventType,turn:a.turn,step:a.step,...a.request}
  if(!matchesSettlement(locator,event)){a.valid=false;return}
  if(event.type==='assistant/message')locator.messageId=event.data.message.id
  a.locator=locator
  for(const id of a.records)publish(state,a,id)
  a.records.clear()
 }
 const bind=request=>{
  if(closed)return undefined
  const candidates=[...agents.values()].filter(s=>!s.disposed&&s.sessionId===request.sessionId&&s.current)
  if(candidates.length!==1){for(const s of candidates)s.current.valid=false;return undefined}
  const state=candidates[0],a=state.current
  if(!a.valid||a.claimed){a.valid=false;return undefined}
  a.claimed=true;a.request={provider:request.provider,model:request.model}
  return {sessionId:state.sessionId,record(id){
   if(closed||state.disposed||!a.valid)return
   if(a.locator){publish(state,a,id);return}
   if(a.records.size>=64){a.valid=false;a.records.clear();return}
   a.records.add(id)
  }}
 }
 return {
  stream(options,next){
   // Read the WeakSet marker before the Host creates adapter-specific clones.
   const eligible=isAgentLoopRequest(options)&&!options.purpose&&identity(options.sessionId)&&identity(options.provider)&&identity(options.model)
   return {[Symbol.asyncIterator](){
    let iterator,binding,started=false
    const call=(method,value)=>{
     if(!started){started=true;binding=eligible?bind(options):undefined}
     return context.run(binding,()=>{
      iterator??=next()[Symbol.asyncIterator]()
      if(typeof iterator[method]==='function')return iterator[method](value)
      if(method==='throw')return Promise.reject(value)
      return Promise.resolve({done:true,value})
     })
    }
    return {next:value=>call('next',value),return:value=>call('return',value),throw:error=>call('throw',error),[Symbol.asyncIterator](){return this}}
   }}
  },
  frame({agent,frame}){
   if(closed||!identity(agent?.id)||!frame)return
   let state=agents.get(agent)
   if(frame.type==='start'){
    if(!identity(frame.attemptId)||!integer(frame.turn)||!integer(frame.step))return
    if(!state){
     if(agents.size>=256){const key=agents.keys().next().value;invalidate(agents.get(key));agents.delete(key)}
     state={sessionId:agent.id,disposed:false,current:null,attempts:new Map(),events:new Map()};agents.set(agent,state)
    }
    const overlapping=Boolean(state.current)
    if(overlapping)state.current.valid=false
    const duplicate=state.attempts.get(frame.attemptId)
    if(duplicate)duplicate.valid=false
    const a={turn:frame.turn,step:frame.step,valid:!overlapping&&!duplicate,claimed:false,records:new Set()}
    state.attempts.set(frame.attemptId,a);state.current=a
    while(state.attempts.size>16){const key=state.attempts.keys().next().value;state.attempts.get(key).valid=false;state.attempts.delete(key)}
   }else if(frame.type==='end'&&state){
    const a=state.attempts.get(frame.attemptId)
    if(!a||a.outcome)return
    if(state.current===a)state.current=null
    a.outcome=frame.outcome
    if(frame.outcome?.kind!=='committed'||!eventTypes.has(frame.outcome.eventType)||!integer(frame.outcome.seq)){a.valid=false;a.records.clear();return}
    settle(state,a)
   }
  },
  event(session,event){
   if(closed||!eventTypes.has(event?.type)||!integer(event.seq))return
   // Keep only fields needed for the join, never full message/stream bodies.
   const data=event.data,snapshot={type:event.type,seq:event.seq,data:{turn:data?.turn,step:data?.step,...(event.type==='assistant/message'?{message:{id:data?.message?.id,source:{provider:data?.message?.source?.provider,model:data?.message?.source?.model}}}:{})}}
   for(const state of agents.values())if(!state.disposed&&state.sessionId===session.id){
    state.events.set(event.seq,snapshot)
    while(state.events.size>32)state.events.delete(state.events.keys().next().value)
    for(const a of state.attempts.values())if(!a.locator)settle(state,a)
   }
  },
  dispose(agent){const state=agents.get(agent);if(state)invalidate(state);agents.delete(agent)},
  close(){if(closed)return;closed=true;for(const state of agents.values())invalidate(state);agents.clear()},
 }
}
