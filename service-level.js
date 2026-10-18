export const SERVICE_TIERS = Object.freeze(['standard', 'flex', 'priority'])

// Only combinations backed by the reviewed Argon documentation are enabled.
// A missing combination means unverified here, not unsupported by Google.
export const SERVICE_TIER_CAPABILITIES = Object.freeze({
  'google-generative-ai/generate-content': SERVICE_TIERS,
  'google-generative-ai/interactions': SERVICE_TIERS,
  'google-vertex/generate-content': Object.freeze(['standard', 'priority']),
  'google-vertex/interactions': Object.freeze(['standard']),
})

export function resolveServicePolicy(config, route, protocol) {
  const tier = (route === 'google-vertex' ? config.vertexServiceTier : config.googleServiceTier) ?? 'standard'
  if (!SERVICE_TIERS.includes(tier)) throw Object.assign(new Error('Invalid Argon service tier.'), { code: 'INVALID_CONFIG' })
  const allowed = SERVICE_TIER_CAPABILITIES[route + '/' + protocol]
  if (!allowed?.includes(tier)) throw Object.assign(new Error('The requested Argon service tier is not verified for this route and protocol. No request was sent and no higher-price fallback was selected.'), { code: 'ARGON_SERVICE_TIER_UNVERIFIED' })
  if (route === 'google-vertex' && protocol === 'interactions' && config.vertexPaygoOnly === true) throw Object.assign(new Error('Vertex PayGo-only routing is not verified for Interactions.'), { code: 'ARGON_SERVICE_TIER_UNVERIFIED' })
  const headers = {}
  if (route === 'google-vertex' && tier !== 'standard') headers['X-Vertex-AI-LLM-Shared-Request-Type'] = tier
  if (route === 'google-vertex' && config.vertexPaygoOnly === true) headers['X-Vertex-AI-LLM-Request-Type'] = 'shared'
  return Object.freeze({ tier, headers: Object.freeze(headers) })
}

export function mergeServiceHeaders(input, policy) {
  const headers = new Headers(input)
  for (const [key, value] of Object.entries(policy.headers)) headers.set(key, value)
  return Object.fromEntries(headers)
}

export function serviceTierFromHeader(value) {
  return typeof value === 'string' && SERVICE_TIERS.includes(value.toLowerCase()) ? value.toLowerCase() : null
}

export function serviceTierFromTraffic(value) {
  const tiers = { ON_DEMAND: 'standard', ON_DEMAND_PRIORITY: 'priority', ON_DEMAND_FLEX: 'flex', PROVISIONED_THROUGHPUT: 'provisioned' }
  return typeof value === 'string' && Object.hasOwn(tiers, value) ? tiers[value] : null
}
