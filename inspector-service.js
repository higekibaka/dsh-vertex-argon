import {randomUUID} from 'node:crypto'
import {shared} from './runtime.js'
import {diagnosticSessionHash} from './diagnostics.js'
import {createResponseHub} from './response-store.js'
import {parseInteractionQuery,interactionQueryErrorResult} from './interaction-query.js'
import {matchesSettlement} from './request-association.js'
const {z}=await shared('zod')
const sessionId=z.string().min(1).max(256), requestId=z.string().uuid()
const page={offset:z.number().int().nonnegative().default(0),length:z.number().int().min(1).max(65536).default(65536)}
const listScope=z.object({sessionId,messageId:z.string().min(1).max(256).optional(),limit:z.number().int().min(1).max(100).default(20)}).strict()
const schemas={
 listRequests:listScope,
 getRequest:z.object({sessionId,requestId}).strict(),
 readResponse:z.object({sessionId,requestId,index:z.number().int().nonnegative().default(0),...page}).strict(),
 queryInteraction:{parse:parseInteractionQuery},
 readQueryResponse:z.object({queryId:requestId,...page}).strict(),
}
export const INSPECTOR_SESSION_METHODS=['listRequests','getRequest','readResponse']
export function inspectorInvocations() {
 return Object.keys(schemas).map(method=>{
  const codec=direction=>{
   const schema=direction==='request'?schemas[method]:{parse(value){
    if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.ok!=='boolean'||(!value.ok&&typeof value.error!=='string'))throw new Error('Invalid inspector response')
    return value
   }}
   return {mode:'strict',typeSymbol:'dsh-vertex-argon/inspector/'+method+'/'+direction,schema,create:()=>schema}
  }
  return {id:'dsh-vertex-argon#vertexArgonDiagnostics/'+method,service:'vertexArgonDiagnostics',namespace:'vertexArgonDiagnostics',method,invocation:{kind:'direct'},parameters:[{name:'request',wire:'request',source:'json',codec:codec('request')}],result:codec('result'),...(method==='queryInteraction'?{cancellation:{parameter:'signal'}}:{})}
 })
}

// Local inspector business operations shared by RPC and later deferred agent tools.
// Global lookup methods intentionally have no sessionId: selected credentials may
// read arbitrary cloud IDs, so a session-only viewer grant is not sufficient.
export function createInspectorOperations(hub,{responseHub,query,readEvent}={}) {
 const queries=createResponseHub({maxRecords:4,maxBytes:32*1024*1024})
 let closed=false
 const owned=(sessionId,id)=>hub.listRecent(200).find(row=>row.id===id&&row.sessionHash===diagnosticSessionHash(sessionId))
 const association=async(record,sessionId,verify=false)=>{
  const locator=record.association
  if(!locator||locator.sessionId!==sessionId)return {association:'unassociated'}
  if(!verify||typeof readEvent!=='function')return {association:'unverified',locator:{...locator}}
  try{
   const window=await readEvent({sessionId,seq:locator.settlementSeq})
   if(!window)return {association:'unverified',locator:{...locator}}
   if(window.session?.id!==sessionId||!matchesSettlement(locator,window.target))return {association:'unassociated'}
   return {association:'linked',locator:{...locator}}
  }catch{return {association:'unverified',locator:{...locator}}}
 }
 const summary=(row,link)=>({id:row.id,startedAt:row.startedAt,route:row.route,model:row.model,protocol:row.protocol??null,outcome:row.outcome,serviceTier:row.serviceTier??null,responseCapture:row.responseCapture??null,...link})
 // Snapshot before historical validation so concurrent arrivals cannot change this list.
 const selectSnapshot=async({sessionId,messageId,limit})=>{
  const candidates=hub.listRecent(200).filter(row=>row.sessionHash===diagnosticSessionHash(sessionId)&&(!messageId||row.association?.messageId===messageId))
  const selected=structuredClone(candidates.slice(0,limit)),records=[]
  for(const row of selected){
   const link=await association(row,sessionId,Boolean(messageId))
   if(!messageId||link.association==='linked')records.push(summary(row,link))
  }
  return {records}
 }
 const invoke=async(method,request,operation)=>{
  try{if(closed)throw new Error('closed');return await operation(schemas[method].parse(request))}
  catch{return {ok:false,code:'ARGON_INSPECTOR_INVALID',error:'Inspector request is invalid or unavailable.'}}
 }
 return {
  listRequests(request){return invoke('listRequests',request,async scope=>{
   const {records}=await selectSnapshot(scope)
   return {ok:true,records}
  })},
  getRequest(request){return invoke('getRequest',request,async({sessionId,requestId})=>{
   const row=owned(sessionId,requestId)
   if(!row)return {ok:true,status:'not-found'}
   const {association:stored,...record}=row
   return {ok:true,status:'available',record:structuredClone(record),...await association(row,sessionId,true)}
  })},
  readResponse(request){return invoke('readResponse',request,({sessionId,requestId,...page})=>({ok:true,page:owned(sessionId,requestId)&&responseHub?responseHub.read({id:requestId,sessionHash:diagnosticSessionHash(sessionId),...page}):{status:'not-retained'}}))},
  async queryInteraction(request,signal){
   try{
    if(closed||typeof query!=='function')throw new Error('unavailable')
    const input=schemas.queryInteraction.parse(request)
    signal?.throwIfAborted()
    const result=await query(input,signal)
    signal?.throwIfAborted()
    if(closed)throw new Error('closed')
    const queryId=randomUUID(),capturedAt=new Date().toISOString()
    const capture=queries.begin({id:queryId,sessionHash:null,startedAt:capturedAt,protocol:'interactions'},true)
    capture.observe('interaction-object',1,result.interaction)
    const retained=capture.finish('done')
    const status=result.interaction.status
    return {ok:true,queryId,capturedAt,identity:result.identity,remoteStatus:['in_progress','completed','requires_action','incomplete','failed','cancelled','budget_exceeded'].includes(status)?status:null,readOnly:true,retention:'memory-only',capture:retained}
   }catch(error){return interactionQueryErrorResult(error,signal)}
  },
  readQueryResponse(request){return invoke('readQueryResponse',request,({queryId,...page})=>({ok:true,page:queries.read({id:queryId,sessionHash:null,...page})}))},
  async close(){if(closed)return;closed=true;query?.close?.();await queries.close()},
 }
}
