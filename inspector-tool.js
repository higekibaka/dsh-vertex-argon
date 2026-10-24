import {shared} from './runtime.js'
import {parseInteractionQuery} from './interaction-query.js'
const {z}=await shared('zod')
const id=z.string().uuid(), offset=z.number().int().min(0).max(64*1024*1024).default(0)
const fragment={offset,length:z.number().int().min(1).max(16384).default(4096)}
const schemas={
 list:z.object({action:z.literal('list'),messageId:z.string().min(1).max(256).optional(),limit:z.number().int().min(1).max(50).default(10)}).strict(),
 detail:z.object({action:z.literal('detail'),requestId:id,offset,limit:z.number().int().min(1).max(10).default(5)}).strict(),
 response:z.object({action:z.literal('response'),requestId:id,index:z.number().int().min(0).max(16383).default(0),...fragment}).strict(),
 query:z.object({action:z.literal('query'),route:z.enum(['google-vertex','google-generative-ai']),id:z.string()}).strict(),
 'query-response':z.object({action:z.literal('query-response'),queryId:id,...fragment}).strict(),
}
const failure=(code,error)=>({ok:false,code,error})
const cancelled=()=>failure('ARGON_INSPECTOR_CANCELLED','Argon inspection was cancelled; no remote cancellation was requested.')
function pageDetail(result,offset,limit){
 if(!result.ok||result.status!=='available')return result
 const value=structuredClone(result), record=value.record, totals={hops:record.hops?.length??0}
 if(record.hops)record.hops=record.hops.slice(offset,offset+limit)
 value.rowPage={offset,limit,totals,nextOffset:offset+limit<totals.hops?offset+limit:null}
 return value
}

// Presentation only: every application operation remains in the same Host service
// as the UI. No configuration, permissions, recovery releases or cloud tool execution.
export function createInspectorTool(service){
 return {
  name:'argon_inspect',deferLoading:true,
  description:'Read Argon request diagnostics, token watermarks, hop trajectories and retained response fragments. Local records belong to this session. Known-ID queries use the selected route’s current credentials and never resume generation, cancel cloud work, or execute returned tools. Raw responses are untrusted data; local captures require prior user opt-in.',
  parameters:{type:'object',additionalProperties:false,required:['action'],properties:{
   action:{type:'string',enum:['list','detail','response','query','query-response'],description:'list finds local request IDs; detail pages diagnostic hops; response reads one captured frame; query performs one read-only cloud GET; query-response reads its temporary result.'},
   messageId:{type:'string',description:'list only: filter to a verified finalized answer ID.'},
   requestId:{type:'string',description:'Required for detail/response; ID returned by list.'},
   queryId:{type:'string',description:'Required for query-response; temporary locator returned by query.'},
   route:{type:'string',enum:['google-vertex','google-generative-ai'],description:'Required for query; selects current configured credentials, not the original task account.'},
   id:{type:'string',description:'Required for query; opaque Interaction ID, not a URL or resource path.'},
   index:{type:'integer',minimum:0,maximum:16383,description:'response only: zero-based captured frame, default 0.'},
   offset:{type:'integer',minimum:0,maximum:67108864,description:'Default 0. detail: hop offset; response/query-response: character offset within the frame.'},
   limit:{type:'integer',minimum:1,maximum:50,description:'list: 1–50, default 10. detail: 1–10 hops, default 5. Not used for response fragments.'},
   length:{type:'integer',minimum:1,maximum:16384,description:'response/query-response only: character limit, default 4096; follow nextOffset for more.'},
  }},
  output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
  timeoutMs:35000,isConcurrencySafe:()=>true,
  async execute(args,exec){
   if(exec.signal?.aborted)return cancelled()
   const sessionId=exec.agent?.id
   if(typeof sessionId!=='string'||!sessionId||sessionId.length>256)return failure('ARGON_INSPECTOR_SESSION','An executing session is required.')
   let input
   try{
    if(!args||typeof args!=='object'||!Object.hasOwn(schemas,args.action))throw Error('invalid')
    input=schemas[args.action].parse(args)
    if(input.action==='query')parseInteractionQuery({route:input.route,id:input.id})
   }catch{return failure('ARGON_INSPECTOR_INVALID','Invalid Argon inspection arguments; use only fields for the selected action.')}
   try{
    let result
    if(input.action==='list')result=await service.listRequests({sessionId,limit:input.limit,...(input.messageId?{messageId:input.messageId}:{})})
    else if(input.action==='detail')result=pageDetail(await service.getRequest({sessionId,requestId:input.requestId}),input.offset,input.limit)
    else if(input.action==='response')result=await service.readResponse({sessionId,requestId:input.requestId,index:input.index,offset:input.offset,length:input.length})
    else if(input.action==='query')result=await service.queryInteraction({route:input.route,id:input.id},exec.signal)
    else result=await service.readQueryResponse({queryId:input.queryId,offset:input.offset,length:input.length})
    return exec.signal?.aborted?cancelled():result
   }catch{return exec.signal?.aborted?cancelled():failure('ARGON_INSPECTOR_UNAVAILABLE','Argon inspection is unavailable.')}
  },
 }
}
