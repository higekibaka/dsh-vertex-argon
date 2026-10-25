import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createArgonAdapter, PROVIDER, MODEL, GOOGLE_API_MODEL } from '../adapter.js'
import { shared } from '../runtime.js'
import { createGoogleSignatureBridge } from '../google-signatures.js'
const { BlockAssembler, createUserMessage, createToolResultMessage } = await shared('@deepseek-ai/dsh-llm')
const { Session } = await shared('@deepseek-ai/dsh-session')
const sig = value => Buffer.from(value).toString('base64')
const S1 = sig('standalone-1'), S2 = sig('standalone-2'), T = sig('tool'), A = sig('text')
const cases = [
 ['signature only', [{thoughtSignature:S1}]],
 ['opaque signature is not reinterpreted locally', [{thoughtSignature:'opaque_url-safe_signature-without-padding'}]],
 ['same signature on empty text and independent parts', [{text:'',thoughtSignature:S1},{thoughtSignature:S1},{text:'X'},{thoughtSignature:S1}]],
 ['between text', [{text:'A'},{thoughtSignature:S1},{text:'B'}]],
 ['consecutive and thought flags', [{thought:true,thoughtSignature:S1},{thought:false,thoughtSignature:S2},{text:'C'}]],
 ['after signed text', [{text:'A',thoughtSignature:A},{thoughtSignature:S1},{text:'B'}]],
 ['after function call', [{functionCall:{id:'call',name:'echo',args:{value:'x'}},thoughtSignature:T},{thoughtSignature:S1},{text:'tail'}]],
 ['after thinking', [{text:'plan',thought:true},{thoughtSignature:S1},{text:'answer'}]],
]
const ctx={get:key=>key==='launchEnvironment'?{get:name=>['GOOGLE_API_KEY','GOOGLE_CLOUD_API_KEY'].includes(name)?{value:'offline-fixture'}:undefined}:undefined}
const sse=parts=>new Response('data: '+JSON.stringify({candidates:[{content:{role:'model',parts},finishReason:'STOP'}]})+'\n\n',{headers:{'Content-Type':'text/event-stream'}})
const originalFetch=globalThis.fetch
const config={googleProtocol:'generate-content',vertexProtocol:'generate-content',routes:{hasGoogle:true,hasVertex:true}}
const tools=[{name:'echo',description:'fixture',parameters:{type:'object',properties:{value:{type:'string'}},required:['value']}}]
async function generation(adapter, model, messages) {
 const assembler=new BlockAssembler(),chunks=[]
 for await(const chunk of adapter.stream({provider:PROVIDER,model,maxTokens:512,sessionId:'signature-fixture',messages,tools})){assembler.push(chunk);chunks.push(chunk)}
 assert.ok(['stop','tool-calls'].includes(assembler.finish.kind),JSON.stringify(assembler.finish))
 return {message:assembler.message({provider:PROVIDER,model,replayState:assembler.replayState}),chunks}
}
for(const model of [GOOGLE_API_MODEL,MODEL])for(const [name,parts]of cases)test(model+': '+name+' survives serialized Session restore and fork at its original position',async()=>{
 const sent=[];let calls=0
 globalThis.fetch=async(_url,init)=>{sent.push(JSON.parse(init.body));return sse(++calls===1?parts:[{text:'next'}])}
 try {
  const adapter=createArgonAdapter(ctx,config),session=Session.create('signature-parent')
  const user=createUserMessage({content:[{type:'text',text:'fixture'}],source:{kind:'user'}})
  session.append('turn/start',{turn:1});session.append('user/message',user,{surfaceOp:'append'})
  const {message,chunks}=await generation(adapter,model,session.deriveMessages())
  assert.equal(message.source.replayState.response.version,2)
  assert.equal(message.content.filter(b=>b.type==='text').map(b=>b.text).join(''),parts.filter(p=>p.text!==undefined&&!p.thought).map(p=>p.text).join(''))
  assert.equal(chunks.filter(c=>c.type==='text-delta'&&c.text==='').length,parts.filter(p=>p.text===''&&!p.thought).length)
  session.append('assistant/message',{turn:1,step:1,stream:[],message},{surfaceOp:'append'})
  for(const block of message.content.filter(b=>b.type==='tool-call'))session.append('tool/result',{turn:1,step:1,message:createToolResultMessage({callId:block.id,content:[{type:'text',text:'ok'}],isError:false})},{surfaceOp:'append'})
  session.append('turn/end',{turn:1,reason:{kind:'completed'}})
  const cold=Session.create('signature-cold',JSON.parse(JSON.stringify(session.snapshotEvents())))
  const fork=Session.create('signature-fork',JSON.parse(JSON.stringify(cold.snapshotEvents())))
  await generation(adapter,model,[...fork.deriveMessages(),createUserMessage({content:[{type:'text',text:'next'}],source:{kind:'user'}})])
  assert.deepEqual(sent[1].contents.find(c=>c.role==='model').parts,parts)
 } finally {globalThis.fetch=originalFetch}
})

