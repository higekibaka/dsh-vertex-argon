import assert from 'node:assert/strict'
import { test as nodeTest } from 'node:test'
import {
  createArgonAdapter,
  resolveConfigValues,
  supportsInteractionsToolRetrieval,
  TOOL_RETRIEVAL_MODES,
  PROVIDER,
  MODEL,
  GOOGLE_API_MODEL,
  CARBON_MODEL,
  GOOGLE_API_CARBON_MODEL,
  HYDROGEN_MODEL,
  GOOGLE_API_HYDROGEN_MODEL,
  NEON_MODEL,
  GOOGLE_API_NEON_MODEL,
} from '../adapter.js'
import {
  buildInteractionRequest,
  generateContentHistory,
  downgradeToolChoiceToAuto,
  CORE_RESIDENT_TOOLS,
} from '../interactions-input.js'
import { streamInteractions } from '../interactions.js'
import { shared } from '../runtime.js'

const { Context } = await shared('@deepseek-ai/cordis')
const { default: LlmRuntime, projectToolUpdates } = await shared('@deepseek-ai/dsh-llm')

const ctx = {
  get: k => k === 'launchEnvironment'
    ? { get: n => ['GOOGLE_API_KEY', 'GOOGLE_CLOUD_API_KEY'].includes(n) ? { value: 'fixture-key' } : undefined }
    : undefined,
}

const allRoutes = {
  hasVertex: true,
  hasGoogle: true,
  hasVertexArgon: true,
  hasGoogleArgon: true,
  hasVertexCarbon: true,
  hasGoogleCarbon: true,
  hasVertexHydrogen: true,
  hasGoogleHydrogen: true,
  hasVertexNeon: true,
  hasGoogleNeon: true,
}

const baseCfg = (extra = {}) => ({
  maxTokens: 65536,
  reasoning: 'medium',
  longDecode: true,
  googleProtocol: 'interactions',
  vertexProtocol: 'interactions',
  interactionsToolRetrieval: 'explicit',
  routes: allRoutes,
  ...extra,
})

