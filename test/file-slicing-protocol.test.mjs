import assert from 'node:assert/strict'
import { test as nodeTest } from 'node:test'
import { shared } from '../runtime.js'
import {
  createArgonAdapter,
  PROVIDER,
  NEON_MODEL,
  GOOGLE_API_NEON_MODEL,
  GOOGLE_API_CARBON_MODEL,
} from '../adapter.js'
import {
  contentHash,
  historyHash,
  INTERACTIONS_REPLAY_API,
  downgradeToolChoiceToAuto,
} from '../interactions-input.js'
import {
  SLICE_TOOL_NAME,
  createFileSliceHub,
  normalizePiAiToolCallId,
} from '../file-slicing.js'
import { geminiApiPrincipalHash } from '../files-transport.js'

const { BlockAssembler, createUserMessage, createToolResultMessage } = await shared('@deepseek-ai/dsh-llm')

const API_KEY = 'fixture-gemini-key-alpha'
const OTHER_API_KEY = 'fixture-gemini-key-beta'
const PRINCIPAL_HASH = geminiApiPrincipalHash(API_KEY)
const SESSION_ID = 'slice-e2e-session'

function makeCtx(apiKey = API_KEY) {
  return {
    get: key => key === 'launchEnvironment'
      ? {
          get: name => {
            if (name === 'GOOGLE_API_KEY') return { value: apiKey }
            if (name === 'GOOGLE_CLOUD_API_KEY') return { value: 'fixture-vertex-key' }
            return undefined
          },
        }
      : undefined,
  }
}

function makeConfig(overrides = {}) {
  return {
    maxTokens: 65536,
    reasoning: 'medium',
    longDecode: true,
    googleProtocol: 'interactions',
    vertexProtocol: 'generate-content',
    allowGeminiFilesApi: true,
    routes: {
      hasGoogle: true,
      hasVertex: true,
      hasGoogleCarbon: true,
      hasVertexCarbon: true,
      hasGoogleNeon: true,
      hasVertexNeon: true,
    },
    ...overrides,
  }
}

const SLICE_TOOLS = [{
  name: SLICE_TOOL_NAME,
  description: 'Slice a local file via Gemini Files API',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
}]

const sse = events => new Response(
  events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join(''),
  { headers: { 'Content-Type': 'text/event-stream' } },
)

const interactionDoneEvents = [
  { event_type: 'interaction.created', event_id: 'e1', interaction: { id: 'remote-slice', status: 'in_progress' } },
  { event_type: 'step.start', event_id: 'e2', index: 0, step: { type: 'model_output' } },
  { event_type: 'step.delta', event_id: 'e3', index: 0, delta: { type: 'text', text: 'analyzed' } },
  { event_type: 'step.stop', event_id: 'e4', index: 0 },
  { event_type: 'interaction.completed', event_id: 'e5', interaction: { id: 'remote-slice', status: 'completed', usage: { total_input_tokens: 40, total_output_tokens: 4, total_thought_tokens: 0, total_tokens: 44 } } },
]

