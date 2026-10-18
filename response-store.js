import { shared } from './runtime.js'
const { z } = await shared('zod')

// Opt-in parsed upstream JSON, NOT HTTP bytes, committed output, or a resume store.
// HTTP headers, request bodies and credentials are never supplied to this store.
export const RESPONSE_LIMITS = Object.freeze({ maxRecords: 20, maxBytes: 64 * 1024 * 1024, maxRecordBytes: 16 * 1024 * 1024, maxFrames: 16384, maxActive: 4, pageChars: 65536 })
const outcomes = ['unknown', 'done', 'max-tokens', 'tool-calls', 'error', 'aborted', 'incomplete']
const kinds = ['gc-chunk', 'interaction-event', 'interaction-object']
const frameSchema = z.object({ index: z.number().int().nonnegative(), hop: z.number().int().positive(), kind: z.enum(kinds), json: z.string().max(RESPONSE_LIMITS.maxRecordBytes) }).strict()
const metadataSchema = z.object({ schemaVersion:z.literal(1), id:z.string().uuid(), sessionHash:z.string().regex(/^[a-f0-9]{24}$/).nullable(), startedAt:z.string().datetime(), protocol:z.enum(['generate-content','interactions']), outcome:z.enum(outcomes), bytes:z.number().int().nonnegative().max(RESPONSE_LIMITS.maxRecordBytes), omittedFrames:z.number().int().nonnegative(), captureError:z.boolean() }).strict()
const responseSchema = metadataSchema.extend({ frames:z.array(frameSchema).max(RESPONSE_LIMITS.maxFrames) }).strict()
export const responseDomain = { name:'vertex_argon_responses', version:1, layout:'per-record', tables:{responses:{valueSchema:responseSchema}} }
const inert = status => ({ observe() {}, finish:() => ({status,frames:0,omittedFrames:0,bytes:0,captureError:false}) })

export function createResponseHub(options = {}) {
 const limits = { ...RESPONSE_LIMITS, ...options }
 for (const key of ['maxRecords','maxBytes','maxRecordBytes','maxFrames','maxActive']) if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > RESPONSE_LIMITS[key]) throw new Error('Invalid response retention bound')
 const records = new Map(), persisted = new Set(), active = new Set()
 let domain, table, detachPromise, closed=false, storageFailed=false, tail=Promise.resolve(), scheduled=false
 const trim = () => {
  let bytes=[...records.values()].reduce((n,r)=>n+r.bytes,0)
  for (const [id,row] of [...records].sort((a,b)=>a[1].startedAt.localeCompare(b[1].startedAt))) {
   if (records.size <= limits.maxRecords && bytes <= limits.maxBytes) break
   records.delete(id);persisted.delete(id);bytes-=row.bytes
  }
 }
 const save = () => {
  if (!table || detachPromise || storageFailed || scheduled) return
  // Coalesce writes without holding an unbounded queue of evicted raw responses.
  scheduled=true
   tail=tail.then(async()=>{
    scheduled=false
    const snapshot=[...records]
    for (const [id] of table.entries()) if (!records.has(id)) { if (!await table.delete(id)) throw new Error('Response retention delete failed');persisted.delete(id) }
    // A finite pass lets queued eviction run during sustained capture churn.
    for (const [id,row] of snapshot) if (records.get(id)===row && !persisted.has(id)) {
     await table.put(id,row)
     if(records.get(id)===row)persisted.add(id)
     else { if (!await table.delete(id)) throw new Error('Response retention delete failed');persisted.delete(id) }
    }
   }).catch(()=>{storageFailed=true;persisted.clear()})
 }
 return {
  attach(value) {
    if (closed || domain || detachPromise) throw new Error('Response store already attached or closed')
    try {
     table=value.table('responses');domain=value;storageFailed=false
     for (const [id,row] of table.entries()) {
      const result=responseSchema.safeParse(row)
      if (result.success && result.data.id===id && !records.has(id)) { records.set(id,result.data);persisted.add(id) }
     }
     trim();save()
    } catch(error) { domain=undefined;table=undefined;persisted.clear();throw error }
  },
  begin(meta, enabled) {
   if (enabled !== true) return inert('disabled')
   if (closed || active.size >= limits.maxActive) return inert('unavailable')
   const row=metadataSchema.parse({schemaVersion:1,...meta,outcome:'unknown',bytes:2048,omittedFrames:0,captureError:false})
   row.frames=[];active.add(row)
   let finished=false, summary
   return {
    observe(kind, hop, value) {
     if (finished || closed) return
     if (row.omittedFrames > 0 || row.frames.length >= limits.maxFrames) { row.omittedFrames++;return }
     try {
      if (!kinds.includes(kind) || !Number.isSafeInteger(hop) || hop<1) throw new Error('Invalid response frame metadata')
      const json=JSON.stringify(value)
      if (typeof json!=='string') throw new Error('Response frame is not JSON')
      const frame={index:row.frames.length,hop,kind,json}
      const size=Buffer.byteLength(JSON.stringify(frame))+1
      if (row.bytes+size > limits.maxRecordBytes) { row.omittedFrames++;return }
      row.frames.push(frame);row.bytes+=size
     } catch { row.captureError=true;row.omittedFrames++ }
    },
    finish(outcome) {
     if (finished) return {...summary}
     finished=true;active.delete(row);row.outcome=outcomes.includes(outcome)?outcome:'unknown'
     summary={status:closed?'unavailable':row.omittedFrames?'truncated':'captured',frames:row.frames.length,omittedFrames:row.omittedFrames,bytes:row.bytes,captureError:row.captureError}
     if (!closed) { records.set(row.id,row);persisted.delete(row.id);trim();save() }
     return {...summary}
    },
   }
  },
  read({id,sessionHash,index=0,offset=0,length=RESPONSE_LIMITS.pageChars}) {
   for (const value of [index,offset,length]) if(!Number.isSafeInteger(value)||value<0)throw new Error('Invalid response page')
   if(length<1||length>RESPONSE_LIMITS.pageChars)throw new Error('Invalid response page length')
   const row=records.get(id)
   if (!row || row.sessionHash!==sessionHash) return {status:'not-retained'}
   const {frames,...metadata}=row, frame=frames[index]
   const end=frame?Math.min(offset+length,frame.json.length):0
   return {status:'available',format:'decoded-upstream-json',includesUncommittedAndReplayedFrames:true,persistence:persisted.has(id)&&!storageFailed&&!detachPromise?'disk':'memory-only',metadata:{...metadata,frames:frames.length},frame:frame?{index,hop:frame.hop,kind:frame.kind,text:frame.json.slice(offset,end),offset,totalChars:frame.json.length,nextOffset:end<frame.json.length?end:null,complete:offset===0&&end===frame.json.length}:null}
  },
  async flush() { while(scheduled){await tail} await tail },
   detach(value) {
    if (detachPromise) return detachPromise
    if (!domain || value!==domain) return Promise.resolve()
    const ownedDomain=domain
    // Only root disposal permanently closes capture; storage can detach/reload.
    detachPromise=(async()=>{
     try { await this.flush();await ownedDomain.close() }
     finally { domain=undefined;table=undefined;persisted.clear() }
    })().finally(()=>{detachPromise=undefined})
    return detachPromise
   },
   async close() {
    if(closed)return
    closed=true;for(const row of active)row.frames=[];active.clear()
    try { await this.detach(domain) } finally { records.clear();persisted.clear() }
   },
 }
}