const hostFetch = globalThis.fetch
const sse = events => new Response(events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join(''), {
  headers: { 'Content-Type': 'text/event-stream' },
})
const collect = async stream => {
  const out = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

const test = (name, fn) => nodeTest(name, async (...args) => {
  try { return await fn(...args) }
  finally { globalThis.fetch = hostFetch }
})

test('supportsInteractionsToolRetrieval enforces exact Google model, route, protocol, and mode allowlist', () => {
  assert.deepEqual([...TOOL_RETRIEVAL_MODES], ['off', 'explicit', 'auto'])

  // Allowed: Gemini API + Interactions v1beta + Argon/Carbon/Hydrogen/Neon + explicit/auto (including models/ prefix & upstream ID)
  for (const model of [
    GOOGLE_API_MODEL,
    GOOGLE_API_CARBON_MODEL,
    GOOGLE_API_HYDROGEN_MODEL,
    GOOGLE_API_NEON_MODEL,
    'models/gemini-4-argon-google',
    'models/gemini-4-carbon-google',
    'models/GEMINI-4-HYDROGEN-GOOGLE',
    'models/GEMINI-4-NEON-GOOGLE',
    'gemini-4-argon',
    'gemini-4-carbon',
    'gemini-4-hydrogen',
    'gemini-4-neon',
  ]) {
    for (const mode of ['explicit', 'auto']) {
      assert.equal(
        supportsInteractionsToolRetrieval({ model, route: 'google-generative-ai', protocol: 'interactions', mode }),
        true,
        `${model} (${mode}) should be supported`,
      )
      assert.equal(
        supportsInteractionsToolRetrieval({ model, route: 'google-generative-ai', protocol: 'interactions', mode, apiVersion: 'v1' }),
        false,
        `${model} (${mode}) must fall back on explicit /v1/interactions`,
      )
    }
    assert.equal(
      supportsInteractionsToolRetrieval({ model, route: 'google-generative-ai', protocol: 'interactions', mode: 'off' }),
      false,
    )
    assert.equal(
      supportsInteractionsToolRetrieval({ model, route: 'google-generative-ai', protocol: 'generate-content', mode: 'explicit' }),
      false,
    )
    assert.equal(
      supportsInteractionsToolRetrieval({ model, route: 'google-vertex', protocol: 'interactions', mode: 'auto' }),
      false,
    )
  }

  // Disallowed: Vertex AI on all four models, unknown models, invalid modes
  for (const model of [MODEL, CARBON_MODEL, HYDROGEN_MODEL, NEON_MODEL]) {
    for (const mode of ['off', 'explicit', 'auto']) {
      assert.equal(
        supportsInteractionsToolRetrieval({ model, route: 'google-vertex', protocol: 'interactions', mode }),
        false,
        `${model} on google-vertex (${mode}) must be unsupported`,
      )
    }
  }
  assert.equal(supportsInteractionsToolRetrieval({ model: GOOGLE_API_MODEL, route: 'google-generative-ai', protocol: 'interactions', mode: 'invalid' }), false)
  assert.equal(supportsInteractionsToolRetrieval({ model: GOOGLE_API_MODEL, route: 'google-generative-ai', protocol: undefined, mode: 'explicit' }), false)
  assert.equal(supportsInteractionsToolRetrieval({ model: 'gemini-4-unknown-google', route: 'google-generative-ai', protocol: 'interactions', mode: 'auto' }), false)
})

test('resolveConfigValues reads interactionsToolRetrieval with explicit default and rejects invalid enum values', () => {
  assert.equal(resolveConfigValues({}).interactionsToolRetrieval, 'explicit')
  assert.equal(resolveConfigValues({ interactionsToolRetrieval: 'off' }).interactionsToolRetrieval, 'off')
  assert.equal(resolveConfigValues({ interactionsToolRetrieval: 'explicit' }).interactionsToolRetrieval, 'explicit')
  assert.equal(resolveConfigValues({ interactionsToolRetrieval: 'auto' }).interactionsToolRetrieval, 'auto')
  assert.equal(resolveConfigValues({ interactionsToolRetrieval: { get: () => 'auto' } }).interactionsToolRetrieval, 'auto')
  assert.throws(() => resolveConfigValues({ interactionsToolRetrieval: 'unknown-mode' }), { code: 'INVALID_CONFIG' })
  assert.throws(() => resolveConfigValues({ interactionsToolRetrieval: null }), { code: 'INVALID_CONFIG' })
  assert.throws(() => resolveConfigValues({ interactionsToolRetrieval: 123 }), { code: 'INVALID_CONFIG' })
})

test('adapter getProfiles cache key, resolveModel, and prepareCall expose toolUpdate: addition-only strictly for supported routes/models', async () => {
  const liveCfg = baseCfg({ interactionsToolRetrieval: 'explicit' })
  const adapter = createArgonAdapter(ctx, () => liveCfg)

  const checkModel = async (model, expectAdditionOnly) => {
    const resolved = await adapter.resolveModel(PROVIDER, model)
    const prepared = await adapter.prepareCall(PROVIDER, model)
    const profileModel = adapter.inner.current().profiles.get(PROVIDER).piProvider.getModels().find(m => m.id === model)
    if (expectAdditionOnly) {
      assert.equal(resolved.toolUpdate, 'addition-only', `resolveModel ${model}`)
      assert.equal(prepared.model.toolUpdate, 'addition-only', `prepareCall ${model}`)
      assert.equal(profileModel.toolUpdate, 'addition-only', `getProfiles ${model}`)
    } else {
      assert.equal(resolved.toolUpdate, undefined, `resolveModel ${model}`)
      assert.equal(prepared.model.toolUpdate, undefined, `prepareCall ${model}`)
      assert.equal(profileModel.toolUpdate, undefined, `getProfiles ${model}`)
    }
  }

  // explicit + interactions: all four Gemini API models (Argon/Carbon/Hydrogen/Neon) get toolUpdate; Vertex models never do
  await checkModel(GOOGLE_API_MODEL, true)
  await checkModel(GOOGLE_API_CARBON_MODEL, true)
  await checkModel(GOOGLE_API_HYDROGEN_MODEL, true)
  await checkModel(GOOGLE_API_NEON_MODEL, true)
  await checkModel(MODEL, false)
  await checkModel(CARBON_MODEL, false)
  await checkModel(HYDROGEN_MODEL, false)
  await checkModel(NEON_MODEL, false)

  // Live toggle to 'off' invalidates getProfiles cache and removes toolUpdate immediately
  liveCfg.interactionsToolRetrieval = 'off'
  await checkModel(GOOGLE_API_MODEL, false)
  await checkModel(GOOGLE_API_CARBON_MODEL, false)
  await checkModel(GOOGLE_API_HYDROGEN_MODEL, false)
  await checkModel(GOOGLE_API_NEON_MODEL, false)

  // Live toggle to 'auto' restores toolUpdate
  liveCfg.interactionsToolRetrieval = 'auto'
  await checkModel(GOOGLE_API_MODEL, true)
  await checkModel(GOOGLE_API_CARBON_MODEL, true)
  await checkModel(GOOGLE_API_HYDROGEN_MODEL, true)
  await checkModel(GOOGLE_API_NEON_MODEL, true)

  // GenerateContent protocol never exposes toolUpdate
  liveCfg.googleProtocol = 'generate-content'
  await checkModel(GOOGLE_API_MODEL, false)
  await checkModel(GOOGLE_API_CARBON_MODEL, false)
  await checkModel(GOOGLE_API_HYDROGEN_MODEL, false)
  await checkModel(GOOGLE_API_NEON_MODEL, false)
})

test('buildInteractionRequest handles explicit/auto/off modes, short_description gating, client tool_search, and unsupported model stripping', async () => {
  const sampleTools = [
    { name: 'bash', description: 'Run shell command', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] }, shortDescription: 'Should not emit when not deferred' },
    { name: 'argon_inspect', description: 'Inspect diagnostics', shortDescription: 'Inspect Argon diagnostics', deferLoading: true, parameters: { type: 'object', properties: { action: { type: 'string' } } } },
    { name: 'mcp__github_search', description: 'Search GitHub repos', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
    { name: 'sv_render', description: 'Render SynthV audio', deferLoading: false, parameters: { type: 'object', properties: { track: { type: 'string' } } } },
    { name: 'custom_plugin_tool', description: 'Custom external tool', short_description: 'Custom short', parameters: { type: 'object', properties: { x: { type: 'number' } } } },
  ]
  const baseOpts = model => ({
    provider: PROVIDER,
    model,
    maxTokens: 1024,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    tools: sampleTools,
  })

  // 1) explicit mode on Argon-Google: only argon_inspect is deferred + single server tool_search at index 0
  const explicitReq = await buildInteractionRequest(baseOpts(GOOGLE_API_MODEL), {
    route: 'google-generative-ai',
    interactionsToolRetrieval: 'explicit',
  })
  assert.deepEqual(explicitReq.tools[0], { type: 'tool_search' })
  assert.equal(explicitReq.tools.filter(t => t.type === 'tool_search').length, 1)
  assert.equal(explicitReq.generation_config.tool_choice, 'validated')
  const byName = req => Object.fromEntries(req.tools.filter(t => t.type === 'function').map(t => [t.name, t]))
  const expMap = byName(explicitReq)
  assert.equal(expMap.bash.defer_loading, undefined)
  assert.equal(expMap.bash.short_description, undefined)
  assert.equal(expMap.argon_inspect.defer_loading, true)
  assert.equal(expMap.argon_inspect.short_description, 'Inspect Argon diagnostics')
  assert.deepEqual(expMap.argon_inspect.parameters, { type: 'object', properties: { action: { type: 'string' } } })
  assert.equal(expMap.mcp__github_search.defer_loading, undefined)
  assert.equal(expMap.sv_render.defer_loading, undefined)
  assert.equal(expMap.custom_plugin_tool.defer_loading, undefined)
  assert.equal(expMap.custom_plugin_tool.short_description, undefined)

  // 2) auto mode on Hydrogen-Google: keeps bash & explicit deferLoading:false (sv_render) immediate; defers argon_inspect, mcp__github_search, custom_plugin_tool
  const autoReq = await buildInteractionRequest(baseOpts(GOOGLE_API_HYDROGEN_MODEL), {
    route: 'google-generative-ai',
    interactionsToolRetrieval: 'auto',
  })
  assert.deepEqual(autoReq.tools[0], { type: 'tool_search' })
  const autoMap = byName(autoReq)
  assert.equal(autoMap.bash.defer_loading, undefined)
  assert.equal(autoMap.sv_render.defer_loading, undefined)
  assert.equal(autoMap.argon_inspect.defer_loading, true)
  assert.equal(autoMap.mcp__github_search.defer_loading, true)
  assert.equal(autoMap.custom_plugin_tool.defer_loading, true)
  assert.equal(autoMap.custom_plugin_tool.short_description, 'Custom short')

  // auto mode with only 1 non-explicit tool does NOT auto-defer (< 2 tools threshold)
  const singleAutoReq = await buildInteractionRequest({
    ...baseOpts(GOOGLE_API_MODEL),
    tools: [{ name: 'mcp__only_one', description: 'Only tool', parameters: { type: 'object', properties: {} } }],
  }, { route: 'google-generative-ai', interactionsToolRetrieval: 'auto' })
  assert.equal(singleAutoReq.tools.length, 1)
  assert.equal(singleAutoReq.tools[0].defer_loading, undefined)

  // Core resident tools stay immediate in auto mode
  const coreTools = CORE_RESIDENT_TOOLS.slice(0, 4).map(name => ({
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
  }))
  const coreReq = await buildInteractionRequest({ ...baseOpts(GOOGLE_API_MODEL), tools: coreTools }, {
    route: 'google-generative-ai',
    interactionsToolRetrieval: 'auto',
  })
  assert.equal(coreReq.tools.some(t => t.type === 'tool_search' || t.defer_loading), false)

  // 2b) Carbon-Google & Neon-Google also enable Tool Retrieval on Gemini API Interactions v1beta
  for (const model of [GOOGLE_API_CARBON_MODEL, GOOGLE_API_NEON_MODEL]) {
    const modelExplicit = await buildInteractionRequest(baseOpts(model), {
      route: 'google-generative-ai',
      interactionsToolRetrieval: 'explicit',
    })
    assert.deepEqual(modelExplicit.tools[0], { type: 'tool_search' }, `${model} explicit must inject tool_search`)
    const modelExpMap = byName(modelExplicit)
    assert.equal(modelExpMap.argon_inspect.defer_loading, true)
    assert.equal(modelExpMap.argon_inspect.short_description, 'Inspect Argon diagnostics')
    assert.equal(modelExpMap.mcp__github_search.defer_loading, undefined)

    const modelAuto = await buildInteractionRequest(baseOpts(model), {
      route: 'google-generative-ai',
      interactionsToolRetrieval: 'auto',
    })
    assert.deepEqual(modelAuto.tools[0], { type: 'tool_search' }, `${model} auto must inject tool_search`)
    const modelAutoMap = byName(modelAuto)
    assert.equal(modelAutoMap.bash.defer_loading, undefined)
    assert.equal(modelAutoMap.sv_render.defer_loading, undefined)
    assert.equal(modelAutoMap.argon_inspect.defer_loading, true)
    assert.equal(modelAutoMap.mcp__github_search.defer_loading, true)
    assert.equal(modelAutoMap.custom_plugin_tool.defer_loading, true)
    assert.equal(modelAutoMap.custom_plugin_tool.short_description, 'Custom short')
  }

  // 3) Vertex AI (all models), explicit /v1/interactions (apiVersion:'v1'), and mode:'off' strip defer_loading/short_description and omit tool_search
  for (const [model, route, mode, apiVersion] of [
    [MODEL, 'google-vertex', 'auto', undefined],
    [CARBON_MODEL, 'google-vertex', 'auto', undefined],
    [HYDROGEN_MODEL, 'google-vertex', 'explicit', undefined],
    [NEON_MODEL, 'google-vertex', 'auto', undefined],
    [GOOGLE_API_CARBON_MODEL, 'google-generative-ai', 'auto', 'v1'],
    [GOOGLE_API_NEON_MODEL, 'google-generative-ai', 'auto', 'v1'],
    [GOOGLE_API_MODEL, 'google-generative-ai', 'off', undefined],
  ]) {
    const stripped = await buildInteractionRequest(baseOpts(model), { route, interactionsToolRetrieval: mode, ...(apiVersion ? { apiVersion } : {}) })
    assert.equal(stripped.tools.some(t => t.type === 'tool_search'), false, `${model}/${route}/${mode}/${apiVersion ?? 'default'}`)
    for (const tool of stripped.tools) {
      assert.equal('defer_loading' in tool, false)
      assert.equal('short_description' in tool, false)
      assert.equal('deferLoading' in tool, false)
      assert.equal('shortDescription' in tool, false)
    }
  }

  // 4) Client-side execution:'client' tool_search and extra non-server fields are explicitly rejected before dispatch (P1-4)
  const clientSearchTool = {
    type: 'tool_search',
    execution: 'client',
    name: 'search_catalog',
    description: 'Search local tools',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  }
  await assert.rejects(
    buildInteractionRequest({
      ...baseOpts(GOOGLE_API_MODEL),
      tools: [clientSearchTool, { name: 'mcp__one', description: 'tool one', parameters: { type: 'object', properties: {} } }],
    }, { route: 'google-generative-ai', interactionsToolRetrieval: 'auto' }),
    /Client-side tool_search execution is not supported/,
  )
  await assert.rejects(
    buildInteractionRequest({
      ...baseOpts(GOOGLE_API_MODEL),
      tools: [{ type: 'tool_search', execution: 'client', name: '', description: 'x', parameters: {} }],
    }, { route: 'google-generative-ai' }),
    /Client-side tool_search execution is not supported/,
  )
  await assert.rejects(
    buildInteractionRequest({
      ...baseOpts(GOOGLE_API_MODEL),
      tools: [{ type: 'tool_search', name: 'forbidden' }],
    }, { route: 'google-generative-ai' }),
    /Server-side tool_search must not specify/,
  )
  await assert.rejects(
    buildInteractionRequest({
      ...baseOpts(GOOGLE_API_MODEL),
      tools: [{ type: 'tool_search', customField: true }],
    }, { route: 'google-generative-ai' }),
    /Server-side tool_search must not specify/,
  )
  await assert.rejects(
    buildInteractionRequest({
      ...baseOpts(GOOGLE_API_MODEL),
      tools: [{ type: 'tool_search' }, { type: 'tool_search' }],
    }, { route: 'google-generative-ai' }),
    /at most one tool_search/,
  )
  await assert.rejects(
    buildInteractionRequest({
      ...baseOpts(GOOGLE_API_MODEL),
      tools: [{ type: 'mcp_server', name: 'remote_mcp', url: 'https://example.invalid/mcp' }],
    }, { route: 'google-generative-ai', interactionsToolRetrieval: 'explicit' }),
    /Remote mcp_server tools are not supported/,
  )

  // Standalone server tool_search stripped on off/auto leaves no dangling tools or tool_choice (P2)
  const strippedStandalone = await buildInteractionRequest({
    ...baseOpts(GOOGLE_API_MODEL),
    tools: [{ type: 'tool_search' }],
  }, { route: 'google-generative-ai', interactionsToolRetrieval: 'off' })
  assert.equal(strippedStandalone.tools, undefined)
  assert.equal(strippedStandalone.generation_config.tool_choice, undefined)

  const strippedStandaloneAuto = await buildInteractionRequest({
    ...baseOpts(GOOGLE_API_MODEL),
    tools: [{ type: 'tool_search' }],
    toolChoice: 'auto',
  }, { route: 'google-generative-ai', interactionsToolRetrieval: 'explicit' })
  assert.equal(strippedStandaloneAuto.tools, undefined)
  assert.equal(strippedStandaloneAuto.generation_config.tool_choice, undefined)

  // 5) options.toolChoice supports Interactions + DSH/OpenAI/Anthropic forms; auto/none disables server tool_search/defer_loading
  const allowedChoice = { allowed_tools: { mode: 'any', tools: ['bash'] } }
  const customChoiceReq = await buildInteractionRequest({
    ...baseOpts(GOOGLE_API_MODEL),
    toolChoice: allowedChoice,
  }, { route: 'google-generative-ai', interactionsToolRetrieval: 'explicit' })
  assert.deepEqual(customChoiceReq.generation_config.tool_choice, allowedChoice)

  const requiredReq = await buildInteractionRequest({ ...baseOpts(GOOGLE_API_MODEL), toolChoice: 'required' }, { route: 'google-generative-ai', interactionsToolRetrieval: 'explicit' })
  assert.equal(requiredReq.generation_config.tool_choice, 'any')
  for (const singleForm of [
    { type: 'function', name: 'argon_inspect' },
    { type: 'function', function: { name: 'argon_inspect' } },
    { type: 'tool', name: 'argon_inspect' },
    { toolName: 'argon_inspect' },
  ]) {
    const singleReq = await buildInteractionRequest({ ...baseOpts(GOOGLE_API_MODEL), toolChoice: singleForm }, { route: 'google-generative-ai', interactionsToolRetrieval: 'explicit' })
    assert.deepEqual(singleReq.generation_config.tool_choice, { allowed_tools: { mode: 'any', tools: ['argon_inspect'] } })
    // Explicitly forced tool is not deferred even if deferLoading:true.
    assert.equal(singleReq.tools.find(t => t.name === 'argon_inspect').defer_loading, undefined)
  }
  for (const disableChoice of ['auto', 'none', { allowed_tools: { mode: 'auto', tools: ['bash'] } }, { allowed_tools: { mode: 'none' } }]) {
    const disabledReq = await buildInteractionRequest({ ...baseOpts(GOOGLE_API_MODEL), toolChoice: disableChoice }, { route: 'google-generative-ai', interactionsToolRetrieval: 'auto' })
    assert.equal(disabledReq.tools.some(t => t.type === 'tool_search' || t.defer_loading || t.short_description), false)
  }
  await assert.rejects(
    buildInteractionRequest({ ...baseOpts(GOOGLE_API_MODEL), toolChoice: 'bogus' }, { route: 'google-generative-ai' }),
    /Invalid Interactions toolChoice/,
  )

  // downgradeToolChoiceToAuto strips server tool_search + defer_loading + short_description
  const downgraded = downgradeToolChoiceToAuto(explicitReq)
  assert.equal(downgraded.generation_config.tool_choice, 'auto')
  assert.equal(downgraded.tools.some(t => t.type === 'tool_search'), false)
  assert.equal(downgraded.tools.some(t => 'defer_loading' in t || 'short_description' in t), false)
})

