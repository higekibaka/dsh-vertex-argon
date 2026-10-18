import assert from 'node:assert/strict'
import {test} from 'node:test'
import {shared} from '../runtime.js'
const {GoogleGenAI}=await shared('@google/genai')
const schema={type:'object',properties:{answer:{type:'string'}},required:['answer'],additionalProperties:false}
const responseFormat={text:{mimeType:'application/json',schema}}
for(const vertexai of [false,true])test('genai 2.21 JSON format wire compatibility: '+(vertexai?'Vertex':'Gemini'),async()=>{
 const original=globalThis.fetch,wire=[]
 globalThis.fetch=async(_url,init)=>{
  wire.push(JSON.parse(init.body))
  return new Response('data: '+JSON.stringify({candidates:[{content:{role:'model',parts:[{text:'{"answer":"fixture"}'}]},finishReason:'STOP'}]})+'\n\n',{headers:{'Content-Type':'text/event-stream'}})
 }
 try{
  const client=new GoogleGenAI({vertexai,apiKey:'offline-fixture'})
  for(const config of [
   {responseFormat},
   {responseMimeType:'application/json',responseJsonSchema:schema},
   {httpOptions:{extraBody:{generationConfig:{responseFormat}}}},
  ]){
   const stream=await client.models.generateContentStream({model:'gemini-4-argon',contents:'Wire fixture only',config:{maxOutputTokens:32,...config}})
   for await(const _chunk of stream){}
  }
  assert.equal(wire.length,3)
  // The guide is newer than this SDK's generateContent config converter.
  assert.equal(wire[0].generationConfig.responseFormat,undefined)
  assert.equal(wire[1].generationConfig.responseMimeType,'application/json')
  assert.deepEqual(wire[1].generationConfig.responseJsonSchema,schema)
  assert.deepEqual(wire[2].generationConfig.responseFormat,responseFormat)
  assert.equal(wire[2].generationConfig.maxOutputTokens,32)
  assert.deepEqual(wire[2].contents,wire[0].contents)
  assert.equal(wire[2].generationConfig.responseSchema,undefined)
  assert.equal(wire[2].generationConfig.responseJsonSchema,undefined)
 }finally{globalThis.fetch=original}
})
