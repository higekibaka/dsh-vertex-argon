window.__ModuleLoader__.load({
  id: 'dsh-vertex-argon',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const ns = 'settings.localVertexArgon'
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
        longDecodeHint: '开启后自动走 v1beta1 端点并处理 CONTINUATION 令牌与断流检查点恢复；多段续传时按首跳输入上报上下文水位，避免误触发自动压缩。',
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
        longDecodeHint: 'Routes Vertex AI via v1beta1 and automatically resumes CONTINUATION tokens and mid-stream checkpoints while preserving first-hop prompt token accounting for compaction.',
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

    function Settings({ form, t }) {
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

      const fmt = n => Number(n).toLocaleString()
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
          '.local-vertex-argon ol{padding-left:22px;margin:8px 0}.local-vertex-argon li{margin:8px 0}'
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
      )
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(ns, dictionaries), 'vertex-argon: locale')
        const form = ctx.configForms.get('local-vertex-argon')
        ctx.effect(() => installAdjacentPicker(ctx), 'vertex-argon: adjacent model picker')
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
