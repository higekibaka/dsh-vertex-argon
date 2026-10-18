// Public price snapshots, not account billing data. All amounts are USD per 1M tokens.
export const PRICE_SNAPSHOT = Object.freeze({
  version: 'argon-public-2026-10-18', verifiedAt: '2026-10-18',
  gemini: 'https://ai.google.dev/gemini-api/docs/pricing#gemini-4-argon',
  vertex: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing',
})
const GEMINI_PROMO = Object.freeze({ standard: [2, 0.1, 10], flex: [1, 0.05, 5], priority: [3.6, 0.18, 18] })
const VERTEX_PROMO = Object.freeze({ standard: [2, 0.1, 10], priority: [3.6, 0.18, 18] })
const knownCount = value => Number.isSafeInteger(value) && value >= 0
const round = value => Math.round(value * 1e9) / 1e9

// Configured request region, not an observed billing location or account identity.
export function classifyRequestRegion(location) {
  if (location === 'global') return 'global'
  return typeof location === 'string' && /^(?:us|eu|[a-z]+-[a-z]+[0-9]+)$/.test(location) ? 'non-global' : null
}

export function resolvePublicPrice({ route, tier, regionClass, at, model = 'gemini-4-argon' }) {
  if (!['gemini-4-argon', 'gemini-4-argon-google'].includes(model)) return null
  const time = typeof at === 'string' ? Date.parse(at) : NaN
  if (!Number.isFinite(time)) return null
  const date = new Date(time).toISOString().slice(0, 10)
  // Do not fabricate a price before the earliest retained price snapshot.
  if (date < PRICE_SNAPSHOT.verifiedAt) return null
  const vertex = route === 'google-vertex'
  if (!vertex && route !== 'google-generative-ai') return null
  const table = vertex ? VERTEX_PROMO : GEMINI_PROMO
  if (typeof tier !== 'string' || !Object.hasOwn(table, tier)) return null
  if (vertex && !['global', 'non-global'].includes(regionClass)) return null
  const promotional = date < '2026-12-01'
  const factor = (promotional ? 1 : 2) * (vertex && regionClass === 'non-global' ? 1.1 : 1)
  const [input, cached, output] = table[tier].map(value => round(value * factor))
  return { version: PRICE_SNAPSHOT.version, source: vertex ? PRICE_SNAPSHOT.vertex : PRICE_SNAPSHOT.gemini, verifiedAt: PRICE_SNAPSHOT.verifiedAt,
    input, cached, output, currency: 'USD', dateBoundary: 'UTC-estimation-convention',
    basis: vertex && promotional ? 'published-after-promotional-credits' : 'published-token-prices' }
}

export function estimateUsageCost({ usage, complete = false, ...selection }) {
  const price = resolvePublicPrice(selection)
  const missing = [], components = { inputUsd: null, cachedUsd: null, outputUsd: null }
  if (complete !== true) missing.push('usage-not-final')
  if (!price) missing.push('price-or-tier-or-region')
  if (!usage) missing.push('usage')
  if (usage && price) {
    for (const key of ['inputTokens', 'cachedTokens', 'outputTokens', 'thoughtTokens', 'toolTokens']) if (!knownCount(usage[key])) missing.push(key)
    if (knownCount(usage.inputTokens) && knownCount(usage.cachedTokens) && usage.cachedTokens > usage.inputTokens) missing.push('cached-exceeds-input')
    if (knownCount(usage.inputTokens) && knownCount(usage.cachedTokens) && knownCount(usage.toolTokens) && usage.cachedTokens <= usage.inputTokens) {
      components.inputUsd = round((usage.inputTokens - usage.cachedTokens + usage.toolTokens) * price.input / 1e6)
      components.cachedUsd = round(usage.cachedTokens * price.cached / 1e6)
    }
    if (knownCount(usage.outputTokens) && knownCount(usage.thoughtTokens)) components.outputUsd = round((usage.outputTokens + usage.thoughtTokens) * price.output / 1e6)
  }
  const known = Object.values(components).filter(value => value !== null)
  const knownSubtotalUsd = known.length ? round(known.reduce((sum, value) => sum + value, 0)) : null
  return { kind: 'usage-estimate', currency: 'USD', estimatedUsd: missing.length ? null : knownSubtotalUsd, knownSubtotalUsd, components, missing, price,
    billingVerified: false, excludes: ['account-discounts', 'tax', 'non-token-tools', 'unreported-usage'] }
}

// A view over observed usage, never an invoice. GC hop observations can include
// uncommitted output; IA per-step reports must not be added to its cumulative total.
export function estimateDiagnosticCost(record) {
 const details=record.usageDetails, gc=record.protocol==='generate-content'
 const missing=[], rows=[]
 const selection={route:record.route,model:record.model,regionClass:record.regionClass,at:record.startedAt}
 const estimate=(usage,complete,observed,index) => {
  const receipt=observed ?? (gc ? null : record.serviceTier?.observed)
  const tier=receipt ?? record.serviceTier?.requested
  const tierBasis=receipt != null ? 'observed' : 'requested'
  const cost=estimateUsageCost({...selection,tier,usage,complete})
  rows.push({index,tier:tier??null,tierBasis,...cost})
 }
 if(!details) missing.push('usage-details')
 else if(gc) {
  for(const row of details.rows)if(row.kind==='gc-hop')estimate(row.usage,row.complete,row.observedServiceTier,row.index)
  if(details.omittedRows)missing.push('omitted-usage-rows')
  if(rows.length!==record.hopCount||rows.length===0)missing.push('incomplete-hop-ledger')
 } else estimate(details.aggregate,details.aggregateComplete,record.serviceTier?.observed,0)
 if(!['done','max-tokens','tool-calls'].includes(record.outcome))missing.push('request-not-complete')
 for(const row of rows)for(const value of row.missing)if(!missing.includes(value))missing.push(value)
 const known=rows.map(row=>row.knownSubtotalUsd).filter(value=>value!==null)
 const knownSubtotalUsd=known.length?round(known.reduce((a,b)=>a+b,0)):null
 return {kind:'usage-estimate',currency:'USD',basis:gc?'gc-hops':'interaction-aggregate',estimatedUsd:missing.length||!rows.length?null:knownSubtotalUsd,knownSubtotalUsd,missing,rows,billingVerified:false}
}