test('MAX_TOKENS tool pruning invalidates the full-message signature binding',async()=>{
 const sent=[];let calls=0
 globalThis.fetch=async(_url,init)=>{sent.push(JSON.parse(init.body));if(++calls!==1)return sse([{text:'next'}]);return new Response('data: '+JSON.stringify({candidates:[{content:{role:'model',parts:[{functionCall:{id:'cut',name:'echo',args:{value:'x'}},thoughtSignature:T},{thoughtSignature:S1},{text:'partial'}]},finishReason:'MAX_TOKENS'}]})+'\n\n',{headers:{'Content-Type':'text/event-stream'}})}
 try{
  const adapter=createArgonAdapter(ctx,config),user=createUserMessage({content:[{type:'text',text:'fixture'}],source:{kind:'user'}}),asm=new BlockAssembler()
  for await(const c of adapter.stream({provider:PROVIDER,model:GOOGLE_API_MODEL,maxTokens:512,messages:[user],tools}))asm.push(c)
  assert.equal(asm.finish.kind,'max-tokens');assert.equal(asm.blocks().some(b=>b.type==='tool-call'),false)
  const message=asm.message({provider:PROVIDER,model:GOOGLE_API_MODEL,replayState:asm.replayState})
  await generation(adapter,GOOGLE_API_MODEL,[user,message,createUserMessage({content:[{type:'text',text:'next'}],source:{kind:'user'}})])
  assert.ok(!JSON.stringify(sent[1]).includes(S1));assert.ok(!JSON.stringify(sent[1]).includes(T))
 }finally{globalThis.fetch=originalFetch}
})

test('uncommitted signature tail is discarded on checkpoint reconnect',async()=>{
 const sent=[];let calls=0;const S3=sig('final')
 globalThis.fetch=async(_url,init)=>{
  sent.push(JSON.parse(init.body));calls++
  if(calls===1){
   const frames=[{candidates:[{content:{role:'model',parts:[{text:'A'},{thoughtSignature:S1}]},continuationToken:'checkpoint'}]},{candidates:[{content:{role:'model',parts:[{thoughtSignature:S2}]}}]}]
   let index=0
   return new Response(new ReadableStream({pull(controller){if(index<frames.length)controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify(frames[index++])+'\n\n'));else controller.error(new Error('socket reset'))}}),{headers:{'Content-Type':'text/event-stream'}})
  }
  return sse(calls===2?[{text:'B'},{thoughtSignature:S3}]:[{text:'next'}])
 }
 try{
  const adapter=createArgonAdapter(ctx,config),user=createUserMessage({content:[{type:'text',text:'fixture'}],source:{kind:'user'}})
  const {message}=await generation(adapter,GOOGLE_API_MODEL,[user])
  assert.equal(calls,2);assert.equal(sent[1].continuationToken,'checkpoint')
  await generation(adapter,GOOGLE_API_MODEL,[user,message,createUserMessage({content:[{type:'text',text:'next'}],source:{kind:'user'}})])
  assert.deepEqual(sent[2].contents.find(c=>c.role==='model').parts,[{text:'A'},{thoughtSignature:S1},{text:'B'},{thoughtSignature:S3}])
  assert.ok(!JSON.stringify(sent[2]).includes('dshGoogleSignatureOnly'))
 }finally{globalThis.fetch=originalFetch}
})
test('signature projection enforces a complete block-count bound',()=>{
 const bridge=createGoogleSignatureBridge({messages:[]},{api:'google-generative-ai',provider:PROVIDER,id:GOOGLE_API_MODEL})
 assert.throws(()=>bridge.observe({candidates:[{content:{parts:Array.from({length:8193},()=>({thoughtSignature:S1}))}}]}),/bounded block count/)
})
for(const change of ['body-edit','history-edit','model-change','malformed-codec'])test(change+' invalidates standalone signatures rather than attaching them to changed history',async()=>{
 const sent=[];let calls=0
 globalThis.fetch=async(_url,init)=>{sent.push(JSON.parse(init.body));return sse(++calls===1?[{text:'original'},{thoughtSignature:S1}]:[{text:'next'}])}
 try{
  const adapter=createArgonAdapter(ctx,config),user=createUserMessage({content:[{type:'text',text:'fixture'}],source:{kind:'user'}})
  const {message}=await generation(adapter,GOOGLE_API_MODEL,[user])
  const altered=JSON.parse(JSON.stringify(message))
  if(change==='body-edit')altered.content[0].text='edited'
  if(change==='malformed-codec'){const row=altered.source.replayState.blocks.find(b=>b.textSignature?.startsWith('{'));row.textSignature=JSON.stringify({...JSON.parse(row.textSignature),unexpected:'never-forward'})}
  await generation(adapter,change==='model-change'?MODEL:GOOGLE_API_MODEL,[change==='history-edit'?createUserMessage({content:[{type:'text',text:'changed earlier input'}],source:{kind:'user'}}):user,altered,createUserMessage({content:[{type:'text',text:'next'}],source:{kind:'user'}})])
  assert.ok(!JSON.stringify(sent[1]).includes(S1))
 }finally{globalThis.fetch=originalFetch}
})