const gcDoneEvents = [{
  candidates: [{ content: { role: 'model', parts: [{ text: 'analyzed' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 4, totalTokenCount: 44 },
}]

const hostFetch = globalThis.fetch
let wire = []
let responder = null

const stubFetch = async (input, init) => {
  const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  const entry = {
    url,
    method: init?.method ?? 'GET',
    body: init?.body ? JSON.parse(init.body) : undefined,
  }
  wire.push(entry)
  if (responder) return responder(entry)
  if (url.includes('streamGenerateContent')) return sse(gcDoneEvents)
  return sse(interactionDoneEvents)
}

const test = (name, fn) => nodeTest(name, async (...args) => {
  wire = []
  responder = null
  globalThis.fetch = stubFetch
  try {
    return await fn(...args)
  } finally {
    globalThis.fetch = hostFetch
    responder = null
  }
})

async function collect(stream) {
  const out = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

function buildInteractionsHistory({
  model = GOOGLE_API_NEON_MODEL,
  route = 'google-generative-ai',
  calls,
  extraReplaySteps = [],
}) {
  const user = { role: 'user', content: [{ type: 'text', text: 'inspect slices' }] }
  const sig = Buffer.from('sig-neon-slice').toString('base64')
  const assistantContent = [
    { type: 'reasoning', text: 'calling slice tool' },
    ...calls.map(c => ({
      type: 'tool-call',
      id: c.callId,
      name: SLICE_TOOL_NAME,
      arguments: JSON.stringify(c.args ?? { path: c.path ?? '/tmp/demo.pdf' }),
    })),
  ]
  const replaySteps = [
    ...extraReplaySteps,
    { type: 'thought', signature: sig, summary: [{ type: 'text', text: 'calling slice tool' }] },
    ...calls.map(c => ({
      type: 'function_call',
      id: c.callId,
      name: SLICE_TOOL_NAME,
      arguments: c.args ?? { path: c.path ?? '/tmp/demo.pdf' },
    })),
  ]
  const assistant = {
    role: 'assistant',
    content: assistantContent,
    source: {
      provider: PROVIDER,
      model,
      replayState: {
        response: {
          api: INTERACTIONS_REPLAY_API,
          provider: PROVIDER,
          model,
          route,
          contentHash: contentHash(assistantContent),
          historyHash: historyHash([user]),
          steps: replaySteps,
        },
      },
    },
  }
  const toolMessages = calls.map(c => ({
    role: 'tool',
    toolCallId: c.callId,
    toolName: SLICE_TOOL_NAME,
    isError: Boolean(c.isError),
    content: [{ type: 'text', text: JSON.stringify(c.result ?? { ok: true, callId: c.callId }) }],
  }))
  return [user, assistant, ...toolMessages]
}

async function buildGenerateContentHistory(adapter, model, calls, sessionId = SESSION_ID) {
  const sig = Buffer.from('gc-slice-sig').toString('base64')
  const prevResponder = responder
  responder = () => sse([{
    candidates: [{
      content: {
        role: 'model',
        parts: calls.map((c, idx) => ({
          functionCall: {
            id: c.callId,
            name: SLICE_TOOL_NAME,
            args: c.args ?? { path: c.path ?? '/tmp/demo.pdf' },
          },
          ...(idx === 0 ? { thoughtSignature: sig } : {}),
        })),
      },
      finishReason: 'STOP',
    }],
    usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, totalTokenCount: 25 },
  }])
  const user = createUserMessage({ content: [{ type: 'text', text: 'inspect slices' }], source: { kind: 'user' } })
  const assembler = new BlockAssembler()
  try {
    for await (const chunk of adapter.stream({
      provider: PROVIDER,
      model,
      maxTokens: 512,
      sessionId,
      messages: [user],
      tools: SLICE_TOOLS,
    })) {
      assembler.push(chunk)
    }
  } finally {
    responder = prevResponder
  }
  assert.equal(assembler.finish.kind, 'tool-calls')
  const assistant = assembler.message({ provider: PROVIDER, model, replayState: assembler.replayState })
  const toolCalls = assistant.content.filter(b => b.type === 'tool-call')
  assert.equal(toolCalls.length, calls.length)
  const toolResults = toolCalls.map((tc, i) => createToolResultMessage({
    callId: tc.id,
    content: [{ type: 'text', text: JSON.stringify(calls[i].result ?? { ok: true, callId: calls[i].callId }) }],
    isError: Boolean(calls[i].isError),
  }))
  return [user, assistant, ...toolResults]
}

function findGcFunctionResponses(body) {
  const out = []
  for (const content of body?.contents ?? []) {
    for (const part of content?.parts ?? []) {
      if (part?.functionResponse) out.push(part.functionResponse)
    }
  }
  return out
}

test('Interactions E2E: injects document, spreadsheet, video, and audio slice blocks onto wire JSON', async () => {
  const nowMs = 1_700_000_000_000
  const expMs = nowMs + 48 * 3600_000
  const hub = createFileSliceHub({ now: () => nowMs })
  try {
    const specs = [
      {
        callId: 'ia-doc-1',
        uri: 'https://generativelanguage.googleapis.com/v1beta/files/doc1',
        name: 'files/doc1',
        mimeType: 'application/pdf',
        category: 'document',
        displayName: 'slice_doc1_report.pdf',
        slice: { startPage: 2, endPage: 5, contentLayers: ['page_text', 'page_image'], resolution: 'high' },
      },
      {
        callId: 'ia-sheet-2',
        uri: 'https://generativelanguage.googleapis.com/v1beta/files/sheet2',
        name: 'files/sheet2',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        category: 'spreadsheet',
        displayName: 'slice_sheet2_q4.xlsx',
        slice: { sheetIndex: 2, visibleCells: 'A1:D20', contentLayers: ['data', 'formulas', 'visual'], resolution: 'medium' },
      },
      {
        callId: 'ia-vid-3',
        uri: 'https://generativelanguage.googleapis.com/v1beta/files/vid3',
        name: 'files/vid3',
        mimeType: 'video/mp4',
        category: 'video',
        displayName: 'slice_vid3_clip.mp4',
        slice: { startOffset: '10s', endOffset: '25s', fps: 2, contentLayers: ['frames', 'audio', 'transcript'], resolution: 'low' },
      },
      {
        callId: 'ia-aud-4',
        uri: 'https://generativelanguage.googleapis.com/v1beta/files/aud4',
        name: 'files/aud4',
        mimeType: 'audio/mpeg',
        category: 'audio',
        displayName: 'slice_aud4_talk.mp3',
        slice: { startOffset: '3s', endOffset: '18.5s' },
      },
    ]
    for (const s of specs) {
      hub.registerSlice({ sessionId: SESSION_ID, route: 'google-generative-ai', principalHash: PRINCIPAL_HASH, expirationTimeMs: expMs, ...s })
    }

    const adapter = createArgonAdapter(makeCtx(), makeConfig({ googleProtocol: 'interactions' }), undefined, undefined, undefined, undefined, undefined, undefined, hub)
    const messages = buildInteractionsHistory({ calls: specs.map(s => ({ callId: s.callId })) })
    const out = await collect(adapter.stream({
      provider: PROVIDER,
      model: GOOGLE_API_NEON_MODEL,
      maxTokens: 512,
      sessionId: SESSION_ID,
      messages,
      tools: SLICE_TOOLS,
    }))
    assert.equal(out.at(-1).reason.kind, 'stop')

    const body = wire.at(-1).body
    const fnResults = body.input.filter(step => step.type === 'function_result')
    assert.equal(fnResults.length, 4)

    const byId = new Map(fnResults.map(r => [r.call_id, r]))
    assert.deepEqual(byId.get('ia-doc-1').result[1], {
      type: 'document',
      uri: 'https://generativelanguage.googleapis.com/v1beta/files/doc1',
      mime_type: 'application/pdf',
      resolution: 'high',
      processing: {
        type: 'static',
        page_options: { start_page: 2, end_page: 5, content_layers: ['page_text', 'page_image'] },
      },
    })
    assert.deepEqual(byId.get('ia-sheet-2').result[1], {
      type: 'document',
      uri: 'https://generativelanguage.googleapis.com/v1beta/files/sheet2',
      mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      resolution: 'medium',
      processing: {
        type: 'static',
        spreadsheet_options: { sheet_index: 2, visible_cells: 'A1:D20', content_layers: ['data', 'formulas', 'visual'] },
      },
    })
    assert.deepEqual(byId.get('ia-vid-3').result[1], {
      type: 'video',
      uri: 'https://generativelanguage.googleapis.com/v1beta/files/vid3',
      mime_type: 'video/mp4',
      resolution: 'low',
      processing: {
        type: 'static',
        start_offset: '10s',
        end_offset: '25s',
        fps: 2,
        content_layers: ['frames', 'audio', 'transcript'],
      },
    })
    assert.deepEqual(byId.get('ia-aud-4').result[1], {
      type: 'audio',
      uri: 'https://generativelanguage.googleapis.com/v1beta/files/aud4',
      mime_type: 'audio/mpeg',
      processing: {
        type: 'static',
        start_offset: '3s',
        end_offset: '18.5s',
      },
    })
  } finally {
    hub.close()
  }
})

test('Interactions E2E: tool-search HTTP 400 fallback replaces sliced media blocks with safe placeholder text', async () => {
  const nowMs = 1_700_000_000_000
  const hub = createFileSliceHub({ now: () => nowMs })
  try {
    hub.registerSlice({
      sessionId: SESSION_ID,
      callId: 'ia-ts-1',
      route: 'google-generative-ai',
      principalHash: PRINCIPAL_HASH,
      uri: 'https://generativelanguage.googleapis.com/v1beta/files/ts1',
      name: 'files/ts1',
      mimeType: 'application/pdf',
      category: 'document',
      displayName: 'slice_ts1_doc.pdf',
      slice: { startPage: 1, endPage: 2 },
      expirationTimeMs: nowMs + 48 * 3600_000,
    })

    let posts = 0
    responder = () => {
      posts++
      if (posts === 1) {
        return new Response(JSON.stringify({ error: { status: 'INVALID_ARGUMENT' } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return sse(interactionDoneEvents)
    }

    const adapter = createArgonAdapter(makeCtx(), makeConfig({ googleProtocol: 'interactions', interactionsToolRetrieval: 'explicit' }), undefined, undefined, undefined, undefined, undefined, undefined, hub)
    const tools = [{ ...SLICE_TOOLS[0], deferLoading: true }]
    const messages = buildInteractionsHistory({
      calls: [{ callId: 'ia-ts-1' }],
      extraReplaySteps: [
        { type: 'tool_search_call', id: 'ts-call-1', arguments: { function_names: [SLICE_TOOL_NAME] } },
        { type: 'tool_search_result', call_id: 'ts-call-1', result: [{ name: SLICE_TOOL_NAME }] },
      ],
    })
    const out = await collect(adapter.stream({
      provider: PROVIDER,
      model: GOOGLE_API_NEON_MODEL,
      maxTokens: 512,
      sessionId: SESSION_ID,
      messages,
      tools,
    }))
    assert.equal(out.at(-1).reason.kind, 'stop')
    assert.equal(posts, 2)

    // First attempt had native function_result with document slice; fallback rebuilt without tool_search and without leaking URI.
    assert.equal(wire[0].body.input.some(s => s.type === 'function_result' && s.result.some(b => b.type === 'document')), true)
    const fallbackInput = wire[1].body.input
    assert.equal(fallbackInput.some(s => s.type === 'function_result'), false)
    assert.equal(JSON.stringify(fallbackInput).includes('generativelanguage.googleapis.com/v1beta/files/ts1'), false)

    // Direct downgradeToolChoiceToAuto on an already-hydrated body also strips sliced media blocks cleanly.
    const downgraded = downgradeToolChoiceToAuto(wire[0].body)
    assert.equal(downgraded.input.some(s => s.type === 'function_result'), false)
    assert.equal(JSON.stringify(downgraded.input).includes('generativelanguage.googleapis.com/v1beta/files/ts1'), false)
    assert.equal(JSON.stringify(downgraded.input).includes('[File slice omitted after tool-search downgrade]'), true)
  } finally {
    hub.close()
  }
})

test('GenerateContent E2E: wire JSON preserves functionResponse.parts metadata, mediaResolution, $ref, and normalized toolCallId', async () => {
  const nowMs = 1_700_000_000_000
  const expMs = nowMs + 48 * 3600_000
  const hub = createFileSliceHub({ now: () => nowMs })
  try {
    const rawDocCallId = 'slice:call/1.pdf'
    const normalizedDocCallId = normalizePiAiToolCallId(rawDocCallId)
    assert.notEqual(normalizedDocCallId, rawDocCallId)

    const specs = [
      {
        callId: rawDocCallId,
        uri: 'https://generativelanguage.googleapis.com/v1beta/files/gc1',
        name: 'files/gc1',
        mimeType: 'application/pdf',
        category: 'document',
        displayName: 'slice_gc1_report.pdf',
        slice: { startPage: 1, endPage: 3, contentLayers: ['page_text', 'page_image'], resolution: 'ultra_high' },
      },
      {
        callId: 'gc-sheet-2',
        uri: 'https://generativelanguage.googleapis.com/v1beta/files/gc2',
        name: 'files/gc2',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        category: 'spreadsheet',
        displayName: 'slice_gc2_budget.xlsx',
        slice: { sheetIndex: 1, visibleCells: 'B2:F10', contentLayers: ['data', 'formulas', 'visual'], resolution: 'high' },
      },
      {
        callId: 'gc-vid-3',
        uri: 'https://generativelanguage.googleapis.com/v1beta/files/gc3',
        name: 'files/gc3',
        mimeType: 'video/mp4',
        category: 'video',
        displayName: 'slice_gc3_demo.mp4',
        slice: { startOffset: '5s', endOffset: '20s', fps: 1.5, contentLayers: ['frames', 'audio', 'transcript'], resolution: 'medium' },
      },
      {
        callId: 'gc-aud-4',
        uri: 'https://generativelanguage.googleapis.com/v1beta/files/gc4',
        name: 'files/gc4',
        mimeType: 'audio/wav',
        category: 'audio',
        displayName: 'slice_gc4_memo.wav',
        slice: { startOffset: '0s', endOffset: '12s' },
      },
    ]
    for (const s of specs) {
      hub.registerSlice({ sessionId: SESSION_ID, route: 'google-generative-ai', principalHash: PRINCIPAL_HASH, expirationTimeMs: expMs, ...s })
    }

    const adapter = createArgonAdapter(makeCtx(), makeConfig({ googleProtocol: 'generate-content' }), undefined, undefined, undefined, undefined, undefined, undefined, hub)
    // Simulate pi-ai emitting the normalized toolCallId on the wire while the hub registered the raw callId.
    const history = await buildGenerateContentHistory(adapter, GOOGLE_API_NEON_MODEL, specs.map((s, idx) => ({
      callId: idx === 0 ? normalizedDocCallId : s.callId,
    })))

    const beforeWire = wire.length
    const out = await collect(adapter.stream({
      provider: PROVIDER,
      model: GOOGLE_API_NEON_MODEL,
      maxTokens: 512,
      sessionId: SESSION_ID,
      messages: history,
      tools: SLICE_TOOLS,
    }))
    assert.equal(out.at(-1).reason.kind, 'stop')
    assert.equal(wire.length, beforeWire + 1)

    const body = wire.at(-1).body
    const responses = findGcFunctionResponses(body)
    assert.equal(responses.length, 4)

    const byId = new Map(responses.map(fr => [fr.id, fr]))

    const docFr = byId.get(normalizedDocCallId)
    assert.ok(docFr, 'normalized toolCallId must match registered slice strictly')
    assert.equal(docFr.id, normalizedDocCallId)
    assert.deepEqual(docFr.response.slice_media, { $ref: 'slice_gc1_report.pdf' })
    assert.deepEqual(docFr.parts, [{
      fileData: {
        fileUri: 'https://generativelanguage.googleapis.com/v1beta/files/gc1',
        mimeType: 'application/pdf',
        displayName: 'slice_gc1_report.pdf',
      },
      documentMetadata: { startPage: 1, endPage: 3, contentLayers: ['PAGE_TEXT', 'PAGE_IMAGE'] },
      mediaResolution: { level: 'MEDIA_RESOLUTION_ULTRA_HIGH' },
    }])

    const sheetFr = byId.get('gc-sheet-2')
    assert.deepEqual(sheetFr.response.slice_media, { $ref: 'slice_gc2_budget.xlsx' })
    assert.deepEqual(sheetFr.parts, [{
      fileData: {
        fileUri: 'https://generativelanguage.googleapis.com/v1beta/files/gc2',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        displayName: 'slice_gc2_budget.xlsx',
      },
      spreadsheetMetadata: { sheetIndex: 1, visibleCells: 'B2:F10', contentLayers: ['DATA', 'FORMULAS', 'VISUAL'] },
      mediaResolution: { level: 'MEDIA_RESOLUTION_HIGH' },
    }])

    const vidFr = byId.get('gc-vid-3')
    assert.deepEqual(vidFr.response.slice_media, { $ref: 'slice_gc3_demo.mp4' })
    assert.deepEqual(vidFr.parts, [{
      fileData: {
        fileUri: 'https://generativelanguage.googleapis.com/v1beta/files/gc3',
        mimeType: 'video/mp4',
        displayName: 'slice_gc3_demo.mp4',
      },
      videoMetadata: { startOffset: '5s', endOffset: '20s', fps: 1.5, contentLayers: ['FRAMES', 'AUDIO', 'TRANSCRIPT'] },
      mediaResolution: { level: 'MEDIA_RESOLUTION_MEDIUM' },
    }])

    const audFr = byId.get('gc-aud-4')
    assert.deepEqual(audFr.response.slice_media, { $ref: 'slice_gc4_memo.wav' })
    assert.deepEqual(audFr.parts, [{
      fileData: {
        fileUri: 'https://generativelanguage.googleapis.com/v1beta/files/gc4',
        mimeType: 'audio/wav',
        displayName: 'slice_gc4_memo.wav',
      },
      audioMetadata: { startOffset: '0s', endOffset: '12s' },
    }])
  } finally {
    hub.close()
  }
})

test('Dual-protocol active slice window: >6 slices keeps newest 6 active and offloads older slices to notice', async () => {
  const nowMs = 1_700_000_000_000
  const expMs = nowMs + 48 * 3600_000
  const hub = createFileSliceHub({ now: () => nowMs })
  try {
    const calls = Array.from({ length: 8 }, (_, idx) => {
      const n = idx + 1
      const callId = `win-${n}`
      hub.registerSlice({
        sessionId: SESSION_ID,
        callId,
        route: 'google-generative-ai',
        principalHash: PRINCIPAL_HASH,
        uri: `https://generativelanguage.googleapis.com/v1beta/files/win${n}`,
        name: `files/win${n}`,
        mimeType: 'application/pdf',
        category: 'document',
        displayName: `slice_win_${n}.pdf`,
        slice: { startPage: n, endPage: n },
        expirationTimeMs: expMs,
      })
      return { callId }
    })

    // 1) Interactions
    const iaAdapter = createArgonAdapter(makeCtx(), makeConfig({ googleProtocol: 'interactions' }), undefined, undefined, undefined, undefined, undefined, undefined, hub)
    const iaHistory = buildInteractionsHistory({ calls })
    const iaOut = await collect(iaAdapter.stream({
      provider: PROVIDER,
      model: GOOGLE_API_NEON_MODEL,
      maxTokens: 512,
      sessionId: SESSION_ID,
      messages: iaHistory,
      tools: SLICE_TOOLS,
    }))
    assert.equal(iaOut.at(-1).reason.kind, 'stop')
    const iaResults = new Map(wire.at(-1).body.input.filter(s => s.type === 'function_result').map(s => [s.call_id, s]))
    for (let n = 1; n <= 8; n++) {
      const step = iaResults.get(`win-${n}`)
      const hasDoc = step.result.some(b => b.type === 'document')
      if (n <= 2) {
        assert.equal(hasDoc, false, `Interactions win-${n} should be offloaded`)
        assert.ok(step.result.some(b => b.type === 'text' && b.text.includes('offloaded from the active window')), `Interactions win-${n} must emit exact offload notice`)
        assert.equal(JSON.stringify(step).includes(`/files/win${n}`), false)
      } else {
        assert.equal(hasDoc, true, `Interactions win-${n} should stay active`)
      }
    }

    // Truncated Interactions history containing ONLY old offloaded slices must NOT resurrect them.
    const iaTruncOut = await collect(iaAdapter.stream({
      provider: PROVIDER,
      model: GOOGLE_API_NEON_MODEL,
      maxTokens: 512,
      sessionId: SESSION_ID,
      messages: buildInteractionsHistory({ calls: [{ callId: 'win-1' }, { callId: 'win-2' }] }),
      tools: SLICE_TOOLS,
    }))
    assert.equal(iaTruncOut.at(-1).reason.kind, 'stop')
    for (const id of ['win-1', 'win-2']) {
      const step = wire.at(-1).body.input.find(s => s.type === 'function_result' && s.call_id === id)
      assert.equal(step.result.some(b => b.type === 'document'), false, `truncated history must not resurrect ${id}`)
      assert.ok(step.result.some(b => b.type === 'text' && b.text.includes('offloaded from the active window')))
    }

    // 2) GenerateContent
    const gcAdapter = createArgonAdapter(makeCtx(), makeConfig({ googleProtocol: 'generate-content' }), undefined, undefined, undefined, undefined, undefined, undefined, hub)
    const gcHistory = await buildGenerateContentHistory(gcAdapter, GOOGLE_API_NEON_MODEL, calls)
    const gcOut = await collect(gcAdapter.stream({
      provider: PROVIDER,
      model: GOOGLE_API_NEON_MODEL,
      maxTokens: 512,
      sessionId: SESSION_ID,
      messages: gcHistory,
      tools: SLICE_TOOLS,
    }))
    assert.equal(gcOut.at(-1).reason.kind, 'stop')
    const gcResults = new Map(findGcFunctionResponses(wire.at(-1).body).map(fr => [fr.id, fr]))
    for (let n = 1; n <= 8; n++) {
      const fr = gcResults.get(`win-${n}`)
      if (n <= 2) {
        assert.equal(fr.parts, undefined, `GC win-${n} should be offloaded`)
        assert.equal(typeof fr.response.slice_notice, 'string')
        assert.ok(fr.response.slice_notice.includes('offloaded from the active window'), `GC win-${n} must emit exact offload notice`)
        assert.equal(JSON.stringify(fr).includes(`/files/win${n}`), false)
      } else {
        assert.equal(fr.parts?.length, 1, `GC win-${n} should stay active`)
        assert.equal(fr.response.slice_media?.$ref, `slice_win_${n}.pdf`)
      }
    }

    // Truncated GenerateContent history containing ONLY old offloaded slices must NOT resurrect them.
    const gcTruncHistory = await buildGenerateContentHistory(gcAdapter, GOOGLE_API_NEON_MODEL, [{ callId: 'win-1' }, { callId: 'win-2' }])
    const gcTruncOut = await collect(gcAdapter.stream({
      provider: PROVIDER,
      model: GOOGLE_API_NEON_MODEL,
      maxTokens: 512,
      sessionId: SESSION_ID,
      messages: gcTruncHistory,
      tools: SLICE_TOOLS,
    }))
    assert.equal(gcTruncOut.at(-1).reason.kind, 'stop')
    for (const id of ['win-1', 'win-2']) {
      const fr = findGcFunctionResponses(wire.at(-1).body).find(x => x.id === id)
      assert.equal(fr.parts, undefined, `truncated GC history must not resurrect ${id}`)
      assert.ok(fr.response.slice_notice?.includes('offloaded from the active window'))
    }
  } finally {
    hub.close()
  }
})

test('Dual-protocol 48h expiry: expired slices gracefully degrade to notice without injecting URIs', async () => {
  let currentNow = 1_700_000_000_000
  const expMs = currentNow + 48 * 3600_000
  const hub = createFileSliceHub({ now: () => currentNow })
  try {
    hub.registerSlice({
      sessionId: SESSION_ID,
      callId: 'exp-1',
      route: 'google-generative-ai',
      principalHash: PRINCIPAL_HASH,
      uri: 'https://generativelanguage.googleapis.com/v1beta/files/exp1',
      name: 'files/exp1',
      mimeType: 'application/pdf',
      category: 'document',
      displayName: 'slice_exp1.pdf',
      slice: { startPage: 1, endPage: 1 },
      expirationTimeMs: expMs,
    })

    // Advance past 48h expiration window
    currentNow = expMs + 1000

    const iaAdapter = createArgonAdapter(makeCtx(), makeConfig({ googleProtocol: 'interactions' }), undefined, undefined, undefined, undefined, undefined, undefined, hub)
    const iaOut = await collect(iaAdapter.stream({
      provider: PROVIDER,
      model: GOOGLE_API_NEON_MODEL,
      maxTokens: 512,
      sessionId: SESSION_ID,
      messages: buildInteractionsHistory({ calls: [{ callId: 'exp-1' }] }),
      tools: SLICE_TOOLS,
    }))
    assert.equal(iaOut.at(-1).reason.kind, 'stop')
    const iaStep = wire.at(-1).body.input.find(s => s.type === 'function_result' && s.call_id === 'exp-1')
    assert.equal(iaStep.result.some(b => b.type === 'document'), false)
    assert.equal(JSON.stringify(iaStep).includes('/files/exp1'), false)
    assert.equal(iaStep.result.length, 2)
    assert.equal(iaStep.result[1].type, 'text')
    assert.match(iaStep.result[1].text, /expir/i)

    const gcAdapter = createArgonAdapter(makeCtx(), makeConfig({ googleProtocol: 'generate-content' }), undefined, undefined, undefined, undefined, undefined, undefined, hub)
    const gcHistory = await buildGenerateContentHistory(gcAdapter, GOOGLE_API_NEON_MODEL, [{ callId: 'exp-1' }])
    const gcOut = await collect(gcAdapter.stream({
      provider: PROVIDER,
      model: GOOGLE_API_NEON_MODEL,
      maxTokens: 512,
      sessionId: SESSION_ID,
      messages: gcHistory,
      tools: SLICE_TOOLS,
    }))
    assert.equal(gcOut.at(-1).reason.kind, 'stop')
    const gcFr = findGcFunctionResponses(wire.at(-1).body).find(fr => fr.id === 'exp-1')
    assert.equal(gcFr.parts, undefined)
    assert.equal(JSON.stringify(gcFr).includes('/files/exp1'), false)
    assert.match(gcFr.response.slice_notice, /expir/i)
  } finally {
    hub.close()
  }
})

test('Dual-protocol consent revocation: allowGeminiFilesApi=false immediately stops URI injection', async () => {
  const nowMs = 1_700_000_000_000
  const hub = createFileSliceHub({ now: () => nowMs })
  try {
    hub.registerSlice({
      sessionId: SESSION_ID,
      callId: 'rev-1',
      route: 'google-generative-ai',
      principalHash: PRINCIPAL_HASH,
      uri: 'https://generativelanguage.googleapis.com/v1beta/files/rev1',
      name: 'files/rev1',
      mimeType: 'application/pdf',
      category: 'document',
      displayName: 'slice_rev1.pdf',
      slice: { startPage: 1, endPage: 2 },
      expirationTimeMs: nowMs + 48 * 3600_000,
    })

    const liveCfg = makeConfig({ googleProtocol: 'interactions', allowGeminiFilesApi: false })
    const iaAdapter = createArgonAdapter(makeCtx(), () => liveCfg, undefined, undefined, undefined, undefined, undefined, undefined, hub)
    const iaOut = await collect(iaAdapter.stream({
      provider: PROVIDER,
      model: GOOGLE_API_NEON_MODEL,
      maxTokens: 512,
      sessionId: SESSION_ID,
      messages: buildInteractionsHistory({ calls: [{ callId: 'rev-1' }] }),
      tools: SLICE_TOOLS,
    }))
    assert.equal(iaOut.at(-1).reason.kind, 'stop')
    const iaStep = wire.at(-1).body.input.find(s => s.type === 'function_result' && s.call_id === 'rev-1')
    assert.equal(iaStep.result.some(b => b.type === 'document'), false)
    assert.equal(JSON.stringify(iaStep).includes('/files/rev1'), false)
    assert.equal(iaStep.result.length, 2)
    assert.equal(iaStep.result[1].type, 'text')

    liveCfg.googleProtocol = 'generate-content'
    const gcAdapter = createArgonAdapter(makeCtx(), () => liveCfg, undefined, undefined, undefined, undefined, undefined, undefined, hub)
    const gcHistory = await buildGenerateContentHistory(gcAdapter, GOOGLE_API_NEON_MODEL, [{ callId: 'rev-1' }])
    const gcOut = await collect(gcAdapter.stream({
      provider: PROVIDER,
      model: GOOGLE_API_NEON_MODEL,
      maxTokens: 512,
      sessionId: SESSION_ID,
      messages: gcHistory,
      tools: SLICE_TOOLS,
    }))
    assert.equal(gcOut.at(-1).reason.kind, 'stop')
    const gcFr = findGcFunctionResponses(wire.at(-1).body).find(fr => fr.id === 'rev-1')
    assert.equal(gcFr.parts, undefined)
    assert.equal(JSON.stringify(gcFr).includes('/files/rev1'), false)
    assert.equal(typeof gcFr.response.slice_notice, 'string')
    assert.ok(gcFr.response.slice_notice.length > 0)
  } finally {
    hub.close()
  }
})

test('Cross-route and credential isolation: Vertex AI and mismatched principalHash never leak Gemini API file URIs', async () => {
  const nowMs = 1_700_000_000_000
  const hub = createFileSliceHub({ now: () => nowMs })
  try {
    hub.registerSlice({
      sessionId: SESSION_ID,
      callId: 'iso-1',
      route: 'google-generative-ai',
      principalHash: PRINCIPAL_HASH,
      uri: 'https://generativelanguage.googleapis.com/v1beta/files/secretiso1',
      name: 'files/secretiso1',
      mimeType: 'application/pdf',
      category: 'document',
      displayName: 'slice_secret.pdf',
      slice: { startPage: 1, endPage: 1 },
      expirationTimeMs: nowMs + 48 * 3600_000,
    })

    // 1) Vertex AI Interactions
    const vertexIaAdapter = createArgonAdapter(makeCtx(), makeConfig({ vertexProtocol: 'interactions' }), undefined, undefined, undefined, undefined, undefined, undefined, hub)
    const vertexIaOut = await collect(vertexIaAdapter.stream({
      provider: PROVIDER,
      model: NEON_MODEL,
      maxTokens: 512,
      sessionId: SESSION_ID,
      messages: buildInteractionsHistory({ model: NEON_MODEL, route: 'google-vertex', calls: [{ callId: 'iso-1' }] }),
      tools: SLICE_TOOLS,
    }))
    assert.equal(vertexIaOut.at(-1).reason.kind, 'stop')
    assert.equal(JSON.stringify(wire.at(-1).body).includes('secretiso1'), false)

    // 2) Vertex AI GenerateContent
    const vertexGcAdapter = createArgonAdapter(makeCtx(), makeConfig({ vertexProtocol: 'generate-content' }), undefined, undefined, undefined, undefined, undefined, undefined, hub)
    const vertexGcHistory = await buildGenerateContentHistory(vertexGcAdapter, NEON_MODEL, [{ callId: 'iso-1' }])
    const vertexGcOut = await collect(vertexGcAdapter.stream({
      provider: PROVIDER,
      model: NEON_MODEL,
      maxTokens: 512,
      sessionId: SESSION_ID,
      messages: vertexGcHistory,
      tools: SLICE_TOOLS,
    }))
    assert.equal(vertexGcOut.at(-1).reason.kind, 'stop')
    assert.equal(JSON.stringify(wire.at(-1).body).includes('secretiso1'), false)
    const vertexFr = findGcFunctionResponses(wire.at(-1).body).find(fr => fr.id === 'iso-1')
    assert.equal(vertexFr?.parts, undefined)
    assert.equal(vertexFr?.response?.slice_media, undefined)

    // 3) Gemini API with DIFFERENT API Key (principalHash mismatch) - Interactions
    const otherIaAdapter = createArgonAdapter(makeCtx(OTHER_API_KEY), makeConfig({ googleProtocol: 'interactions' }), undefined, undefined, undefined, undefined, undefined, undefined, hub)
    const otherIaOut = await collect(otherIaAdapter.stream({
      provider: PROVIDER,
      model: GOOGLE_API_NEON_MODEL,
      maxTokens: 512,
      sessionId: SESSION_ID,
      messages: buildInteractionsHistory({ calls: [{ callId: 'iso-1' }] }),
      tools: SLICE_TOOLS,
    }))
    assert.equal(otherIaOut.at(-1).reason.kind, 'stop')
    assert.equal(JSON.stringify(wire.at(-1).body).includes('secretiso1'), false)

    // 4) Gemini API with DIFFERENT API Key (principalHash mismatch) - GenerateContent
    const otherGcAdapter = createArgonAdapter(makeCtx(OTHER_API_KEY), makeConfig({ googleProtocol: 'generate-content' }), undefined, undefined, undefined, undefined, undefined, undefined, hub)
    const otherGcHistory = await buildGenerateContentHistory(otherGcAdapter, GOOGLE_API_NEON_MODEL, [{ callId: 'iso-1' }])
    const otherGcOut = await collect(otherGcAdapter.stream({
      provider: PROVIDER,
      model: GOOGLE_API_NEON_MODEL,
      maxTokens: 512,
      sessionId: SESSION_ID,
      messages: otherGcHistory,
      tools: SLICE_TOOLS,
    }))
    assert.equal(otherGcOut.at(-1).reason.kind, 'stop')
    assert.equal(JSON.stringify(wire.at(-1).body).includes('secretiso1'), false)
    const otherFr = findGcFunctionResponses(wire.at(-1).body).find(fr => fr.id === 'iso-1')
    assert.equal(otherFr?.parts, undefined)
    assert.equal(otherFr?.response?.slice_media, undefined)
  } finally {
    hub.close()
  }
})

test('Cross-model history degradation: neon-google -> carbon-google degrades slice tool turns to text without leaking native URIs', async () => {
  const nowMs = 1_700_000_000_000
  const hub = createFileSliceHub({ now: () => nowMs })
  try {
    hub.registerSlice({
      sessionId: SESSION_ID,
      callId: 'xm-1',
      route: 'google-generative-ai',
      principalHash: PRINCIPAL_HASH,
      uri: 'https://generativelanguage.googleapis.com/v1beta/files/xm1',
      name: 'files/xm1',
      mimeType: 'application/pdf',
      category: 'document',
      displayName: 'slice_xm1.pdf',
      slice: { startPage: 1, endPage: 1 },
      expirationTimeMs: nowMs + 48 * 3600_000,
    })

    // 1) Interactions: neon-google history replayed on carbon-google
    const iaAdapter = createArgonAdapter(makeCtx(), makeConfig({ googleProtocol: 'interactions' }), undefined, undefined, undefined, undefined, undefined, undefined, hub)
    const iaOut = await collect(iaAdapter.stream({
      provider: PROVIDER,
      model: GOOGLE_API_CARBON_MODEL,
      maxTokens: 512,
      sessionId: SESSION_ID,
      messages: buildInteractionsHistory({ model: GOOGLE_API_NEON_MODEL, route: 'google-generative-ai', calls: [{ callId: 'xm-1' }] }),
      tools: SLICE_TOOLS,
    }))
    assert.equal(iaOut.at(-1).reason.kind, 'stop')
    const iaBody = wire.at(-1).body
    assert.equal(iaBody.input.some(s => s.type === 'function_result'), false)
    assert.equal(JSON.stringify(iaBody).includes('/files/xm1'), false)
    assert.ok(JSON.stringify(iaBody).includes('[Previously executed tool argon_slice_file; call xm-1]'))

    // 2) GenerateContent: neon-google history replayed on carbon-google
    const gcAdapter = createArgonAdapter(makeCtx(), makeConfig({ googleProtocol: 'generate-content' }), undefined, undefined, undefined, undefined, undefined, undefined, hub)
    const gcHistory = await buildGenerateContentHistory(gcAdapter, GOOGLE_API_NEON_MODEL, [{ callId: 'xm-1' }])
    const gcOut = await collect(gcAdapter.stream({
      provider: PROVIDER,
      model: GOOGLE_API_CARBON_MODEL,
      maxTokens: 512,
      sessionId: SESSION_ID,
      messages: gcHistory,
      tools: SLICE_TOOLS,
    }))
    assert.equal(gcOut.at(-1).reason.kind, 'stop')
    const gcBody = wire.at(-1).body
    assert.equal(findGcFunctionResponses(gcBody).length, 0)
    assert.equal(JSON.stringify(gcBody).includes('/files/xm1'), false)
    assert.ok(JSON.stringify(gcBody).includes('[Previously executed tool argon_slice_file; call xm-1]'))
  } finally {
    hub.close()
  }
})

test('Live consent revocation on the SAME prepared adapter instance immediately stops URI injection in both protocols', async () => {
  const nowMs = 1_700_000_000_000
  const hub = createFileSliceHub({ now: () => nowMs })
  try {
    const rec = hub.registerSlice({
      sessionId: SESSION_ID,
      callId: 'live-rev-1',
      route: 'google-generative-ai',
      principalHash: PRINCIPAL_HASH,
      uri: 'https://generativelanguage.googleapis.com/v1beta/files/liverev1',
      name: 'files/liverev1',
      mimeType: 'application/pdf',
      category: 'document',
      displayName: 'slice_liverev1.pdf',
      slice: { startPage: 1, endPage: 2 },
      expirationTimeMs: nowMs + 48 * 3600_000,
    })

    // 1) Interactions: prepareCall while enabled -> revoke -> stream on same prepared handle
    const liveCfg = makeConfig({ googleProtocol: 'interactions', allowGeminiFilesApi: true })
    const adapter = createArgonAdapter(makeCtx(), () => liveCfg, undefined, undefined, undefined, undefined, undefined, undefined, hub)
    const preparedIa = await adapter.prepareCall(PROVIDER, GOOGLE_API_NEON_MODEL)
    liveCfg.allowGeminiFilesApi = false
    const iaOut = await collect(preparedIa.stream({
      provider: PROVIDER,
      model: GOOGLE_API_NEON_MODEL,
      maxTokens: 512,
      sessionId: SESSION_ID,
      messages: buildInteractionsHistory({ calls: [{ callId: 'live-rev-1', result: { ok: true, sliceId: rec.sliceId } }] }),
      tools: SLICE_TOOLS,
    }))
    assert.equal(iaOut.at(-1).reason.kind, 'stop')
    const iaStep = wire.at(-1).body.input.find(s => s.type === 'function_result' && s.call_id === 'live-rev-1')
    assert.equal(iaStep.result.some(b => b.type === 'document'), false)
    assert.equal(JSON.stringify(iaStep).includes('/files/liverev1'), false)
    assert.equal(iaStep.result.length, 2)
    assert.equal(iaStep.result[1].type, 'text')

    // 2) GenerateContent: prepareCall while enabled -> revoke before stream -> ZERO fileData/uri on wire
    liveCfg.googleProtocol = 'generate-content'
    liveCfg.allowGeminiFilesApi = true
    const gcHistory = await buildGenerateContentHistory(adapter, GOOGLE_API_NEON_MODEL, [{ callId: 'live-rev-1', result: { ok: true, sliceId: rec.sliceId } }])
    const preparedGc = await adapter.prepareCall(PROVIDER, GOOGLE_API_NEON_MODEL)
    liveCfg.allowGeminiFilesApi = false
    const gcOut = await collect(preparedGc.stream({
      provider: PROVIDER,
      model: GOOGLE_API_NEON_MODEL,
      maxTokens: 512,
      sessionId: SESSION_ID,
      messages: gcHistory,
      tools: SLICE_TOOLS,
    }))
    assert.equal(gcOut.at(-1).reason.kind, 'stop')
    const gcFr = findGcFunctionResponses(wire.at(-1).body).find(fr => fr.id === 'live-rev-1')
    assert.equal(gcFr.parts, undefined)
    assert.equal(JSON.stringify(gcFr).includes('/files/liverev1'), false)
    assert.equal(typeof gcFr.response.slice_notice, 'string')
    assert.ok(gcFr.response.slice_notice.length > 0)
  } finally {
    hub.close()
  }
})

test('Colliding 64-char normalized toolCallIds refuse cross-binding without sliceId and bind 1:1 with sliceId', async () => {
  const nowMs = 1_700_000_000_000
  const expMs = nowMs + 48 * 3600_000
  const hub = createFileSliceHub({ now: () => nowMs })
  try {
    const prefix = 'a'.repeat(64)
    const rawA = prefix + '-alpha'
    const rawB = prefix + '-beta'
    assert.equal(normalizePiAiToolCallId(rawA), prefix)
    assert.equal(normalizePiAiToolCallId(rawB), prefix)

    const recA = hub.registerSlice({
      sessionId: SESSION_ID,
      callId: rawA,
      route: 'google-generative-ai',
      principalHash: PRINCIPAL_HASH,
      uri: 'https://generativelanguage.googleapis.com/v1beta/files/colA',
      name: 'files/colA',
      mimeType: 'application/pdf',
      category: 'document',
      displayName: 'slice_colA.pdf',
      slice: { startPage: 1, endPage: 1 },
      expirationTimeMs: expMs,
    })
    const recB = hub.registerSlice({
      sessionId: SESSION_ID,
      callId: rawB,
      route: 'google-generative-ai',
      principalHash: PRINCIPAL_HASH,
      uri: 'https://generativelanguage.googleapis.com/v1beta/files/colB',
      name: 'files/colB',
      mimeType: 'application/pdf',
      category: 'document',
      displayName: 'slice_colB.pdf',
      slice: { startPage: 2, endPage: 2 },
      expirationTimeMs: expMs,
    })

    const adapter = createArgonAdapter(makeCtx(), makeConfig({ googleProtocol: 'generate-content' }), undefined, undefined, undefined, undefined, undefined, undefined, hub)

    // Helper to build a two-turn GenerateContent history where both turns carry the same colliding 64-char normalized ID.
    const buildTwoTurnCollidingGcHistory = async (resultA, resultB) => {
      const turn1 = await buildGenerateContentHistory(adapter, GOOGLE_API_NEON_MODEL, [{ callId: prefix, result: resultA }])
      const turn2 = await buildGenerateContentHistory(adapter, GOOGLE_API_NEON_MODEL, [{ callId: prefix, result: resultB }])
      return [...turn1, ...turn2]
    }

    // Without sliceId: colliding 64-char normalized IDs on wire refuse injection completely (no cross-binding).
    const ambiguousHistory = await buildTwoTurnCollidingGcHistory({ ok: true }, { ok: true })
    const ambOut = await collect(adapter.stream({
      provider: PROVIDER,
      model: GOOGLE_API_NEON_MODEL,
      maxTokens: 512,
      sessionId: SESSION_ID,
      messages: ambiguousHistory,
      tools: SLICE_TOOLS,
    }))
    assert.equal(ambOut.at(-1).reason.kind, 'stop')
    const ambResponses = findGcFunctionResponses(wire.at(-1).body)
    assert.equal(ambResponses.length, 2)
    assert.equal(ambResponses[0].id, prefix)
    assert.equal(ambResponses[1].id, prefix)
    assert.equal(ambResponses[0].parts, undefined)
    assert.equal(ambResponses[1].parts, undefined)
    assert.equal(JSON.stringify(ambResponses).includes('/files/col'), false)

    // With sliceId in tool output JSON: each colliding normalized call binds 1:1 to its exact slice.
    const exactHistory = await buildTwoTurnCollidingGcHistory(
      { ok: true, sliceId: recA.sliceId },
      { ok: true, sliceId: recB.sliceId },
    )
    const exactOut = await collect(adapter.stream({
      provider: PROVIDER,
      model: GOOGLE_API_NEON_MODEL,
      maxTokens: 512,
      sessionId: SESSION_ID,
      messages: exactHistory,
      tools: SLICE_TOOLS,
    }))
    assert.equal(exactOut.at(-1).reason.kind, 'stop')
    const exactResponses = findGcFunctionResponses(wire.at(-1).body)
    assert.equal(exactResponses.length, 2)
    assert.equal(exactResponses[0].id, prefix)
    assert.equal(exactResponses[1].id, prefix)
    assert.equal(exactResponses[0].parts[0].fileData.fileUri, 'https://generativelanguage.googleapis.com/v1beta/files/colA')
    assert.equal(exactResponses[1].parts[0].fileData.fileUri, 'https://generativelanguage.googleapis.com/v1beta/files/colB')
  } finally {
    hub.close()
  }
})

test('Failed { ok: false } tool output never receives an active slice in Interactions or GenerateContent', async () => {
  const nowMs = 1_700_000_000_000
  const hub = createFileSliceHub({ now: () => nowMs })
  try {
    hub.registerSlice({
      sessionId: SESSION_ID,
      callId: 'err-reuse-1',
      route: 'google-generative-ai',
      principalHash: PRINCIPAL_HASH,
      uri: 'https://generativelanguage.googleapis.com/v1beta/files/err1',
      name: 'files/err1',
      mimeType: 'application/pdf',
      category: 'document',
      displayName: 'slice_err1.pdf',
      slice: { startPage: 1, endPage: 1 },
      expirationTimeMs: nowMs + 48 * 3600_000,
    })

    const failedResult = { ok: false, code: 'ARGON_SLICE_INVALID', error: 'invalid slice' }

    const iaAdapter = createArgonAdapter(makeCtx(), makeConfig({ googleProtocol: 'interactions' }), undefined, undefined, undefined, undefined, undefined, undefined, hub)
    const iaOut = await collect(iaAdapter.stream({
      provider: PROVIDER,
      model: GOOGLE_API_NEON_MODEL,
      maxTokens: 512,
      sessionId: SESSION_ID,
      messages: buildInteractionsHistory({ calls: [{ callId: 'err-reuse-1', result: failedResult }] }),
      tools: SLICE_TOOLS,
    }))
    assert.equal(iaOut.at(-1).reason.kind, 'stop')
    const iaStep = wire.at(-1).body.input.find(s => s.type === 'function_result' && s.call_id === 'err-reuse-1')
    assert.equal(iaStep.result.length, 1)
    assert.equal(JSON.stringify(iaStep).includes('/files/err1'), false)

    const gcAdapter = createArgonAdapter(makeCtx(), makeConfig({ googleProtocol: 'generate-content' }), undefined, undefined, undefined, undefined, undefined, undefined, hub)
    const gcHistory = await buildGenerateContentHistory(gcAdapter, GOOGLE_API_NEON_MODEL, [{ callId: 'err-reuse-1', result: failedResult }])
    const gcOut = await collect(gcAdapter.stream({
      provider: PROVIDER,
      model: GOOGLE_API_NEON_MODEL,
      maxTokens: 512,
      sessionId: SESSION_ID,
      messages: gcHistory,
      tools: SLICE_TOOLS,
    }))
    assert.equal(gcOut.at(-1).reason.kind, 'stop')
    const gcFr = findGcFunctionResponses(wire.at(-1).body).find(fr => fr.id === 'err-reuse-1')
    assert.equal(gcFr.parts, undefined)
    assert.equal(gcFr.response.slice_media, undefined)
    assert.equal(gcFr.response.slice_notice, undefined)
    assert.equal(JSON.stringify(gcFr).includes('/files/err1'), false)
  } finally {
    hub.close()
  }
})

test('Explicit /v1/interactions endpoint injects zero file slice blocks', async () => {
  const nowMs = 1_700_000_000_000
  const hub = createFileSliceHub({ now: () => nowMs })
  try {
    const gwBase = 'https://gateway-v1.example.test'
    hub.registerSlice({
      sessionId: SESSION_ID,
      callId: 'v1-gate-1',
      route: 'google-generative-ai',
      principalHash: PRINCIPAL_HASH,
      endpointBase: gwBase,
      uri: `${gwBase}/v1beta/files/v1gate`,
      name: 'files/v1gate',
      mimeType: 'application/pdf',
      category: 'document',
      displayName: 'slice_v1gate.pdf',
      slice: { startPage: 1, endPage: 1 },
      expirationTimeMs: nowMs + 48 * 3600_000,
    })

    const cfg = makeConfig({
      googleProtocol: 'interactions',
      routes: {
        ...makeConfig().routes,
        googleBaseUrl: `${gwBase}/v1/interactions`,
      },
    })
    const adapter = createArgonAdapter(makeCtx(), cfg, undefined, undefined, undefined, undefined, undefined, undefined, hub)
    const out = await collect(adapter.stream({
      provider: PROVIDER,
      model: GOOGLE_API_NEON_MODEL,
      maxTokens: 512,
      sessionId: SESSION_ID,
      messages: buildInteractionsHistory({ calls: [{ callId: 'v1-gate-1' }] }),
      tools: SLICE_TOOLS,
    }))
    assert.equal(out.at(-1).reason.kind, 'stop')
    assert.ok(wire.at(-1).url.endsWith('/v1/interactions'))
    const step = wire.at(-1).body.input.find(s => s.type === 'function_result' && s.call_id === 'v1-gate-1')
    assert.equal(step.result.length, 1)
    assert.equal(JSON.stringify(step).includes('/files/v1gate'), false)
  } finally {
    hub.close()
  }
})

test('Cross-gateway endpointBase isolation: switching googleBaseUrl never leaks Gateway A URI onto Gateway B', async () => {
  const nowMs = 1_700_000_000_000
  const hub = createFileSliceHub({ now: () => nowMs })
  try {
    const gwA = 'https://gw-a.example.test'
    const gwB = 'https://gw-b.example.test'
    hub.registerSlice({
      sessionId: SESSION_ID,
      callId: 'gw-iso-1',
      route: 'google-generative-ai',
      principalHash: PRINCIPAL_HASH,
      endpointBase: gwA,
      uri: `${gwA}/v1beta/files/gwa1`,
      name: 'files/gwa1',
      mimeType: 'application/pdf',
      category: 'document',
      displayName: 'slice_gwa1.pdf',
      slice: { startPage: 1, endPage: 1 },
      expirationTimeMs: nowMs + 48 * 3600_000,
    })

    const gwBCfg = protocol => makeConfig({
      googleProtocol: protocol,
      routes: { ...makeConfig().routes, googleBaseUrl: `${gwB}/v1beta` },
    })

    // 1) Interactions on Gateway B
    const iaAdapter = createArgonAdapter(makeCtx(), gwBCfg('interactions'), undefined, undefined, undefined, undefined, undefined, undefined, hub)
    const iaOut = await collect(iaAdapter.stream({
      provider: PROVIDER,
      model: GOOGLE_API_NEON_MODEL,
      maxTokens: 512,
      sessionId: SESSION_ID,
      messages: buildInteractionsHistory({ calls: [{ callId: 'gw-iso-1' }] }),
      tools: SLICE_TOOLS,
    }))
    assert.equal(iaOut.at(-1).reason.kind, 'stop')
    assert.equal(JSON.stringify(wire.at(-1).body).includes('gwa1'), false)

    // 2) GenerateContent on Gateway B
    const gcAdapter = createArgonAdapter(makeCtx(), gwBCfg('generate-content'), undefined, undefined, undefined, undefined, undefined, undefined, hub)
    const gcHistory = await buildGenerateContentHistory(gcAdapter, GOOGLE_API_NEON_MODEL, [{ callId: 'gw-iso-1' }])
    const gcOut = await collect(gcAdapter.stream({
      provider: PROVIDER,
      model: GOOGLE_API_NEON_MODEL,
      maxTokens: 512,
      sessionId: SESSION_ID,
      messages: gcHistory,
      tools: SLICE_TOOLS,
    }))
    assert.equal(gcOut.at(-1).reason.kind, 'stop')
    assert.equal(JSON.stringify(wire.at(-1).body).includes('gwa1'), false)
    const gcFr = findGcFunctionResponses(wire.at(-1).body).find(fr => fr.id === 'gw-iso-1')
    assert.equal(gcFr.parts, undefined)
  } finally {
    hub.close()
  }
})

test('degradeToolSearchInputSteps strips argon_slice_file slices while preserving non-slice tool media blocks', () => {
  const body = {
    model: 'gemini-4-neon',
    tools: [{ type: 'tool_search' }, { type: 'function', name: SLICE_TOOL_NAME, defer_loading: true }, { type: 'function', name: 'other_media_tool', defer_loading: true }],
    generation_config: { tool_choice: 'validated' },
    input: [
      { type: 'user_input', content: [{ type: 'text', text: 'compare both' }] },
      { type: 'tool_search_call', id: 'ts1', arguments: { function_names: [SLICE_TOOL_NAME, 'other_media_tool'] } },
      { type: 'tool_search_result', call_id: 'ts1', result: [{ name: SLICE_TOOL_NAME }, { name: 'other_media_tool' }] },
      { type: 'function_call', id: 'c-slice', name: SLICE_TOOL_NAME, arguments: { path: '/tmp/a.pdf' } },
      { type: 'function_call', id: 'c-other', name: 'other_media_tool', arguments: { id: 'img-1' } },
      {
        type: 'function_result',
        call_id: 'c-slice',
        name: SLICE_TOOL_NAME,
        is_error: false,
        result: [
          { type: 'text', text: '{"ok":true}' },
          { type: 'document', uri: 'https://generativelanguage.googleapis.com/v1beta/files/stripme', mime_type: 'application/pdf', processing: { type: 'static', page_options: { start_page: 1, end_page: 1 } } },
        ],
      },
      {
        type: 'function_result',
        call_id: 'c-other',
        name: 'other_media_tool',
        is_error: false,
        result: [
          { type: 'text', text: 'preview ready' },
          { type: 'document', uri: 'https://example.test/legit.pdf', mime_type: 'application/pdf' },
          { type: 'image', data: 'QUJD', mime_type: 'image/png' },
        ],
      },
    ],
  }

  const downgraded = downgradeToolChoiceToAuto(body)
  const sliceUserInput = downgraded.input.find(s => s.type === 'user_input' && JSON.stringify(s).includes('c-slice'))
  const otherUserInput = downgraded.input.find(s => s.type === 'user_input' && JSON.stringify(s).includes('c-other'))

  assert.ok(sliceUserInput)
  assert.equal(JSON.stringify(sliceUserInput).includes('stripme'), false)
  assert.equal(JSON.stringify(sliceUserInput).includes('[File slice omitted after tool-search downgrade]'), true)

  assert.ok(otherUserInput)
  assert.equal(JSON.stringify(otherUserInput).includes('[File slice omitted after tool-search downgrade]'), false)
  assert.deepEqual(
    otherUserInput.content.find(b => b.type === 'document'),
    { type: 'document', uri: 'https://example.test/legit.pdf', mime_type: 'application/pdf' },
  )
  assert.deepEqual(
    otherUserInput.content.find(b => b.type === 'image'),
    { type: 'image', data: 'QUJD', mime_type: 'image/png' },
  )
})

test('degradeToolSearchInputSteps preserves FIFO per-occurrence tool identity when calls share a call_id', () => {
  const body = {
    model: 'gemini-4-neon',
    tools: [
      { type: 'tool_search' },
      { type: 'function', name: SLICE_TOOL_NAME, defer_loading: true },
      { type: 'function', name: 'other_media_tool', defer_loading: true },
    ],
    generation_config: { tool_choice: 'validated' },
    input: [
      { type: 'user_input', content: [{ type: 'text', text: 'shared id fifo' }] },
      { type: 'tool_search_call', id: 'ts-fifo', arguments: { function_names: [SLICE_TOOL_NAME, 'other_media_tool'] } },
      { type: 'tool_search_result', call_id: 'ts-fifo', result: [{ name: SLICE_TOOL_NAME }, { name: 'other_media_tool' }] },
      { type: 'function_call', id: 'dup-id', name: SLICE_TOOL_NAME, arguments: { path: '/tmp/a.pdf' } },
      { type: 'function_call', id: 'dup-id', name: 'other_media_tool', arguments: { id: 'preview-1' } },
      {
        type: 'function_result',
        call_id: 'dup-id',
        name: SLICE_TOOL_NAME,
        is_error: false,
        result: [
          { type: 'text', text: '{"ok":true}' },
          { type: 'document', uri: 'https://generativelanguage.googleapis.com/v1beta/files/fifoStrip', mime_type: 'application/pdf', processing: { type: 'static', page_options: { start_page: 1, end_page: 1 } } },
        ],
      },
      {
        type: 'function_result',
        call_id: 'dup-id',
        name: 'other_media_tool',
        is_error: false,
        result: [
          { type: 'text', text: 'non-slice preview' },
          { type: 'document', uri: 'https://example.test/fifo-keep.pdf', mime_type: 'application/pdf' },
        ],
      },
    ],
  }

  const downgraded = downgradeToolChoiceToAuto(body)
  const degradedToolResults = downgraded.input.filter(s => s.type === 'user_input' && JSON.stringify(s).includes('dup-id'))
  assert.equal(degradedToolResults.length, 2)

  // First occurrence (argon_slice_file) must strip its slice URI into placeholder text.
  assert.ok(JSON.stringify(degradedToolResults[0]).includes('[Previously executed tool argon_slice_file; call dup-id]'))
  assert.equal(JSON.stringify(degradedToolResults[0]).includes('fifoStrip'), false)
  assert.equal(JSON.stringify(degradedToolResults[0]).includes('[File slice omitted after tool-search downgrade]'), true)

  // Second occurrence (other_media_tool) must preserve its legitimate media block untouched.
  assert.ok(JSON.stringify(degradedToolResults[1]).includes('[Previously executed tool other_media_tool; call dup-id]'))
  assert.equal(JSON.stringify(degradedToolResults[1]).includes('[File slice omitted after tool-search downgrade]'), false)
  assert.deepEqual(
    degradedToolResults[1].content.find(b => b.type === 'document'),
    { type: 'document', uri: 'https://example.test/fifo-keep.pdf', mime_type: 'application/pdf' },
  )
})

test('GenerateContent prepared against Gateway A never pulls Gateway B slice when live googleBaseUrl switches before onPayload', async () => {
  const nowMs = 1_700_000_000_000
  const hub = createFileSliceHub({ now: () => nowMs })
  try {
    const gwA = 'https://gw-pin-a.example.test'
    const gwB = 'https://gw-pin-b.example.test'
    const recB = hub.registerSlice({
      sessionId: SESSION_ID,
      callId: 'pin-gw-1',
      route: 'google-generative-ai',
      principalHash: PRINCIPAL_HASH,
      endpointBase: gwB,
      uri: `${gwB}/v1beta/files/gwbOnly`,
      name: 'files/gwbOnly',
      mimeType: 'application/pdf',
      category: 'document',
      displayName: 'slice_gwb_only.pdf',
      slice: { startPage: 1, endPage: 1 },
      expirationTimeMs: nowMs + 48 * 3600_000,
    })

    const liveCfg = makeConfig({
      googleProtocol: 'generate-content',
      routes: { ...makeConfig().routes, googleBaseUrl: `${gwA}/v1beta` },
    })
    const adapter = createArgonAdapter(makeCtx(), () => liveCfg, undefined, undefined, undefined, undefined, undefined, undefined, hub)
    const gcHistory = await buildGenerateContentHistory(adapter, GOOGLE_API_NEON_MODEL, [{ callId: 'pin-gw-1', result: { ok: true, sliceId: recB.sliceId } }])

    // Prepare call while pinned to Gateway A, then mutate live config to Gateway B BEFORE streaming!
    const preparedA = await adapter.prepareCall(PROVIDER, GOOGLE_API_NEON_MODEL)
    liveCfg.routes = { ...liveCfg.routes, googleBaseUrl: `${gwB}/v1beta` }

    const out = await collect(preparedA.stream({
      provider: PROVIDER,
      model: GOOGLE_API_NEON_MODEL,
      maxTokens: 512,
      sessionId: SESSION_ID,
      messages: gcHistory,
      tools: SLICE_TOOLS,
    }))
    assert.equal(out.at(-1).reason.kind, 'stop')
    assert.ok(wire.at(-1).url.startsWith(`${gwA}/v1beta/`), 'prepared request must still target Gateway A')
    assert.equal(JSON.stringify(wire.at(-1).body).includes('gwbOnly'), false, 'Gateway A request must never pull Gateway B slice URI')
    const fr = findGcFunctionResponses(wire.at(-1).body).find(x => x.id === 'pin-gw-1')
    assert.equal(fr.parts, undefined)
  } finally {
    hub.close()
  }
})
