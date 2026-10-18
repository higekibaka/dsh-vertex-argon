import Ajv2020 from 'ajv/dist/2020.js'

// Conservative portable subset, not a claim to support every Google Schema keyword.
// Reject unsupported constraints instead of silently weakening the user's contract.
export const STRUCTURED_OUTPUT_LIMITS = Object.freeze({
  schemaBytes: 16 * 1024, schemaNodes: 256, schemaDepth: 16,
  resultBytes: 4 * 1024 * 1024, resultNodes: 50000, resultDepth: 64,
})
const keywords = new Set(['type', 'title', 'description', 'enum', 'properties', 'required', 'additionalProperties', 'items', 'prefixItems', 'minItems', 'maxItems', 'minimum', 'maximum', 'anyOf'])
const preparedPolicies = new WeakSet()
export function assertPreparedStructuredOutput(policy) {
  if (policy !== undefined && !preparedPolicies.has(policy)) throw error('ARGON_JSON_SCHEMA_INVALID')
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const error = code => Object.assign(new Error({
  ARGON_JSON_SCHEMA_INVALID: 'Provide a valid JSON Schema object.',
  ARGON_JSON_SCHEMA_UNSUPPORTED: 'This JSON Schema uses a constraint outside the supported bounded subset.',
  ARGON_JSON_SCHEMA_LIMIT: 'This JSON Schema exceeds the size or complexity limit.',
  ARGON_JSON_TOOLS_UNVERIFIED: 'Structured JSON results require a separate request without tools.',
  ARGON_JSON_FORMAT_CONFLICT: 'Structured JSON results cannot combine other format settings or raw body overrides.',
}[code]), {code})

function inspectJson(value, maxNodes, maxDepth) {
  let nodes = 0
  function visit(value, depth) {
    if (++nodes > maxNodes || depth > maxDepth) return 'resource-limit'
    if (typeof value === 'number' && !Number.isFinite(value)) return 'invalid-json'
    if (value === null || typeof value !== 'object') return null
    const keys = Object.keys(value)
    if (keys.length > maxNodes - nodes) return 'resource-limit'
    for (const key of keys) { const failure = visit(value[key], depth + 1); if (failure) return failure }
    return null
  }
  return visit(value, 0)
}
function checkSubset(schema) {
  let count = 0
  function visit(node, depth) {
    if (++count > STRUCTURED_OUTPUT_LIMITS.schemaNodes || depth > STRUCTURED_OUTPUT_LIMITS.schemaDepth) throw error('ARGON_JSON_SCHEMA_LIMIT')
    if (!object(node)) throw error('ARGON_JSON_SCHEMA_INVALID')
    for (const key of Object.keys(node)) if (!keywords.has(key)) throw error('ARGON_JSON_SCHEMA_UNSUPPORTED')
    if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.some(value => value !== null && typeof value === 'object'))) throw error('ARGON_JSON_SCHEMA_INVALID')
    if (node.properties !== undefined) {
      if (!object(node.properties)) throw error('ARGON_JSON_SCHEMA_INVALID')
      // Ajv intentionally excludes this property from Schema maps; never accept a
      // constraint it would silently drop. The same key in result JSON stays data.
      if (Object.hasOwn(node.properties, '__proto__')) throw error('ARGON_JSON_SCHEMA_UNSUPPORTED')
      for (const child of Object.values(node.properties)) visit(child, depth + 1)
    }
    for (const key of ['items', 'additionalProperties']) if (node[key] !== undefined && typeof node[key] !== 'boolean') visit(node[key], depth + 1)
    for (const key of ['prefixItems', 'anyOf']) if (node[key] !== undefined) {
      if (!Array.isArray(node[key])) throw error('ARGON_JSON_SCHEMA_INVALID')
      for (const child of node[key]) visit(child, depth + 1)
    }
  }
  visit(schema, 0)
}
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}

// Input is text so the wire snapshot is detached, plain JSON, and measured before parsing.
// The validator is request-owned; there is no unbounded global Schema cache.
export function prepareStructuredOutput(schemaText) {
  const limits = STRUCTURED_OUTPUT_LIMITS
  if (typeof schemaText !== 'string') throw error('ARGON_JSON_SCHEMA_INVALID')
  if (Buffer.byteLength(schemaText, 'utf8') > limits.schemaBytes) throw error('ARGON_JSON_SCHEMA_LIMIT')
  let schema
  try { schema = JSON.parse(schemaText) } catch { throw error('ARGON_JSON_SCHEMA_INVALID') }
  const failure = inspectJson(schema, limits.schemaNodes * 16, limits.schemaDepth * 3)
  if (failure) throw error(failure === 'resource-limit' ? 'ARGON_JSON_SCHEMA_LIMIT' : 'ARGON_JSON_SCHEMA_INVALID')
  checkSubset(schema)
  const ajv = new Ajv2020({
    strictSchema: true, strictTypes: false, strictTuples: false, strictRequired: false,
    strictNumbers: true, allErrors: false, validateFormats: false, ownProperties: true,
    coerceTypes: false, useDefaults: false, removeAdditional: false, addUsedSchema: false,
    messages: false,
  })
  let validate
  try { validate = ajv.compile(schema) } catch { throw error('ARGON_JSON_SCHEMA_INVALID') }
  freeze(schema)
  function noTools(tools) {
    if (tools !== undefined && (!Array.isArray(tools) || tools.length > 0)) throw error('ARGON_JSON_TOOLS_UNVERIFIED')
  }
  const policy = Object.freeze({
    schema,
    generateContent(payload) {
      const config = payload.config ?? {}, httpOptions = config.httpOptions ?? {}
      noTools(config.tools)
      if (['responseMimeType', 'responseJsonSchema', 'responseSchema', 'responseFormat'].some(key => config[key] !== undefined) ||
          (httpOptions.extraBody !== undefined && (!object(httpOptions.extraBody) || Object.keys(httpOptions.extraBody).length))) throw error('ARGON_JSON_FORMAT_CONFLICT')
      // SDK2.21 drops config.responseFormat. Its documented extraBody extension
      // carries the modern field without mutating the original native request.
      return {...payload, config: {...config, httpOptions: {...httpOptions, extraBody: {
        generationConfig: {responseFormat: {text: {mimeType: 'application/json', schema}}},
      }}}}
    },
    interactions(request) {
      noTools(request.tools)
      if (request.response_format !== undefined) throw error('ARGON_JSON_FORMAT_CONFLICT')
      return {...request, response_format: {type: 'text', mime_type: 'application/json', schema}}
    },
    checkResult(text, {finishReason} = {}) {
      // Even syntactically valid partial JSON is not a completed result.
      if (finishReason !== 'stop') return {status: 'incomplete'}
      if (typeof text !== 'string') return {status: 'invalid-json'}
      if (Buffer.byteLength(text, 'utf8') > limits.resultBytes) return {status: 'resource-limit'}
      let value
      try { value = JSON.parse(text) } catch { return {status: 'invalid-json'} }
      const failure = inspectJson(value, limits.resultNodes, limits.resultDepth)
      if (failure) return {status: failure}
      if (validate(value)) return {status: 'valid', value}
      const issue = validate.errors?.[0]
      return {status: 'schema-mismatch', issue: {
        keyword: String(issue?.keyword ?? 'schema').slice(0, 64),
        instancePath: String(issue?.instancePath ?? '').slice(0, 512),
        schemaPath: String(issue?.schemaPath ?? '').slice(0, 512),
      }}
    },
  })
  preparedPolicies.add(policy)
  return policy
}