test('snake_case signature-only parts are captured into the versioned codec', async () => {
 const bridge=createGoogleSignatureBridge({messages:[]},{api:'google-generative-ai',provider:PROVIDER,id:GOOGLE_API_MODEL})
 bridge.observe({candidates:[{content:{parts:[{thought_signature:S1}]}}]})
 const source={async *[Symbol.asyncIterator](){yield{type:'start'};yield{type:'done',message:{role:'assistant',content:[]}}}}
 const events=[]
 for await(const event of bridge.stream(source))events.push(event)
 const content=events.at(-1).message.content
 assert.equal(content.length,1);assert.equal(content[0].text,'')
 const codec=JSON.parse(content[0].textSignature)
 assert.equal(codec.dshGoogleSignatureOnly,1);assert.equal(codec.signature,S1);assert.ok(codec.contentDigest)
})

test('snake_case thought_signature survives a serialized restore at its original position',async()=>{
 const sent=[];let calls=0
 globalThis.fetch=async(_url,init)=>{sent.push(JSON.parse(init.body));return sse(++calls===1?[{text:'A'},{thought_signature:S1}]:[{text:'next'}])}
 try{
  const adapter=createArgonAdapter(ctx,config),user=createUserMessage({content:[{type:'text',text:'fixture'}],source:{kind:'user'}})
  const {message}=await generation(adapter,GOOGLE_API_MODEL,[user])
  assert.equal(message.content.filter(b=>b.type==='text').map(b=>b.text).join(''),'A')
  await generation(adapter,GOOGLE_API_MODEL,[user,message,createUserMessage({content:[{type:'text',text:'next'}],source:{kind:'user'}})])
  assert.deepEqual(sent[1].contents.find(c=>c.role==='model').parts,[{text:'A'},{thoughtSignature:S1}])
  assert.ok(!JSON.stringify(sent[1]).includes('thought_signature'))
 }finally{globalThis.fetch=originalFetch}
})

// Opaque replay metadata must survive snake_case wire spellings next to real
// content, and always leave the plugin as the camelCase Part spelling.
for (const [name, wireParts, expected] of [
 ['text', [{ text: 'A' }, { thought_signature: S1 }], [{ text: 'A' }, { thoughtSignature: S1 }]],
 ['thought', [{ text: 'plan', thought: true }, { thought_signature: S1 }, { text: 'answer' }], [{ text: 'plan', thought: true }, { thoughtSignature: S1 }, { text: 'answer' }]],
 ['function call', [{ functionCall: { id: 'call', name: 'echo', args: { value: 'x' } }, thought_signature: T }], [{ functionCall: { id: 'call', name: 'echo', args: { value: 'x' } }, thoughtSignature: T }]],
]) test('snake_case thought_signature beside ' + name + ' round-trips to the camelCase wire part', async () => {
 const sent = []; let calls = 0
 globalThis.fetch = async (_url, init) => { sent.push(JSON.parse(init.body)); return sse(++calls === 1 ? wireParts : [{ text: 'next' }]) }
 try {
  const adapter = createArgonAdapter(ctx, config), user = createUserMessage({ content: [{ type: 'text', text: 'fixture' }], source: { kind: 'user' } })
  const { message } = await generation(adapter, GOOGLE_API_MODEL, [user])
  await generation(adapter, GOOGLE_API_MODEL, [user, message, createUserMessage({ content: [{ type: 'text', text: 'next' }], source: { kind: 'user' } })])
  assert.deepEqual(sent[1].contents.find(c => c.role === 'model').parts, expected)
  assert.ok(!JSON.stringify(sent[1]).includes('thought_signature'))
 } finally { globalThis.fetch = originalFetch }
})
