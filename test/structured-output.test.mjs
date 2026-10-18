import assert from 'node:assert/strict'
import {test} from 'node:test'
import {prepareStructuredOutput, STRUCTURED_OUTPUT_LIMITS as limits} from '../structured-output.js'
const sample={type:'object',properties:{answer:{type:'string'},score:{type:['number','null'],minimum:0,maximum:1}},required:['answer','score'],additionalProperties:false}
const prepare=schema=>prepareStructuredOutput(JSON.stringify(schema))
const valid=(policy,text)=>policy.checkResult(text,{finishReason:'stop'})

test('wire transforms preserve original inputs, transport options and exact schema',()=>{
 const policy=prepare(sample),marker=Symbol('continuation'),signal=new AbortController().signal
 const payload={model:'gemini-4-argon',contents:[{role:'user',parts:[{text:'source'}]}],config:{maxOutputTokens:512,httpOptions:{headers:{custom:'kept'},abortSignal:signal,[marker]:true}}}
 const transformed=policy.generateContent(payload)
 assert.equal(payload.config.httpOptions.extraBody,undefined)
 assert.equal(transformed.contents,payload.contents)
 assert.equal(transformed.config.httpOptions.abortSignal,signal)
 assert.equal(transformed.config.httpOptions[marker],true)
 assert.deepEqual(transformed.config.httpOptions.headers,{custom:'kept'})
 assert.equal(transformed.config.httpOptions.extraBody.generationConfig.responseFormat.text.schema,policy.schema)
 const input={model:'gemini-4-argon',input:[{type:'user_input',content:[{type:'text',text:'source'}]}],generation_config:{max_output_tokens:512}}
 const output=policy.interactions(input)
 assert.equal(input.response_format,undefined)
 assert.equal(output.input,input.input)
 assert.equal(output.response_format.schema,policy.schema)
})
test('wire transforms reject existing formats and raw overrides without changing them',()=>{
 const policy=prepare(sample)
 for(const key of ['responseFormat','responseSchema','responseJsonSchema','responseMimeType'])assert.throws(()=>policy.generateContent({config:{[key]:{}}}),{code:'ARGON_JSON_FORMAT_CONFLICT'})
 for(const extraBody of [{tools:[{codeExecution:{}}]},{'generationConfig.responseFormat':{}},{generationConfig:{maxOutputTokens:1024}},null,[]])assert.throws(()=>policy.generateContent({config:{httpOptions:{extraBody}}}),{code:'ARGON_JSON_FORMAT_CONFLICT'})
 assert.throws(()=>policy.interactions({response_format:{}}),{code:'ARGON_JSON_FORMAT_CONFLICT'})
})
test('wire transforms reject all offered tools including built-ins, not just functions',()=>{
 const policy=prepare(sample)
 for(const tools of [[{codeExecution:{}}],[{googleSearch:{}}],[{functionDeclarations:[]}],{},null]){
  assert.throws(()=>policy.generateContent({config:{tools}}),{code:'ARGON_JSON_TOOLS_UNVERIFIED'})
  assert.throws(()=>policy.interactions({tools}),{code:'ARGON_JSON_TOOLS_UNVERIFIED'})
 }
 assert.ok(policy.generateContent({config:{tools:[]}}))
 assert.ok(policy.interactions({tools:[]}))
})
test('schema snapshot is detached and deeply frozen; JSON validation never coerces or repairs',()=>{
 const policy=prepare(sample)
 assert.deepEqual(policy.schema,sample)
 assert.ok(Object.isFrozen(policy.schema.properties.answer))
 assert.throws(()=>{policy.schema.properties.answer.type='number'},TypeError)
 assert.deepEqual(valid(policy,'{"answer":"yes","score":0.5}'),{status:'valid',value:{answer:'yes',score:0.5}})
 assert.equal(valid(policy,'{"answer":12,"score":0.5}').status,'schema-mismatch')
 assert.equal(valid(policy,'{"answer":"yes","score":"0.5"}').status,'schema-mismatch')
 assert.equal(valid(policy,'{"answer":"yes","score":0.5,"extra":true}').status,'schema-mismatch')
 assert.equal(valid(policy,'{"answer":"yes"}').status,'schema-mismatch')
 assert.equal(valid(policy,'{"answer":"yes","score":null}').status,'valid')
})
test('strict JSON rejects fences, trailing prose, comments and partial results',()=>{
 const policy=prepare({type:'object'})
 for(const text of ['```json\n{}\n```','{} trailing','{/*comment*/}','{"x":',''])assert.equal(valid(policy,text).status,'invalid-json')
 for(const finishReason of ['max-tokens','error','aborted','tool-calls',undefined])assert.equal(policy.checkResult('{}',{finishReason}).status,'incomplete')
 assert.equal(policy.checkResult('{}').status,'incomplete')
})
test('primitive, tuple, array, enum and anyOf checks use declared JSON Schema semantics',()=>{
 assert.equal(valid(prepare({type:'integer',minimum:0,maximum:3}),'2').status,'valid')
 assert.equal(valid(prepare({type:'integer'}),'1.5').status,'schema-mismatch')
 const policy=prepare({type:'array',prefixItems:[{type:'string',enum:['a','b']}],items:{anyOf:[{type:'number'},{type:'null'}]},minItems:1,maxItems:3})
 assert.equal(valid(policy,'["a",2,null]').status,'valid')
 for(const text of ['[]','["c"]','["b",true]','["a",1,2,3]'])assert.equal(valid(policy,text).status,'schema-mismatch')
})
test('unknown or ambiguous schema constraints are rejected rather than silently ignored',()=>{
 for(const schema of [{$ref:'https://example.invalid/schema'},{type:'string',pattern:'(a+)+$'},{type:'string',format:'email'},{oneOf:[{type:'number'},{type:'integer'}]},{type:'object',default:{}},{type:'object',$defs:{x:{type:'string'}}},{nullable:true,type:'string'}])assert.throws(()=>prepare(schema),{code:'ARGON_JSON_SCHEMA_UNSUPPORTED'})
 for(const text of ['null','true','[]','{"type":"invented"}','{"type":"object","required":"answer"}'])assert.throws(()=>prepareStructuredOutput(text),{code:'ARGON_JSON_SCHEMA_INVALID'})
 assert.throws(()=>prepareStructuredOutput({type:'object'}),{code:'ARGON_JSON_SCHEMA_INVALID'})
})
test('schema byte, depth and node limits reject before unbounded compilation',()=>{
 assert.throws(()=>prepare({type:'string',description:'x'.repeat(limits.schemaBytes)}),{code:'ARGON_JSON_SCHEMA_LIMIT'})
 let deep={type:'string'};for(let i=0;i<=limits.schemaDepth;i++)deep={type:'array',items:deep}
 assert.throws(()=>prepare(deep),{code:'ARGON_JSON_SCHEMA_LIMIT'})
 const properties=Object.fromEntries(Array.from({length:limits.schemaNodes},(_,i)=>['p'+i,{type:'string'}]))
 assert.throws(()=>prepare({type:'object',properties}),{code:'ARGON_JSON_SCHEMA_LIMIT'})
})
test('result bytes, depth and nodes are bounded without presenting a partial value as valid',()=>{
 const policy=prepare({})
 assert.equal(valid(policy,JSON.stringify('x'.repeat(limits.resultBytes))).status,'resource-limit')
 assert.equal(valid(policy,'['.repeat(limits.resultDepth+1)+'0'+']'.repeat(limits.resultDepth+1)).status,'resource-limit')
 assert.equal(valid(policy,JSON.stringify(Array(limits.resultNodes+1).fill(0))).status,'resource-limit')
 assert.equal(valid(policy,'1e999').status,'invalid-json')
})
test('validation errors are bounded descriptors, not echoed output or schema descriptions',()=>{
 const policy=prepare({type:'string',enum:['allowed']})
 const result=valid(policy,JSON.stringify('private-output-marker'))
 assert.equal(result.status,'schema-mismatch')
 assert.ok(result.issue.keyword==='enum')
 assert.equal(JSON.stringify(result).includes('private-output-marker'),false)
 assert.equal(Object.hasOwn(result,'value'),false)
})
test('prototype-like result keys stay data; schema properties Ajv drops are refused',()=>{
 assert.throws(()=>prepare(JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}')),{code:'ARGON_JSON_SCHEMA_UNSUPPORTED'})
 const result=valid(prepare({type:'object'}),'{"__proto__":{"polluted":true}}')
 assert.equal(result.status,'valid')
 assert.equal(Object.hasOwn(result.value,'__proto__'),true)
 assert.equal(Object.getPrototypeOf(result.value),Object.prototype)
 assert.equal({}.polluted,undefined)
})
