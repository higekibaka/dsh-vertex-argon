import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createArgonAdapter, PROVIDER, MODEL, GOOGLE_API_MODEL } from '../adapter.js'

const tool = { name: 'run_code', description: 'Execute the provided program', parameters: { type: 'object', properties: { code: { type: 'string' }, description: { type: 'string' } }, required: ['code', 'description'] } }
const ctx = { get: key => key === 'launchEnvironment' ? { get: name => ['GOOGLE_API_KEY', 'GOOGLE_CLOUD_API_KEY'].includes(name) ? { value: 'offline-fixture' } : undefined } : undefined }
const sse = events => new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } })
const originalFetch = globalThis.fetch

for (const model of [GOOGLE_API_MODEL, MODEL]) {
  for (const protocol of ['generate-content', 'interactions']) {
    for (const withTools of [false, true]) {
      test(model + '/' + protocol + ': validated is sent iff function tools exist (' + withTools + ')', async () => {
        const wire = []
        globalThis.fetch = async (_input, init) => {
          wire.push(JSON.parse(init.body))
          return protocol === 'generate-content'
            ? sse([{ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }])
            : sse([{ event_type: 'interaction.created', interaction: { id: 'fixture', status: 'in_progress' } }, { event_type: 'interaction.completed', interaction: { id: 'fixture', status: 'completed' } }])
        }
        try {
          const config = { maxTokens: 65536, reasoning: 'medium', longDecode: true, googleProtocol: protocol, vertexProtocol: protocol, routes: { hasGoogle: true, hasVertex: true } }
          const adapter = createArgonAdapter(ctx, config)
          const prepared = await adapter.prepareCall(PROVIDER, model)
          const chunks = []
          const tools = withTools ? [structuredClone(tool)] : []
          for await (const chunk of prepared.stream({ provider: PROVIDER, model, maxTokens: 512, sessionId: 'policy-fixture', messages: [{ role: 'user', content: [{ type: 'text', text: 'Test payload only.' }] }], tools })) chunks.push(chunk)
          assert.equal(chunks.at(-1).reason.kind, 'stop')
          assert.equal(wire.length, 1)
          const body = wire[0]
          const mode = protocol === 'interactions' ? body.generation_config?.tool_choice : body.toolConfig?.functionCallingConfig?.mode
          assert.equal(mode, withTools ? (protocol === 'interactions' ? 'validated' : 'VALIDATED') : undefined)
          if (withTools) {
            const declaration = protocol === 'interactions' ? body.tools[0] : body.tools[0].functionDeclarations[0]
            assert.deepEqual((declaration.parameters ?? declaration.parametersJsonSchema).required, ['code', 'description'])
            assert.deepEqual(tools, [tool], 'request normalization must not mutate host tool schemas')
          }
        } finally { globalThis.fetch = originalFetch }
      })
    }
  }
}
