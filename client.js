window.__ModuleLoader__.load({
  id: 'dsh-vertex-argon',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const ns = 'settings.localVertexArgon'

    function parseListRecentRequest(value) {
      if (value === undefined || value === null) return { limit: 20 }
      if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid diagnostics request')
      const limit = value.limit === undefined ? 20 : Number(value.limit)
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid diagnostics limit')
      return { limit }
    }

    function parseListRecentResult(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid diagnostics response')
      if (value.ok === false) {
        if (typeof value.error !== 'string') throw new Error('Invalid diagnostics error response')
        return value
      }
      if (value.ok !== true || !Array.isArray(value.records)) throw new Error('Invalid diagnostics records response')
      return value
    }

    function diagnosticsCodec(direction) {
      const schema = {
        parse: value => (direction === 'request' ? parseListRecentRequest(value) : parseListRecentResult(value)),
      }
      return {
        mode: 'strict',
        typeSymbol: 'dsh-vertex-argon/listRecent' + (direction === 'request' ? 'Request' : 'Result'),
        schema,
        create: () => schema,
      }
    }

    const DIAGNOSTICS_INVOCATION = {
      id: 'dsh-vertex-argon#vertexArgonDiagnostics/listRecent',
      service: 'vertexArgonDiagnostics',
      namespace: 'vertexArgonDiagnostics',
      method: 'listRecent',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: diagnosticsCodec('request') }],
      result: diagnosticsCodec('result'),
    }

    const isRecoveryTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value))

    function parseRecoveryResult(value) {
      const result = parseListRecentResult(value)
      if (!result.ok) return { ok: false, error: result.error }
      const records = result.records.map(row => {
        if (!row || typeof row.key !== 'string' || !/^[a-f0-9]{64}$/.test(row.key) ||
          typeof row.sessionHash !== 'string' || !/^[a-f0-9]{12}$/.test(row.sessionHash) ||
          !['creating', 'accepted', 'unknown', 'cancel-failed'].includes(row.stage) || !isRecoveryTime(row.updatedAt) ||
          !(row.releasedAt === null || isRecoveryTime(row.releasedAt)) || !(row.uncertainAt === null || isRecoveryTime(row.uncertainAt)) ||
          typeof row.hasRemoteId !== 'boolean' || typeof row.active !== 'boolean') throw new Error('Invalid recovery record')
        // Only the redacted audit fields cross into this view; never render task payloads.
        const { key, sessionHash, stage, updatedAt, releasedAt, uncertainAt, hasRemoteId, active } = row
        return { key, sessionHash, stage, updatedAt, releasedAt, uncertainAt, hasRemoteId, active }
      })
      return { ok: true, records }
    }

    function parseReleaseRequest(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).some(key => !['key', 'expectedUpdatedAt', 'acknowledgeRisk'].includes(key)) ||
        typeof value.key !== 'string' || !/^[a-f0-9]{64}$/.test(value.key) || !isRecoveryTime(value.expectedUpdatedAt) || value.acknowledgeRisk !== true) {
        throw new Error('Explicit risk acknowledgement and a current recovery record are required')
      }
      return { key: value.key, expectedUpdatedAt: value.expectedUpdatedAt, acknowledgeRisk: true }
    }

    function parseReleaseResult(value) {
      if (value?.ok === false && typeof value.error === 'string') return { ok: false, error: value.error }
      if (value?.ok !== true || value.released !== true || value.remoteAction !== 'none' || value.newRequestStarted !== false) {
        throw new Error('Invalid recovery release response')
      }
      return { ok: true, released: true, remoteAction: 'none', newRequestStarted: false }
    }

    const RECOVERY_INVOCATIONS = ['listRecovery', 'releaseUnknown'].map(method => {
      const codec = direction => {
        const schema = { parse: direction === 'request'
          ? (method === 'listRecovery' ? parseListRecentRequest : parseReleaseRequest)
          : (method === 'listRecovery' ? parseRecoveryResult : parseReleaseResult) }
        return { mode: 'strict', typeSymbol: 'dsh-vertex-argon/' + method + '/' + direction, schema, create: () => schema }
      }
      return {
        id: 'dsh-vertex-argon#vertexArgonDiagnostics/' + method,
        service: 'vertexArgonDiagnostics', namespace: 'vertexArgonDiagnostics', method,
        invocation: { kind: 'direct' },
        parameters: [{ name: 'request', wire: 'request', source: 'json', codec: codec('request') }],
        result: codec('result'),
      }
    })

    // Plain-JS Client has no cross-bundle value imports. Offline parity tests
    // compare this reviewed UI gate with service-level.js; Host remains authoritative.
    const SERVICE_TIERS = ['standard', 'flex', 'priority']
    const SERVICE_TIER_CAPABILITIES = {
      'google-generative-ai/generate-content': SERVICE_TIERS,
      'google-generative-ai/interactions': SERVICE_TIERS,
      'google-vertex/generate-content': ['standard', 'priority'],
      'google-vertex/interactions': ['standard'],
    }
    const tierAllowed = (route, protocol, tier) => SERVICE_TIER_CAPABILITIES[route + '/' + protocol]?.includes(tier) === true
    function serviceSettingAllowed(value, key, next) {
      if (key === 'googleServiceTier' || key === 'vertexServiceTier') {
        const vertex = key === 'vertexServiceTier'
        return tierAllowed(vertex ? 'google-vertex' : 'google-generative-ai', value[vertex ? 'vertexProtocol' : 'googleProtocol'] ?? 'generate-content', next)
      }
      if (key === 'vertexPaygoOnly') return typeof next === 'boolean' && (!next || (value.vertexProtocol ?? 'generate-content') === 'generate-content')
      if (key === 'googleProtocol' || key === 'vertexProtocol') {
        const vertex = key === 'vertexProtocol'
        return tierAllowed(vertex ? 'google-vertex' : 'google-generative-ai', next, value[vertex ? 'vertexServiceTier' : 'googleServiceTier'] ?? 'standard') &&
          (!vertex || next !== 'interactions' || value.vertexPaygoOnly !== true)
      }
      return true
    }

    const INSPECTOR_METHODS = ['listRequests', 'getOverview', 'getRequest', 'readResponse', 'queryInteraction', 'readQueryResponse']
    const inspectorObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    const inspectorId = value => typeof value === 'string' && /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i.test(value)
    function parseInspectorRequest(method, value) {
      const fields = {
        listRequests: ['sessionId', 'messageId', 'limit'], getOverview: ['sessionId', 'messageId', 'limit'], getRequest: ['sessionId', 'requestId'],
        readResponse: ['sessionId', 'requestId', 'index', 'offset', 'length'],
        queryInteraction: ['route', 'id'], readQueryResponse: ['queryId', 'offset', 'length'],
      }[method]
      const invalid = () => { throw new Error('Invalid inspector request') }
      if (!inspectorObject(value) || Object.keys(value).some(key => !fields.includes(key))) invalid()
      const result = { ...value }
      if (['listRequests', 'getOverview', 'getRequest', 'readResponse'].includes(method) &&
        (typeof value.sessionId !== 'string' || value.sessionId.length < 1 || value.sessionId.length > 256)) invalid()
      if (method === 'listRequests' || method === 'getOverview') {
        if (value.messageId !== undefined && (typeof value.messageId !== 'string' || value.messageId.length < 1 || value.messageId.length > 256)) invalid()
        result.limit = value.limit === undefined ? 20 : value.limit
        if (!Number.isInteger(result.limit) || result.limit < 1 || result.limit > 100) invalid()
      }
      if (['getRequest', 'readResponse'].includes(method) && !inspectorId(value.requestId)) invalid()
      if (method === 'readQueryResponse' && !inspectorId(value.queryId)) invalid()
      if (method === 'queryInteraction' && (!['google-generative-ai', 'google-vertex'].includes(value.route) ||
        typeof value.id !== 'string' || !/^[A-Za-z0-9._~+=-]{1,4096}$/.test(value.id) || ['.', '..'].includes(value.id))) invalid()
      if (['readResponse', 'readQueryResponse'].includes(method)) {
        for (const key of method === 'readResponse' ? ['index', 'offset', 'length'] : ['offset', 'length']) {
          result[key] = value[key] === undefined ? (key === 'length' ? 65536 : 0) : value[key]
          if (!Number.isSafeInteger(result[key]) || result[key] < (key === 'length' ? 1 : 0) || (key === 'length' && result[key] > 65536)) invalid()
        }
      }
      return result
    }
    function parseInspectorResult(value) {
      if (!inspectorObject(value) || typeof value.ok !== 'boolean' || (!value.ok && typeof value.error !== 'string')) throw new Error('Invalid inspector response')
      return value
    }
    const INSPECTOR_INVOCATIONS = INSPECTOR_METHODS.map(method => {
      const codec = direction => {
        const schema = { parse: direction === 'request' ? value => parseInspectorRequest(method, value) : parseInspectorResult }
        return { mode: 'strict', typeSymbol: 'dsh-vertex-argon/inspector/' + method + '/' + direction, schema, create: () => schema }
      }
      return { id: 'dsh-vertex-argon#vertexArgonDiagnostics/' + method,
        service: 'vertexArgonDiagnostics', namespace: 'vertexArgonDiagnostics', method, invocation: { kind: 'direct' },
        parameters: [{ name: 'request', wire: 'request', source: 'json', codec: codec('request') }], result: codec('result'),
        ...(method === 'queryInteraction' ? { cancellation: { parameter: 'signal' } } : {}),
      }
    })

    const DIAGNOSTICS_REMOTE = {
      package: 'dsh-vertex-argon',
      descriptors: [DIAGNOSTICS_INVOCATION, ...RECOVERY_INVOCATIONS, ...INSPECTOR_INVOCATIONS],
    }

    const dictionaries = {
      zh: {
        title: 'Vertex Argon',
        subtitle: '聚合 Gemini API 与 Vertex AI 的 Argon 双通道 · 原生三档思考、独立协议与长解码控制',
        summaryLabel: '当前配置摘要',
        summaryLongDecode: '长解码',
        summaryEffectiveCap: '静态有效预算上限',
        readonlyBanner: '只读模式：当前连接仅可查看配置，无法修改宿主设置。',
        generalTitle: '1. 常用与默认思考',
        show: '在模型选择器中显示 Vertex Argon 分组',
        showHint: '控制是否在会话模型选择器中列出本分组模型；当前会话不受隐藏影响。',
        visible: '已显示',
        hidden: '已隐藏',
        reasoningLabel: '默认思考档位（Thinking Level）',
        reasoningHint: '固定 Low / Medium（默认） / High 三档，按所选协议映射原生思考级别与思考摘要，永不发送 thinkingBudget。',
        level_low: 'Low（低）',
        level_medium: 'Medium（默认）',
        level_high: 'High（高）',
        protocolTitle: '2. 独立双通道协议',
        protocolExperimental: 'Interactions（实验性）',
        protocolHint: '两通道协议独立生效，失败不静默互切。GenerateContent 使用客户端检查点续传；Interactions 不开后台仍支持普通流式与本地工具调用。',
        budgetWarningGoogle: 'Gemini API (Interactions) 预算冲突：当前静态有效预算超过 65,536，须在第 4 节同时开启「云端存储许可」与「后台执行」，或手动将输出预算调至 ≤ 65,536。',
        budgetWarningVertex: 'Vertex AI (Interactions) 预算冲突：超过 65,536 的预算当前会被预检直接拒绝，请切回 GenerateContent 或手动将输出预算调至 ≤ 65,536。',
        budgetTitle: '3. 长解码与预算（双通道共用）',
        longDecodeLabel: '长解码能力与续传开关（Long Decode）',
        longDecodeHint: '默认开启，同时控制 > 65,536 预算上限与 GenerateContent 客户端检查点续传（不代表每轮都会写满）。关闭时仅停用 GenerateContent 客户端续传（Interactions 事件流重连仍保留），且有效预算上限受限为 ≤ 65,536（同时受窗口预留限制），不会改动原配置值。GenerateContent 仅提交检查点已确认内容，断流回滚尾段，首批显示可能延后。',
        longDecodeOn: '已开启',
        longDecodeOff: '已关闭',
        maxTokensLabel: '最大输出预算（Max Output Tokens）',
        maxTokensHint: '思考、工具调用与正文共用此上限（非字数目标）。配置窗口 > 131,072 时预留 131,072 历史空间（1,048,576 窗口下静态上限为 917,504），并非实时剩余上下文，也不保证输出 1M。',
        contextWindowLabel: '共享上下文窗口（Context Window）',
        contextWindowHint: '此项用于 DSH 本地预算与历史压缩管理，不会改变远端模型硬限制（官方窗口上限 1,048,576，由输入、思考和输出共享；上下文水位与累计计费用量分开统计）。',
        customValueTag: ' · 自定义当前值',
        effectiveBudget: '静态有效配置上限（含历史安全预留）',
        effectiveClampedHint: '（长解码已关闭，有效上限 ≤ 65,536 且受窗口预留限制，原配置值保留）',
        interactionsTitle: '4. Interactions 存储许可与后台执行',
        storageLabel: '允许 Interactions 在 Google 端存储任务数据',
        storageHint: '采用 Interactions 的通道共用此许可。任何后台执行都须先授权存储（store: true）；关闭只影响新请求，不删除已有云端记录，也不等于所有平台零留存。',
        backgroundLabel: 'Interactions 后台执行',
        backgroundHint: '仅托管云端生成，支持按任务 ID 恢复并在停止时请求远端取消；DSH 本地工具仍在本机执行。未开启存储许可时此项禁用。未知远端状态仅阻止插件自动重发，不保证远端已停止或免人工处理。',
        resetDefaults: '恢复插件默认值',
        saving: '保存中…',
        saved: '已保存；正在运行的请求不受影响',
        error: '保存失败，请重试。',
        loading: '正在读取配置…',
        unavailable: '当前连接无法修改宿主设置。',
        advTitle: '5. 能力边界、自动兼容与接入说明',
        capabilities: '实测边界：两通道 GenerateContent 均有真实生成记录，两通道 Interactions 短调用与本地工具往返已实测；Gemini Interactions 后台已测至 63,303 tokens 与单次 POST 冷恢复入口；严格跨 65,536 真实输出尚未观测，Vertex Interactions > 65,536 保持门控。',
        how: '自动检测与凭据复用',
        step1: '在 DSH「设置 → 模型」的 Google 或 Google Vertex AI 中添加 gemini-4-argon 后，本分组自动出现对应双通道入口。',
        step2: 'Vertex AI 读取 GOOGLE_APPLICATION_CREDENTIALS / GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION；Gemini API 复用已配置的 GOOGLE_API_KEY。',
        step3: '插件同时为原生 google 与 google-vertex 入口注入 GenerateContent 兼容保护（原生思考档位映射、剥离采样参数与签名回传）；Interactions 后台冷恢复与单次 POST 防重锁属于本插件对应的 Interactions 协议通道。',
        scope: '路由标识',
        detail: 'GenerateContent 检查点重连、工具签名回放与 Interactions 未知远端状态防重锁均为各自协议的内置自动机制；若遇云端终止未确认或未知中断，请结合下方诊断记录人工核查。',
        route: '提供方路由：google-vertex-argon · 模型 ID：gemini-4-argon (Vertex AI) / gemini-4-argon-google (Gemini API)',
        recoveryTitle: '后台任务恢复',
        recoveryHint: '最近 20 条脱敏状态，未解除记录优先。这里只解除本地防重拦截，不取消云端任务，也不自动重发。',
        recoveryRefresh: '刷新恢复状态',
        recoveryLoading: '正在读取恢复状态…',
        recoveryEmpty: '暂无后台任务恢复记录。',
        recoveryError: '恢复操作或状态刷新失败：',
        recoverySession: '会话摘要',
        recoveryUpdated: '更新于',
        recoveryUncertain: '结果未知始于',
        recoveryReleased: '本地拦截已解除（审计记录）',
        recoveryActive: '原会话正在处理此任务，不能解除拦截。',
        recoveryKnownId: '保留的远端 ID 可由原会话恢复；此处不取消云端任务。',
        recoveryStage_creating: '创建中，结果未确认',
        recoveryStage_accepted: '已接收',
        recoveryStage_unknown: '远端结果未知',
        'recoveryStage_cancel-failed': '云端终止未确认',
        recoveryRelease: '解除本地拦截…',
        recoveryRisk: '我理解旧任务可能仍运行/计费；此操作不取消云端，不会自动重发',
        recoveryConfirm: '确认解除本地拦截',
        recoveryCancel: '取消',
        recoveryReleasing: '正在解除本地拦截…',
        recoverySuccess: '本地拦截已解除，旧云端结果仍未知；未发送新请求。回原会话手动继续。',
        diagPhase: '失败阶段',
        diagNotSubmitted: '请求尚未发送',
        diagTitle: '最近请求诊断摘要',
        diagSubtitle: '点击展开查看最近 20 次请求的通道版本、64K 续传跳数、断流检查点自愈与双轨 Token 计量',
        diagRefresh: '刷新诊断',
        diagLoading: '正在读取诊断记录…',
        diagEmpty: '暂无请求诊断记录。使用 Gemini 4 Argon 发起一次对话后即可在此查看。',
        diagError: '读取诊断记录失败，请确认已重启 DSH 加载最新版插件后重试。',
        diagStorageHint: '诊断落盘目录：~/.dsh/storages/vertex_argon_diagnostics/requests/（最多保留最近 200 条，严格脱敏，不保存对话正文、图片或密钥）',
        diagStatTotal: '最近记录',
        diagStatOk: '成功完成',
        diagStatCont: '64K 续传跳数',
        diagStatRecovered: '断流自愈',
        diagStatErr: '异常/失败',
        diagOutcome_done: '完成',
        diagOutcome_tool: '工具调用',
        diagOutcome_max: '达到上限',
        diagOutcome_error: '失败',
        diagOutcome_aborted: '已取消',
        diagOutcome_incomplete: '中断',
        diagOutcome_recovered: '断流已自愈',
        diagTrigger_initial: '首跳',
        diagTrigger_continuation: '64K续传',
        diagTrigger_reconnect: '检查点重连',
        diagTrigger_retry: '同检查点重试',
        diagTrigger_original: '原请求重试',
        diagTrigger_icreate: '创建交互任务',
        diagTrigger_iresume: '恢复交互事件流',
        diagCancelUnconfirmed: '云端终止未确认',
        diagCancelConfirmed: '云端终止已确认',
        diagReqCap: '本次请求上限',
        diagUnrecorded: '未记录',
        diagHopsDroppedPrefix: '已省略 ',
        diagHopsDroppedSuffix: ' 条分段诊断（非输出丢失）',
      },
      en: {
        title: 'Vertex Argon',
        subtitle: 'Dual-route Gemini API & Vertex AI Argon integration · native thinking levels, independent protocols & long decode controls',
        summaryLabel: 'Current configuration',
        summaryLongDecode: 'Long Decode',
        summaryEffectiveCap: 'Static effective cap',
        readonlyBanner: 'Read-only mode: this connection can view settings but cannot modify Host configuration.',
        generalTitle: '1. General & Default Thinking',
        show: 'Show Vertex Argon group in the model picker',
        showHint: 'Controls whether Vertex Argon models appear in the model picker; active conversations are unaffected.',
        visible: 'Visible',
        hidden: 'Hidden',
        reasoningLabel: 'Default Thinking Level',
        reasoningHint: 'Supports Low, Medium (default), and High, mapped to each protocol\'s native thinking level and summary output without sending thinkingBudget.',
        level_low: 'Low',
        level_medium: 'Medium (Default)',
        level_high: 'High',
        protocolTitle: '2. Per-Route Protocol Selection',
        protocolExperimental: 'Interactions (experimental)',
        protocolHint: 'Each route is configured independently and never switches protocols silently on error. GenerateContent uses client checkpoint continuation; Interactions supports foreground streaming and local tools even with background off.',
        budgetWarningGoogle: 'Gemini API (Interactions) budget conflict: effective budget exceeds 65,536; enable both Cloud Storage Consent and Background Execution in Section 4, or lower maxTokens to ≤ 65,536.',
        budgetWarningVertex: 'Vertex AI (Interactions) budget conflict: budgets above 65,536 are currently rejected by pre-flight check; switch Vertex AI to GenerateContent or lower maxTokens to ≤ 65,536.',
        budgetTitle: '3. Shared Long Decode & Output Budget',
        longDecodeLabel: 'Long Decode Capability & Continuation',
        longDecodeHint: 'Enabled by default; controls both > 65,536 budget caps and GenerateContent client checkpoint continuation (does not force every turn to run long). When disabled, only GenerateContent client continuation is turned off (Interactions stream reconnect remains active), and the effective cap is bounded to ≤ 65,536 (and by window headroom) without overwriting your saved maxTokens. GenerateContent commits only checkpoint-confirmed chunks, so first output may wait for a checkpoint or completion.',
        longDecodeOn: 'Enabled',
        longDecodeOff: 'Disabled',
        maxTokensLabel: 'Max Output Budget (Max Output Tokens)',
        maxTokensHint: 'Shared ceiling across thinking, tool calls, and visible text (not a word-count target). Configured context windows > 131,072 reserve 131,072 tokens for history (917,504 static cap at 1,048,576); this is not a real-time remaining context meter or a 1M output guarantee.',
        contextWindowLabel: 'Shared Context Window',
        contextWindowHint: 'Used by DSH for local budget calculation and history compaction; does not alter remote model hard limits (official 1,048,576 window shared across input, thinking, and output; context occupancy and billed usage are tracked separately).',
        customValueTag: ' · Custom value',
        effectiveBudget: 'Static effective budget cap (with history reserve)',
        effectiveClampedHint: ' (Long Decode is off; effective cap is ≤ 65,536 and bounded by window reserve while keeping your configured value)',
        interactionsTitle: '4. Interactions Storage Consent & Background',
        storageLabel: 'Allow Google to store Interactions task data',
        storageHint: 'Shared by routes using Interactions. All background execution requires explicit storage consent (store: true). Disabling affects future requests only; it neither deletes existing cloud records nor guarantees zero retention on every platform.',
        backgroundLabel: 'Interactions background execution',
        backgroundHint: 'Hosts model generation remotely with task-ID recovery and remote cancel on Stop; DSH local tools still run on this machine. Disabled until storage consent is enabled. Unknown remote state only blocks automatic duplicate sends and does not guarantee remote termination without manual review.',
        resetDefaults: 'Restore Plugin Defaults',
        saving: 'Saving…',
        saved: 'Saved; in-flight requests are unaffected',
        error: 'Could not save. Please retry.',
        loading: 'Loading configuration…',
        unavailable: 'This connection cannot edit Host settings.',
        advTitle: '5. Capabilities, Verification & Setup Guide',
        capabilities: 'Verification boundaries: both routes have live-verified GenerateContent generation records, and both routes have live-verified Interactions short calls and local tool round-trips. Gemini Interactions background is verified up to 63,303 tokens with single-POST cold resume entry; strict > 65,536 live output is not yet observed, and Vertex Interactions > 65,536 remains gated.',
        how: 'Auto-detection & credential reuse',
        step1: 'Add gemini-4-argon under Google or Google Vertex AI in Models settings to expose both routes automatically.',
        step2: 'Vertex AI reads GOOGLE_APPLICATION_CREDENTIALS / GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION; Gemini API reuses your configured GOOGLE_API_KEY.',
        step3: 'Native google and google-vertex entries receive GenerateContent compatibility protection (native thinkingLevel mapping, sampling parameter stripping, and thoughtSignature replay); Interactions background cold resume and single-POST dedup locks belong to this plugin\'s Interactions protocol route.',
        scope: 'Route identifiers',
        detail: 'GenerateContent checkpoint reconnect, tool signature replay, and Interactions unknown-remote-state dedup locks run automatically within their respective protocols; if remote termination is unconfirmed or interrupted in an unknown state, inspect the diagnostics panel below.',
        route: 'Provider route: google-vertex-argon · Models: gemini-4-argon (Vertex AI) / gemini-4-argon-google (Gemini API)',
        recoveryTitle: 'Background Task Recovery',
        recoveryHint: 'Latest 20 redacted states, unreleased records first. This only releases the local duplicate-send block; it never cancels a cloud task or automatically resends a request.',
        recoveryRefresh: 'Refresh recovery status',
        recoveryLoading: 'Loading recovery status…',
        recoveryEmpty: 'No background task recovery records.',
        recoveryError: 'Recovery action or status refresh failed: ',
        recoverySession: 'Session hash',
        recoveryUpdated: 'Updated',
        recoveryUncertain: 'Unknown since',
        recoveryReleased: 'Local block released (audit record)',
        recoveryActive: 'The original session is processing this task; the block cannot be released.',
        recoveryKnownId: 'The retained remote ID allows recovery from the original session; this page does not cancel cloud tasks.',
        recoveryStage_creating: 'Creating; result unconfirmed',
        recoveryStage_accepted: 'Accepted',
        recoveryStage_unknown: 'Remote result unknown',
        'recoveryStage_cancel-failed': 'Remote termination unconfirmed',
        recoveryRelease: 'Release local block…',
        recoveryRisk: 'I understand the old task may still be running/billing; this does not cancel it in the cloud or automatically resend a request',
        recoveryConfirm: 'Confirm release of local block',
        recoveryCancel: 'Cancel',
        recoveryReleasing: 'Releasing local block…',
        recoverySuccess: 'Local block released; the old cloud result is still unknown. No new request was sent. Return to the original session to continue manually.',
        diagPhase: 'Failure phase',
        diagNotSubmitted: 'Request not submitted',
        diagTitle: 'Recent Request Diagnostics Summary',
        diagSubtitle: 'Expand to inspect the latest 20 requests: route/API version, 64K continuation hops, checkpoint drop recovery, and dual-track token accounting',
        diagRefresh: 'Refresh',
        diagLoading: 'Loading diagnostics…',
        diagEmpty: 'No request diagnostics recorded yet. Send a message with Gemini 4 Argon to populate this view.',
        diagError: 'Could not load diagnostics. Restart DSH after upgrading the plugin and try again.',
        diagStorageHint: 'Persisted under ~/.dsh/storages/vertex_argon_diagnostics/requests/ (retains latest 200 records; strictly scrubbed—no prompts, images, or credentials).',
        diagStatTotal: 'Records',
        diagStatOk: 'Succeeded',
        diagStatCont: '64K Cont. Hops',
        diagStatRecovered: 'Drop Recoveries',
        diagStatErr: 'Errors',
        diagOutcome_done: 'Done',
        diagOutcome_tool: 'Tool Calls',
        diagOutcome_max: 'Max Tokens',
        diagOutcome_error: 'Error',
        diagOutcome_aborted: 'Aborted',
        diagOutcome_incomplete: 'Incomplete',
        diagOutcome_recovered: 'Recovered',
        diagTrigger_initial: 'Initial',
        diagTrigger_continuation: '64K Cont.',
        diagTrigger_reconnect: 'Ckpt Reconnect',
        diagTrigger_retry: 'Ckpt Retry',
        diagTrigger_original: 'Original Retry',
        diagTrigger_icreate: 'Interaction Create',
        diagTrigger_iresume: 'Interaction Resume',
        diagCancelUnconfirmed: 'Remote termination unconfirmed',
        diagCancelConfirmed: 'Remote termination confirmed',
        diagReqCap: 'Request cap',
        diagUnrecorded: 'unrecorded',
        diagHopsDroppedPrefix: '',
        diagHopsDroppedSuffix: ' hop diagnostic entries omitted (not output loss)',
      },
    }

    Object.assign(dictionaries.zh, {
  "inspectorUnverified": "存在关联记录，尚未经历史日志核验",
  "inspectorTitle": "Argon 诊断",
  "inspectorOpen": "Argon 详情",
  "inspectorRequests": "请求与响应",
  "inspectorUsage": "用量与费用",
  "inspectorQuery": "按 ID 查询云端状态 · 网络访问",
  "inspectorSession": "会话",
  "inspectorMessage": "正式消息",
  "inspectorRefresh": "刷新请求列表",
  "inspectorStart": "尚未取得本地列表；可手动刷新，不会发起云查询或生成。",
  "inspectorEmpty": "此范围内没有保留的请求诊断。",
  "inspectorMessageEmpty": "没有与此正式消息精确关联的保留请求；旧记录仍可能未关联，不按时间猜测。",
  "inspectorSelect": "选择请求",
  "inspectorChoose": "先选择一个请求查看详情。",
  "inspectorUnassociated": "未关联正式消息",
  "inspectorAssociated": "已精确关联正式消息",
  "inspectorNotFound": "请求已不在保留范围内。",
  "inspectorDenied": "当前连接未获此读取权限。",
  "inspectorError": "读取失败；请重试或检查连接与权限。",
  "inspectorLoading": "正在读取…",
  "inspectorCancel": "停止本地读取",
  "inspectorCancelled": "已停止本地读取；未请求云端取消。",
  "inspectorReset": "连接已重置，旧结果已清空；请重新读取。",
  "inspectorRaw": "读取上游响应",
  "inspectorRawHint": "解析后的上游 JSON，不是 HTTP 原始字节、已提交正文或恢复快照；可能包含未提交/重放帧、敏感正文与不透明签名，不代表隐藏思维链。",
  "inspectorNotRetained": "当前没有可读取的已保留原始响应；此状态不说明缺失原因，旧数据不会补录。",
  "inspectorFrame": "帧索引",
  "inspectorPrevFrame": "上一帧",
  "inspectorNextFrame": "下一帧",
  "inspectorPrevPage": "上一段",
  "inspectorNextPage": "下一段",
  "inspectorPartial": "这是 JSON 片段，不是完整对象。",
  "inspectorComplete": "完整帧 JSON",
  "inspectorNoFrame": "保留记录中没有此帧。",
  "inspectorOmitted": "省略帧数",
  "inspectorCaptureError": "捕获时发生错误",
  "inspectorMemory": "仅内存留存",
  "inspectorDisk": "已落盘",
  "inspectorSummary": "脱敏诊断汇总（不是原始响应）",
  "inspectorUnknown": "未记录 / 未知",
  "inspectorRequested": "请求服务等级",
  "inspectorObserved": "服务端观察等级",
  "inspectorEstimate": "用量估算 USD（非账单实扣）",
  "inspectorSubtotal": "已知部分小计 USD（不代表总额）",
  "inspectorBilling": "未核验云账单；缺失不是零。请求地区来自配置，价格按 UTC 日期估算，账户折扣、税、非 Token 工具费和未报告用量不含在内。",
  "inspectorMissing": "估算缺口",
  "inspectorProvenance": "价格版本与逐段估算依据",
  "inspectorUsageHint": "DSH step、Google step、GC HTTP hop 与 GET 重连不同。Interactions step 不与累计总量相加；GC 按 hop 独立计价，可能含未提交尾段。",
  "inspectorAggregate": "上游累计用量",
  "inspectorUsageRows": "逐 step / hop 与分模态用量",
  "inspectorQueryHint": "使用所选路由当前配置凭据，仅执行一次已知 ID 的只读 GET；不生成、不执行工具、不导入会话、不恢复或取消云端任务。查询并不承诺免费。",
  "inspectorRoute": "查询路由",
  "inspectorId": "Interaction ID（仅 ID，不是 URL）",
  "inspectorLookup": "查询已知 ID",
  "inspectorInvalidId": "请选择路由并填写有效的不透明 ID，不接受 URL、路径、空白或 dot 段。",
  "inspectorReadQuery": "读取查询结果",
  "inspectorQueryResult": "查询元数据（独立内存缓存，未导入会话）",
  "inspectorQueryExpired": "查询结果未留存或已淘汰；重新查询需要再次点击查询。",
  "retainRawTitle": "原始响应留存授权",
  "retainRawLabel": "允许本地留存解析后的上游响应",
  "retainRawHint": "默认关闭。开启后仅影响新请求；可能保存敏感正文、图片数据与不透明签名。最多 20 条/共 64 MiB、每条 16 MiB/16,384 帧，超限明确截断；关闭不删除既有记录。与 Google 云端存储许可不同。"
})
    Object.assign(dictionaries.en, {
  "inspectorUnverified": "Stored association; historical verification pending",
  "inspectorTitle": "Argon diagnostics",
  "inspectorOpen": "Argon details",
  "inspectorRequests": "Requests & responses",
  "inspectorUsage": "Usage & cost",
  "inspectorQuery": "Cloud ID lookup · network access",
  "inspectorSession": "Session",
  "inspectorMessage": "Durable message",
  "inspectorRefresh": "Refresh request list",
  "inspectorStart": "Local list not yet available; refresh manually. No cloud lookup or generation.",
  "inspectorEmpty": "No retained request diagnostics in this scope.",
  "inspectorMessageEmpty": "No retained request is exactly associated with this message. Older records may be unassociated; times are not used to infer a match.",
  "inspectorSelect": "Select request",
  "inspectorChoose": "Select a request to inspect its details.",
  "inspectorUnassociated": "Unassociated with a durable message",
  "inspectorAssociated": "Exactly associated with a durable message",
  "inspectorNotFound": "Request is no longer retained.",
  "inspectorDenied": "This connection is not allowed to perform this read.",
  "inspectorError": "Read failed; retry or check connection and access.",
  "inspectorLoading": "Reading…",
  "inspectorCancel": "Stop local read",
  "inspectorCancelled": "Local read stopped; no cloud cancellation was requested.",
  "inspectorReset": "Connection reset; old results were cleared. Read again when ready.",
  "inspectorRaw": "Read upstream response",
  "inspectorRawHint": "Decoded upstream JSON, not HTTP bytes, committed output or a recovery snapshot. May include uncommitted/replayed frames, sensitive text and opaque signatures, not hidden chain-of-thought.",
  "inspectorNotRetained": "No retained raw response is currently readable. This does not identify why it is absent; older data is not backfilled.",
  "inspectorFrame": "Frame index",
  "inspectorPrevFrame": "Previous frame",
  "inspectorNextFrame": "Next frame",
  "inspectorPrevPage": "Previous segment",
  "inspectorNextPage": "Next segment",
  "inspectorPartial": "This is a JSON segment, not a complete object.",
  "inspectorComplete": "Complete frame JSON",
  "inspectorNoFrame": "No frame at this index.",
  "inspectorOmitted": "Omitted frames",
  "inspectorCaptureError": "Capture encountered an error",
  "inspectorMemory": "Memory-only retention",
  "inspectorDisk": "Persisted to disk",
  "inspectorSummary": "Redacted diagnostic summary (not raw response)",
  "inspectorUnknown": "Not recorded / unknown",
  "inspectorRequested": "Requested tier",
  "inspectorObserved": "Observed tier",
  "inspectorEstimate": "Usage estimate USD (not billed charge)",
  "inspectorSubtotal": "Known subtotal USD (not a total)",
  "inspectorBilling": "Cloud billing is unverified; missing is not zero. Region is request configuration, price dates use UTC estimation, and account discounts, tax, non-token tools and unreported usage are excluded.",
  "inspectorMissing": "Estimate gaps",
  "inspectorProvenance": "Price version & per-part provenance",
  "inspectorUsageHint": "DSH steps, Google steps, GC HTTP hops and GET reconnects differ. Interaction steps are not added to cumulative totals; GC is priced per hop and may include uncommitted tails.",
  "inspectorAggregate": "Upstream cumulative usage",
  "inspectorUsageRows": "Per-step / hop & modality usage",
  "inspectorQueryHint": "Uses current configured credentials on the selected route for one read-only GET of a known ID. No generation, tools, session import, recovery or cloud cancellation. Lookup is not promised to be free.",
  "inspectorRoute": "Lookup route",
  "inspectorId": "Interaction ID (ID only, not URL)",
  "inspectorLookup": "Look up known ID",
  "inspectorInvalidId": "Choose a route and supply an opaque ID; URLs, paths, whitespace and dot segments are rejected.",
  "inspectorReadQuery": "Read lookup result",
  "inspectorQueryResult": "Lookup metadata (separate memory cache, not imported)",
  "inspectorQueryExpired": "Lookup result is absent or evicted; another GET requires clicking lookup again.",
  "retainRawTitle": "Raw response retention consent",
  "retainRawLabel": "Allow local retention of decoded upstream responses",
  "retainRawHint": "Off by default; enabling affects new requests only. May retain sensitive text, image data and opaque signatures. At most 20 records / 64 MiB total, 16 MiB / 16,384 frames per record; omissions are explicit. Disabling does not delete existing records. Separate from Google cloud-storage consent."
})

    dictionaries.zh.ARGON_QUERY_INVALID = "请选择路由并填写有效的 Interaction ID。"
    dictionaries.en.ARGON_QUERY_INVALID = "Select a route and enter a valid Interaction ID."
    dictionaries.zh.ARGON_QUERY_CANCELLED = "查询已在本地停止；未请求云端取消。"
    dictionaries.en.ARGON_QUERY_CANCELLED = "Lookup stopped locally; no cloud cancellation requested."
    dictionaries.zh.ARGON_QUERY_TIMEOUT = "查询超时；云端任务状态尚未核实。"
    dictionaries.en.ARGON_QUERY_TIMEOUT = "Lookup timed out; remote task status is unverified."
    dictionaries.zh.ARGON_QUERY_TOO_LARGE = "查询响应超过大小上限。"
    dictionaries.en.ARGON_QUERY_TOO_LARGE = "Lookup response exceeded the size limit."
    dictionaries.zh.ARGON_QUERY_RESPONSE = "查询未返回有效 JSON 对象。"
    dictionaries.en.ARGON_QUERY_RESPONSE = "Lookup did not return a valid JSON object."
    dictionaries.zh.ARGON_QUERY_ID_MISMATCH = "查询返回的 ID 与请求 ID 不符。"
    dictionaries.en.ARGON_QUERY_ID_MISMATCH = "Returned ID did not match the requested ID."
    dictionaries.zh.ARGON_QUERY_UNAVAILABLE = "所选路由或当前凭据无法读取此 ID。"
    dictionaries.en.ARGON_QUERY_UNAVAILABLE = "This ID could not be read with the selected route and current credentials."
    dictionaries.zh.ARGON_QUERY_BUSY = "查询并发已满，请等待已有查询完成。"
    dictionaries.en.ARGON_QUERY_BUSY = "Too many lookups are active; wait for one to finish."
    dictionaries.zh.ARGON_INSPECTOR_INVALID = "读取参数无效或检查器当前不可用。"
    dictionaries.en.ARGON_INSPECTOR_INVALID = "Read parameters are invalid or the inspector is unavailable."

    dictionaries.zh.tierTitle = "默认服务等级"
    dictionaries.en.tierTitle = "Default service tiers"
    dictionaries.zh.tierHint = "每次点击仅保存所选字段，供后续请求使用；不改动当前请求、不自动切换协议，也不自动升降等级。Priority 可能增加费用，请由用户选择。"
    dictionaries.en.tierHint = "Each click saves only that field for future requests; it does not alter an active request, switch protocols, or upgrade/downgrade a tier. Priority may cost more and must be selected by the user."
    dictionaries.zh.tierLabel = "服务等级"
    dictionaries.en.tierLabel = "service tier"
    dictionaries.zh.tier_standard = "Standard（标准）"
    dictionaries.en.tier_standard = "Standard"
    dictionaries.zh.tier_flex = "Flex（弹性）"
    dictionaries.en.tier_flex = "Flex"
    dictionaries.zh.tier_priority = "Priority（优先）"
    dictionaries.en.tier_priority = "Priority"
    dictionaries.zh.tierNotVerified = "此路由与协议组合在本插件中尚未核实，不能保存；这不代表 Google 不支持。"
    dictionaries.en.tierNotVerified = "This route/protocol combination is not verified by this plugin and cannot be saved; this is not a claim that Google does not support it."
    dictionaries.zh.tierGateHint = "禁用项仅表示该组合在本插件中尚未核实，不代表 Google 不支持。"
    dictionaries.en.tierGateHint = "Disabled options mean the combination is unverified by this plugin, not that Google does not support it."
    dictionaries.zh.tierProtocolBlocked = "切换前请先明确选择兼容的服务等级；使用 Vertex Interactions 时还须关闭 PayGo-only。现有值不会自动修改。"
    dictionaries.en.tierProtocolBlocked = "Before switching, explicitly select a compatible tier; Vertex Interactions also requires PayGo-only off. Existing values are never changed automatically."
    dictionaries.zh.tierMismatch = "当前保存值不符合已核实矩阵。该值保持原样；Host 会在发送前拒绝请求。请明确选择有效等级或关闭 PayGo-only。"
    dictionaries.en.tierMismatch = "The saved value is outside the verified matrix and is preserved. Host will reject the request before sending. Explicitly choose a valid tier or turn off PayGo-only."
    dictionaries.zh.tierUnknown = "当前未识别等级："
    dictionaries.en.tierUnknown = "Unrecognized saved tier: "
    dictionaries.zh.tierMatrixGoogleGC = "Gemini API · GenerateContent：Standard / Flex / Priority。Flex 不自动升级；Priority 需 Google Tier 2/3，可能被服务端降档。实际等级以响应头为准，不等于账单。"
    dictionaries.en.tierMatrixGoogleGC = "Gemini API · GenerateContent: Standard / Flex / Priority. Flex never auto-upgrades; Priority requires Google Tier 2/3 and may be downgraded by the server. Response headers report the actual tier, not an invoice."
    dictionaries.zh.tierMatrixGoogleIA = "Gemini API · Interactions：Standard / Flex / Priority。"
    dictionaries.en.tierMatrixGoogleIA = "Gemini API · Interactions: Standard / Flex / Priority."
    dictionaries.zh.tierMatrixVertexGC = "Vertex AI · GenerateContent：Standard / Priority；Flex 尚未核实。"
    dictionaries.en.tierMatrixVertexGC = "Vertex AI · GenerateContent: Standard / Priority; Flex is unverified."
    dictionaries.zh.tierMatrixVertexIA = "Vertex AI · Interactions：仅 Standard；PayGo-only 尚未核实。"
    dictionaries.en.tierMatrixVertexIA = "Vertex AI · Interactions: Standard only; PayGo-only is unverified."
    dictionaries.zh.paygoLabel = "Vertex 仅使用 PayGo"
    dictionaries.en.paygoLabel = "Vertex PayGo-only"
    dictionaries.zh.paygoHint = "开启时请求共享按量付费路径，不使用预配吞吐量；不保证免费或降低费用。目前只核实 GenerateContent，Interactions 不可开启；已保存的开启值仍可明确关闭。"
    dictionaries.en.paygoHint = "When enabled, request shared pay-as-you-go routing rather than provisioned throughput. It does not guarantee free or lower-cost usage. Verified only for GenerateContent; cannot be enabled for Interactions, but an existing enabled value can be explicitly turned off."
    dictionaries.zh.tierResetHint = "“恢复默认设置”会明确将两路恢复为 Standard 并关闭 PayGo-only；平时切换协议不会更改这些值。"
    dictionaries.en.tierResetHint = "Reset defaults explicitly restores Standard on both routes and turns PayGo-only off; ordinary protocol switches never change these values."

    Object.assign(dictionaries.zh, {
      inspectorDiagnosis: '诊断', inspectorOperations: '操作', inspectorProtocol: '请求协议',
      inspectorGuideHint: '当前会话的请求、用量与费用估算；操作另行确认。',
      inspectorScopeChanged: '会话位置已变化或入口参数无效；请在目标会话的右侧栏重新打开 Argon 诊断。',
      inspectorSessionScope: '范围：当前会话', inspectorAnswerScope: '范围：此条回答（精确关联）',
      inspectorScopeIds: '查看范围标识', inspectorAllRequests: '查看本会话全部请求', inspectorBackToAnswer: '返回此回答的请求',
      inspectorSelectionMissing: '所选请求已不在刷新后的列表中，旧详情已清空。请重新选择。',
      inspectorLocalHint: '仅读取本地保留诊断，最多 100 条；不会自动查询云端或读取原始响应。',
      inspectorOperationsHint: '以下操作分别涉及云读取或全局本地保护；展开前请核对范围。',
      inspectorGlobalRecovery: '全局防重复创建保护 · 本地状态',
      inspectorGlobalHint: '覆盖所有会话的本地保护记录，不是当前回答的任务。解除 unknown 保护可能允许重复付费创建，不会恢复或取消云端任务。',
      inspectorRequestSummary: '请求摘要', inspectorRequestId: '请求标识', inspectorRequestRoute: '请求路由',
      inspectorOutcome: '结果状态', inspectorFinish: '最后保留 hop 的结束原因',
      inspectorCaptureStatus: '原始响应捕获记录', inspectorCapture_disabled: '本次请求未开启留存',
      inspectorCapture_captured: '已捕获（当前是否可读取需单独检查）', inspectorCapture_truncated: '捕获已截断',
      inspectorCapture_unavailable: '捕获不可用', inspectorCapture_unknown: '未记录 / 未知',
      inspectorSettingsHint: '此处仅修改后续请求的默认设置。请求诊断与操作请使用当前会话的 Argon 详情页、右侧栏的 Argon 诊断，或回答下方的详情图标。',
      inspectorKpiRequests: '保留请求', inspectorKpiRoutes: '路由与协议', inspectorKpiTokens: 'Token 构成', inspectorKpiCost: '估算与等级',
      inspectorTokenMix: 'Token 分布与缓存命中', inspectorTokenUncached: '未缓存输入', inspectorTokenCached: '缓存命中',
      inspectorTokenReasoning: '推理思考', inspectorTokenOutput: '输出生成', inspectorTokenTool: '工具提示',
      inspectorTokenTotal: '总计 Token', inspectorCacheHitRate: '缓存命中率', inspectorTimeline: '请求时间线',
      inspectorEyebrow: 'ARGON / 请求检查器', inspectorInput: '输入', inspectorEstimateBadge: 'USD · 估算', inspectorRowsPreview: '预览行数（完整数据见下方）',
      inspectorGcBasis: '所选请求 · 各 hop 合计', inspectorIaBasis: '所选请求 · 累计用量',
      inspectorTokenNotRecorded: '未记录',
      inspectorChartRecordedOnly: '已记录分项合计与总量一致，比例按总量计算；未记录项保持未知，不补零。',
      inspectorChartUnavailable: '分布数据不足、未结算或分项与总量不一致；仅展示已记录数值，不补零。',
      inspectorSelectedScope: '以下 Token 与费用仅属于所选请求', inspectorNoSelection: '未选择请求',
      inspectorMetaScope: '当前保留列表 · 最多 100 条，非会话全历史', inspectorRawTitle: '响应与证据',
      inspectorDashboardHint: '从请求到证据，一处看清。', inspectorLocalOnly: '本地诊断',
      inspectorStepHopTable: 'Step / Hop 轨迹明细',
      inspectorOverview: '当前范围总览', inspectorOverviewKnown: '已知小计', inspectorOverviewComplete: '完整记录合计',
      inspectorOverviewCoverage: '已记录请求', inspectorOverviewCoverageComplete: '完整请求', inspectorOverviewPartial: '部分记录；不是完整总量',
      inspectorOverviewDenied: '无总览读取权限；请求列表仍可单独查看。', inspectorOverviewWindow: '当前本地保留窗口，非全历史或云账单；最多扫描最近 200 条，再按当前范围取最多 100 条。',
      inspectorOverviewLimited: '当前范围匹配记录超过显示上限，较早记录不含在内。', inspectorOverviewDates: '记录时间范围',
      inspectorOverviewCache: '按输入 Token 加权；仅全部请求的缓存与输入均完整有效时展示。',
      inspectorOverviewCost: '已知费用小计（USD）', inspectorOverviewCostComplete: '完整费用估算（USD）',
      inspectorOverviewFields: '各项 Token 合计',
    })
    Object.assign(dictionaries.en, {
      inspectorDiagnosis: 'Diagnosis', inspectorOperations: 'Operations', inspectorProtocol: 'Request protocol',
      inspectorGuideHint: 'Requests, usage and cost estimates for this session; operations require separate actions.',
      inspectorScopeChanged: 'The session surface changed or entry parameters are invalid. Reopen Argon diagnostics from the intended session’s right sidebar.',
      inspectorSessionScope: 'Scope: current session', inspectorAnswerScope: 'Scope: this answer (exact association)',
      inspectorScopeIds: 'Scope identifiers', inspectorAllRequests: 'View all requests in this session', inspectorBackToAnswer: 'Back to this answer’s requests',
      inspectorSelectionMissing: 'The selected request is no longer in the refreshed list. Previous details were cleared; select another request.',
      inspectorLocalHint: 'Local retained diagnostics only, up to 100 records. No automatic cloud lookup or raw response read.',
      inspectorOperationsHint: 'These actions have separate scopes: cloud reads or global local protection.',
      inspectorGlobalRecovery: 'Global duplicate-create protection · local state',
      inspectorGlobalHint: 'Local protection records across all sessions, not tasks for this answer. Releasing unknown protection may allow another paid creation; it does not resume or cancel cloud work.',
      inspectorRequestSummary: 'Request summary', inspectorRequestId: 'Request ID', inspectorRequestRoute: 'Request route',
      inspectorOutcome: 'Outcome', inspectorFinish: 'Last retained hop finish reason',
      inspectorCaptureStatus: 'Raw response capture record', inspectorCapture_disabled: 'Retention was off for this request',
      inspectorCapture_captured: 'Captured (current availability requires a separate read)', inspectorCapture_truncated: 'Capture truncated',
      inspectorCapture_unavailable: 'Capture unavailable', inspectorCapture_unknown: 'Not recorded / unknown',
      inspectorSettingsHint: 'Only defaults for future requests are changed here. Use the session’s Argon details tab, Argon diagnostics in the right sidebar, or the details icon below an answer for diagnostics and operations.',
      inspectorKpiRequests: 'Retained requests', inspectorKpiRoutes: 'Routes & protocols', inspectorKpiTokens: 'Token composition', inspectorKpiCost: 'Estimate & tier',
      inspectorTokenMix: 'Token breakdown & cache hit', inspectorTokenUncached: 'Uncached input', inspectorTokenCached: 'Cached input',
      inspectorTokenReasoning: 'Reasoning', inspectorTokenOutput: 'Output', inspectorTokenTool: 'Tool prompt',
      inspectorTokenTotal: 'Total tokens', inspectorCacheHitRate: 'Cache hit rate', inspectorTimeline: 'Request timeline',
      inspectorEyebrow: 'ARGON / REQUEST INSPECTOR', inspectorInput: 'Input', inspectorEstimateBadge: 'USD · Estimate', inspectorRowsPreview: 'Preview rows (full data below)',
      inspectorGcBasis: 'Selected request · sum of hops', inspectorIaBasis: 'Selected request · cumulative usage',
      inspectorTokenNotRecorded: 'Not recorded',
      inspectorChartRecordedOnly: 'Recorded parts match the reported total; percentages use that total. Missing fields remain unknown, not zero.',
      inspectorChartUnavailable: 'Distribution is insufficient, provisional, or inconsistent with the total. Recorded values only; no zero filling.',
      inspectorSelectedScope: 'Tokens and cost below belong only to the selected request', inspectorNoSelection: 'No request selected',
      inspectorMetaScope: 'Retained list · up to 100, not the full session history', inspectorRawTitle: 'Response & evidence',
      inspectorDashboardHint: 'From request to evidence, in one place.', inspectorLocalOnly: 'Local diagnostics',
      inspectorStepHopTable: 'Step / Hop trajectory',
      inspectorOverview: 'Current scope overview', inspectorOverviewKnown: 'Known subtotal', inspectorOverviewComplete: 'Complete recorded total',
      inspectorOverviewCoverage: 'Reported requests', inspectorOverviewCoverageComplete: 'Complete requests', inspectorOverviewPartial: 'Partial records; not a complete total',
      inspectorOverviewDenied: 'No permission to read the overview; individual requests remain available in the list.', inspectorOverviewWindow: 'Current local retained window, not all history or cloud billing; scans at most the latest 200 records, then takes up to 100 for this scope.',
      inspectorOverviewLimited: 'Matching retained records exceed the display limit; earlier records are excluded.', inspectorOverviewDates: 'Record time range',
      inspectorOverviewCache: 'Weighted by input tokens; shown only when every request has complete, valid cache/input counts.',
      inspectorOverviewCost: 'Known cost subtotal (USD)', inspectorOverviewCostComplete: 'Complete cost estimate (USD)',
      inspectorOverviewFields: 'Token totals by field',
    })

    function installAdjacentPicker(ctx) {
      const slot = 'conversation.input.model'
      const lenses = new WeakMap()
      function lens(source) {
        if (lenses.has(source)) return lenses.get(source)
        let previous; let projected
        const view = {
          subscribe: listener => source.subscribe(listener),
          getSnapshot() {
            const state = source.getSnapshot()
            if (state === previous) return projected
            previous = state; projected = state
            const groups = state?.groups
            if (!Array.isArray(groups)) return projected
            const native = groups.findIndex(group => group.id === 'google-vertex')
            const argon = groups.findIndex(group => group.id === 'google-vertex-argon')
            if (native < 0 || argon < 0 || argon === native + 1) return projected
            const rest = groups.filter(group => group.id !== 'google-vertex-argon')
            const at = rest.findIndex(group => group.id === 'google-vertex') + 1
            projected = { ...state, groups: [...rest.slice(0, at), groups[argon], ...rest.slice(at)] }
            return projected
          },
        }
        lenses.set(source, view)
        return view
      }
      function OrderedPicker({ originalComponent, ...props }) { return h(originalComponent, props) }
      return ctx.slots.inject(slot, () => {
        let original; let stop = () => {}; let updating = false; let disposed = false
        const sync = () => {
          if (updating || disposed) return
          const others = ctx.slots.entries(slot).filter(entry => entry.component !== OrderedPicker)
          const candidate = others.length === 1 ? others[0] : undefined
          const next = candidate?.locale === 'model' && typeof candidate.inject === 'function' &&
            (candidate.options.priority ?? 0) === 0 && !candidate.children && !candidate.store ? candidate : undefined
          if (next === original) return
          updating = true
          try {
            stop(); stop = () => {}; original = next
            if (next) stop = ctx.slots.register({
              name: slot, priority: -10, locale: next.locale,
              inject: (...args) => {
                const props = next.inject(...args)
                const source = props.directory
                const directory = source && typeof source.getSnapshot === 'function' && typeof source.subscribe === 'function' ? lens(source) : source
                return { ...props, directory, originalComponent: next.component }
              },
            }, OrderedPicker)
          } finally { updating = false }
        }
        const unsubscribe = ctx.slots.subscribe(slot, sync)
        sync()
        return () => { disposed = true; unsubscribe(); stop() }
      })
    }

    // toLocaleTimeString rebuilt a formatter for every rendered row. The cached
    // one is byte-identical: hour/minute/second numeric with hour12:false keeps
    // zh-CN and en-GB zero-padded hours and never rewrites a ko-KR pattern.
    const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false })

    function formatTimeShort(iso) {
      if (typeof iso !== 'string') return ''
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return iso.slice(11, 19)
      return timeFormatter.format(d)
    }

    function formatDuration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '0ms'
      if (ms < 1000) return Math.round(ms) + 'ms'
      return (ms / 1000).toFixed(2) + 's'
    }

    // Number#toLocaleString allocated a formatter per rendered value; the
    // cached formatter prints identically, including 786432 -> "786,432".
    const numberFormatter = new Intl.NumberFormat()

    function DiagnosticsPanel({ loadDiagnostics, t }) {
      const [open, setOpen] = React.useState(false)
      const [loading, setLoading] = React.useState(false)
      const [error, setError] = React.useState(false)
      const [records, setRecords] = React.useState([])

      const refresh = React.useCallback(async () => {
        if (typeof loadDiagnostics !== 'function') {
          setError(true)
          return
        }
        setLoading(true)
        setError(false)
        try {
          const res = await loadDiagnostics(20)
          if (res && res.ok === true && Array.isArray(res.records)) {
            setRecords(res.records)
          } else {
            setError(true)
          }
        } catch {
          setError(true)
        } finally {
          setLoading(false)
        }
      }, [loadDiagnostics])

      React.useEffect(() => {
        if (open) void refresh()
      }, [open, refresh])

      const fmt = n => (typeof n === 'number' && Number.isFinite(n) ? numberFormatter.format(n) : '-')
      const total = records.length
      const okCount = records.filter(r => r.outcome === 'done' || r.outcome === 'tool-calls' || r.outcome === 'max-tokens').length
      const contHops = records.reduce((acc, r) => acc + (r.continuationCount || 0), 0)
      const recoveredCount = records.filter(r => r.recoveredFromDrop).length
      const errCount = records.filter(r => r.outcome === 'error').length

      const outcomeBadge = r => {
        if (r.recoveredFromDrop) return { text: t('diagOutcome_recovered'), cls: 'badge-recovered' }
        switch (r.outcome) {
          case 'done': return { text: t('diagOutcome_done'), cls: 'badge-ok' }
          case 'tool-calls': return { text: t('diagOutcome_tool'), cls: 'badge-ok' }
          case 'max-tokens': return { text: t('diagOutcome_max'), cls: 'badge-warn' }
          case 'error': return { text: t('diagOutcome_error'), cls: 'badge-err' }
          case 'aborted': return { text: t('diagOutcome_aborted'), cls: 'badge-muted' }
          default: return { text: t('diagOutcome_incomplete'), cls: 'badge-muted' }
        }
      }

      const triggerLabel = tr => {
        switch (tr) {
          case 'continuation': return t('diagTrigger_continuation')
          case 'checkpoint-reconnect': return t('diagTrigger_reconnect')
          case 'retry-same-checkpoint': return t('diagTrigger_retry')
          case 'retry-original': return t('diagTrigger_original')
          case 'interaction-create': return t('diagTrigger_icreate')
          case 'interaction-resume': return t('diagTrigger_iresume')
          case 'initial': return t('diagTrigger_initial')
          default: return tr
        }
      }

      return h('div', { className: 'card' },
        h('div', { className: 'row', style: { marginBottom: '4px' } },
          h('button', {
            type: 'button',
            className: 'diag-toggle',
            'aria-expanded': open,
            onClick: () => setOpen(!open),
          },
            h('span', { style: { marginRight: '6px', display: 'inline-block' } }, open ? '▾' : '▸'),
            h('strong', null, t('diagTitle')),
          ),
          open
            ? h('button', { type: 'button', disabled: loading, onClick: refresh }, loading ? t('diagLoading') : t('diagRefresh'))
            : null,
        ),
        h('p', { className: 'muted', style: { marginBottom: open ? '12px' : '0' } }, t('diagSubtitle')),
        open
          ? h('div', { className: 'diag-body' },
              error
                ? h('p', { className: 'status error', role: 'alert' }, t('diagError'))
                : records.length === 0 && !loading
                  ? h('p', { className: 'muted' }, t('diagEmpty'))
                  : h(React.Fragment, null,
                      h('div', { className: 'diag-stats' },
                        h('span', { className: 'diag-stat' }, t('diagStatTotal') + ': ' + total),
                        h('span', { className: 'diag-stat' }, t('diagStatOk') + ': ' + okCount),
                        h('span', { className: 'diag-stat' }, t('diagStatCont') + ': ' + contHops),
                        h('span', { className: 'diag-stat' }, t('diagStatRecovered') + ': ' + recoveredCount),
                        h('span', { className: 'diag-stat' }, t('diagStatErr') + ': ' + errCount),
                      ),
                      h('div', { className: 'diag-list' },
                        ...records.map(r => {
                          const badge = outcomeBadge(r)
                          const u = r.tokenUsage || {}
                          const hops = Array.isArray(r.hops) ? r.hops : []
                          const hopsDropped = typeof r.hopsDropped === 'number' && r.hopsDropped > 0 ? r.hopsDropped : 0
                          const showHops = hops.length > 1 || r.reconnectCount > 0 || hopsDropped > 0 || r.outcome === 'error'
                          const routeLabel = r.route === 'google-generative-ai' ? 'Gemini API' : 'Vertex AI'
                          const reqCapText = typeof r.configuredMaxTokens === 'number' && Number.isFinite(r.configuredMaxTokens)
                            ? fmt(r.configuredMaxTokens)
                            : t('diagUnrecorded')
                          return h('div', { key: r.id, className: 'diag-item' },
                            h('div', { className: 'diag-item-head' },
                              h('span', { className: 'diag-mono' }, formatTimeShort(r.startedAt)),
                              h('span', { className: 'diag-chip' }, routeLabel + ' · ' + r.apiVersion),
                              h('span', { className: 'diag-chip' }, (r.protocol || 'generate-content') + (r.background ? ' · background' : '')),
                              h('span', { className: 'diag-chip' }, r.thinkingLevel),
                              h('span', { className: 'diag-chip' }, t('diagReqCap') + ': ' + reqCapText),
                              r.remoteCancellation === 'unconfirmed' ? h('span', { className: 'diag-chip badge-err' }, t('diagCancelUnconfirmed')) : null,
                              r.remoteCancellation === 'confirmed' ? h('span', { className: 'diag-chip badge-muted' }, t('diagCancelConfirmed')) : null,
                              h('span', { className: 'diag-badge ' + badge.cls }, badge.text),
                              r.failureCategory ? h('span', { className: 'diag-chip badge-err' }, r.failureCategory) : null,
                              h('span', { className: 'diag-mono', style: { marginLeft: 'auto' } },
                                (r.hopCount || 1) + ' hop' + ((r.hopCount || 1) > 1 ? 's' : '') + ' · ' + formatDuration(r.durationMs)
                              ),
                            ),
                            u.reportedInputTokens !== null || u.outputTokens !== null
                              ? h('div', { className: 'diag-tokens muted' },
                                  'Tokens — In: ' + fmt(u.reportedInputTokens) +
                                  (u.reportedCacheTokens ? ' (Cache: ' + fmt(u.reportedCacheTokens) + ')' : '') +
                                  ' · Out: ' + fmt(u.outputTokens) +
                                  (u.thoughtsTokens ? ' · Think: ' + fmt(u.thoughtsTokens) : '') +
                                  ((r.hopCount || 1) > 1 && u.billedTotalTokens !== null
                                    ? ' | Billed In: ' + fmt(u.billedPromptTokens) + ' · Billed Total: ' + fmt(u.billedTotalTokens)
                                    : '')
                                )
                              : null,
                            showHops
                              ? h('div', { className: 'diag-hops' },
                                  ...hops.map(hp =>
                                    h('div', { key: hp.hopIndex, className: 'diag-hop-row' },
                                      '#' + hp.hopIndex + ' [' + triggerLabel(hp.trigger) + ']' +
                                      (hp.backoffDelayMs > 0 ? ' (backoff ' + hp.backoffDelayMs + 'ms)' : '') +
                                      ' · HTTP ' + (hp.status ?? '-') +
                                      (hp.errorPhase ? ' · ' + t('diagPhase') + ': ' + hp.errorPhase : '') +
                                      (hp.requestSubmitted === false ? ' · ' + t('diagNotSubmitted') : '') +
                                      ' · ' + hp.chunkCount + ' chunks' +
                                      (hp.finishReason ? ' · ' + hp.finishReason : '') +
                                      (Array.isArray(hp.errorCodes) && hp.errorCodes.length > 0 ? ' · ' + hp.errorCodes.join(',') : '') +
                                      ' · ' + formatDuration(hp.durationMs)
                                    )
                                  ),
                                  hopsDropped > 0
                                    ? h('div', { className: 'diag-hop-row' }, t('diagHopsDroppedPrefix') + hopsDropped + t('diagHopsDroppedSuffix'))
                                    : null,
                                )
                              : null,
                          )
                        }),
                      ),
                    ),
              h('p', { className: 'muted', style: { marginTop: '10px', fontSize: '12px' } }, t('diagStorageHint')),
            )
          : null,
      )
    }

    function formWritable(form) {
      const snapshot = form.getSnapshot()
      return snapshot.status === 'ready' && snapshot.writable === true
    }

    function RecoveryPanel({ form, disabled, loadRecovery, releaseRecovery, t }) {
      // Settings no longer renders this panel; keep its write-state projection live here.
      React.useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot(), () => form.getSnapshot())
      const [records, setRecords] = React.useState([])
      const [loading, setLoading] = React.useState(false)
      const [error, setError] = React.useState('')
      const [confirmation, setConfirmation] = React.useState(null)
      const [acknowledged, setAcknowledged] = React.useState(false)
      const [releasing, setReleasing] = React.useState(false)
      const [success, setSuccess] = React.useState(false)
      // Synchronous gates also protect retained callbacks and rapid double clicks.
      const gate = React.useRef({ records: [], loading: false, releasing: false, confirmation: null, acknowledged: false, released: new Set(), disposed: false })
      const version = row => row.key + ':' + row.updatedAt
      const released = row => row.releasedAt !== null || gate.current.released.has(version(row))
      const eligible = row => row && !row.hasRemoteId && !row.active && !released(row) && ['creating', 'unknown'].includes(row.stage)
      const canChange = () => !disabled && formWritable(form) && !gate.current.loading && !gate.current.releasing && !gate.current.disposed
      const currentRow = row => gate.current.records.find(current => current.key === row.key && current.updatedAt === row.updatedAt)
      const selected = row => gate.current.confirmation === version(row)
      const clearConfirmation = () => {
        gate.current.confirmation = null; gate.current.acknowledged = false
        setConfirmation(null); setAcknowledged(false)
      }

      const refresh = React.useCallback(async (afterRelease = false) => {
        const state = gate.current
        if (state.loading || state.disposed || (state.releasing && !afterRelease)) return
        state.loading = true
        setLoading(true); setError(''); clearConfirmation()
        if (!afterRelease) setSuccess(false)
        try {
          const result = parseRecoveryResult(await loadRecovery(20))
          if (state.disposed) return
          if (!result.ok) throw new Error(result.error)
          state.records = result.records
          setRecords(result.records)
        } catch (err) {
          if (!state.disposed) {
            // Stale rows may remain for audit, but cannot authorize an action.
            state.records = []
            setError(err?.message || 'Read failed')
          }
        } finally {
          state.loading = false
          if (!state.disposed) setLoading(false)
        }
      }, [loadRecovery])

      React.useEffect(() => {
        gate.current.disposed = false
        void refresh()
        return () => { gate.current.disposed = true }
      }, [refresh])

      const openConfirmation = row => {
        if (!canChange() || !eligible(currentRow(row))) return
        gate.current.confirmation = version(row); gate.current.acknowledged = false
        setConfirmation(version(row)); setAcknowledged(false); setSuccess(false); setError('')
      }
      const acknowledge = (row, checked) => {
        if (!canChange() || !selected(row) || !eligible(currentRow(row))) return
        gate.current.acknowledged = checked === true
        setAcknowledged(checked === true)
      }
      const cancel = row => {
        if (!canChange() || !selected(row)) return
        clearConfirmation()
      }
      const confirm = async row => {
        if (!canChange() || !selected(row) || !gate.current.acknowledged || !eligible(currentRow(row))) return
        gate.current.releasing = true
        setReleasing(true); setError(''); setSuccess(false)
        try {
          const result = parseReleaseResult(await releaseRecovery({ key: row.key, expectedUpdatedAt: row.updatedAt, acknowledgeRisk: true }))
          if (gate.current.disposed) return
          if (!result.ok) throw new Error(result.error)
          gate.current.released.add(version(row))
          clearConfirmation(); setSuccess(true)
          await refresh(true)
        } catch (err) {
          if (!gate.current.disposed) {
            clearConfirmation()
            setError(err?.message || 'Release failed')
          }
        } finally {
          gate.current.releasing = false
          if (!gate.current.disposed) setReleasing(false)
        }
      }
      const blocked = disabled || !formWritable(form) || loading || releasing
      const sorted = [...records].sort((a, b) => Number(released(a)) - Number(released(b)) || (b.updatedAt < a.updatedAt ? -1 : (b.updatedAt > a.updatedAt ? 1 : 0))).slice(0, 20)
      return h('div', { className: 'card', 'aria-label': t('recoveryTitle') },
        h('div', { className: 'row' },
          h('h3', null, t('recoveryTitle')),
          h('button', { type: 'button', disabled: loading || releasing, onClick: () => refresh() }, t(loading ? 'recoveryLoading' : 'recoveryRefresh')),
        ),
        h('p', { className: 'muted' }, t('recoveryHint')),
        error ? h('p', { className: 'status error', role: 'alert' }, t('recoveryError') + error) : null,
        success ? h('p', { className: 'status', role: 'status' }, t('recoverySuccess')) : null,
        !records.length && !loading && !error ? h('p', { className: 'muted' }, t('recoveryEmpty')) : null,
        h('div', { className: 'diag-list' }, ...sorted.map(row => {
          const showConfirmation = confirmation === version(row) && eligible(row)
          return h('div', { className: 'diag-item', key: row.key },
            h('div', { className: 'diag-item-head' },
              h('span', { className: 'diag-mono' }, t('recoverySession') + ': ' + row.sessionHash),
              h('span', { className: 'diag-chip' }, t('recoveryStage_' + row.stage)),
              released(row) ? h('span', { className: 'diag-chip badge-muted' }, t('recoveryReleased')) : null,
            ),
            h('p', { className: 'muted' }, t('recoveryUpdated') + ': ' + new Date(row.updatedAt).toLocaleString()),
            row.uncertainAt ? h('p', { className: 'muted' }, t('recoveryUncertain') + ': ' + new Date(row.uncertainAt).toLocaleString()) : null,
            row.releasedAt ? h('p', { className: 'muted' }, t('recoveryReleased') + ': ' + new Date(row.releasedAt).toLocaleString()) : null,
            row.hasRemoteId ? h('p', { className: 'muted' }, t('recoveryKnownId')) : null,
            row.active ? h('p', { className: 'muted' }, t('recoveryActive')) : null,
            eligible(row) ? h('button', {
              type: 'button', disabled: blocked || !eligible(currentRow(row)), 'aria-expanded': showConfirmation,
              onClick: () => openConfirmation(row),
            }, t('recoveryRelease')) : null,
            showConfirmation ? h('div', { className: 'recovery-confirm', role: 'group', 'aria-label': t('recoveryConfirm') },
              h('label', { className: 'recovery-risk' },
                h('input', { type: 'checkbox', checked: acknowledged, disabled: blocked,
                  onChange: event => acknowledge(row, event.target.checked) }),
                t('recoveryRisk'),
              ),
              h('div', { className: 'group' },
                h('button', { type: 'button', disabled: blocked || !acknowledged, onClick: () => confirm(row) }, t(releasing ? 'recoveryReleasing' : 'recoveryConfirm')),
                h('button', { type: 'button', disabled: blocked, onClick: () => cancel(row) }, t('recoveryCancel')),
              ),
            ) : null,
          )
        })),
      )
    }

    const INSPECTOR_KIND = 'argon-inspector'
    const INSPECTOR_KEY = 'dsh-vertex-argon/inspector'
    const inspectorEndpoint = method => 'vertexArgonDiagnostics/' + method
    const jsonEvidence = value => JSON.stringify(value, null, 2)

    function InspectorEntry({ sessionId, messageId, openInspector, t }) {
      const [unavailable, setUnavailable] = React.useState(false)
      if (typeof sessionId !== 'string' || !sessionId.trim() || typeof messageId !== 'string' || !messageId.trim()) return null
      return h(React.Fragment, null,
        h('style', null,
          '.argon-inspector-entry{display:inline-flex;align-items:center;justify-content:center;width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));padding:6px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}' +
          '.argon-inspector-entry:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}.argon-inspector-entry:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.argon-inspector-entry svg{width:calc(17px + var(--dsh-content-font-delta,0px));height:calc(17px + var(--dsh-content-font-delta,0px))}',
        ),
        h('button', { type: 'button', className: 'argon-inspector-entry', title: t('inspectorOpen'), 'aria-label': t('inspectorOpen'),
          onClick: () => setUnavailable(openInspector(sessionId, messageId) !== true),
        }, h('svg', { viewBox: '0 0 24 24', width: 17, height: 17, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: 'false' },
          h('rect', { x: 5, y: 3, width: 14, height: 18, rx: 2 }), h('path', { d: 'M9 8h6M9 12h6M9 16h3' }))),
        unavailable ? h('span', { role: 'status', style: { color: 'var(--dsw-alias-label-secondary)' } }, t('inspectorScopeChanged')) : null,
      )
    }

    function Inspector({ sessionId, useTabInfo, ...props }) {
      const { tab } = useTabInfo()
      const params = tab.navigation.params
      // Native Guide opens without params. Explicit malformed or mismatched
      // params never become a current-session or latest-request view.
      const guide = params === undefined || (inspectorObject(params) && Object.keys(params).length === 0)
      const validMessage = value => value === undefined || (typeof value === 'string' && Boolean(value.trim()))
      const validScope = typeof sessionId === 'string' && Boolean(sessionId.trim()) && (guide ||
        (inspectorObject(params) && Object.keys(params).every(key => ['sessionId', 'messageId', 'returnMessageId'].includes(key)) &&
          params.sessionId === sessionId && validMessage(params.messageId) && validMessage(params.returnMessageId) &&
          !(params.messageId !== undefined && params.returnMessageId !== undefined)))
      if (!tab.visible || tab.signal.aborted) return null
      if (!validScope) return h('p', { role: 'alert' }, props.t('inspectorScopeChanged'))
      const messageId = guide ? undefined : params.messageId
      const returnMessageId = guide ? undefined : params.returnMessageId
      // Preserve only this tab's explicit answer origin, never a global/latest answer.
      // The origin is navigation state; it is not sent with whole-session reads.
      return h(InspectorSurface, { ...props, sessionId, messageId,
        signal: tab.signal, scopeRevision: tab.navigation.revision,
        showSession: messageId ? () => tab.actions.openTab(INSPECTOR_KIND, { params: { sessionId, returnMessageId: messageId }, replaceTab: true }) : undefined,
        showAnswer: returnMessageId ? () => tab.actions.openTab(INSPECTOR_KIND, { params: { sessionId, messageId: returnMessageId }, replaceTab: true }) : undefined,
      })
    }

    function ConversationInspector({ sessionId, ...props }) {
      const [lifetime, setLifetime] = React.useState(null)
      // Native conversation.view mounts only the selected View. Own its lifetime
      // here, not through a fabricated sidebar tab. Each effect setup gets a fresh
      // controller, including StrictMode's cleanup/re-setup cycle.
      React.useEffect(() => {
        const controller = new AbortController()
        setLifetime({ sessionId, controller })
        return () => controller.abort()
      }, [sessionId])
      // Own the entire View's hit area, including empty/loading space. A normal
      // content layer sits above the resident transcript handles, below its composer.
      // No Host selectors, width preferences or sidebar layout are changed.
      const validSession = typeof sessionId === 'string' && Boolean(sessionId.trim())
      const ready = lifetime && lifetime.sessionId === sessionId && !lifetime.controller.signal.aborted
      return h('div', { className: 'argon-conversation-page',
        style: { position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', flex: '1', minWidth: 0, minHeight: 0 },
      }, !validSession ? h('p', { role: 'alert' }, props.t('inspectorScopeChanged'))
        : ready ? h(InspectorSurface, { ...props, sessionId, signal: lifetime.controller.signal }) : null)
    }

    function InspectorSurface({ sessionId, messageId, signal, scopeRevision, useAccess, useRemoteAccess, resetSource, ...props }) {
      const reset = React.useSyncExternalStore(resetSource.subscribe, resetSource.getSnapshot, resetSource.getSnapshot)
      // Undefined access is deny; Host reauthorizes every RPC on either surface.
      const permissions = {
        listRequests: useAccess(inspectorEndpoint('listRequests')) === true,
        getOverview: useAccess(inspectorEndpoint('getOverview')) === true,
        getRequest: useAccess(inspectorEndpoint('getRequest')) === true,
        readResponse: useAccess(inspectorEndpoint('readResponse')) === true,
        queryInteraction: useRemoteAccess(inspectorEndpoint('queryInteraction')) === true,
        readQueryResponse: useRemoteAccess(inspectorEndpoint('readQueryResponse')) === true,
        listRecovery: useRemoteAccess(inspectorEndpoint('listRecovery')) === true,
        releaseUnknown: useRemoteAccess(inspectorEndpoint('releaseUnknown')) === true,
      }
      if (signal.aborted) return null
      // Navigation/session/access/reset destroys results and cancels pending work.
      return h(InspectorBody, { ...props, sessionId, messageId, signal, permissions, resetSource,
        key: JSON.stringify([sessionId, messageId, scopeRevision, reset, Object.values(permissions)]),
      })
    }

    const INSPECTOR_CSS = "\n.argon-inspector{box-sizing:border-box;min-width:0;width:100%;height:100%;padding:20px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);line-height:1.55;font-size:13px;overflow:auto;container:argon-inspector/inline-size;scrollbar-gutter:stable}\n.argon-inspector *{box-sizing:border-box}\n.argon-inspector h2{font-size:24px;line-height:1.25;font-weight:650;letter-spacing:-.6px;margin:4px 0 8px}\n.argon-inspector h3{font-size:14px;font-weight:600;margin:0 0 8px}\n.argon-inspector h4{font-size:13px;margin:10px 0}\n.argon-inspector p{overflow-wrap:anywhere;margin:8px 0}\n.argon-inspector .muted,.argon-inspector dt{color:var(--dsw-alias-label-secondary)}\n.argon-inspector .ag-small{font-size:11px;line-height:1.6}\n.argon-inspector .ag-header{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:18px}\n.argon-inspector .ag-eyebrow{font-size:10px;letter-spacing:1.8px;font-weight:600;color:var(--dsw-alias-brand-primary)}\n.argon-inspector .ag-toolbar,.argon-inspector .group,.argon-inspector .row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}\n.argon-inspector .ag-toolbar{padding:10px 0;border-block:1px solid var(--dsw-alias-border-l1)}\n.argon-inspector button,.argon-inspector input,.argon-inspector select{font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 10px;max-width:100%;min-width:0}\n.argon-inspector button{cursor:pointer;transition:background .15s,border-color .15s;min-height:32px;text-align:start}\n.argon-inspector button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary)}\n.argon-inspector button:disabled{opacity:.5;cursor:not-allowed}\n.argon-inspector :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}\n.argon-inspector .ag-segmented{background:var(--dsw-alias-bg-layer-2);padding:3px;border-radius:10px;gap:2px}\n.argon-inspector .ag-segmented button{border-color:transparent;background:transparent;min-height:28px;padding:4px 14px}\n.argon-inspector .ag-segmented button[aria-pressed=true]{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-brand-primary);font-weight:600}\n.argon-inspector .ag-refresh{margin-inline-start:auto}\n.argon-inspector details{min-width:0}\n.argon-inspector summary{cursor:pointer;overflow-wrap:anywhere;padding:6px 0;font-size:12px}\n.argon-inspector .ag-scope{font-size:11px;color:var(--dsw-alias-label-secondary);margin:6px 0 14px}\n.argon-inspector .card{min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:16px;margin:0}\n.argon-inspector .ag-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:12px}\n.argon-inspector .ag-card-head h3{margin:0}\n.argon-inspector .ag-overview,.argon-inspector .ag-selected-kpis{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:12px 0}\n.argon-inspector .ag-metric{min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:5px;border-top:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,var(--dsw-alias-border-l2))}\n.argon-inspector .ag-metric-label{font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}\n.argon-inspector .ag-kpi-value{font-size:24px;line-height:1.3;font-weight:600;letter-spacing:-.6px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}\n.argon-inspector .ag-workbench{display:grid;grid-template-columns:minmax(0,1fr);align-items:start;gap:16px;margin-top:14px}\n.argon-inspector .ag-detail-column{min-width:0;display:grid;gap:14px}\n.argon-inspector .ag-selected-scope{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary)}\n.argon-inspector .ag-selected-kpis{margin:0}\n.argon-inspector label{display:block;margin:8px 0;font-size:12px}\n.argon-inspector label>input:not([type=checkbox]),.argon-inspector label>select{display:block;width:100%;margin-top:6px}\n.argon-inspector .ag-request-select{font-size:11px;color:var(--dsw-alias-label-secondary);margin:0 0 12px}\n.argon-inspector .ag-request-select select{font-size:11px}\n.argon-inspector .ag-request-list{display:flex;flex-direction:column;gap:8px;max-height:480px;overflow-y:auto;padding:3px}\n.argon-inspector .ag-request-item{width:100%;height:auto;flex:0 0 auto;white-space:normal;display:flex;flex-direction:column;gap:6px;padding:12px;border-radius:9px;position:relative;overflow-wrap:anywhere}\n.argon-inspector .ag-request-item[aria-pressed=true]{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,var(--dsw-alias-bg-layer-1));box-shadow:inset 3px 0 var(--dsw-alias-brand-primary)}\n.argon-inspector .ag-request-line{display:flex;align-items:center;justify-content:space-between;gap:6px;width:100%;flex-wrap:wrap;font-size:12px}\n.argon-inspector .ag-request-id{font:10px/1.5 ui-monospace,monospace;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}\n.argon-inspector .ag-pill{display:inline-flex;align-items:center;max-width:100%;gap:5px;font-size:10px;line-height:1.5;padding:3px 7px;border-radius:6px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);overflow-wrap:anywhere}\n.argon-inspector [data-tone=success]{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}\n.argon-inspector [data-tone=warn],.argon-inspector .ag-pill-amber{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent)}\n.argon-inspector [data-tone=error],.argon-inspector [role=alert]{color:var(--dsw-alias-state-error-primary)}\n.argon-inspector .ag-empty{min-height:150px;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;gap:8px;padding:24px 8px;color:var(--dsw-alias-label-secondary)}\n.argon-inspector .ag-detail-empty .ag-empty{min-height:280px}\n.argon-inspector .ag-empty-symbol{font-size:28px;color:var(--dsw-alias-brand-primary)}\n.argon-inspector .ag-definition-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(180px,100%),1fr));gap:12px;margin:10px 0}\n.argon-inspector dt{font-size:11px}.argon-inspector dd{margin:4px 0 0;overflow-wrap:anywhere;font-size:12px}\n.argon-inspector .ag-token-body{display:flex;gap:18px;align-items:center;flex-wrap:wrap;padding:10px 0 16px}\n.argon-inspector .ag-donut-wrap{flex:0 0 112px;width:112px;height:112px;position:relative}\n.argon-inspector .ag-donut-svg{display:block;transform:rotate(-90deg)}\n.argon-inspector .ag-donut-center{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:3px;font-size:10px;color:var(--dsw-alias-label-secondary);pointer-events:none}\n.argon-inspector .ag-donut-val{font-size:15px;max-width:86px;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;text-align:center}\n.argon-inspector .ag-token-right{flex:1 1 180px;min-width:0}\n.argon-inspector .ag-legend-grid{display:grid;gap:7px}\n.argon-inspector .ag-legend-item{display:grid;grid-template-columns:8px minmax(0,1fr) auto 42px;align-items:center;gap:8px;font-size:11px}\n.argon-inspector .ag-legend-dot{width:7px;height:7px;border-radius:2px}\n.argon-inspector .ag-legend-num,.argon-inspector .ag-legend-pct,.argon-inspector .ag-hop-tot{font-variant-numeric:tabular-nums;text-align:right}\n.argon-inspector .ag-legend-pct{color:var(--dsw-alias-label-secondary)}\n.argon-inspector .ag-cache-rate{font-size:11px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px}\n.argon-inspector .ag-kv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:8px;margin-top:8px}\n.argon-inspector .ag-kv-cell{margin:0;padding:10px;background:var(--dsw-alias-bg-layer-2);border-radius:8px;font-size:12px;font-variant-numeric:tabular-nums}\n.argon-inspector .ag-kv-wide{grid-column:1/-1}\n.argon-inspector .ag-hint-banner{font-size:11px;color:var(--dsw-alias-label-secondary);padding:10px 12px;background:var(--dsw-alias-bg-layer-2);border-radius:8px}\n.argon-inspector .ag-subhead{font-size:12px;font-weight:600}\n.argon-inspector .ag-hop-visual{margin:16px 0}.argon-inspector .ag-hop-list{display:grid;gap:6px;margin-top:8px}\n.argon-inspector .ag-hop-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border-bottom:1px solid var(--dsw-alias-border-l1);padding:6px 0;font-size:11px}\n.argon-inspector .ag-hop-tot{margin-left:auto}.argon-inspector .ag-hop-nums{overflow-wrap:anywhere}\n.argon-inspector .ag-drawers{border-top:1px solid var(--dsw-alias-border-l1);margin-top:12px;padding-top:6px}\n.argon-inspector .ag-details summary{padding:9px 0;color:var(--dsw-alias-label-secondary)}\n.argon-inspector pre{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;max-height:360px;overflow:auto;padding:12px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;font:11px/1.65 ui-monospace,monospace}\n.argon-inspector .ag-notice{padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}\n.argon-inspector .ag-progress-track{height:3px;background:var(--dsw-alias-border-l1);margin:10px 0}.argon-inspector .ag-progress-fill{height:100%;background:var(--dsw-alias-brand-primary)}\n.argon-inspector .ag-mono-meta{font-size:11px;font-variant-numeric:tabular-nums}.argon-inspector .ag-chip-line{font-size:11px}\n.argon-inspector .ag-operations{display:grid;gap:12px;margin-top:12px}.argon-inspector .ag-operations>.card>summary{font-weight:600;padding:5px 0}\n.argon-inspector .diag-list{display:grid;gap:10px;margin-top:12px}.argon-inspector .diag-item{padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}.argon-inspector .diag-item-head{display:flex;flex-wrap:wrap;gap:8px}\n.argon-inspector .diag-chip{font-size:11px;border-radius:5px;padding:2px 6px;background:var(--dsw-alias-bg-layer-2)}.argon-inspector .recovery-confirm{border-top:1px solid var(--dsw-alias-border-l2);margin-top:12px;padding-top:10px}.argon-inspector .recovery-risk{display:flex;align-items:flex-start;gap:8px}\n@container argon-inspector (min-width:760px){.argon-inspector .ag-workbench{grid-template-columns:minmax(240px,.85fr) minmax(0,2fr)}.argon-inspector .ag-overview{grid-template-columns:repeat(4,minmax(0,1fr))}.argon-inspector .ag-selected-kpis{grid-template-columns:repeat(3,minmax(0,1fr))}}\n@container argon-inspector (max-width:400px){.argon-inspector .ag-header{align-items:flex-start}.argon-inspector .ag-header>.ag-pill{display:none}.argon-inspector .ag-selected-kpis{grid-template-columns:minmax(0,1fr)}.argon-inspector .ag-kpi-value{font-size:20px}.argon-inspector .ag-request-list{max-height:220px}.argon-inspector .card{padding:12px}}\n@media (prefers-reduced-motion:no-preference){.argon-inspector .ag-donut-arc{animation:argon-chart-in .3s ease-out}@keyframes argon-chart-in{from{opacity:0}to{opacity:1}}}\n"

    const OVERVIEW_CSS = '\n.argon-inspector .ag-scope-overview{margin:14px 0}.argon-inspector .ag-scope-overview .ag-overview{grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));margin:12px 0}.argon-inspector .ag-overview-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,140px),1fr));gap:14px;margin:12px 0}.argon-inspector .ag-overview-fields dd{margin:4px 0;font-variant-numeric:tabular-nums;font-size:17px}.argon-inspector .ag-overview-fields small{display:block;font-size:11px;color:var(--dsw-alias-label-secondary)}'
    function ScopeOverview({ overview, t, metric, busy, allowed }) {
      const coverage = value => t('inspectorOverviewCoverage') + ': ' + (value?.reportedRequests ?? 0) + '/' + overview.requestCount + ' · ' + t('inspectorOverviewCoverageComplete') + ': ' + (value?.completeRequests ?? 0) + '/' + overview.requestCount
      const total = overview?.tokens?.totalTokens, cost = overview?.cost
      const money = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? '$' + value.toFixed(6) : '—'
      const completeCost = cost?.estimatedUsd != null
      const fields = [['inputTokens', 'inspectorInput'], ['cachedTokens', 'inspectorTokenCached'], ['outputTokens', 'inspectorTokenOutput'], ['thoughtTokens', 'inspectorTokenReasoning'], ['toolTokens', 'inspectorTokenTool']]
      return h('section', { className: 'card ag-scope-overview', 'data-overview': true, 'aria-label': t('inspectorOverview') },
        h('h3', null, t('inspectorOverview')),
        h('p', { className: 'muted ag-small' }, t('inspectorOverviewWindow')),
        !allowed ? h('p', { role: 'status' }, t('inspectorOverviewDenied')) : !overview ? h('p', { role: 'status' }, t(busy ? 'inspectorLoading' : 'inspectorStart')) : h(React.Fragment, null,
          overview.window?.limited ? h('p', { className: 'ag-notice' }, t('inspectorOverviewLimited')) : null,
          h('div', { className: 'ag-overview' },
            metric('overview-total', t('inspectorTokenTotal') + ' · ' + t(total?.complete ? 'inspectorOverviewComplete' : 'inspectorOverviewKnown'), tokenText(total?.knownSubtotal), coverage(total)),
            metric('overview-cache', t('inspectorCacheHitRate'), typeof overview.cache?.percent === 'number' && Number.isFinite(overview.cache.percent) ? overview.cache.percent.toFixed(1) + '%' : '—', t('inspectorOverviewCache')),
            metric('overview-cost', t(completeCost ? 'inspectorOverviewCostComplete' : 'inspectorOverviewCost'), money(completeCost ? cost.estimatedUsd : cost?.knownSubtotalUsd), coverage(cost))),
          h('dl', { className: 'ag-overview-fields', 'aria-label': t('inspectorOverviewFields') }, ...fields.map(([key, label]) => {
            const value = overview.tokens?.[key]
            return h('div', { key }, h('dt', null, t(label)), h('dd', { 'data-metric': 'overview-' + key }, tokenText(value?.knownSubtotal)),
              h('small', null, t(value?.complete ? 'inspectorOverviewComplete' : 'inspectorOverviewPartial')), h('small', null, coverage(value)))
          })),
          h('p', { className: 'muted ag-small' }, t('inspectorOverviewDates') + ': ' + (overview.window?.oldestAt ?? '—') + ' → ' + (overview.window?.newestAt ?? '—')),
          h('p', { className: 'muted ag-small' }, t('inspectorBilling'))))
    }

    const knownTokens = value => Number.isSafeInteger(value) && value >= 0
    const tokenText = value => knownTokens(value) ? numberFormatter.format(value) : '—'
    function extractTokenMix(record) {
      const details = record?.usageDetails
      const keys = ['inputTokens', 'cachedTokens', 'outputTokens', 'thoughtTokens', 'toolTokens', 'totalTokens']
      let usage = null, complete = false, sourceCacheValid = true, sourceTotalsValid = true
      if (record?.protocol === 'generate-content') {
        const rows = (details?.rows ?? []).filter(row => row.kind === 'gc-hop')
        const ledger = rows.length > 0 && rows.length === record.hopCount && !details.omittedRows && new Set(rows.map(row => row.index)).size === rows.length
        usage = Object.fromEntries(keys.map(key => {
          const values = rows.map(row => row.usage?.[key])
          const sum = ledger && values.every(knownTokens) ? values.reduce((a, b) => a + b, 0) : null
          return [key, knownTokens(sum) ? sum : null]
        }))
        sourceCacheValid = rows.every(row => knownTokens(row.usage?.inputTokens) && knownTokens(row.usage?.cachedTokens) && row.usage.cachedTokens <= row.usage.inputTokens)
        sourceTotalsValid = rows.every(row => {
          const parts = ['inputTokens', 'outputTokens', 'thoughtTokens', 'toolTokens'].map(key => row.usage?.[key])
          return knownTokens(row.usage?.totalTokens) && parts.every(value => value == null || knownTokens(value))
            && parts.filter(knownTokens).reduce((sum, value) => sum + value, 0) === row.usage.totalTokens
        })
        complete = ledger && rows.every(row => row.complete === true)
      } else if (record?.protocol === 'interactions') {
        usage = details?.aggregate
        complete = details?.aggregateComplete === true
      }
      const read = key => knownTokens(usage?.[key]) ? usage[key] : null
      const input = read('inputTokens'), cached = read('cachedTokens'), total = read('totalTokens')
      const cacheValid = sourceCacheValid && input !== null && cached !== null && cached <= input
      const segments = [
        ['uncached', 'inspectorTokenUncached', cacheValid ? input - cached : null, 'var(--dsw-alias-brand-primary)'],
        ['cached', 'inspectorTokenCached', cached, 'var(--dsw-alias-state-success-primary)'],
        ['output', 'inspectorTokenOutput', read('outputTokens'), 'var(--dsw-alias-label-primary)'],
        ['reasoning', 'inspectorTokenReasoning', read('thoughtTokens'), 'var(--dsw-alias-state-warn-primary)'],
        ['tool', 'inspectorTokenTool', read('toolTokens'), 'var(--dsw-alias-state-idle-primary)'],
      ].map(([key, labelKey, count, color]) => ({ key, labelKey, count, color, pct: null }))
      const sumParts = segments.every(s => s.count !== null) ? segments.reduce((sum, s) => sum + s.count, 0) : null
      // A missing field remains unknown. Only chart recorded parts when they
      // account for the reported total, both per hop and after aggregation.
      const recordedSum = sumParts !== null ? sumParts : segments.filter(s => s.count !== null).reduce((sum, s) => sum + s.count, 0)
      const chartReady = complete && cacheValid && sourceTotalsValid && knownTokens(recordedSum) && total !== null && total > 0 && recordedSum === total
      if (chartReady) for (const s of segments) if (s.count !== null) s.pct = s.count / total * 100
      return { segments, total, sumParts, complete, chartReady, hasData: total !== null || segments.some(s => s.count !== null), cacheHitPct: cacheValid && input > 0 ? cached / input * 100 : null }
    }

    function TokenMixVisual({ record, t }) {
      const mix = extractTokenMix(record)
      const circumference = 2 * Math.PI * 42
      let offset = 0
      return h('div', { className: 'ag-token-visual' },
        h('div', { className: 'ag-card-head' },
          h('span', { className: 'ag-subhead' }, t('inspectorTokenMix')),
          h('span', { className: 'ag-pill' }, t(record?.protocol === 'generate-content' ? 'inspectorGcBasis' : 'inspectorIaBasis'))),
        h('div', { className: 'ag-token-body' },
          h('div', { className: 'ag-donut-wrap' },
            h('svg', { viewBox: '0 0 112 112', width: 112, height: 112, className: 'ag-donut-svg', 'aria-hidden': true },
              h('circle', { cx: 56, cy: 56, r: 42, fill: 'none', stroke: 'var(--dsw-alias-border-l2)', strokeWidth: 10 }),
              ...(mix.chartReady ? mix.segments.filter(s => s.count > 0).map(seg => {
                const arc = h('circle', { key: seg.key, cx: 56, cy: 56, r: 42, fill: 'none', stroke: seg.color, strokeWidth: 10,
                  strokeDasharray: (seg.pct / 100 * circumference) + ' ' + circumference, strokeDashoffset: -offset, className: 'ag-donut-arc' })
                offset += seg.pct / 100 * circumference
                return arc
              }) : [])),
            h('div', { className: 'ag-donut-center' }, h('strong', { className: 'ag-donut-val' }, tokenText(mix.total)), h('span', null, t('inspectorTokenTotal')))),
          h('div', { className: 'ag-token-right' },
            h('div', { className: 'ag-legend-grid' }, ...mix.segments.map(seg => h('div', { key: seg.key, className: 'ag-legend-item', 'data-token-kind': seg.key },
              h('span', { className: 'ag-legend-dot', style: { background: seg.color }, 'aria-hidden': true }),
              h('span', null, t(seg.labelKey)), h('strong', { className: 'ag-legend-num' }, seg.count === null ? t('inspectorTokenNotRecorded') : tokenText(seg.count)),
              h('span', { className: 'ag-legend-pct' }, seg.pct === null ? '—' : seg.pct.toFixed(1) + '%')))),
            h('p', { className: 'ag-cache-rate' }, t('inspectorCacheHitRate') + ': ' + (mix.cacheHitPct === null ? '—' : mix.cacheHitPct.toFixed(1) + '%')))),
        !mix.chartReady ? h('p', { className: 'muted ag-small' }, t('inspectorChartUnavailable'))
          : mix.segments.some(s => s.count === null) ? h('p', { className: 'muted ag-small' }, t('inspectorChartRecordedOnly')) : null,
        h('p', { className: 'muted ag-small' }, t('inspectorUsageHint')),
      )
    }

    function ResponsePage({ page, query, readPage, busy, t }) {
      if (!page) return null
      if (page.status !== 'available') return h('p', { className: 'ag-empty-note' }, t(query ? 'inspectorQueryExpired' : 'inspectorNotRetained'))
      const { frame, metadata } = page
      const progressPct = frame && frame.totalChars > 0 ? Math.min(100, Math.round(((frame.offset + frame.text.length) / frame.totalChars) * 100)) : 0
      return h('section', { className: 'ag-raw-section', 'aria-label': t('inspectorRaw') },
        h('p', { className: 'muted ag-hint-banner' }, t('inspectorRawHint')),
        h('div', { className: 'ag-raw-meta-bar' },
          h('p', { className: 'ag-chip-line' }, t(page.persistence === 'disk' ? 'inspectorDisk' : 'inspectorMemory') + ' · ' + t('inspectorOmitted') + ': ' + (metadata?.omittedFrames ?? t('inspectorUnknown'))),
          metadata?.captureError ? h('p', { className: 'ag-alert-inline', role: 'alert' }, t('inspectorCaptureError')) : null,
        ),
        !frame ? h('p', { className: 'ag-empty-note' }, t('inspectorNoFrame')) : h(React.Fragment, null,
          h('div', { className: 'ag-frame-toolbar' },
            h('div', { className: 'ag-frame-info' },
              h('p', { className: 'ag-mono-meta' }, t('inspectorFrame') + ': ' + frame.index + ' · ' + frame.kind + ' · hop ' + frame.hop + ' · ' + frame.offset + '–' + (frame.offset + frame.text.length) + ' / ' + frame.totalChars),
              h('p', { className: 'ag-pill ' + (frame.complete ? 'ag-pill-emerald' : 'ag-pill-amber'), role: 'status' }, t(frame.complete ? 'inspectorComplete' : 'inspectorPartial')),
            ),
            h('div', { className: 'group ag-pager-group' },
              !query ? h('button', { type: 'button', disabled: busy || frame.index === 0, onClick: () => readPage(frame.index - 1, 0) }, t('inspectorPrevFrame')) : null,
              h('button', { type: 'button', disabled: busy || frame.offset === 0, onClick: () => readPage(frame.index, Math.max(0, frame.offset - 65536)) }, t('inspectorPrevPage')),
              h('button', { type: 'button', disabled: busy || frame.nextOffset === null, onClick: () => readPage(frame.index, frame.nextOffset) }, t('inspectorNextPage')),
              !query ? h('button', { type: 'button', disabled: busy || frame.index + 1 >= metadata.frames, onClick: () => readPage(frame.index + 1, 0) }, t('inspectorNextFrame')) : null,
            ),
          ),
          h('div', { className: 'ag-progress-track' },
            h('div', { className: 'ag-progress-fill', style: { width: progressPct + '%' } }),
          ),
          h('pre', { className: 'ag-code-block', tabIndex: 0, 'aria-label': t('inspectorRaw') }, frame.text),
        ),
      )
    }

    function UsageEvidence({ detail, t }) {
      const { record, cost } = detail
      const value = input => input === null || input === undefined ? t('inspectorUnknown') : String(input)
      const money = input => typeof input === 'number' && Number.isFinite(input) ? input.toFixed(9) : t('inspectorUnknown')
      const rows = Array.isArray(record.usageDetails?.rows) ? record.usageDetails.rows : []
      return h('section', { className: 'card ag-card', 'aria-label': t('inspectorUsage') },
        h('div', { className: 'ag-card-head' },
          h('h3', null, t('inspectorUsage')),
          cost?.billingVerified === false ? h('span', { className: 'ag-pill ag-pill-sky' }, t('inspectorEstimateBadge')) : null,
        ),
        h(TokenMixVisual, { record, t }),
        h('div', { className: 'ag-kv-grid ag-usage-grid' },
          h('p', { className: 'ag-kv-cell' }, t('inspectorRequested') + ': ' + value(record.serviceTier?.requested)),
          h('p', { className: 'ag-kv-cell' }, t('inspectorObserved') + ': ' + value(record.serviceTier?.observed)),
          h('p', { className: 'ag-kv-cell ag-kv-accent' }, t('inspectorEstimate') + ': ' + money(cost?.estimatedUsd)),
          h('p', { className: 'ag-kv-cell ag-kv-accent' }, t('inspectorSubtotal') + ': ' + money(cost?.knownSubtotalUsd)),
          h('p', { className: 'ag-kv-cell ag-kv-wide' }, t('inspectorMissing') + ': ' + (cost?.missing?.length ? cost.missing.join(', ') : cost ? '—' : t('inspectorUnknown'))),
        ),
        h('p', { className: 'muted ag-hint-banner' }, t('inspectorBilling')),
        rows.length > 0 ? h('div', { className: 'ag-hop-visual' },
          h('div', { className: 'ag-subhead' }, t('inspectorStepHopTable') + ' (' + rows.length + ')'),
          h('div', { className: 'ag-hop-list' },
            ...rows.slice(0, 12).map((r, idx) => {
              const pTok = r.usage?.inputTokens
              const oTok = r.usage?.outputTokens
              const tTok = r.usage?.thoughtTokens
              const tot = r.usage?.totalTokens
              return h('div', { key: idx, className: 'ag-hop-row' },
                h('span', { className: 'ag-pill ag-pill-muted' }, (r.kind ?? 'hop') + ' #' + (r.index ?? idx)),
                h('span', { className: 'ag-hop-nums' }, t('inspectorInput') + ' ' + tokenText(pTok) + ' · ' + t('inspectorTokenOutput') + ' ' + tokenText(oTok) + ' · ' + t('inspectorTokenReasoning') + ' ' + tokenText(tTok)),
                h('span', { className: 'ag-hop-tot' }, tokenText(tot)),
              )
            }),
          ),
          rows.length > 12 ? h('p', { className: 'muted ag-small' }, t('inspectorRowsPreview') + ' 12 / ' + rows.length) : null,
        ) : null,
        h('div', { className: 'ag-drawers' },
          h('details', { className: 'ag-details' }, h('summary', null, t('inspectorAggregate')),
            h('pre', { className: 'ag-code-block', tabIndex: 0 }, record.usageDetails?.aggregate ? jsonEvidence({ complete: record.usageDetails.aggregateComplete, usage: record.usageDetails.aggregate }) : t('inspectorUnknown'))),
          h('details', { className: 'ag-details' }, h('summary', null, t('inspectorUsageRows')),
            h('p', { className: 'muted' }, t('inspectorUsageHint')),
            h('pre', { className: 'ag-code-block', tabIndex: 0 }, record.usageDetails ? jsonEvidence({ rows: record.usageDetails.rows, omittedRows: record.usageDetails.omittedRows }) : t('inspectorUnknown'))),
          h('details', { className: 'ag-details' }, h('summary', null, t('inspectorProvenance')),
            h('pre', { className: 'ag-code-block', tabIndex: 0 }, cost ? jsonEvidence(cost) : t('inspectorUnknown'))),
        ),
      )
    }

    function InspectorBody({ sessionId, messageId, signal, showSession, showAnswer, permissions, resetSource, callInspector, form, loadRecovery, releaseRecovery, t }) {
      const [mode, setMode] = React.useState('diagnosis')
      const [queryOpen, setQueryOpen] = React.useState(false)
      const [recoveryOpen, setRecoveryOpen] = React.useState(false)
      const [rawOpen, setRawOpen] = React.useState(false)
      const [snapshot, setSnapshot] = React.useState(null)
      const records = snapshot?.records ?? null
      const overview = snapshot?.overview ?? null
      const [selected, setSelected] = React.useState('')
      const [detail, setDetail] = React.useState(null)
      const [page, setPage] = React.useState(null)
      const [route, setRoute] = React.useState('google-generative-ai')
      const [interactionId, setInteractionId] = React.useState('')
      const [lookup, setLookup] = React.useState(null)
      const [queryPage, setQueryPage] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const gate = React.useRef({ alive: true, job: null, selected: '', records: null, mode: 'diagnosis', queryOpen: false, rawOpen: false, listed: false, lookupRevision: 0 })
      const lookupRevision = gate.current.lookupRevision
      const stop = () => { gate.current.job?.abort(); gate.current.job = null }
      React.useEffect(() => {
        const current = gate.current
        current.alive = !signal.aborted
        const terminate = () => { current.alive = false; stop() }
        const reset = () => {
          terminate(); setBusy(false); setSnapshot(null); setSelected(''); setDetail(null); setPage(null); setLookup(null); setQueryPage(null); setNotice(t('inspectorReset'))
        }
        const unsubscribe = resetSource.subscribe(reset)
        signal.addEventListener('abort', terminate, { once: true })
        return () => { terminate(); unsubscribe(); signal.removeEventListener('abort', terminate) }
      }, [signal, resetSource])
      const cancel = () => { stop(); setBusy(false); setNotice(t('inspectorCancelled')) }
      const run = async (method, request, accept) => {
        if (!gate.current.alive || !permissions[method] || signal.aborted) return
        stop()
        const controller = new AbortController()
        gate.current.job = controller
        setBusy(true); setError(''); setNotice('')
        try {
          const result = await callInspector(method, request, controller.signal)
          if (!gate.current.alive || controller.signal.aborted || gate.current.job !== controller) return
          if (result?.ok !== true) {
            setError(t(Object.hasOwn(dictionaries.en, result?.code) ? result.code : 'inspectorError'))
            return
          }
          accept(result)
        } catch {
          if (gate.current.alive && !controller.signal.aborted && gate.current.job === controller) setError(t('inspectorError'))
        } finally {
          if (gate.current.alive && gate.current.job === controller) { gate.current.job = null; setBusy(false) }
        }
      }
      const clearSelection = () => {
        gate.current.selected = ''; gate.current.rawOpen = false
        setSelected(''); setDetail(null); setPage(null); setRawOpen(false)
      }
      const select = requestId => {
        if (!gate.current.alive || gate.current.mode !== 'diagnosis' || !permissions.getRequest) return
        if (requestId === '') { stop(); setBusy(false); clearSelection(); return }
        if (!gate.current.records?.some(row => row.id === requestId)) return
        clearSelection(); gate.current.selected = requestId; setSelected(requestId)
        return run('getRequest', { sessionId, requestId }, result => {
          if (result.status === 'available' && result.record?.id !== requestId) throw new Error('Mismatched request')
          setDetail(result)
        })
      }
      const refresh = () => {
        if (!gate.current.alive || gate.current.mode !== 'diagnosis' || !permissions.listRequests) return
        setSnapshot(null)
        const method = permissions.getOverview ? 'getOverview' : 'listRequests'
        return run(method, { sessionId, ...(messageId ? { messageId } : {}), limit: 100 }, result => {
          if (!Array.isArray(result.records)) throw new Error('Invalid request list')
          const previous = gate.current.selected
          const first = gate.current.records === null
          if (method === 'getOverview' && (!result.overview || result.overview.requestCount !== result.records.length)) throw new Error('Invalid overview snapshot')
          gate.current.records = result.records
          setSnapshot({ records: result.records, overview: method === 'getOverview' ? result.overview : null })
          if (previous && !result.records.some(row => row.id === previous)) {
            clearSelection(); setNotice(t('inspectorSelectionMissing'))
          } else if (first && messageId && result.records.length === 1) {
            // Host filters by the exact durable answer. Never pick the latest in a session.
            void select(result.records[0].id)
          }
        })
      }
      React.useEffect(() => {
        if (gate.current.listed || !permissions.listRequests || !gate.current.alive) return
        gate.current.listed = true
        void refresh()
        return () => { gate.current.listed = false; stop() }
      }, [])
      const readRaw = (index = 0, offset = 0) => {
        if (gate.current.mode !== 'diagnosis' || !gate.current.rawOpen || !selected || selected !== gate.current.selected) return
        setPage(null)
        return run('readResponse', { sessionId, requestId: selected, index, offset, length: 65536 }, result => setPage(result.page))
      }
      const toggleRaw = () => {
        if (!gate.current.alive || gate.current.mode !== 'diagnosis' || !permissions.readResponse || !selected || selected !== gate.current.selected) return
        gate.current.rawOpen = !gate.current.rawOpen; setRawOpen(gate.current.rawOpen)
        if (gate.current.rawOpen) return readRaw()
        stop(); setBusy(false); setPage(null)
      }
      const changeLookup = (key, value) => {
        if (!gate.current.alive || gate.current.mode !== 'operations' || !gate.current.queryOpen) return
        gate.current.lookupRevision++
        stop(); setBusy(false); setLookup(null); setQueryPage(null); setError(''); setNotice('')
        if (key === 'route') setRoute(value); else setInteractionId(value)
      }
      const query = () => {
        if (lookupRevision !== gate.current.lookupRevision || gate.current.job || !gate.current.alive || gate.current.mode !== 'operations' || !gate.current.queryOpen || !permissions.queryInteraction) return
        let request
        try { request = parseInspectorRequest('queryInteraction', { route, id: interactionId }) }
        catch { setError(t('inspectorInvalidId')); return }
        gate.current.lookupRevision++
        setLookup(null); setQueryPage(null)
        return run('queryInteraction', request, result => setLookup(result))
      }
      const readQuery = (_index = 0, offset = 0) => {
        if (lookupRevision !== gate.current.lookupRevision || gate.current.mode !== 'operations' || !gate.current.queryOpen || !lookup?.queryId) return
        setQueryPage(null)
        return run('readQueryResponse', { queryId: lookup.queryId, offset, length: 65536 }, result => setQueryPage(result.page))
      }
      const switchMode = next => {
        if (!gate.current.alive || !['diagnosis', 'operations'].includes(next) || next === gate.current.mode) return
        stop(); gate.current.lookupRevision++; gate.current.mode = next; gate.current.queryOpen = false; gate.current.rawOpen = false
        setBusy(false); setError(''); setNotice(''); setQueryOpen(false); setRecoveryOpen(false); setRawOpen(false); setPage(null); setLookup(null); setQueryPage(null); setMode(next)
      }
      const toggleOperation = (kind, event) => {
        if (!gate.current.alive || gate.current.mode !== 'operations' || (event.target && event.target !== event.currentTarget)) return
        const open = event.currentTarget.open === true
        if (kind === 'recovery') { setRecoveryOpen(open); return }
        if (open === gate.current.queryOpen) return
        gate.current.lookupRevision++; gate.current.queryOpen = open; setQueryOpen(open)
        if (!open) { stop(); setBusy(false); setLookup(null); setQueryPage(null); setError(''); setNotice('') }
      }
      const changeScope = navigate => {
        if (!gate.current.alive || signal.aborted || !navigate) return
        stop(); clearSelection(); gate.current.alive = false
        navigate()
      }
      const association = row => t(row?.association === 'linked' ? 'inspectorAssociated' : row?.association === 'unverified' ? 'inspectorUnverified' : 'inspectorUnassociated')
      const routeName = value => value === 'google-generative-ai' ? 'Gemini API' : value === 'google-vertex' ? 'Vertex AI' : (value ?? t('inspectorUnknown'))
      const outcome = value => t(({ done: 'diagOutcome_done', 'tool-calls': 'diagOutcome_tool', 'max-tokens': 'diagOutcome_max', error: 'diagOutcome_error', aborted: 'diagOutcome_aborted' })[value] ?? 'diagOutcome_incomplete')
      const tone = value => value === 'done' || value === 'tool-calls' ? 'success' : value === 'error' ? 'error' : value === 'max-tokens' ? 'warn' : 'idle'
      const metric = (key, label, value, note) => h('div', { className: 'ag-metric', key },
        h('span', { className: 'ag-metric-label' }, label), h('strong', { className: 'ag-kpi-value', 'data-metric': key }, value),
        note ? h('span', { className: 'muted ag-small' }, note) : null)
      const activeDetail = detail?.status === 'available' ? detail : null
      const mix = extractTokenMix(activeDetail?.record)
      const count = records === null ? '—' : String(records.length)
      const routes = new Set((records ?? []).map(row => row.route).filter(Boolean))
      const badge = row => h('span', { className: 'ag-pill', 'data-tone': tone(row.outcome) }, outcome(row.outcome))
      const placeholder = text => h('div', { className: 'ag-empty' }, h('span', { className: 'ag-empty-symbol', 'aria-hidden': true }, '◈'), h('p', null, text))
      return h('section', { className: 'argon-inspector', 'aria-label': t('inspectorTitle'), 'data-dashboard-version': '1' },
        h('style', null, INSPECTOR_CSS + OVERVIEW_CSS),
        h('header', { className: 'ag-header' },
          h('div', null, h('span', { className: 'ag-eyebrow' }, t('inspectorEyebrow')), h('h2', null, t('inspectorTitle')), h('p', { className: 'muted' }, t('inspectorDashboardHint'))),
          h('span', { className: 'ag-pill' }, t('inspectorLocalOnly'))),
        h('div', { className: 'ag-toolbar' },
          h('div', { className: 'group ag-segmented', role: 'group', 'aria-label': t('inspectorTitle') }, ...[['diagnosis', 'inspectorDiagnosis'], ['operations', 'inspectorOperations']].map(([key, label]) =>
            h('button', { key, type: 'button', 'aria-pressed': mode === key, onClick: () => switchMode(key) }, t(label)))),
          h('span', { className: 'muted ag-small' }, t(messageId ? 'inspectorAnswerScope' : 'inspectorSessionScope')),
          messageId && showSession ? h('button', { type: 'button', onClick: () => changeScope(showSession) }, t('inspectorAllRequests'))
            : showAnswer ? h('button', { type: 'button', onClick: () => changeScope(showAnswer) }, t('inspectorBackToAnswer')) : null,
          mode === 'diagnosis' ? h('button', { type: 'button', className: 'ag-refresh', disabled: busy || !permissions.listRequests, onClick: refresh }, t('inspectorRefresh')) : null),
        h('details', { className: 'ag-scope' }, h('summary', null, t('inspectorScopeIds')),
          h('p', null, t('inspectorSession') + ': ' + sessionId), messageId ? h('p', null, t('inspectorMessage') + ': ' + messageId) : null),
        busy ? h('div', { className: 'group ag-notice' }, h('span', { role: 'status' }, t('inspectorLoading')), h('button', { type: 'button', onClick: cancel }, t('inspectorCancel'))) : null,
        error ? h('p', { className: 'ag-notice', role: 'alert' }, error) : null,
        notice ? h('p', { className: 'ag-notice', role: 'status' }, notice) : null,
        mode === 'diagnosis' ? h(React.Fragment, null,
          h('div', { className: 'ag-overview' },
            metric('requests', t('inspectorKpiRequests'), count, t('inspectorMetaScope')),
            metric('done', t('diagStatOk'), records === null ? '—' : String(records.filter(row => ['done', 'tool-calls'].includes(row.outcome)).length)),
            metric('errors', t('diagStatErr'), records === null ? '—' : String(records.filter(row => row.outcome === 'error').length)),
            metric('routes', t('inspectorKpiRoutes'), records === null ? '—' : String(routes.size), [...routes].map(routeName).join(' / '))),
          h(ScopeOverview, { overview, t, metric, busy, allowed: permissions.listRequests && permissions.getOverview }),
          h('p', { className: 'muted ag-small' }, t('inspectorLocalHint')),
          h('div', { className: 'ag-workbench' },
            h('section', { className: 'card ag-request-column', 'aria-label': t('inspectorTimeline') },
              h('div', { className: 'ag-card-head' }, h('h3', null, t('inspectorTimeline')), h('span', { className: 'ag-pill' }, count)),
              !permissions.listRequests ? placeholder(t('inspectorDenied')) : records === null ? placeholder(t(busy ? 'inspectorLoading' : 'inspectorStart')) : records.length === 0 ? placeholder(t(messageId ? 'inspectorMessageEmpty' : 'inspectorEmpty')) : h(React.Fragment, null,
                h('label', { className: 'ag-request-select' }, t('inspectorSelect'), h('select', { value: selected, disabled: busy || !permissions.getRequest, onChange: event => select(event.target.value) },
                  h('option', { value: '' }, t('inspectorChoose')), ...records.map(row => h('option', { key: row.id, value: row.id }, row.startedAt + ' · ' + routeName(row.route) + ' · ' + row.id)))),
                h('div', { className: 'ag-request-list' }, ...records.map(row => h('button', {
                  type: 'button', key: row.id, className: 'ag-request-item', 'data-request-id': row.id, 'aria-pressed': selected === row.id,
                  disabled: !permissions.getRequest, onClick: () => select(row.id),
                }, h('span', { className: 'ag-request-line' }, h('strong', null, routeName(row.route)), badge(row)),
                h('span', { className: 'muted ag-small' }, (row.startedAt ?? '—') + ' · ' + (row.protocol ?? t('inspectorUnknown'))),
                h('span', { className: 'ag-request-id' }, row.id))))),
              !permissions.getRequest ? h('p', { className: 'muted' }, t('inspectorDenied')) : null),
            h('div', { className: 'ag-detail-column' },
              activeDetail ? h(React.Fragment, null,
                h('p', { className: 'ag-selected-scope' }, t('inspectorSelectedScope')),
                h('div', { className: 'ag-selected-kpis' },
                  metric('total', t('inspectorTokenTotal'), tokenText(mix.total)),
                  metric('cache', t('inspectorCacheHitRate'), mix.cacheHitPct === null ? '—' : mix.cacheHitPct.toFixed(1) + '%'),
                  metric('cost', t('inspectorEstimate'), typeof activeDetail.cost?.estimatedUsd === 'number' && Number.isFinite(activeDetail.cost.estimatedUsd) ? '$' + activeDetail.cost.estimatedUsd.toFixed(6) : '—')),
                h('section', { className: 'card', 'aria-label': t('inspectorRequestSummary') },
                  h('div', { className: 'ag-card-head' }, h('h3', null, t('inspectorRequestSummary')), badge(detail.record)),
                  h('dl', { className: 'ag-definition-grid' }, ...[['inspectorRequestId', detail.record.id], ['inspectorRequestRoute', detail.record.route], ['inspectorProtocol', detail.record.protocol], ['inspectorFinish', detail.record.hops?.at(-1)?.finishReason]].map(([label, value]) =>
                    h('div', { key: label }, h('dt', null, t(label)), h('dd', null, value ?? t('inspectorUnknown'))))),
                  h('p', { className: 'muted ag-small' }, association(detail))),
                h(UsageEvidence, { detail, t }),
                h('section', { className: 'card' },
                  h('h3', null, t('inspectorRawTitle')),
                  h('p', { className: 'muted' }, t('inspectorCaptureStatus') + ': ' + t('inspectorCapture_' + (['disabled', 'captured', 'truncated', 'unavailable'].includes(detail.record.responseCapture?.status) ? detail.record.responseCapture.status : 'unknown'))),
                  h('button', { type: 'button', 'aria-expanded': rawOpen, disabled: busy || !permissions.readResponse, onClick: toggleRaw }, t('inspectorRaw')),
                  !permissions.readResponse ? h('p', null, t('inspectorDenied')) : null,
                  rawOpen ? h(ResponsePage, { page, readPage: readRaw, busy, t }) : null),
                h('details', { className: 'card' }, h('summary', null, t('inspectorSummary')),
                  detail.locator ? h('pre', { tabIndex: 0 }, jsonEvidence(detail.locator)) : null,
                  h('pre', { tabIndex: 0 }, jsonEvidence(detail.record))),
              ) : h('section', { className: 'card ag-detail-empty' }, placeholder(t(detail?.status === 'not-found' ? 'inspectorNotFound' : selected && busy ? 'inspectorLoading' : selected && error ? 'inspectorError' : 'inspectorChoose'))))),
        ) : h('div', { className: 'ag-operations' },
          h('p', { className: 'muted' }, t('inspectorOperationsHint')),
          h('details', { className: 'card', 'data-operation': 'query', open: queryOpen, onToggle: event => toggleOperation('query', event) },
            h('summary', null, t('inspectorQuery')),
            queryOpen ? h(React.Fragment, null,
              h('p', { className: 'muted' }, t('inspectorQueryHint')),
              h('label', null, t('inspectorRoute'), h('select', { value: route, onChange: event => changeLookup('route', event.target.value) },
                h('option', { value: 'google-generative-ai' }, 'Gemini API'), h('option', { value: 'google-vertex' }, 'Vertex AI'))),
              h('label', null, t('inspectorId'), h('input', { value: interactionId, maxLength: 4096, autoComplete: 'off', spellCheck: false, onChange: event => changeLookup('id', event.target.value) })),
              h('button', { type: 'button', disabled: busy || !permissions.queryInteraction || !interactionId, onClick: query }, t('inspectorLookup')),
              !permissions.queryInteraction ? h('p', null, t('inspectorDenied')) : null,
              lookup ? h(React.Fragment, null, h('h4', null, t('inspectorQueryResult')), h('pre', { tabIndex: 0 }, jsonEvidence(lookup)),
                h('button', { type: 'button', disabled: busy || !permissions.readQueryResponse, onClick: () => readQuery() }, t('inspectorReadQuery')),
                !permissions.readQueryResponse ? h('p', null, t('inspectorDenied')) : null,
                h(ResponsePage, { page: queryPage, query: true, readPage: readQuery, busy, t }),
              ) : null,
            ) : null,
          ),
          h('details', { className: 'card', 'data-operation': 'recovery', open: recoveryOpen, onToggle: event => toggleOperation('recovery', event) },
            h('summary', null, t('inspectorGlobalRecovery')),
            h('p', { className: 'muted' }, t('inspectorGlobalHint')),
            recoveryOpen ? (permissions.listRecovery ? h(RecoveryPanel, { form, disabled: !permissions.releaseUnknown, loadRecovery, releaseRecovery, t }) : h('p', null, t('inspectorDenied'))) : null),
        ),
      )
    }

    function Settings({ form, t }) {
      const state = React.useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot(), () => form.getSnapshot())
      const [pending, setPending] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      const writing = React.useRef(false)
      const val = state.value || {}
      const visible = val.showInModelPicker !== false
      const reasoning = val.reasoning || 'medium'
      const longDecode = val.longDecode !== false
      const maxTokens = val.maxTokens || 65536
      const contextWindow = val.contextWindow || 1048576
      const googleProtocol = val.googleProtocol || 'generate-content'
      const vertexProtocol = val.vertexProtocol || 'generate-content'
      const background = val.interactionsBackground === true
      const allowStorage = val.allowInteractionStorage === true
      const retainRaw = val.retainRawResponses === true
      const googleTier = val.googleServiceTier ?? 'standard'
      const vertexTier = val.vertexServiceTier ?? 'standard'
      const paygoOnly = val.vertexPaygoOnly === true
      const tierLabel = tier => SERVICE_TIERS.includes(tier) ? t('tier_' + tier) : t('tierUnknown') + String(tier)
      const effectiveBudget = Math.min(maxTokens, longDecode ? 1048576 : 65536, contextWindow > 131072 ? contextWindow - 131072 : contextWindow)
      const googleMismatch = effectiveBudget > 65536 && googleProtocol === 'interactions' && (!background || !allowStorage)
      const vertexMismatch = effectiveBudget > 65536 && vertexProtocol === 'interactions'
      const budgetMismatch = googleMismatch || vertexMismatch
      const budgetWarningText = [
        googleMismatch ? t('budgetWarningGoogle') : '',
        vertexMismatch ? t('budgetWarningVertex') : '',
      ].filter(Boolean).join(' ')
      const isReady = state.status === 'ready'
      const isReadonly = isReady && !state.writable
      const disabled = pending || !isReady || !state.writable

      const setField = (key, value) => formWritable(form) ? form.set(key, value) : false
      const updateField = async (key, nextVal) => {
        if (disabled || writing.current || !formWritable(form)) return
        if (!serviceSettingAllowed(form.getSnapshot().value || {}, key, nextVal)) { setNotice('tierNotVerified'); return }
        writing.current = true; setPending(true); setNotice('')
        try { setNotice(await setField(key, nextVal) ? 'saved' : 'error') }
        catch { setNotice('error') }
        finally { writing.current = false; setPending(false) }
      }

      const resetAll = async () => {
        if (disabled || writing.current || !formWritable(form)) return
        writing.current = true; setPending(true); setNotice('')
        try {
          const ok1 = await setField('showInModelPicker', true)
          const ok2 = await setField('reasoning', 'medium')
          const ok3 = await setField('longDecode', true)
          const ok4 = await setField('maxTokens', 65536)
          const ok5 = await setField('contextWindow', 1048576)
          const ok11 = await setField('googleServiceTier', 'standard')
          const ok12 = await setField('vertexServiceTier', 'standard')
          const ok13 = await setField('vertexPaygoOnly', false)
          const ok6 = await setField('googleProtocol', 'generate-content')
          const ok7 = await setField('vertexProtocol', 'generate-content')
          const ok8 = await setField('interactionsBackground', false)
          const ok9 = await setField('allowInteractionStorage', false)
          const ok10 = await setField('retainRawResponses', false)
          setNotice(ok1 && ok2 && ok3 && ok4 && ok5 && ok6 && ok7 && ok8 && ok9 && ok10 && ok11 && ok12 && ok13 ? 'saved' : 'error')
        } catch { setNotice('error') }
        finally { writing.current = false; setPending(false) }
      }

      const fmt = n => numberFormatter.format(n)
      const allTokenPresets = [8192, 16384, 32768, 65536, 131072, 262144, 524288, 786432, 1048576]
      const maxTokenCaps = longDecode ? allTokenPresets : [8192, 16384, 32768, 65536]
      const contextWindowPresets = [262144, 524288, 1048576]
      const isCustomMaxTokens = !allTokenPresets.includes(maxTokens)
      const isCustomContextWindow = !contextWindowPresets.includes(contextWindow)

      return h('section', { className: 'local-vertex-argon', 'aria-label': t('title') },
        h('style', null,
          '.local-vertex-argon{max-width:720px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.55}' +
          '.local-vertex-argon h2{font-size:20px;line-height:1.35;margin:0 0 6px;font-weight:600}' +
          '.local-vertex-argon h3{font-size:14px;margin:0 0 8px;font-weight:600}' +
          '.local-vertex-argon p{margin:0 0 8px}.local-vertex-argon .muted{color:var(--dsw-alias-label-secondary);font-size:13px}' +
          '.local-vertex-argon .summary-bar{padding:8px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:12.5px;margin:8px 0}' +
          '.local-vertex-argon .card{padding:14px 0;border-top:1px solid var(--dsw-alias-border-l1);margin-top:12px}' +
          '.local-vertex-argon .row{display:flex;gap:12px;align-items:center;justify-content:space-between;margin-bottom:6px;flex-wrap:wrap}' +
          '.local-vertex-argon .group{display:flex;gap:8px;flex-wrap:wrap;align-items:center}' +
          '.local-vertex-argon button{font:inherit;flex:none;min-width:72px;padding:5px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;transition:background .15s,border-color .15s}' +
          '.local-vertex-argon button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}' +
          '.local-vertex-argon button[aria-pressed="true"],.local-vertex-argon button[aria-checked="true"]{border-color:var(--dsw-alias-brand-primary);font-weight:600;background:var(--dsw-alias-bg-layer-2)}' +
          '.local-vertex-argon button:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}' +
          '.local-vertex-argon button:disabled{opacity:.55;cursor:default}' +
          '.local-vertex-argon .status{min-height:20px;font-size:13px;color:var(--dsw-alias-label-secondary);margin-top:4px}' +
          '.local-vertex-argon .status.error{color:var(--dsw-alias-state-error-primary)}' +
          '.local-vertex-argon .adv-details summary{cursor:pointer;font-weight:600;font-size:14px;padding:2px 0;user-select:none}' +
          '.local-vertex-argon .adv-body{margin-top:10px}' +
          '.local-vertex-argon ol{padding-left:20px;margin:6px 0}.local-vertex-argon li{margin:4px 0}' +
          '.local-vertex-argon .diag-toggle{border:none;background:transparent;padding:4px 0;min-width:0;text-align:left}' +
          '.local-vertex-argon .diag-toggle:hover:not(:disabled){background:transparent;opacity:.85}' +
          '.local-vertex-argon .diag-stats{display:flex;gap:12px;flex-wrap:wrap;padding:8px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);margin-bottom:10px;font-size:12px}' +
          '.local-vertex-argon .recovery-confirm{margin-top:10px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l2)}' +
          '.local-vertex-argon .recovery-risk{display:flex;align-items:flex-start;gap:8px;margin-bottom:8px}.local-vertex-argon .recovery-risk input{accent-color:var(--dsw-alias-brand-primary)}' +
          '.local-vertex-argon .diag-stat{font-weight:500}' +
          '.local-vertex-argon .diag-list{display:flex;flex-direction:column;gap:8px;max-height:360px;overflow-y:auto;padding-right:2px}' +
          '.local-vertex-argon .diag-item{padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-size:12.5px}' +
          '.local-vertex-argon .diag-item-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap}' +
          '.local-vertex-argon .diag-mono{font-family:ui-monospace,monospace;font-size:12px}' +
          '.local-vertex-argon .diag-chip{padding:1px 7px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);font-size:11.5px}' +
          '.local-vertex-argon .diag-badge{padding:1px 8px;border-radius:999px;font-weight:600;font-size:11.5px}' +
          '.local-vertex-argon .badge-ok{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}' +
          '.local-vertex-argon .badge-recovered{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent)}' +
          '.local-vertex-argon .badge-warn{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent)}' +
          '.local-vertex-argon .badge-err{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}' +
          '.local-vertex-argon .badge-muted{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}' +
          '.local-vertex-argon .diag-tokens{margin-top:6px;font-size:12px;font-family:ui-monospace,monospace}' +
          '.local-vertex-argon .diag-hops{margin-top:6px;padding-top:6px;border-top:1px dashed var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:3px;font-family:ui-monospace,monospace;font-size:11.5px;color:var(--dsw-alias-label-secondary)}'
        ),
        h('h2', null, t('title')),
        h('p', { className: 'muted' }, t('subtitle')),
        isReady
          ? h('div', { className: 'summary-bar', role: 'region', 'aria-label': t('summaryLabel') },
              h('strong', null, t('summaryLabel') + '：'),
              t('summaryLongDecode') + ' ' + t(longDecode ? 'longDecodeOn' : 'longDecodeOff') +
              ' · ' + t('summaryEffectiveCap') + ' ' + fmt(effectiveBudget) +
              ' · Gemini API: ' + (googleProtocol === 'interactions' ? 'Interactions' : 'GenerateContent') +
              ' / ' + tierLabel(googleTier) +
              ' · Vertex AI: ' + (vertexProtocol === 'interactions' ? 'Interactions' : 'GenerateContent') + ' / ' + tierLabel(vertexTier) +
              ' · ' + t('paygoLabel') + ': ' + t(paygoOnly ? 'longDecodeOn' : 'longDecodeOff'),
            )
          : h('p', { className: 'summary-bar muted', role: 'status' }, state.status === 'loading' ? t('loading') : t('unavailable')),
        isReadonly ? h('p', { className: 'status', role: 'status' }, t('readonlyBanner')) : null,
        h('div', { className: 'card' },
          h('h3', null, t('generalTitle')),
          h('div', { className: 'row' },
            h('strong', { id: 'vertex-argon-visibility-label' }, t('show')),
            h('button', {
              type: 'button', role: 'switch', 'aria-checked': visible,
              'aria-labelledby': 'vertex-argon-visibility-label',
              'aria-describedby': 'vertex-argon-visibility-hint',
              disabled, onClick: () => updateField('showInModelPicker', !visible),
            }, t(pending ? 'saving' : visible ? 'visible' : 'hidden')),
          ),
          h('p', { className: 'muted', id: 'vertex-argon-visibility-hint' }, t('showHint')),
          h('div', { className: 'row', style: { marginTop: '12px' } },
            h('strong', null, t('reasoningLabel')),
            h('div', { className: 'group', role: 'group', 'aria-label': t('reasoningLabel') },
              ...['low', 'medium', 'high'].map(level =>
                h('button', {
                  key: level, type: 'button', 'aria-pressed': reasoning === level,
                  disabled, onClick: () => updateField('reasoning', level),
                }, t('level_' + level))
              ),
            ),
          ),
          h('p', { className: 'muted' }, t('reasoningHint')),
        ),
        h('div', { className: 'card' },
          h('h3', null, t('protocolTitle')),
          ...[['googleProtocol', 'Gemini API', googleProtocol], ['vertexProtocol', 'Vertex AI', vertexProtocol]].map(([key, label, selected]) =>
            h('div', { className: 'row', key },
              h('strong', null, label),
              h('div', { className: 'group', role: 'group', 'aria-label': label + ' protocol' },
                ...['generate-content', 'interactions'].map(protocol =>
                  h('button', {
                    key: protocol, type: 'button', 'aria-pressed': selected === protocol,
                    disabled: disabled || !serviceSettingAllowed(val, key, protocol),
                    title: serviceSettingAllowed(val, key, protocol) ? undefined : t('tierProtocolBlocked'),
                    'aria-describedby': 'argon-tier-protocol-hint',
                    onClick: () => updateField(key, protocol),
                  }, protocol === 'interactions' ? t('protocolExperimental') : 'GenerateContent')
                ),
              ),
            )),
          h('p', { className: 'muted' }, t('protocolHint')),
          h('p', { className: 'muted', id: 'argon-tier-protocol-hint' }, t('tierProtocolBlocked')),
          budgetMismatch ? h('p', { role: 'alert', className: 'status error' }, budgetWarningText) : null,
        ),
        h('div', { className: 'card' },
          h('h3', null, t('tierTitle')),
          h('p', { className: 'muted' }, t('tierHint')),
          ...[
            ['googleServiceTier', 'google-generative-ai', 'Gemini API', googleProtocol, googleTier, googleProtocol === 'interactions' ? 'tierMatrixGoogleIA' : 'tierMatrixGoogleGC'],
            ['vertexServiceTier', 'google-vertex', 'Vertex AI', vertexProtocol, vertexTier, vertexProtocol === 'interactions' ? 'tierMatrixVertexIA' : 'tierMatrixVertexGC'],
          ].map(([key, route, label, protocol, selected, hint]) => h('div', { key },
            h('div', { className: 'row' },
              h('strong', null, label + ' · ' + tierLabel(selected)),
              h('div', { className: 'group', role: 'group', 'aria-label': label + ' ' + t('tierLabel'), 'data-tier-field': key },
                ...SERVICE_TIERS.map(tier => h('button', {
                  key: tier, type: 'button', 'aria-pressed': selected === tier,
                  disabled: disabled || !tierAllowed(route, protocol, tier),
                  title: tierAllowed(route, protocol, tier) ? undefined : t('tierNotVerified'),
                  'aria-describedby': 'argon-' + key + '-hint',
                  onClick: () => updateField(key, tier),
                }, t('tier_' + tier))),
              ),
            ),
            h('p', { className: 'muted', id: 'argon-' + key + '-hint' }, t(hint) + ' ' + t('tierGateHint')),
            isReady && (!tierAllowed(route, protocol, selected) || (route === 'google-vertex' && protocol === 'interactions' && paygoOnly))
              ? h('p', { className: 'status error', role: 'alert' }, label + ': ' + t('tierMismatch')) : null,
          )),
          h('div', { className: 'row' },
            h('strong', { id: 'argon-paygo-label' }, t('paygoLabel')),
            h('button', { type: 'button', role: 'switch', 'aria-checked': paygoOnly,
              'aria-labelledby': 'argon-paygo-label', 'aria-describedby': 'argon-paygo-hint',
              disabled: disabled || !serviceSettingAllowed(val, 'vertexPaygoOnly', !paygoOnly),
              onClick: () => updateField('vertexPaygoOnly', !paygoOnly),
            }, t(paygoOnly ? 'longDecodeOn' : 'longDecodeOff')),
          ),
          h('p', { className: 'muted', id: 'argon-paygo-hint' }, t('paygoHint')),
          h('p', { className: 'muted' }, t('tierResetHint')),
        ),
        h('div', { className: 'card' },
          h('h3', null, t('budgetTitle')),
          h('div', { className: 'row' },
            h('strong', { id: 'vertex-argon-longdecode-label' }, t('longDecodeLabel')),
            h('button', {
              type: 'button', role: 'switch', 'aria-checked': longDecode,
              'aria-labelledby': 'vertex-argon-longdecode-label',
              'aria-describedby': 'vertex-argon-longdecode-hint',
              disabled, onClick: () => updateField('longDecode', !longDecode),
            }, t(pending ? 'saving' : longDecode ? 'longDecodeOn' : 'longDecodeOff')),
          ),
          h('p', { className: 'muted', id: 'vertex-argon-longdecode-hint' }, t('longDecodeHint')),
          h('div', { className: 'row', style: { marginTop: '12px' } },
            h('strong', null, t('maxTokensLabel') + ' (' + fmt(maxTokens) + (isCustomMaxTokens ? t('customValueTag') : '') + ')'),
            h('div', { className: 'group', role: 'group', 'aria-label': t('maxTokensLabel') },
              ...maxTokenCaps.map(cap =>
                h('button', {
                  key: cap, type: 'button', 'aria-pressed': maxTokens === cap,
                  disabled, onClick: () => updateField('maxTokens', cap),
                }, fmt(cap))
              ),
            ),
          ),
          h('p', { className: 'muted' }, t('maxTokensHint')),
          h('p', { className: 'muted' }, t('effectiveBudget') + ': ' + fmt(effectiveBudget) + (!longDecode && maxTokens > 65536 ? t('effectiveClampedHint') : '')),
          h('div', { className: 'row', style: { marginTop: '12px' } },
            h('strong', null, t('contextWindowLabel') + ' (' + fmt(contextWindow) + (isCustomContextWindow ? t('customValueTag') : '') + ')'),
            h('div', { className: 'group', role: 'group', 'aria-label': t('contextWindowLabel') },
              ...contextWindowPresets.map(win =>
                h('button', {
                  key: win, type: 'button', 'aria-pressed': contextWindow === win,
                  disabled, onClick: () => updateField('contextWindow', win),
                }, fmt(win))
              ),
            ),
          ),
          h('p', { className: 'muted' }, t('contextWindowHint')),
        ),
        h('div', { className: 'card' },
          h('h3', null, t('interactionsTitle')),
          h('div', { className: 'row' },
            h('strong', { id: 'argon-storage-label' }, t('storageLabel')),
            h('button', {
              type: 'button', role: 'switch', 'aria-checked': allowStorage,
              'aria-labelledby': 'argon-storage-label',
              disabled, onClick: () => updateField('allowInteractionStorage', !allowStorage),
            }, t(allowStorage ? 'longDecodeOn' : 'longDecodeOff')),
          ),
          h('p', { className: 'muted' }, t('storageHint')),
          h('div', { className: 'row', style: { marginTop: '12px' } },
            h('strong', { id: 'argon-background-label' }, t('backgroundLabel')),
            h('button', {
              type: 'button', role: 'switch', 'aria-checked': background,
              'aria-labelledby': 'argon-background-label',
              disabled: disabled || (!allowStorage && !background),
              onClick: () => updateField('interactionsBackground', !background),
            }, t(background ? 'longDecodeOn' : 'longDecodeOff')),
          ),
          h('p', { className: 'muted' }, t('backgroundHint')),
          h('div', { className: 'row', style: { marginTop: '10px' } },
            h('span', {
              className: 'status' + (notice === 'error' || notice === 'tierNotVerified' ? ' error' : ''),
              role: notice === 'error' || notice === 'tierNotVerified' ? 'alert' : 'status', 'aria-live': 'polite',
            }, state.status === 'loading' ? t('loading') : state.status === 'unavailable' ? t('unavailable') : isReadonly && !notice ? t('readonlyBanner') : notice ? t(notice) : ''),
            h('button', { type: 'button', disabled, onClick: resetAll }, t('resetDefaults')),
          ),
        ),
        h('div', { className: 'card' },
          h('h3', null, t('retainRawTitle')),
          h('div', { className: 'row' },
            h('strong', { id: 'argon-retain-raw-label' }, t('retainRawLabel')),
            h('button', { type: 'button', role: 'switch', 'aria-checked': retainRaw,
              'aria-labelledby': 'argon-retain-raw-label', 'aria-describedby': 'argon-retain-raw-hint',
              disabled, onClick: () => updateField('retainRawResponses', !retainRaw),
            }, t(retainRaw ? 'longDecodeOn' : 'longDecodeOff')),
          ),
          h('p', { className: 'muted', id: 'argon-retain-raw-hint' }, t('retainRawHint')),
        ),
        h('details', { className: 'card adv-details' },
          h('summary', null, t('advTitle')),
          h('div', { className: 'adv-body' },
            h('p', { className: 'muted' }, t('capabilities')),
            h('h3', { style: { marginTop: '10px' } }, t('how')),
            h('ol', { className: 'muted' }, ...['step1', 'step2', 'step3'].map(key => h('li', { key }, t(key)))),
            h('h3', { style: { marginTop: '10px' } }, t('scope')),
            h('p', { className: 'muted' }, t('detail')),
            h('p', { className: 'muted' }, t('route')),
          ),
        ),
        h('p', { className: 'muted' }, t('inspectorSettingsHint')),
      )
    }

    return {
      inject: ['slots', 'locale', 'configForms', 'sidebarRightTabs', 'sidebarRight'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(ns, dictionaries), 'vertex-argon: locale')
        const form = ctx.configForms.get('local-vertex-argon')
        ctx.effect(() => installAdjacentPicker(ctx), 'vertex-argon: adjacent model picker')

        let resetRevision = 0
        const resetListeners = new Set()
        const resetSource = { subscribe: listener => { resetListeners.add(listener); return () => resetListeners.delete(listener) }, getSnapshot: () => resetRevision }
        const resetInspector = () => { resetRevision++; for (const listener of [...resetListeners]) listener() }
        let active = true
        let mountedOn
        let pendingMount
        let disposeMount
        const getRemote = () => {
          try { return ctx.get('remote') } catch { return undefined }
        }
        const identity = remote => remote?.[Symbol.for('cordis.original')] ?? remote
        async function ensureRemoteReady() {
          if (!active) throw new Error('Vertex Argon client disposed')
          if (pendingMount) return pendingMount
          const remote = getRemote()
          if (mountedOn && mountedOn === identity(remote)) return
          pendingMount = (async () => {
            const release = disposeMount
            disposeMount = undefined
            mountedOn = undefined
            await release?.()
            if (!remote || typeof remote.$mount !== 'function') throw new Error('Remote connection not ready')
            const dispose = await remote.$mount(DIAGNOSTICS_REMOTE)
            if (!active) {
              await dispose?.()
              throw new Error('Vertex Argon client disposed')
            }
            disposeMount = dispose
            mountedOn = identity(remote)
          })()
          try {
            await pendingMount
          } finally {
            pendingMount = undefined
          }
        }

        async function callDiagnostics(method, request, parseResult, mutation = false, signal) {
          try {
            if (mutation && !formWritable(form)) return { ok: false, error: 'Host settings are not writable' }
            await ensureRemoteReady()
            if (mutation && !formWritable(form)) return { ok: false, error: 'Host settings are not writable' }
            const api = ctx.get('remote.vertexArgonDiagnostics')
            if (typeof api?.[method] !== 'function') return { ok: false, error: 'Diagnostics service unavailable' }
            signal?.throwIfAborted()
            const response = method === 'queryInteraction' ? await api[method](request, signal) : await api[method](request)
            if (response?.ok === false && typeof response.error === 'object') {
              return { ok: false, error: String(response.error?.message || 'Read failed') }
            }
            const result = response?.ok === true && Object.hasOwn(response, 'value') ? response.value : response
            return parseResult(result)
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : 'Read failed' }
          }
        }

        const callInspector = (method, request, signal) => callDiagnostics(method, parseInspectorRequest(method, request), parseInspectorResult, false, signal)
        const loadDiagnostics = (limit = 20) => callDiagnostics('listRecent', { limit }, parseListRecentResult)
        const loadRecovery = (limit = 20) => callDiagnostics('listRecovery', { limit }, parseRecoveryResult)
        const releaseRecovery = request => callDiagnostics('releaseUnknown', parseReleaseRequest(request), parseReleaseResult, true)

        ctx.effect(() => {
          void ensureRemoteReady().catch(() => {})
          return async () => {
            active = false
            resetInspector(); resetListeners.clear()
            await pendingMount?.catch(() => {})
            const dispose = disposeMount
            disposeMount = undefined
            mountedOn = undefined
            await dispose?.()
          }
        }, 'vertex-argon: diagnostics remote lifetime')

        ctx.on?.('connection/reset', () => {
          resetInspector()
          void ensureRemoteReady().catch(() => {})
        })

        const openInspector = (sessionId, messageId) => {
          if (!active || typeof sessionId !== 'string' || !sessionId.trim() || typeof messageId !== 'string' || !messageId.trim()) return false
          // Global openTab targets mounted, not the session named in params. This
          // synchronous check and dispatch have no await or auto-selection between them.
          if (ctx.sidebarRight.mounted.getSnapshot() !== sessionId) return false
          ctx.sidebarRight.openTab(INSPECTOR_KIND, { params: { sessionId, messageId } })
          return true
        }
        ctx.effect(() => ctx.sidebarRightTabs.register({ id: INSPECTOR_KEY, kind: INSPECTOR_KIND,
          title: () => ctx.locale.bind(ns)('inspectorTitle'),
          guide: [{ id: INSPECTOR_KEY, order: 50, title: () => ctx.locale.bind(ns)('inspectorTitle'), description: () => ctx.locale.bind(ns)('inspectorGuideHint') }],
        }), 'vertex-argon: inspector type')
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab', key: INSPECTOR_KEY, locale: ns,
          inject: () => ({ callInspector, resetSource, form, loadRecovery, releaseRecovery }),
        }, Inspector)), 'vertex-argon: inspector body')
        ctx.effect(() => ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view', id: INSPECTOR_KEY, order: 40, locale: ns,
          label: () => ctx.locale.bind(ns)('inspectorOpen'),
          inject: () => ({ callInspector, resetSource, form, loadRecovery, releaseRecovery }),
        }, ConversationInspector)), 'vertex-argon: conversation view')
        ctx.effect(() => ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions', id: INSPECTOR_KEY, order: 50, locale: ns, inject: () => ({ openInspector }),
        }, InspectorEntry)), 'vertex-argon: inspector entry')

        ctx.effect(() => ctx.configForms.whileServed(['local-vertex-argon'], () =>
          ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section', id: 'local-vertex-argon', order: 36,
            label: () => ctx.locale.bind(ns)('title'), locale: ns, inject: () => ({ form }),
          }, Settings)),
        ), 'vertex-argon: settings section')
      },
    }
  },
})
