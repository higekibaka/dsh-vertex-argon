import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createResponseHub, responseDomain } from '../response-store.js'
const meta = { id:'00000000-0000-4000-8000-000000000001', sessionHash:'a'.repeat(24), startedAt:'2026-10-18T00:00:00.000Z', protocol:'generate-content' }
const page = (hub, extra={}) => hub.read({id:meta.id,sessionHash:meta.sessionHash,...extra})
function store() {
 const rows=new Map();let closed=false
 return {rows,domain:{table:()=>({entries:()=>rows.entries(),put:async(k,v)=>{responseDomain.tables.responses.valueSchema.parse(v);rows.set(k,structuredClone(v))},delete:async k=>rows.delete(k)}),close:async()=>{closed=true}},isClosed:()=>closed}
}
test('raw retention is off unless explicitly enabled; disabled capture never serializes payload',()=>{
 const hub=createResponseHub();const capture=hub.begin(meta,false)
 capture.observe('gc-chunk',1,{get secret(){throw Error('must not read')}})
 assert.equal(capture.finish('done').status,'disabled');assert.equal(page(hub).status,'not-retained')
})
test('capture preserves original parsed objects, separates wire observations from output, and isolates readers',()=>{
 const hub=createResponseHub();const capture=hub.begin(meta,true)
 const raw={candidates:[{content:{parts:[{thoughtSignature:'opaque',thought:true}]},continuationToken:'private-token'}]}
 capture.observe('gc-chunk',1,raw);raw.candidates[0].continuationToken='changed';capture.finish('done')
 const result=page(hub);assert.equal(result.status,'available');assert.equal(result.persistence,'memory-only')
 assert.equal(JSON.parse(result.frame.text).candidates[0].continuationToken,'private-token');assert.equal(result.frame.kind,'gc-chunk')
 result.metadata.outcome='changed';assert.equal(page(hub).metadata.outcome,'done')
 assert.equal(page(hub,{sessionHash:'b'.repeat(24)}).status,'not-retained')
})
test('paging is bounded and labels partial JSON fragments instead of pretending they are whole objects',()=>{
 const hub=createResponseHub();const c=hub.begin(meta,true);c.observe('interaction-object',1,{text:'x'.repeat(2000)});c.finish('done')
 const a=page(hub,{length:512});assert.equal(a.frame.text.length,512);assert.equal(a.frame.complete,false);assert.equal(a.frame.nextOffset,512)
 const b=page(hub,{offset:512,length:512});assert.equal(b.frame.offset,512)
 assert.throws(()=>page(hub,{length:99999999}));assert.throws(()=>page(hub,{index:-1}))
})
test('frame and byte limits mark omissions and never stop generation',()=>{
 const hub=createResponseHub({maxFrames:2,maxRecordBytes:4096});const c=hub.begin(meta,true)
 for(let i=0;i<4;i++)c.observe('gc-chunk',1,{text:String(i)})
 const summary=c.finish('error');assert.equal(summary.status,'truncated');assert.equal(summary.omittedFrames,2)
 assert.equal(page(hub).metadata.outcome,'error');assert.equal(page(hub,{index:1}).frame.index,1)
 const c2=hub.begin({...meta,id:'00000000-0000-4000-8000-000000000002'},true);c2.observe('gc-chunk',1,{text:'x'.repeat(9000)})
 assert.equal(c2.finish('done').omittedFrames,1)
})
test('capture serialization failures are observable without leaking the error or failing the stream',()=>{
 const hub=createResponseHub();const c=hub.begin(meta,true);const obj={};obj.self=obj
 c.observe('gc-chunk',1,obj);const summary=c.finish('done');assert.equal(summary.status,'truncated');assert.equal(summary.captureError,true)
})
test('retention evicts oldest complete records by bytes and record count',()=>{
 const hub=createResponseHub({maxRecords:2});for(let i=1;i<=3;i++){const c=hub.begin({...meta,id:meta.id.slice(0,-1)+i},true);c.observe('gc-chunk',1,{i});c.finish('done')}
 assert.equal(page(hub).status,'not-retained');assert.equal(page(hub,{id:meta.id.slice(0,-1)+'3'}).status,'available')
})
test('durable capture cold-loads with the same association and bounded retention',async()=>{
 const f=store();const hub=createResponseHub({maxRecords:1});hub.attach(f.domain)
 const c=hub.begin(meta,true);c.observe('interaction-event',1,{event_id:'event1',event_type:'interaction.complete'});c.finish('done');await hub.flush()
 assert.equal(f.rows.size,1);assert.equal(page(hub).persistence,'disk')
 const cold=createResponseHub();cold.attach(f.domain);assert.equal(page(cold).frame.kind,'interaction-event')
 await hub.close();assert.equal(f.isClosed(),true)
})
test('storage failure degrades honestly to memory-only and cannot overwrite a response outcome',async()=>{
 const hub=createResponseHub();hub.attach({table:()=>({entries:()=>[][Symbol.iterator](),put:async()=>{throw Error('PRIVATE_PATH')},delete:async()=>true}),close:async()=>{}})
 const c=hub.begin(meta,true);c.observe('gc-chunk',1,{text:'ok'});c.finish('done');await hub.flush()
 const result=page(hub);assert.equal(result.persistence,'memory-only');assert.equal(result.metadata.outcome,'done');assert.ok(!JSON.stringify(result).includes('PRIVATE_PATH'));await hub.close()
})
test('concurrent retained captures have an independent hard bound',()=>{
 const hub=createResponseHub({maxActive:1});const first=hub.begin(meta,true);const denied=hub.begin({...meta,id:meta.id.slice(0,-1)+'2'},true)
 assert.equal(denied.finish('done').status,'unavailable');first.finish('done');assert.equal(hub.begin({...meta,id:meta.id.slice(0,-1)+'3'},true).finish('done').status,'captured')
})
test('slow writes and interleaved evictions never exceed the disk record bound, even transiently',async()=>{
 const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {resolve,promise}}
 const started=Array.from({length:8},deferred), gates=Array.from({length:8},deferred),rows=new Map();let writes=0,peak=0
 const hub=createResponseHub({maxRecords:1})
 hub.attach({table:()=>({entries:()=>[...rows.entries()][Symbol.iterator](),put:async(id,row)=>{const n=writes++;started[n].resolve();await gates[n].promise;rows.set(id,row);peak=Math.max(peak,rows.size)},delete:async id=>rows.delete(id)}),close:async()=>{}})
 const finish=i=>{const c=hub.begin({...meta,id:meta.id.slice(0,-1)+i,startedAt:'2026-10-18T00:00:0'+i+'.000Z'},true);c.observe('gc-chunk',1,{i});c.finish('done')}
 finish(1)
 for(let i=0;i<8;i++){await started[i].promise;if(i<7)finish(i+2);gates[i].resolve()}
 await hub.flush();assert.equal(rows.size,1);assert.equal(peak,1);await hub.close()
})
test('storage dependency detaches without closing root memory and can attach again',async()=>{
 const a=store(),b=store(),hub=createResponseHub();hub.attach(a.domain)
 const c=hub.begin(meta,true);c.observe('gc-chunk',1,{a:1});c.finish('done');await hub.flush()
 await hub.detach(a.domain);assert.equal(a.isClosed(),true);assert.equal(page(hub).persistence,'memory-only')
 const next=hub.begin({...meta,id:meta.id.slice(0,-1)+'2'},true);next.observe('gc-chunk',1,{b:2});assert.equal(next.finish('done').status,'captured')
 hub.attach(b.domain);await hub.flush();assert.equal(b.rows.size,2);assert.equal(page(hub).persistence,'disk');await hub.close();assert.equal(b.isClosed(),true)
})
test('failed attachment leaves memory usable and does not prevent a later valid attachment',async()=>{
 const hub=createResponseHub(),good=store();assert.throws(()=>hub.attach({table(){throw Error('bad table')}}))
 const c=hub.begin(meta,true);c.observe('gc-chunk',1,{ok:true});assert.equal(c.finish('done').status,'captured')
 hub.attach(good.domain);await hub.flush();assert.equal(page(hub).persistence,'disk');await hub.close()
})
test('closing the hub drains writes and late captures cannot resurrect disposed data',async()=>{
 const hub=createResponseHub();const c=hub.begin(meta,true);c.observe('gc-chunk',1,{text:'late'});await hub.close();assert.equal(c.finish('done').status,'unavailable');assert.equal(page(hub).status,'not-retained')
})
