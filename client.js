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

    const DIAGNOSTICS_REMOTE = {
      package: 'dsh-vertex-argon',
      descriptors: [DIAGNOSTICS_INVOCATION],
    }

    const dictionaries = {
      zh: {
        title: 'Vertex Argon',
        subtitle: '自动聚合 Vertex AI 与 Gemini API 的 Argon 通道 · 原生三档思考、Long Decode 自动续传与工具签名回传',
        show: '在模型选择器中显示 Vertex Argon 分组',
        showHint: '控制是否在会话模型选择器中列出 Vertex Argon 分组下的模型。正在使用该模型的会话不受隐藏影响。',
        visible: '已显示',
        hidden: '已隐藏',
        reasoningLabel: '默认思考档位（Thinking Level）',
        reasoningHint: '仅支持官方 LOW / MEDIUM（默认）/ HIGH 三档，直接发送原生 thinkingLevel 并开启 includeThoughts: true，彻底不传 thinkingBudget。',
        level_low: 'Low（低）',
        level_medium: 'Medium（默认）',
        level_high: 'High（高）',
        longDecodeLabel: '长生成自动续传（Long Decode Continuation）',
        longDecodeHint: '开启后自动走 v1beta1 端点并处理 CONTINUATION 令牌与断流检查点指数退避恢复；多段续传时按首跳输入上报上下文水位，避免误触发自动压缩。',
        longDecodeOn: '已开启',
        longDecodeOff: '已关闭',
        maxTokensLabel: '最大输出预算（Max Output Tokens）',
        maxTokensHint: '默认 65,536 tokens（单次流式上限）；开启 Long Decode 后最高可设为 524,288 tokens（跨 64K 分段自动续传，与输入共享 1M 总窗口）。',
        contextWindowLabel: '共享上下文窗口（Context Window）',
        contextWindowHint: '官方总窗口为 1,048,576 tokens，由输入、思考和输出共同共享。',
        resetDefaults: '恢复官方默认配置',
        saving: '保存中…',
        saved: '已保存并实时生效',
        error: '保存失败，请重试。',
        loading: '正在读取配置…',
        unavailable: '当前连接无法修改宿主设置。',
        how: '自动检测与使用方法',
        step1: '自动检测：只要在 DSH「设置 → 模型」的 Google（Gemini API）或 Google Vertex AI 中添加了 gemini-4-argon，本插件分组下就会自动出现对应的「Gemini 4 Argon (Vertex AI)」与「Gemini 4 Argon (Gemini API)」。',
        step2: '凭据复用：Vertex AI 通道自动读取环境变量（GOOGLE_APPLICATION_CREDENTIALS / GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION）；Gemini API 通道自动复用 Google 提供商配置的 GOOGLE_API_KEY。',
        step3: '在会话模型选择器中选择 Vertex Argon 分组下的对应模型，即可正常切换 Low / Medium / High 三档并查看思维链与工具调用卡片。',
        scope: '通道特性与双保险',
        detail: '本插件不仅提供完整支持 thought: true 思考摘要、thoughtSignature 签名回传与 v1beta1 Long Decode 自动续传的模型入口，还同时为原生的 google 与 google-vertex 路由注入了 Gemini 4 兼容补丁。',
        route: '提供方路由：google-vertex-argon · 模型 ID：gemini-4-argon (Vertex AI) / gemini-4-argon-google (Gemini API)',
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
      },
      en: {
        title: 'Vertex Argon',
        subtitle: 'Auto-detected Vertex AI & Gemini API Argon routes · native thinking levels, Long Decode continuation & signed tool replay',
        show: 'Show Vertex Argon group in the model picker',
        showHint: 'Controls whether Vertex Argon models appear in the model picker. Active conversations are unaffected.',
        visible: 'Visible',
        hidden: 'Hidden',
        reasoningLabel: 'Default Thinking Level',
        reasoningHint: 'Supports official LOW, MEDIUM (default), and HIGH levels via native thinkingLevel with includeThoughts: true. Never sends thinkingBudget.',
        level_low: 'Low',
        level_medium: 'Medium (Default)',
        level_high: 'High',
        longDecodeLabel: 'Long Decode Automatic Continuation',
        longDecodeHint: 'Routes Vertex AI via v1beta1 and automatically resumes CONTINUATION tokens and mid-stream checkpoints with exponential backoff while preserving first-hop prompt token accounting for compaction.',
        longDecodeOn: 'Enabled',
        longDecodeOff: 'Disabled',
        maxTokensLabel: 'Max Output Budget (Max Output Tokens)',
        maxTokensHint: 'Defaults to 65,536 tokens (single-request streaming cap). With Long Decode enabled, up to 524,288 tokens can be generated across 64K continuation hops.',
        contextWindowLabel: 'Shared Context Window',
        contextWindowHint: 'Official 1,048,576-token window shared across input, thinking, and output tokens.',
        resetDefaults: 'Restore Official Defaults',
        saving: 'Saving…',
        saved: 'Saved and applied live',
        error: 'Could not save. Please retry.',
        loading: 'Loading configuration…',
        unavailable: 'This connection cannot edit Host settings.',
        how: 'Auto-detection & usage',
        step1: 'Auto-detection: When gemini-4-argon is configured under Google (Gemini API) or Google Vertex AI in Models settings, this plugin automatically lists "Gemini 4 Argon (Vertex AI)" and/or "Gemini 4 Argon (Gemini API)".',
        step2: 'Credential reuse: Vertex AI uses GOOGLE_APPLICATION_CREDENTIALS / GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION; Gemini API reuses your configured GOOGLE_API_KEY.',
        step3: 'Select either model under Vertex Argon in the model picker for full Low / Medium / High thinking summaries and tool calls.',
        scope: 'Scope & fallback protection',
        detail: 'In addition to the dedicated Vertex Argon group with Long Decode continuation, this plugin patches native google and google-vertex Gemini 4 requests so selecting the original entries also sends thinkingLevel instead of thinkingBudget.',
        route: 'Provider route: google-vertex-argon · Models: gemini-4-argon (Vertex AI) / gemini-4-argon-google (Gemini API)',
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
      },
    }

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

    // Bolt ⚡: Cache Intl.DateTimeFormat instance to avoid expensive object creation in tight render loops
    const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: false })

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

    // Bolt ⚡: Cache Intl.NumberFormat instance outside component to avoid expensive object creation on every render
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
          default: return t('diagTrigger_initial')
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
                          const showHops = hops.length > 1 || r.reconnectCount > 0 || r.outcome === 'error'
                          const routeLabel = r.route === 'google-generative-ai' ? 'Gemini API' : 'Vertex AI'
                          return h('div', { key: r.id, className: 'diag-item' },
                            h('div', { className: 'diag-item-head' },
                              h('span', { className: 'diag-mono' }, formatTimeShort(r.startedAt)),
                              h('span', { className: 'diag-chip' }, routeLabel + ' · ' + r.apiVersion),
                              h('span', { className: 'diag-chip' }, r.thinkingLevel),
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
                                      ' · ' + hp.chunkCount + ' chunks' +
                                      (hp.finishReason ? ' · ' + hp.finishReason : '') +
                                      (Array.isArray(hp.errorCodes) && hp.errorCodes.length > 0 ? ' · ' + hp.errorCodes.join(',') : '') +
                                      ' · ' + formatDuration(hp.durationMs)
                                    )
                                  ),
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

    function Settings({ form, loadDiagnostics, t }) {
      const state = React.useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot(), () => form.getSnapshot())
      const [pending, setPending] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      const val = state.value || {}
      const visible = val.showInModelPicker !== false
      const reasoning = val.reasoning || 'medium'
      const longDecode = val.longDecode !== false
      const maxTokens = val.maxTokens || 65536
      const contextWindow = val.contextWindow || 1048576
      const disabled = pending || state.status !== 'ready' || !state.writable

      const updateField = async (key, nextVal) => {
        if (disabled) return
        setPending(true); setNotice('')
        try { setNotice(await form.set(key, nextVal) ? 'saved' : 'error') }
        catch { setNotice('error') }
        finally { setPending(false) }
      }

      const resetAll = async () => {
        if (disabled) return
        setPending(true); setNotice('')
        try {
          const ok1 = await form.set('showInModelPicker', true)
          const ok2 = await form.set('reasoning', 'medium')
          const ok3 = await form.set('longDecode', true)
          const ok4 = await form.set('maxTokens', 65536)
          const ok5 = await form.set('contextWindow', 1048576)
          setNotice(ok1 && ok2 && ok3 && ok4 && ok5 ? 'saved' : 'error')
        } catch { setNotice('error') }
        finally { setPending(false) }
      }

      const fmt = n => numberFormatter.format(Number(n))
      const maxTokenCaps = longDecode
        ? [8192, 16384, 32768, 65536, 131072, 262144, 524288]
        : [8192, 16384, 32768, 65536]

      return h('section', { className: 'local-vertex-argon', 'aria-label': t('title') },
        h('style', null,
          '.local-vertex-argon{max-width:720px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.6}' +
          '.local-vertex-argon h2{font-size:20px;line-height:1.35;margin:0 0 8px;font-weight:600}' +
          '.local-vertex-argon h3{font-size:14px;margin:0 0 8px;font-weight:600}' +
          '.local-vertex-argon p{margin:0 0 12px}.local-vertex-argon .muted{color:var(--dsw-alias-label-secondary)}' +
          '.local-vertex-argon .card{padding:18px 0;border-top:1px solid var(--dsw-alias-border-l1);margin-top:16px}' +
          '.local-vertex-argon .row{display:flex;gap:16px;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap}' +
          '.local-vertex-argon .group{display:flex;gap:8px;flex-wrap:wrap;align-items:center}' +
          '.local-vertex-argon button{font:inherit;flex:none;min-width:72px;padding:6px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;transition:background .15s,border-color .15s}' +
          '.local-vertex-argon button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}' +
          '.local-vertex-argon button[aria-pressed="true"],.local-vertex-argon button[aria-checked="true"]{border-color:var(--dsw-alias-brand-primary);font-weight:600;background:var(--dsw-alias-bg-layer-2)}' +
          '.local-vertex-argon button:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}' +
          '.local-vertex-argon button:disabled{opacity:.55;cursor:default}' +
          '.local-vertex-argon .status{min-height:22px;font-size:13px;color:var(--dsw-alias-label-secondary);margin-top:6px}' +
          '.local-vertex-argon .status.error{color:var(--dsw-alias-state-error-primary)}' +
          '.local-vertex-argon ol{padding-left:22px;margin:8px 0}.local-vertex-argon li{margin:8px 0}' +
          '.local-vertex-argon .diag-toggle{border:none;background:transparent;padding:4px 0;min-width:0;text-align:left}' +
          '.local-vertex-argon .diag-toggle:hover:not(:disabled){background:transparent;opacity:.85}' +
          '.local-vertex-argon .diag-stats{display:flex;gap:12px;flex-wrap:wrap;padding:8px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);margin-bottom:10px;font-size:12px}' +
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
        h('div', { className: 'card' },
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
          h('div', { className: 'row', style: { marginTop: '16px' } },
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
          h('div', { className: 'row', style: { marginTop: '16px' } },
            h('strong', null, t('maxTokensLabel') + ' (' + fmt(maxTokens) + ')'),
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
          h('div', { className: 'row', style: { marginTop: '16px' } },
            h('strong', null, t('contextWindowLabel') + ' (' + fmt(contextWindow) + ')'),
            h('div', { className: 'group', role: 'group', 'aria-label': t('contextWindowLabel') },
              ...[262144, 524288, 1048576].map(win =>
                h('button', {
                  key: win, type: 'button', 'aria-pressed': contextWindow === win,
                  disabled, onClick: () => updateField('contextWindow', win),
                }, fmt(win))
              ),
            ),
          ),
          h('p', { className: 'muted' }, t('contextWindowHint')),
          h('div', { className: 'row', style: { marginTop: '12px' } },
            h('span', {
              className: 'status' + (notice === 'error' ? ' error' : ''),
              role: notice === 'error' ? 'alert' : 'status', 'aria-live': 'polite',
            }, state.status === 'loading' ? t('loading') : state.status === 'unavailable' ? t('unavailable') : notice ? t(notice) : ''),
            h('button', { type: 'button', disabled, onClick: resetAll }, t('resetDefaults')),
          ),
        ),
        h('div', { className: 'card' },
          h('h3', null, t('how')),
          h('ol', null, ...['step1', 'step2', 'step3'].map(key => h('li', { key }, t(key)))),
        ),
        h('div', { className: 'card' },
          h('h3', null, t('scope')),
          h('p', null, t('detail')),
          h('p', { className: 'muted' }, t('route')),
        ),
        h(DiagnosticsPanel, { loadDiagnostics, t }),
      )
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(ns, dictionaries), 'vertex-argon: locale')
        const form = ctx.configForms.get('local-vertex-argon')
        ctx.effect(() => installAdjacentPicker(ctx), 'vertex-argon: adjacent model picker')

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

        async function loadDiagnostics(limit = 20) {
          try {
            await ensureRemoteReady()
            const api = ctx.get('remote.vertexArgonDiagnostics')
            if (typeof api?.listRecent !== 'function') return { ok: false, error: 'Diagnostics service unavailable' }
            const response = await api.listRecent({ limit })
            if (response?.ok === false && typeof response.error === 'object') {
              return { ok: false, error: String(response.error?.message || 'Read failed') }
            }
            const result = response?.ok === true && Object.hasOwn(response, 'value') ? response.value : response
            return parseListRecentResult(result)
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : 'Read failed' }
          }
        }

        ctx.effect(() => {
          void ensureRemoteReady().catch(() => {})
          return async () => {
            active = false
            await pendingMount?.catch(() => {})
            const dispose = disposeMount
            disposeMount = undefined
            mountedOn = undefined
            await dispose?.()
          }
        }, 'vertex-argon: diagnostics remote lifetime')

        ctx.on?.('connection/reset', () => {
          void ensureRemoteReady().catch(() => {})
        })

        ctx.effect(() => ctx.configForms.whileServed(['local-vertex-argon'], () =>
          ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section', id: 'local-vertex-argon', order: 36,
            label: () => ctx.locale.bind(ns)('title'), locale: ns, inject: () => ({ form, loadDiagnostics }),
          }, Settings)),
        ), 'vertex-argon: settings section')
      },
    }
  },
})