test('developer/system tool-addition blocks for deferred tools are omitted from system_instruction without affecting non-deferred tools', async () => {
  const opts = {
    provider: PROVIDER,
    model: GOOGLE_API_MODEL,
    system: 'Base system prompt.',
    maxTokens: 1024,
    messages: [
      { role: 'developer', content: [{ type: 'tool-addition', toolName: 'argon_inspect' }] },
      { role: 'developer', content: [{ type: 'text', text: 'Keep this note.' }, { type: 'tool-addition', toolName: 'argon_inspect' }, { type: 'tool-addition', toolName: 'bash' }] },
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    ],
    tools: [
      { name: 'bash', description: 'shell', parameters: { type: 'object', properties: {} } },
      { name: 'argon_inspect', description: 'inspect', deferLoading: true, parameters: { type: 'object', properties: {} } },
    ],
  }

  // Supported model/route: argon_inspect is deferred -> omitted from system_instruction, empty developer msg skipped!
  const supported = await buildInteractionRequest(opts, {
    route: 'google-generative-ai',
    interactionsToolRetrieval: 'explicit',
  })
  assert.equal(supported.system_instruction, 'Base system prompt.\n\nKeep this note.\n[Tool availability update: tool-addition bash]')
  assert.equal(supported.system_instruction.includes('argon_inspect'), false)

  // When ALL developer blocks are deferred tool-additions and no options.system exists, system_instruction is omitted entirely
  const cleanSystem = await buildInteractionRequest({
    ...opts,
    system: undefined,
    messages: [
      { role: 'developer', content: [{ type: 'tool-addition', toolName: 'argon_inspect' }] },
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    ],
  }, { route: 'google-generative-ai', interactionsToolRetrieval: 'explicit' })
  assert.equal(cleanSystem.system_instruction, undefined)

  // Carbon-Google & Neon-Google also defer argon_inspect and omit its tool-addition from system_instruction
  for (const model of [GOOGLE_API_CARBON_MODEL, GOOGLE_API_NEON_MODEL]) {
    const googleReq = await buildInteractionRequest({ ...opts, model }, {
      route: 'google-generative-ai',
      interactionsToolRetrieval: 'explicit',
    })
    assert.ok(googleReq.tools.some(t => t.type === 'tool_search'), `${model} must inject tool_search`)
    assert.equal(googleReq.system_instruction, 'Base system prompt.\n\nKeep this note.\n[Tool availability update: tool-addition bash]')
    assert.equal(googleReq.system_instruction.includes('argon_inspect'), false)
  }

  // Unsupported routes/endpoints (Vertex AI & explicit v1): argon_inspect is NOT deferred, so tool-addition text stays intact
  const vertexCarbonReq = await buildInteractionRequest({ ...opts, model: CARBON_MODEL }, {
    route: 'google-vertex',
    interactionsToolRetrieval: 'explicit',
  })
  assert.equal(vertexCarbonReq.tools.some(t => t.type === 'tool_search'), false)
  assert.ok(vertexCarbonReq.system_instruction.includes('[Tool availability update: tool-addition argon_inspect]'))

  const v1NeonReq = await buildInteractionRequest({ ...opts, model: GOOGLE_API_NEON_MODEL }, {
    route: 'google-generative-ai',
    interactionsToolRetrieval: 'explicit',
    apiVersion: 'v1',
  })
  assert.equal(v1NeonReq.tools.some(t => t.type === 'tool_search'), false)
  assert.ok(v1NeonReq.system_instruction.includes('[Tool availability update: tool-addition argon_inspect]'))
})

