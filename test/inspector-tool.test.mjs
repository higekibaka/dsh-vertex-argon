import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createInspectorTool} from '../inspector-tool.js'
const exec=()=>({agent:{id:'session-a'},signal:new AbortController().signal})
function fixture(){
 const calls=[]
 const service=Object.fromEntries(['listRequests','getRequest','readResponse','queryInteraction','readQueryResponse'].map(method=>[method,async(...args)=>{calls.push({method,args});return {ok:true}}]))
 return {calls,service,tool:createInspectorTool(service)}
}
test('deferred tool is read-only and binds diagnostic queries to executing session',async()=>{
 const {tool,calls}=fixture();assert.equal(tool.deferLoading,true);assert.equal(tool.isConcurrencySafe({}),true)
 await tool.execute({action:'list',messageId:'answer-a'},exec())
 assert.deepEqual(calls,[{method:'listRequests',args:[{sessionId:'session-a',messageId:'answer-a',limit:10}]}])
 assert.equal(tool.name,'argon_inspect');assert.match(tool.description,/token watermarks/);assert.doesNotMatch(tool.description,/cost|invoice|estimate/)
 assert.equal(Object.hasOwn(tool.parameters.properties,'sessionId'),false)
})
test('invalid actions, extra fields, missing identifiers and oversized pages never dispatch',async()=>{
 const {tool,calls}=fixture()
 for(const args of [{action:'releaseUnknown'},{action:'list',sessionId:'other'},{action:'detail'},{action:'response',requestId:'bad'},{action:'query',route:'google-vertex',id:'..'},{action:'query',route:'google-vertex',id:'x',endpoint:'https://evil.test'},{action:'detail',requestId:'00000000-0000-4000-8000-000000000001',limit:11},{action:'response',requestId:'00000000-0000-4000-8000-000000000001',length:16385}]){
  assert.equal((await tool.execute(args,exec())).ok,false)
 }
 assert.equal(calls.length,0)
})
test('missing agent and pre-aborted calls cannot dispatch',async()=>{
 const {tool,calls}=fixture();assert.equal((await tool.execute({action:'list'},{signal:new AbortController().signal})).ok,false)
 const e=exec(),controller=new AbortController();controller.abort(Error('private reason'));e.signal=controller.signal
 const result=await tool.execute({action:'query',route:'google-generative-ai',id:'cloud-id'},e)
 assert.equal(result.code,'ARGON_INSPECTOR_CANCELLED');assert.doesNotMatch(JSON.stringify(result),/private/);assert.equal(calls.length,0)
})
test('detail pages hops without changing token watermarks or source',async()=>{
 const {service,tool,calls}=fixture(),rows=Array.from({length:12},(_,hopIndex)=>({hopIndex}))
 const original={ok:true,status:'available',record:{hops:rows,tokenUsage:{totalTokens:120}}}
 service.getRequest=async request=>{calls.push(request);return original}
 const requestId='00000000-0000-4000-8000-000000000001'
 const result=await tool.execute({action:'detail',requestId,offset:4,limit:3},exec())
 assert.deepEqual(result.record.hops,rows.slice(4,7));assert.equal(result.record.tokenUsage.totalTokens,120)
 assert.deepEqual(result.rowPage,{offset:4,limit:3,totals:{hops:12},nextOffset:7})
 assert.equal(original.record.hops.length,12)
 const final=await tool.execute({action:'detail',requestId,offset:11},exec())
 assert.equal(final.rowPage.nextOffset,null);assert.equal(final.record.hops.length,1)
})
test('raw response fragments keep explicit frame and bounded character paging',async()=>{
 const {tool,calls}=fixture(),id='00000000-0000-4000-8000-000000000001'
 await tool.execute({action:'response',requestId:id,index:2,offset:4},exec())
 await tool.execute({action:'query-response',queryId:id,offset:8192,length:256},exec())
 assert.deepEqual(calls[0],{method:'readResponse',args:[{sessionId:'session-a',requestId:id,index:2,offset:4,length:4096}]})
 assert.deepEqual(calls[1],{method:'readQueryResponse',args:[{queryId:id,offset:8192,length:256}]})
})
test('known-ID query passes current-credential selection and the actual AbortSignal only',async()=>{
 const {tool,calls}=fixture(),e=exec()
 await tool.execute({action:'query',route:'google-vertex',id:'known-id'},e)
 assert.deepEqual(calls[0],{method:'queryInteraction',args:[{route:'google-vertex',id:'known-id'},e.signal]})
 assert.equal(Object.hasOwn(calls[0].args[0],'sessionId'),false)
})
test('late cancellation discards even successful metadata results and errors remain secret-free',async()=>{
 const {tool,service}=fixture(),controller=new AbortController(),e={agent:{id:'session-a'},signal:controller.signal}
 service.listRequests=async()=>{controller.abort();return {ok:true,records:[{secret:'do not expose'}]}}
 assert.equal((await tool.execute({action:'list'},e)).code,'ARGON_INSPECTOR_CANCELLED')
 service.listRequests=async()=>{throw Error('credential secret')}
 assert.doesNotMatch(JSON.stringify(await tool.execute({action:'list'},exec())),/credential secret/)
})
test('renderer is inert JSON text and forwards missing/expired states without inventing values',async()=>{
 const {tool,service}=fixture(),value={ok:true,status:'not-found'};service.getRequest=async()=>value
 assert.deepEqual(await tool.execute({action:'detail',requestId:'00000000-0000-4000-8000-000000000001'},exec()),value)
 assert.deepEqual(tool.output.render({},value),[{type:'text',text:JSON.stringify(value)}])
})

test('retired overview action is not advertised or dispatched',async()=>{
 const {tool,calls}=fixture()
 assert.deepEqual(tool.parameters.properties.action.enum,['list','detail','response','query','query-response'])
 assert.equal((await tool.execute({action:'overview'},exec())).code,'ARGON_INSPECTOR_INVALID')
 assert.deepEqual(calls,[])
})
