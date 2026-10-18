import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createInteractionQuery} from '../interaction-query.js'
import {createInteractionsTransport} from '../interaction-transport.js'
import {createConfiguredInteractionQuery} from '../adapter.js'
const route='google-generative-ai', id='v1_fixture-id'
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
function fixture(overrides={}) {
 const calls=[], secrets=[], configurations=[]
 class SDK {constructor(config){configurations.push(config);this.apiClient={getAuthHeaders:async()=>({'x-goog-api-key':'fixture-secret'})}}}
 const query=createInteractionQuery({GoogleGenAI:SDK,resolveSecret:async name=>{secrets.push(name);return name==='GOOGLE_API_KEY'?'fixture-secret':name==='GOOGLE_CLOUD_PROJECT'?'fixture-project':undefined},getRoutes:()=>({googleApiKeyEnv:'GOOGLE_API_KEY'}),fetchImpl:async(url,init)=>{calls.push({url:String(url),init});return new Response(JSON.stringify({id,status:'requires_action',outputs:[{type:'function_call',name:'never_execute',arguments:{}}]}),{headers:{'content-type':'application/json'}})},...overrides})
 return {query,calls,secrets,configurations}
}
for(const selected of [route,'google-vertex'])test(selected+': explicit query is exactly one inert GET under selected credentials',async()=>{
 const f=fixture();const value=await f.query({route:selected,id})
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].init.method,'GET');assert.equal(f.calls[0].init.body,undefined);assert.equal(f.calls[0].init.redirect,'error');assert.equal(f.calls[0].init.headers.get('accept'),'application/json');assert.equal(value.interaction.outputs[0].name,'never_execute')
 assert.equal(value.identity.route,selected);assert.equal(value.identity.credentialBinding,'current-configuration');assert.ok(f.calls[0].url.endsWith('/interactions/'+id));assert.ok(!f.calls[0].url.includes('stream='))
 assert.equal(f.configurations[0].vertexai,selected==='google-vertex');if(selected==='google-vertex')assert.equal(f.configurations[0].project,'fixture-project')
})
test('configured lookup never falls back to ambient credentials after credential-store failure',async()=>{
 let ambient=0;const ctx={get:key=>key==='credentials'?{resolve:async()=>{throw new Error('SECRET_STORE_FAILURE')}}:key==='launchEnvironment'?{get:()=>{ambient++;return {value:'fixture-ambient-secret'}}}:undefined}
 const query=createConfiguredInteractionQuery(ctx,{routes:{hasGoogle:true}})
 try{await assert.rejects(query({route,id}),e=>e.code==='ARGON_QUERY_UNAVAILABLE'&&!String(e).includes('SECRET'));assert.equal(ambient,0)}finally{query.close()}
})
test('query validates opaque IDs and strict input before credentials or network',async()=>{
 const f=fixture()
 for(const value of ['', '.', '..', 'a/b', 'a b', 'a\nb', 'https://example.test/x', 'a?key=secret', '%2e%2e', 'a'.repeat(4097)])await assert.rejects(f.query({route,id:value}),{code:'ARGON_QUERY_INVALID'})
 for(const req of [{route:'other',id},{route,id,endpoint:'https://attacker.test'},{route,id,apiKey:'secret'},{route,id,stream:true}])await assert.rejects(f.query(req),{code:'ARGON_QUERY_INVALID'})
 assert.equal(f.secrets.length,0);assert.equal(f.calls.length,0)
})
test('transport rejects URL-normalized dot segments for get/cancel/delete',async()=>{
 let sent=0;const t=createInteractionsTransport({endpoint:'https://example.test/interactions',getHeaders:()=>({}),fetchImpl:async()=>{sent++;return new Response('{}')}})
 for(const operation of ['get','cancel','delete'])for(const value of ['.','..'])await assert.rejects(async()=>t[operation](value))
 assert.equal(sent,0)
})
test('401/403/404/503 never retry, fall back routes, or disclose upstream error text',async()=>{
 for(const status of [401,403,404,503]){let count=0;const f=fixture({fetchImpl:async()=>{count++;return new Response('SECRET_KEY SECRET_PROMPT',{status})}})
 await assert.rejects(f.query({route,id}),e=>{assert.equal(e.status,status);assert.doesNotMatch(String(e)+JSON.stringify(e),/SECRET/);return true});assert.equal(count,1)}
})
test('only matching JSON objects are accepted, never mismatched IDs or SSE',async()=>{
 for(const [body,type,code] of [['{}','application/json','ARGON_QUERY_ID_MISMATCH'],['{"id":"other"}','application/json','ARGON_QUERY_ID_MISMATCH'],['[]','application/json','ARGON_QUERY_RESPONSE'],['{"id":SECRET','application/json','ARGON_QUERY_RESPONSE'],['data: {}','text/event-stream','ARGON_QUERY_RESPONSE']]) {
 const f=fixture({fetchImpl:async()=>new Response(body,{headers:{'content-type':type}})})
 await assert.rejects(f.query({route,id}),e=>{assert.equal(e.code,code);assert.doesNotMatch(String(e)+JSON.stringify(e),/SECRET/);return true})
 }
})
test('actual UTF-8 bytes enforce the response cap despite missing or lying Content-Length',async()=>{
 for(const length of [undefined,'1','9999']){let cancelled=0;const f=fixture({maxResponseBytes:64,fetchImpl:async()=>new Response(new ReadableStream({pull(c){c.enqueue(new TextEncoder().encode('界'.repeat(30)))},cancel(){cancelled++}},{highWaterMark:0}),{headers:{'content-type':'application/json',...(length?{'content-length':length}:{})}})})
 await assert.rejects(f.query({route,id}),{code:'ARGON_QUERY_TOO_LARGE'});assert.equal(cancelled,1)}
})
test('already-aborted query never resolves credentials',async()=>{
 const c=new AbortController();c.abort();const f=fixture();await assert.rejects(f.query({route,id},c.signal),{code:'ARGON_QUERY_CANCELLED'});assert.equal(f.secrets.length,0)
})
test('cancelling pending credential resolution settles and late resolution never dispatches',async()=>{
 const pending=deferred(),ready=deferred(),c=new AbortController();const f=fixture({resolveSecret:()=>{ready.resolve();return pending.promise}})
 const result=f.query({route,id},c.signal);await ready.promise;c.abort(new Error('SECRET_REASON'))
 await assert.rejects(result,e=>e.code==='ARGON_QUERY_CANCELLED'&&!String(e).includes('SECRET'));pending.resolve('fixture-secret');await Promise.resolve();await Promise.resolve();assert.equal(f.calls.length,0)
})
test('cancelling SDK authentication prevents late GET dispatch',async()=>{
 const pending=deferred(),ready=deferred(),c=new AbortController();class SDK{constructor(){this.apiClient={getAuthHeaders:()=>{ready.resolve();return pending.promise}}}}
 const f=fixture({GoogleGenAI:SDK});const result=f.query({route,id},c.signal);await ready.promise;c.abort();await assert.rejects(result,{code:'ARGON_QUERY_CANCELLED'});pending.resolve({});await Promise.resolve();await Promise.resolve();assert.equal(f.calls.length,0)
})
test('local cancellation interrupts a hanging fetch, without issuing remote cancellation',async()=>{
 const ready=deferred(),c=new AbortController();let n=0,signal
 const f=fixture({fetchImpl:(_url,init)=>{n++;signal=init.signal;ready.resolve();return new Promise(()=>{})}})
 const result=f.query({route,id},c.signal);await ready.promise;c.abort();await assert.rejects(result,{code:'ARGON_QUERY_CANCELLED'});assert.equal(n,1);assert.equal(signal.aborted,true)
})
test('local cancellation cancels the body reader even if the response ignores fetch signal',async()=>{
 const ready=deferred(),c=new AbortController();let cancelled=0
 const f=fixture({fetchImpl:async()=>new Response(new ReadableStream({pull(){ready.resolve();return new Promise(()=>{})},cancel(){cancelled++}},{highWaterMark:0}),{headers:{'content-type':'application/json'}})})
 const result=f.query({route,id},c.signal);await ready.promise;c.abort();await assert.rejects(result,{code:'ARGON_QUERY_CANCELLED'});assert.equal(cancelled,1)
})
test('lookup concurrency is bounded and closing cancels all pending queries without dispatch',async()=>{
 const f=fixture({resolveSecret:()=>new Promise(()=>{})})
 const calls=Array.from({length:4},()=>f.query({route,id}))
 await assert.rejects(f.query({route,id}),{code:'ARGON_QUERY_BUSY'})
 f.query.close()
 for(const result of calls)await assert.rejects(result,{code:'ARGON_QUERY_CANCELLED'})
 await assert.rejects(f.query({route,id}),{code:'ARGON_QUERY_CANCELLED'});assert.equal(f.calls.length,0)
})
test('query deadline includes credential setup rather than starting at fetch',async()=>{
 const f=fixture({timeoutMs:15,resolveSecret:()=>new Promise(()=>{})})
 await assert.rejects(f.query({route,id}),{code:'ARGON_QUERY_TIMEOUT'});assert.equal(f.calls.length,0)
})
test('query uses one immutable route selection even when configuration changes during credentials',async()=>{
 const routes={googleBaseUrl:'https://first.test/v1beta',googleApiKeyEnv:'CUSTOM'},pending=deferred(),ready=deferred();let observed
 const f=fixture({getRoutes:()=>routes,resolveSecret:async name=>{if(name==='CUSTOM'){ready.resolve();return pending.promise}},fetchImpl:async(url)=>{observed=String(url);return new Response(JSON.stringify({id}),{headers:{'content-type':'application/json'}})}})
 const result=f.query({route,id});await ready.promise;routes.googleBaseUrl='https://second.test';pending.resolve('fixture-secret');await result;assert.ok(observed.startsWith('https://first.test/'))
})