test('stateless tool_search + processing + multimodal turn replays verbatim in Interactions and degrades cleanly in GenerateContent', async () => {
  const events = [
    { event_type: 'interaction.created', interaction: { id: 'tr-1', status: 'in_progress' } },
    { event_type: 'step.start', index: 0, step: { type: 'thought' } },
    { event_type: 'step.delta', index: 0, delta: { type: 'thought_summary', content: { type: 'text', text: 'Searching tools' } } },
    { event_type: 'step.delta', index: 0, delta: { type: 'thought_signature', signature: 'sig-t0' } },
    { event_type: 'step.stop', index: 0 },
    { event_type: 'step.start', index: 1, step: { type: 'tool_search_call', id: 'tsc-1', arguments: { function_names: ['argon_inspect'] }, signature: 'sig-tsc' } },
    { event_type: 'step.stop', index: 1 },
    { event_type: 'step.start', index: 2, step: { type: 'tool_search_result', call_id: 'tsc-1', result: [{ type: 'function', name: 'argon_inspect', description: 'inspect' }], signature: 'sig-tsr' } },
    { event_type: 'step.stop', index: 2 },
    { event_type: 'step.start', index: 3, step: { type: 'function_call', id: 'fc-1', name: 'argon_inspect', arguments: { action: 'list' } } },
    { event_type: 'step.stop', index: 3 },
    { event_type: 'interaction.requires_action', interaction: { id: 'tr-1', status: 'requires_action' } },
  ]
  const turn1Opts = {
    provider: PROVIDER,
    model: GOOGLE_API_MODEL,
    maxTokens: 1024,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Check logs' }] }],
    tools: [
      { name: 'bash', description: 'shell', parameters: { type: 'object', properties: {} } },
      { name: 'argon_inspect', description: 'inspect', deferLoading: true, parameters: { type: 'object', properties: { action: { type: 'string' } } } },
    ],
  }
  const chunks = await collect(streamInteractions(turn1Opts, {
    route: 'google-generative-ai',
    interactionsToolRetrieval: 'explicit',
    store: false,
    background: false,
    transport: {
      create: async () => (async function* () { for (const e of events) yield e })(),
      get: async () => assert.fail('unexpected get'),
      cancel: async () => ({ status: 'cancelled' }),
    },
  }))
  const finish = chunks.at(-1)
  assert.equal(finish.reason.kind, 'tool-calls')
  const assistantBlocks = chunks.filter(c => c.type === 'block-end').map(c => c.block)
  assert.equal(assistantBlocks.filter(b => b.type === 'tool-call').length, 1)
  assert.equal(assistantBlocks.find(b => b.type === 'tool-call').name, 'argon_inspect')

  // Turn 2: stateless Interactions replay preserves tool_search_call & tool_search_result + signatures verbatim before function_call & function_result
  const turn2Opts = {
    ...turn1Opts,
    messages: [
      ...turn1Opts.messages,
      { role: 'assistant', source: { provider: PROVIDER, model: GOOGLE_API_MODEL, replayState: finish.replayState }, content: assistantBlocks },
      { role: 'tool', toolCallId: 'fc-1', isError: false, content: [{ type: 'text', text: '{"ok":true}' }] },
    ],
  }
  const turn2Body = await buildInteractionRequest(turn2Opts, {
    route: 'google-generative-ai',
    interactionsToolRetrieval: 'explicit',
  })
  assert.deepEqual(
    turn2Body.input.map(s => s.type),
    ['user_input', 'thought', 'tool_search_call', 'tool_search_result', 'function_call', 'function_result'],
  )
  assert.equal(turn2Body.input[2].signature, 'sig-tsc')
  assert.equal(turn2Body.input[3].signature, 'sig-tsr')
  assert.deepEqual(turn2Body.tools[0], { type: 'tool_search' })

  // Turn 3: switching back to GenerateContent degrades cleanly without leaking tool_search_* steps or opaque signatures
  const gcOpts = generateContentHistory(turn2Opts, GOOGLE_API_MODEL)
  assert.equal(gcOpts.messages[1].source?.replayState, undefined)
  assert.equal(JSON.stringify(gcOpts).includes('tool_search_call'), false)
  assert.equal(JSON.stringify(gcOpts).includes('sig-tsc'), false)
  assert.ok(JSON.stringify(gcOpts.messages[2]).includes('[Previously executed tool argon_inspect; call fc-1]'))

  // P2-3: toggling interactionsToolRetrieval to 'off' mid-session degrades historical tool_search_* turns to text transcript (no orphan tool_search_call/result).
  const turn2Off = await buildInteractionRequest(turn2Opts, {
    route: 'google-generative-ai',
    interactionsToolRetrieval: 'off',
  })
  assert.equal(turn2Off.tools.some(t => t.type === 'tool_search'), false)
  assert.equal(turn2Off.input.some(s => s.type === 'tool_search_call' || s.type === 'tool_search_result' || s.type === 'function_call' || s.type === 'function_result'), false)
  assert.ok(JSON.stringify(turn2Off.input).includes('[Previously executed tool argon_inspect; call fc-1]'))

  // P2-3: validated->auto HTTP 400 fallback rebuilds input without orphan tool_search_call/result steps, and standalone downgradeToolChoiceToAuto also degrades them.
  const standaloneDowngraded = downgradeToolChoiceToAuto(turn2Body)
  assert.equal(standaloneDowngraded.generation_config.tool_choice, 'auto')
  assert.equal(standaloneDowngraded.tools.some(t => t.type === 'tool_search'), false)
  assert.equal(standaloneDowngraded.input.some(s => s.type === 'tool_search_call' || s.type === 'tool_search_result' || s.type === 'function_call' || s.type === 'function_result'), false)

  const sentBodies = []
  const fallbackChunks = await collect(streamInteractions(turn2Opts, {
    route: 'google-generative-ai',
    interactionsToolRetrieval: 'explicit',
    store: false,
    background: false,
    transport: {
      create: async body => {
        sentBodies.push(body)
        if (sentBodies.length === 1) throw Object.assign(new Error('HTTP 400 INVALID_ARGUMENT'), { status: 400, phase: 'fetch', code: 'INVALID_REQUEST', upstreamCode: 'INVALID_ARGUMENT' })
        return (async function* () {
          yield { event_type: 'interaction.created', interaction: { id: 'tr-2', status: 'in_progress' } }
          yield { event_type: 'step.start', index: 0, step: { type: 'model_output' } }
          yield { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'degraded-ok' } }
          yield { event_type: 'step.stop', index: 0 }
          yield { event_type: 'interaction.completed', interaction: { id: 'tr-2', status: 'completed' } }
        })()
      },
      get: async () => assert.fail('unexpected get'),
      cancel: async () => ({ status: 'cancelled' }),
    },
  }))
  assert.equal(fallbackChunks.at(-1).reason.kind, 'stop')
  assert.equal(sentBodies.length, 2)
  assert.equal(sentBodies[0].input.some(s => s.type === 'tool_search_call'), true)
  assert.equal(sentBodies[1].generation_config.tool_choice, 'auto')
  assert.equal(sentBodies[1].tools.some(t => t.type === 'tool_search' || t.defer_loading), false)
  assert.equal(sentBodies[1].input.some(s => s.type === 'tool_search_call' || s.type === 'tool_search_result' || s.type === 'function_call' || s.type === 'function_result'), false)
  assert.ok(JSON.stringify(sentBodies[1].input).includes('[Previously executed tool argon_inspect; call fc-1]'))
})

