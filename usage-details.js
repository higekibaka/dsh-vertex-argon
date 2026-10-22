export const USAGE_COUNT_KEYS = Object.freeze(['inputTokens', 'cachedTokens', 'outputTokens', 'thoughtTokens', 'toolTokens', 'totalTokens'])
export const USAGE_DETAIL_KEYS = Object.freeze(['inputByModality', 'cachedByModality', 'outputByModality', 'toolByModality'])
export const USAGE_MODALITIES = Object.freeze(['text', 'image', 'audio', 'video', 'document'])
export const MAX_USAGE_ROWS = 256
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// Shared read-time interpretation for new samples and legacy persisted nulls.
// Missing optional counters are zero only beside a valid base counter. Invalid
// wire values carry a durable marker so normalization cannot launder them to zero.
export function resolveUsageCounts(usage, protocol) {
  if (!object(usage)) return null
  const invalid = new Set(Array.isArray(usage.invalidCounts) ? usage.invalidCounts : [])
  const result = Object.fromEntries(USAGE_COUNT_KEYS.map(key => [key, invalid.has(key) ? null : count(usage[key])]))
  const absent = key => usage[key] == null && !invalid.has(key)
  if (result.inputTokens !== null) {
    for (const key of ['cachedTokens', 'toolTokens']) if (absent(key)) result[key] = 0
  }
  // GC may omit a zero candidate count (e.g. a tool-only response). Require
  // a reported total that proves zero; never infer a positive output or input.
  if (protocol === 'generate-content' && absent('outputTokens') && result.inputTokens !== null && result.totalTokens !== null && result.toolTokens !== null) {
    const thoughts = absent('thoughtTokens') ? 0 : result.thoughtTokens
    const accounted = thoughts === null ? null : result.inputTokens + result.toolTokens + thoughts
    if (accounted !== null && count(accounted) !== null && accounted === result.totalTokens) result.outputTokens = 0
  }
  if (result.outputTokens !== null && absent('thoughtTokens')) result.thoughtTokens = 0
  return result
}

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
  const invalidCounts = USAGE_COUNT_KEYS.filter((key, i) => raw[keys[i]] !== undefined && result[key] === null)
  if (invalidCounts.length) result.invalidCounts = invalidCounts
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
