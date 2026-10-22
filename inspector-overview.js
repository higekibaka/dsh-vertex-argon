import {estimateDiagnosticCost} from './pricing.js'
import {USAGE_COUNT_KEYS,resolveUsageCounts} from './usage-details.js'

const knownCount=value=>Number.isSafeInteger(value)&&value>=0
const knownMoney=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER
const finalOutcome=outcome=>['done','max-tokens','tool-calls'].includes(outcome)

// Empty or overflowing sums are unknown, not zero. Never omit an overflowing
// request and report the remaining requests as if they were the whole subtotal.
function sumKnown(values,valid) {
 if(!values.length)return null
 let sum=0
 for(const value of values){sum+=value;if(!valid(sum))return null}
 return sum
}

function requestSources(record) {
 const details=record.usageDetails
 if(!details)return {rows:[],complete:false}
 if(record.protocol==='generate-content') {
  const rows=(details.rows??[]).filter(row=>row.kind==='gc-hop')
  const complete=finalOutcome(record.outcome)&&rows.length>0&&rows.length===record.hopCount&&details.omittedRows===0
   &&rows.every(row=>row.complete===true&&knownCount(row.index))&&new Set(rows.map(row=>row.index)).size===rows.length
  return {rows,complete}
 }
 if(record.protocol==='interactions')return {rows:[{usage:details.aggregate}],complete:finalOutcome(record.outcome)&&details.aggregateComplete===true}
 return {rows:[],complete:false}
}

function requestSummary(record) {
 const {rows,complete}=requestSources(record)
 const usages=rows.map(row=>resolveUsageCounts(row.usage,record.protocol))
 const tokens=Object.fromEntries(USAGE_COUNT_KEYS.map(key=>{
  const known=usages.map(usage=>usage?.[key]).filter(knownCount)
  const subtotal=sumKnown(known,knownCount)
  return [key,{subtotal,reported:known.length>0,complete:complete&&known.length===rows.length&&subtotal!==null}]
 }))
 const cacheComplete=tokens.inputTokens.complete&&tokens.cachedTokens.complete
  &&usages.every(usage=>usage.cachedTokens<=usage.inputTokens)
 // Keep pricing in one place; a duplicate/invalid hop ledger still cannot be
 // promoted to a complete estimate even if its individual rows are priced.
 const cost=['generate-content','interactions'].includes(record.protocol)?estimateDiagnosticCost(record):null
 return {tokens,cacheComplete,cost, costComplete:complete&&knownMoney(cost?.estimatedUsd)}
}

// The caller supplies filtered, bounded records, verified when answer-scoped.
// This describes that retained snapshot, never the entire session history.
export function summarizeRequestOverview(records,window={limit:20,limited:false}) {
 const requests=records.map(requestSummary),requestCount=requests.length
 const tokens=Object.fromEntries(USAGE_COUNT_KEYS.map(key=>{
  const reported=requests.map(request=>request.tokens[key]).filter(field=>field.reported)
  const knownSubtotal=reported.some(field=>field.subtotal===null)?null:sumKnown(reported.map(field=>field.subtotal),knownCount)
  const completeRequests=requests.filter(request=>request.tokens[key].complete).length
  return [key,{knownSubtotal,reportedRequests:reported.length,completeRequests,complete:requestCount>0&&completeRequests===requestCount&&knownSubtotal!==null}]
 }))
 const cacheCompleteRequests=requests.filter(request=>request.cacheComplete).length
 const percent=requestCount>0&&cacheCompleteRequests===requestCount&&tokens.inputTokens.complete&&tokens.cachedTokens.complete&&tokens.inputTokens.knownSubtotal>0
  ?tokens.cachedTokens.knownSubtotal/tokens.inputTokens.knownSubtotal*100:null
 const reportedCosts=requests.filter(request=>knownMoney(request.cost?.knownSubtotalUsd))
 const costSum=sumKnown(reportedCosts.map(request=>request.cost.knownSubtotalUsd),knownMoney)
 // A numeric but unrepresentable source cost must not silently disappear.
 const invalidCost=requests.some(request=>request.cost?.knownSubtotalUsd!=null&&!knownMoney(request.cost.knownSubtotalUsd))
 const knownSubtotalUsd=invalidCost||costSum===null?null:Math.round(costSum*1e9)/1e9
 const completeRequests=requests.filter(request=>request.costComplete).length
 // One pass over the retained snapshot replaces a full copy plus sort.
 let oldestAt=null,newestAt=null
 for(const record of records){
  const startedAt=record.startedAt
  if(typeof startedAt==='string'){
   if(oldestAt===null||startedAt<oldestAt)oldestAt=startedAt
   if(newestAt===null||startedAt>newestAt)newestAt=startedAt
  }
 }
 return {
  requestCount,
  window:{limit:window.limit??20,retainedWindowLimit:200,limited:window.limited===true,oldestAt,newestAt},
  tokens,
  cache:{percent,completeRequests:cacheCompleteRequests},
  cost:{knownSubtotalUsd,estimatedUsd:requestCount>0&&completeRequests===requestCount?knownSubtotalUsd:null,reportedRequests:reportedCosts.length,completeRequests,billingVerified:false},
 }
}