test('end-to-end DSH LlmRuntime + projectToolUpdates preserves deferLoading for Gemini API models (Argon/Carbon/Neon) and strips for Vertex AI', async () => {
  const wire = []
  globalThis.fetch = async (input, init) => {
    wire.push({ url: String(typeof input === 'string' ? input : input.url), body: JSON.parse(init.body) })
    return sse([
      { event_type: 'interaction.created', event_id: 'e1', interaction: { id: 'r1', status: 'in_progress' } },
      { event_type: 'step.start', event_id: 'e2', index: 0, step: { type: 'model_output' } },
      { event_type: 'step.delta', event_id: 'e3', index: 0, delta: { type: 'text', text: 'ok' } },
      { event_type: 'step.stop', event_id: 'e4', index: 0 },
      { event_type: 'interaction.completed', event_id: 'e5', interaction: { id: 'r1', status: 'completed' } },
    ])
  }

  const runtimeCtx = new Context()
  await runtimeCtx.plugin(LlmRuntime)
  const originalGet = runtimeCtx.get.bind(runtimeCtx)
  runtimeCtx.get = key => key === 'launchEnvironment'
    ? { get: n => ['GOOGLE_API_KEY', 'GOOGLE_CLOUD_API_KEY'].includes(n) ? { value: 'fixture-key' } : undefined }
    : originalGet(key)

  try {
    const adapter = createArgonAdapter(runtimeCtx, baseCfg({ interactionsToolRetrieval: 'explicit' }))
    const unregister = runtimeCtx.llm.registerAdapter([PROVIDER], adapter)
    try {
      const bashTool = { name: 'bash', description: 'Run shell', parameters: { type: 'object', properties: {} } }
      const inspectTool = { name: 'argon_inspect', description: 'Inspect diagnostics', deferLoading: true, parameters: { type: 'object', properties: {} } }
      const dynamicTool = { name: 'mcp__late_tool', description: 'Added mid-session', parameters: { type: 'object', properties: {} } }
      const devMsg = { id: 'dev-1', role: 'developer', content: [{ type: 'tool-addition', toolName: 'mcp__late_tool' }] }
      const userMsg = { id: 'u-1', role: 'user', content: [{ type: 'text', text: 'hello' }] }
      const toolHistory = { tools: [bashTool, inspectTool], updates: [{ messageId: 'dev-1', additions: [dynamicTool] }] }

      // 1) Argon-Google: host prepareCall exposes toolUpdate:'addition-only', preserves deferLoading:true for both baseline & dynamic tools, injects tool_search, filters developer tool-addition
      const preparedArgon = await runtimeCtx.llm.prepareCall({ provider: PROVIDER, model: GOOGLE_API_MODEL })
      assert.equal(preparedArgon.toolUpdate, 'addition-only')
      const projectedArgon = projectToolUpdates([userMsg, devMsg], [bashTool, inspectTool, dynamicTool], preparedArgon.toolUpdate, toolHistory)
      assert.equal(projectedArgon.tools.find(t => t.name === 'argon_inspect').deferLoading, true)
      assert.equal(projectedArgon.tools.find(t => t.name === 'mcp__late_tool').deferLoading, true)
      const outArgon = await collect(preparedArgon.stream({
        ...preparedArgon.config,
        system: 'Host system prompt.',
        messages: [userMsg, devMsg],
        tools: [bashTool, inspectTool, dynamicTool],
        toolHistory,
      }))
      assert.equal(outArgon.at(-1).reason.kind, 'stop')
      const argonWire = wire.at(-1).body
      assert.deepEqual(argonWire.tools[0], { type: 'tool_search' })
      assert.equal(argonWire.tools.find(t => t.name === 'argon_inspect').defer_loading, true)
      assert.equal(argonWire.tools.find(t => t.name === 'mcp__late_tool').defer_loading, true)
      assert.equal(argonWire.system_instruction, 'Host system prompt.')
      assert.equal(argonWire.system_instruction.includes('mcp__late_tool'), false)

      // 2) Carbon-Google & Neon-Google: host prepareCall exposes toolUpdate:'addition-only', preserves deferLoading:true, injects tool_search, filters developer tool-addition
      for (const model of [GOOGLE_API_CARBON_MODEL, GOOGLE_API_NEON_MODEL]) {
        const preparedGoogle = await runtimeCtx.llm.prepareCall({ provider: PROVIDER, model })
        assert.equal(preparedGoogle.toolUpdate, 'addition-only', `${model} must expose toolUpdate`)
        const projectedGoogle = projectToolUpdates([userMsg, devMsg], [bashTool, inspectTool, dynamicTool], preparedGoogle.toolUpdate, toolHistory)
        assert.equal(projectedGoogle.tools.find(t => t.name === 'argon_inspect').deferLoading, true)
        assert.equal(projectedGoogle.tools.find(t => t.name === 'mcp__late_tool').deferLoading, true)
        const outGoogle = await collect(preparedGoogle.stream({
          ...preparedGoogle.config,
          system: 'Host system prompt.',
          messages: [userMsg, devMsg],
          tools: [bashTool, inspectTool, dynamicTool],
          toolHistory,
        }))
        assert.equal(outGoogle.at(-1).reason.kind, 'stop')
        const googleWire = wire.at(-1).body
        assert.deepEqual(googleWire.tools[0], { type: 'tool_search' })
        assert.equal(googleWire.tools.find(t => t.name === 'argon_inspect').defer_loading, true)
        assert.equal(googleWire.tools.find(t => t.name === 'mcp__late_tool').defer_loading, true)
        assert.equal(googleWire.system_instruction, 'Host system prompt.')
        assert.equal(googleWire.system_instruction.includes('mcp__late_tool'), false)
      }

      // 3) Vertex AI (Carbon/Neon): host prepareCall omits toolUpdate, host strips deferLoading, wire sends normal tools with zero tool_search/defer_loading
      for (const vertexModel of [CARBON_MODEL, NEON_MODEL]) {
        const preparedVertex = await runtimeCtx.llm.prepareCall({ provider: PROVIDER, model: vertexModel })
        assert.equal(preparedVertex.toolUpdate, undefined, `${vertexModel} on Vertex must omit toolUpdate`)
        const outVertex = await collect(preparedVertex.stream({
          ...preparedVertex.config,
          system: 'Host system prompt.',
          messages: [userMsg, devMsg],
          tools: [bashTool, inspectTool, dynamicTool],
          toolHistory,
        }))
        assert.equal(outVertex.at(-1).reason.kind, 'stop')
        const vertexWire = wire.at(-1).body
        assert.equal(vertexWire.tools.some(t => t.type === 'tool_search' || t.defer_loading), false)
      }
    } finally {
      unregister()
    }
  } finally {
    await runtimeCtx.fiber.dispose()
  }
})

