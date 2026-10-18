export const USAGE_COUNT_KEYS = Object.freeze(['inputTokens', 'cachedTokens', 'outputTokens', 'thoughtTokens', 'toolTokens', 'totalTokens'])
export const USAGE_DETAIL_KEYS = Object.freeze(['inputByModality', 'cachedByModality', 'outputByModality', 'toolByModality'])
export const USAGE_MODALITIES = Object.freeze(['text', 'image', 'audio', 'video', 'document'])
export const MAX_USAGE_ROWS = 256
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function modalities(raw, protocol) {
  if (!Array.isArray(raw) || raw.length > USAGE_MODALITIES.length) return null
  const result = [], seen = new Set()
  for (const row of raw) {
    if (!object(row) || typeof row.modality !== 'string') return null
    const modality = row.modality.toLowerCase(), tokens = count(protocol === 'interactions' ? row.tokens : row.tokenCount)
    if (!USAGE_MODALITIES.includes(modality) || seen.has(modality) || tokens === null) return null
    seen.add(modality); result.push({ modality, tokens })
  }
  return result
}

export function normalizeUsageDetails(protocol, raw) {
  if (!object(raw)) return null
  const keys = protocol === 'interactions'
    ? ['total_input_tokens', 'total_cached_tokens', 'total_output_tokens', 'total_thought_tokens', 'total_tool_use_tokens', 'total_tokens']
    : ['promptTokenCount', 'cachedContentTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'toolUsePromptTokenCount', 'totalTokenCount']
  const arrays = protocol === 'interactions'
    ? ['input_tokens_by_modality', 'cached_tokens_by_modality', 'output_tokens_by_modality', 'tool_use_tokens_by_modality']
    : ['promptTokensDetails', 'cacheTokensDetails', 'candidatesTokensDetails', 'toolUsePromptTokensDetails']
  const result = Object.fromEntries(USAGE_COUNT_KEYS.map((key, i) => [key, count(raw[keys[i]])]))
  for (const [i, key] of USAGE_DETAIL_KEYS.entries()) result[key] = modalities(raw[arrays[i]], protocol)
  return result
}

// Rows are replacements of one cumulative sample, never additions of SSE deltas.
export function createUsageDetails() {
  const rows = new Map(), omitted = new Set()
  let aggregate = null, aggregateComplete = false
  return {
    recordAggregate(protocol, raw) { aggregate = normalizeUsageDetails(protocol, raw) },
    completeAggregate() { aggregateComplete = true },
    recordRow(kind, index, protocol, raw, complete, serviceTier = null) {
      if (!['gc-hop', 'interaction-step'].includes(kind) || !Number.isSafeInteger(index) || index < 0 || index > 4095) return
      const key = kind + ':' + index
      if (!rows.has(key) && rows.size >= MAX_USAGE_ROWS) { omitted.add(key); return }
      rows.set(key, { kind, index, usage: normalizeUsageDetails(protocol, raw), complete: complete === true, observedServiceTier: ['standard', 'flex', 'priority', 'provisioned'].includes(serviceTier) ? serviceTier : null })
    },
    snapshot() { return structuredClone({ aggregate, aggregateComplete, rows: [...rows.values()], omittedRows: omitted.size }) },
  }
}