test('P1-5 & P2: full deep-equal roundtrip with processing_*, all 4 multimodal content types, model_output.signature, cursor rollback, consistency checks, and /v1/interactions gate', async () => {
  const turn1Opts = {
    provider: PROVIDER,
    model: GOOGLE_API_MODEL,
    maxTokens: 1024,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Analyze media and inspect' }] }],
    tools: [
      { name: 'bash', description: 'shell', parameters: { type: 'object', properties: {} } },
      { name: 'argon_inspect', description: 'inspect', deferLoading: true, parameters: { type: 'object', properties: { action: { type: 'string' } } } },
    ],
  }

  let getCount = 0
  const chunks = await collect(streamInteractions(turn1Opts, {
    route: 'google-generative-ai',
    interactionsToolRetrieval: 'explicit',
    store: true,
    background: false,
    reconnectBackoff: { initialDelayMs: 0 },
    transport: {
      create: async () => (async function* () {
        yield { event_type: 'interaction.created', event_id: 'm1', interaction: { id: 'mm-1', status: 'in_progress' } }
        yield { event_type: 'step.start', event_id: 'm2', index: 0, step: { type: 'thought', summary: [{ type: 'text', text: 'Plan' }, { type: 'image', uri: 'https://example.invalid/think.png', mime_type: 'image/png' }], signature: 'sig-t' } }
        yield { event_type: 'step.stop', event_id: 'm3', index: 0 }
        yield { event_type: 'step.start', event_id: 'm4', index: 1, step: { type: 'tool_search_call', id: 'tsc-1', arguments: { function_names: ['argon_inspect'] }, signature: 'sig-tsc' } }
        yield { event_type: 'step.stop', event_id: 'm5', index: 1 }
        yield { event_type: 'step.start', event_id: 'm6', index: 2, step: { type: 'tool_search_result', call_id: 'tsc-1', result: [{ type: 'function', name: 'argon_inspect' }], signature: 'sig-tsr' } }
        // Unindexed duplicate/phantom delta before drop -> must roll back!
        yield { event_type: 'step.delta', index: 2, delta: { type: 'tool_search_result', result: [{ type: 'function', name: 'phantom_tool' }] } }
        throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET', phase: 'stream', status: 200 })
      })(),
      get: async (_id, reqOpts) => {
        getCount++
        assert.equal(reqOpts.last_event_id, 'm6')
        return (async function* () {
          yield { event_type: 'step.stop', event_id: 'm7', index: 2 }
          yield { event_type: 'step.start', event_id: 'm8', index: 3, step: { type: 'processing_call', id: 'pc-1', signature: 'sig-pc' } }
          yield { event_type: 'step.stop', event_id: 'm9', index: 3 }
          yield { event_type: 'step.start', event_id: 'm10', index: 4, step: { type: 'processing_result', call_id: 'pc-1', signature: 'sig-pr' } }
          yield { event_type: 'step.stop', event_id: 'm11', index: 4 }
          yield {
            event_type: 'step.start',
            event_id: 'm12',
            index: 5,
            step: {
              type: 'model_output',
              content: [
                { type: 'text', text: 'Media summary: ' },
                { type: 'image', data: 'AQID', mime_type: 'image/png' },
              ],
            },
          }
          yield { event_type: 'step.delta', event_id: 'm13', index: 5, delta: { type: 'audio', uri: 'https://example.invalid/a.mp3', mime_type: 'audio/mpeg' } }
          yield { event_type: 'step.delta', event_id: 'm14', index: 5, delta: { type: 'document', uri: 'https://example.invalid/d.pdf', mime_type: 'application/pdf' } }
          yield { event_type: 'step.delta', event_id: 'm15', index: 5, delta: { type: 'video', uri: 'https://example.invalid/v.mp4', mime_type: 'video/mp4' } }
          yield { event_type: 'step.delta', event_id: 'm16', index: 5, delta: { type: 'text', text: 'Calling inspect.', signature: 'sig-model-out' } }
          yield { event_type: 'step.stop', event_id: 'm17', index: 5 }
          yield { event_type: 'step.start', event_id: 'm18', index: 6, step: { type: 'function_call', id: 'fc-1', name: 'argon_inspect', arguments: { action: 'list' }, signature: 'sig-fc' } }
          yield { event_type: 'step.stop', event_id: 'm19', index: 6 }
          yield { event_type: 'interaction.requires_action', event_id: 'm20', interaction: { id: 'mm-1', status: 'requires_action' } }
        })()
      },
      cancel: async () => ({ status: 'cancelled' }),
    },
  }))
  assert.equal(getCount, 1)
  const finish = chunks.at(-1)
  assert.equal(finish.reason.kind, 'tool-calls')
  const assistantBlocks = chunks.filter(c => c.type === 'block-end').map(c => c.block)

  const turn2Body = await buildInteractionRequest({
    ...turn1Opts,
    messages: [
      ...turn1Opts.messages,
      { role: 'assistant', source: { provider: PROVIDER, model: GOOGLE_API_MODEL, replayState: finish.replayState }, content: assistantBlocks },
      { role: 'tool', toolCallId: 'fc-1', isError: false, content: [{ type: 'text', text: '{"ok":true}' }] },
    ],
  }, { route: 'google-generative-ai', interactionsToolRetrieval: 'explicit' })

  assert.deepEqual(turn2Body.input, [
    { type: 'user_input', content: [{ type: 'text', text: 'Analyze media and inspect' }] },
    { type: 'thought', signature: 'sig-t', summary: [{ type: 'text', text: 'Plan' }, { type: 'image', uri: 'https://example.invalid/think.png', mime_type: 'image/png' }] },
    { type: 'tool_search_call', id: 'tsc-1', arguments: { function_names: ['argon_inspect'] }, signature: 'sig-tsc' },
    { type: 'tool_search_result', call_id: 'tsc-1', result: [{ type: 'function', name: 'argon_inspect' }], signature: 'sig-tsr' },
    { type: 'processing_call', id: 'pc-1', signature: 'sig-pc' },
    { type: 'processing_result', call_id: 'pc-1', signature: 'sig-pr' },
    {
      type: 'model_output',
      content: [
        { type: 'text', text: 'Media summary: ' },
        { type: 'image', data: 'AQID', mime_type: 'image/png' },
        { type: 'audio', uri: 'https://example.invalid/a.mp3', mime_type: 'audio/mpeg' },
        { type: 'document', uri: 'https://example.invalid/d.pdf', mime_type: 'application/pdf' },
        { type: 'video', uri: 'https://example.invalid/v.mp4', mime_type: 'video/mp4' },
        { type: 'text', text: 'Calling inspect.' },
      ],
      signature: 'sig-model-out',
    },
    { type: 'function_call', id: 'fc-1', name: 'argon_inspect', arguments: { action: 'list' }, signature: 'sig-fc' },
    { type: 'function_result', call_id: 'fc-1', name: 'argon_inspect', is_error: false, result: [{ type: 'text', text: '{"ok":true}' }] },
  ])

  // P1-5 consistency checks: orphan tool_search_result or mismatched function_call degrades completed turn to text transcript and rejects unfinished turn.
  const orphanReplay = structuredClone(finish.replayState)
  orphanReplay.response.steps = orphanReplay.response.steps.filter(s => s.type !== 'tool_search_call')
  const orphanCompleted = await buildInteractionRequest({
    ...turn1Opts,
    messages: [
      ...turn1Opts.messages,
      { role: 'assistant', source: { provider: PROVIDER, model: GOOGLE_API_MODEL, replayState: orphanReplay }, content: assistantBlocks },
      { role: 'tool', toolCallId: 'fc-1', isError: false, content: [{ type: 'text', text: '{"ok":true}' }] },
    ],
  }, { route: 'google-generative-ai', interactionsToolRetrieval: 'explicit' })
  assert.equal(orphanCompleted.input.some(s => s.type === 'tool_search_result' || s.type === 'function_call'), false)
  assert.ok(JSON.stringify(orphanCompleted.input).includes('[Previously executed tool argon_inspect; call fc-1]'))

  await assert.rejects(
    buildInteractionRequest({
      ...turn1Opts,
      messages: [
        ...turn1Opts.messages,
        { role: 'assistant', source: { provider: PROVIDER, model: GOOGLE_API_MODEL, replayState: orphanReplay }, content: assistantBlocks },
      ],
    }, { route: 'google-generative-ai', interactionsToolRetrieval: 'explicit' }),
    /unfinished foreign or edited tool call/,
  )

  const mismatchedFnReplay = structuredClone(finish.replayState)
  mismatchedFnReplay.response.steps.find(s => s.type === 'function_call').arguments = { action: 'tampered' }
  const mismatchedCompleted = await buildInteractionRequest({
    ...turn1Opts,
    messages: [
      ...turn1Opts.messages,
      { role: 'assistant', source: { provider: PROVIDER, model: GOOGLE_API_MODEL, replayState: mismatchedFnReplay }, content: assistantBlocks },
      { role: 'tool', toolCallId: 'fc-1', isError: false, content: [{ type: 'text', text: '{"ok":true}' }] },
    ],
  }, { route: 'google-generative-ai', interactionsToolRetrieval: 'explicit' })
  assert.equal(mismatchedCompleted.input.some(s => s.type === 'function_call'), false)

  // P2: explicit /v1/interactions custom baseURL disables Tool Retrieval & toolUpdate: 'addition-only' across Argon/Carbon/Neon
  for (const model of [GOOGLE_API_MODEL, GOOGLE_API_CARBON_MODEL, GOOGLE_API_HYDROGEN_MODEL, GOOGLE_API_NEON_MODEL]) {
    assert.equal(supportsInteractionsToolRetrieval({ model, route: 'google-generative-ai', protocol: 'interactions', mode: 'auto', apiVersion: 'v1' }), false)
    assert.equal(supportsInteractionsToolRetrieval({ model, route: 'google-generative-ai', protocol: 'interactions', mode: 'auto', apiVersion: 'v1beta' }), true)
  }
  const v1Wire = []
  globalThis.fetch = async (input, init) => {
    v1Wire.push({ url: typeof input === 'string' ? input : (input?.href ?? input?.url ?? String(input)), body: JSON.parse(init.body) })
    return sse([
      { event_type: 'interaction.created', event_id: 'v1-1', interaction: { id: 'r-v1', status: 'in_progress' } },
      { event_type: 'step.start', event_id: 'v1-2', index: 0, step: { type: 'model_output' } },
      { event_type: 'step.delta', event_id: 'v1-3', index: 0, delta: { type: 'text', text: 'v1-ok' } },
      { event_type: 'step.stop', event_id: 'v1-4', index: 0 },
      { event_type: 'interaction.completed', event_id: 'v1-5', interaction: { id: 'r-v1', status: 'completed' } },
    ])
  }
  let v1Diag
  const v1Adapter = createArgonAdapter(ctx, baseCfg({
    interactionsToolRetrieval: 'auto',
    routes: { ...allRoutes, googleBaseUrl: 'https://generativelanguage.googleapis.com/v1/interactions' },
  }), undefined, undefined, d => v1Diag = d)
  for (const v1Model of [GOOGLE_API_MODEL, GOOGLE_API_CARBON_MODEL, GOOGLE_API_NEON_MODEL]) {
    const v1Prepared = await v1Adapter.prepareCall(PROVIDER, v1Model)
    assert.equal(v1Prepared.model.toolUpdate, undefined)
    const v1Resolved = await v1Adapter.resolveModel(PROVIDER, v1Model)
    assert.equal(v1Resolved.toolUpdate, undefined)
    const v1Out = await collect(v1Prepared.stream({ ...turn1Opts, model: v1Model }))
    assert.equal(v1Out.at(-1).reason.kind, 'stop')
    assert.equal(v1Diag.apiVersion, 'v1')
    assert.equal(v1Wire.at(-1).url, 'https://generativelanguage.googleapis.com/v1/interactions')
    assert.equal(v1Wire.at(-1).body.tools.some(t => t.type === 'tool_search' || t.defer_loading), false)
  }
})
