import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { hostClientModule, hostReactRuntime } from './host-internals.mjs'
import vm from 'node:vm'
import { registerHooks } from 'node:module'

// Imported UI barrels carry CSS. Strip only inert styles, never controller/store behavior.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('.css')) return { url: new URL(specifier, context.parentURL).href, shortCircuit: true }
    return next(specifier === 'picomatch/posix' ? 'picomatch/posix.js' : specifier, context)
  },
  load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true }
  return next(url, context)
} })
import { Context } from '@deepseek-ai/cordis'

const root = process.env.DSH_TEST_HOST_ROOT || import.meta.resolve('@deepseek-ai/dsh-client-ui-sidebar-right/package.json')
assert.ok(root, 'Matching DSH source is required; never replace the sidebar controller with a spy')
const host = suffix => hostClientModule('@deepseek-ai/dsh-client-ui-sidebar-right', 'packages/client/ui-sidebar-right/src/client/' + suffix)
const { createSidebarRightController } = await host('service.ts')
const { SidebarRightTabRegistry } = await host('tab-registry.ts')
const { createSidebarRightStore } = await host('stores.ts')
const { React: nativeReact, renderToStaticMarkup } = hostReactRuntime()
const { DefaultConversationViews } = await hostClientModule('@deepseek-ai/dsh-client-ui-conversation', 'packages/client/ui-conversation/lib/types/client/skeleton/DefaultConversationViews.js')
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
export const plain = value => JSON.parse(JSON.stringify(value))
export const tick = () => new Promise(setImmediate)
export const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
export const requestId = '11111111-1111-4111-8111-111111111111'
export const secondId = '22222222-2222-4222-8222-222222222222'
export const queryId = '33333333-3333-4333-8333-333333333333'
export const row = (id = requestId) => ({ id, startedAt: '2026-10-18T00:00:00.000Z', route: 'google-generative-ai', outcome: 'done', association: 'unassociated' })
export const detail = (id = requestId) => ({ ok: true, status: 'available', association: 'unassociated', record: { ...row(id), tokenUsage: { reportedInputTokens: null, reportedCacheTokens: null, outputTokens: null, thoughtsTokens: null, totalTokens: null } } })
export const page = (index = 0, offset = 0) => ({ status: 'available', persistence: 'memory-only', metadata: { frames: 2, omittedFrames: 4, captureError: true }, frame: { index, offset, hop: 1, kind: 'gc-chunk', text: '<script>not executed</script>', nextOffset: offset === 0 ? 65536 : null, totalChars: 70000, complete: false } })

export function renderer(React, { strictEffects = false } = {}) {
  const instances = new Map()
  const same = (a, b) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]))
  function close(instance) { for (const fn of instance.cleanups) fn?.() }
  function draw(element) {
    const seen = new Set(), effects = [], replays = [], nodes = []
    function visit(node, path) {
      if (!node || typeof node !== 'object') return
      if (typeof node.type === 'function') {
        const key = path + ':' + node.type.name + ':' + (node.props.key ?? '')
        seen.add(key)
        if (!instances.has(key)) instances.set(key, { hooks: [], cleanups: [] })
        const instance = instances.get(key), { hooks, cleanups } = instance
        let cursor = 0
        const saved = { ...React }
        React.useState = initial => { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial; return [hooks[i], next => { hooks[i] = typeof next === 'function' ? next(hooks[i]) : next }] }
        React.useRef = initial => { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: initial }; return hooks[i] }
        React.useCallback = (fn, deps) => { const i = cursor++; if (!hooks[i] || !same(hooks[i].deps, deps)) hooks[i] = { fn, deps }; return hooks[i].fn }
        React.useSyncExternalStore = (subscribe, getSnapshot) => {
          const i = cursor++
          if (hooks[i] !== subscribe) { hooks[i] = subscribe; effects.push(() => { cleanups[i]?.(); cleanups[i] = subscribe(() => {}) }) }
          return getSnapshot()
        }
        React.useEffect = (fn, deps) => { const i = cursor++; if (!same(hooks[i], deps)) { const first = !(i in hooks); hooks[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); if (first && strictEffects) replays.push({ cleanup: () => cleanups[i]?.(), setup: () => { cleanups[i] = fn() } }) }) } }
        let child
        try { child = node.type(node.props) } finally { Object.assign(React, saved) }
        visit(child, key)
        return
      }
      nodes.push(node)
      for (const [i, child] of (node.children ?? []).entries()) visit(child, path + '/' + i)
    }
    visit(element, 'root')
    for (const [key, instance] of instances) if (!seen.has(key)) { close(instance); instances.delete(key) }
    for (const effect of effects) effect()
    for (const effect of replays) effect.cleanup()
    for (const effect of replays) effect.setup()
    return { nodes, text: nodes.flatMap(node => (node.children ?? []).filter(value => typeof value === 'string')).join(' ') }
  }
  return { draw, close: () => { for (const instance of instances.values()) close(instance); instances.clear() } }
}

export function fixture({ language = 'en', access = true, globalAccess = true, strictEffects = false } = {}) {
  let declaration, dictionary, mounted
  const slots = new Map(), types = [], events = new Map(), disposers = [], calls = [], permissions = [], globalPermissions = []
  const tabLifetime = new AbortController()
  const state = { sessionId: 'session-A', params: undefined, revision: 1, visible: true, access, globalAccess }
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }), useSyncExternalStore: (_subscribe, get) => get(), useEffect: () => {}, useRef: initial => ({ current: initial }), useState: initial => [initial, () => {}], useCallback: fn => fn, Fragment: 'fragment' }
  const render = renderer(React, { strictEffects }), entryRender = renderer(React)
  const controllers = [], viewSelections = []
  class TrackedAbortController extends AbortController { constructor() { super(); controllers.push(this) } }
  const registryContext = new Context()
  const registry = new SidebarRightTabRegistry(registryContext)
  const { controller, adopt, show } = createSidebarRightController(registry, () => {}, { autoFullscreen: () => false, openWithFocus: (_id, open) => open(), closeWithFocus: (_id, _pane, close) => close() })
  const stores = new Map()
  for (const id of ['session-A', 'session-B']) { const store = createSidebarRightStore(() => ({ kind: 'guide', title: 'Guide' })).create(); stores.set(id, store); disposers.push(adopt(id, store)) }
  show('session-A')
  const handlers = {
    listRequests: async () => ({ ok: true, records: [row(), row(secondId)] }),
    getRequest: async request => detail(request.requestId),
    readResponse: async request => ({ ok: true, page: page(request.index, request.offset) }),
    queryInteraction: async () => ({ ok: true, queryId, readOnly: true, retention: 'memory-only', identity: { route: 'google-generative-ai', credentialBinding: 'current-configuration' } }),
    readQueryResponse: async request => ({ ok: true, page: page(0, request.offset) }),
    listRecovery: async () => ({ ok: true, records: [] }),
  }
  const api = new Proxy({}, { get: (_target, method) => async (...args) => {
    calls.push({ method, args }); const descriptor = mounted.descriptors.find(d => d.method === method)
    assert.ok(descriptor, 'RPC descriptor must be mounted'); descriptor.parameters[0].codec.schema.parse(args[0])
    return { ok: true, value: await handlers[method](...args) }
  } })
  const remote = { $mount: async value => { mounted = value; return () => {} } }
  // Match ConfigFormController's receiver-sensitive public methods, not arrow-method spies.
  class FixtureConfigForm {
    snapshot = { status: 'ready', writable: true, value: {} }
    listeners = new Set()
    notifications = 0
    subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
    getSnapshot() { return this.snapshot }
    publish(patch) { this.snapshot = { ...this.snapshot, ...patch }; for (const listener of this.listeners) { this.notifications++; listener() } }
    set() { throw new Error('Unexpected configuration write') }
  }
  const form = new FixtureConfigForm()
  const ctx = {
    get: key => key === 'remote' ? remote : key === 'remote.vertexArgonDiagnostics' ? api : undefined,
    effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
    on: (event, fn) => events.set(event, fn),
    locale: { register: (_ns, dictionaries) => { dictionary = dictionaries[language]; return () => {} }, bind: () => key => dictionary[key] },
    configForms: { get: () => form, whileServed: (_ids, fn) => fn() },
    sidebarRight: controller,
    sidebarRightTabs: { register: value => { types.push(value); return registry.register(value) } },
    slots: { inject: (_slot, fn) => fn(), entries: () => [], subscribe: () => () => {}, register: (options, component) => { slots.set(options.name, { options, component }); return () => {} } },
  }
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: value => { declaration = value } } }, AbortController: TrackedAbortController, console, Date, Symbol, Object, Map, WeakMap, Set })
  declaration.factory(name => { assert.equal(name, 'react'); return React }).apply(ctx)
  const wrapper = slots.get('sidebar.right.pane.tab')
  const t = key => { assert.equal(typeof dictionary[key], 'string', 'missing locale: ' + key); return dictionary[key] }
  let followed
  const draw = () => {
    const occurrence = followed ? controller.tabDomain.occurrence(followed.sessionId, followed.tab) : undefined
    if (occurrence) { const nav = occurrence.navigation.getSnapshot(); state.sessionId = followed.sessionId; state.params = nav.params; state.revision = nav.revision }
    const shared = { sessionId: state.sessionId,
      useAccess: name => { permissions.push(name); return typeof state.access === 'function' ? state.access(name) : state.access },
      useRemoteAccess: name => { globalPermissions.push(name); return typeof state.globalAccess === 'function' ? state.globalAccess(name) : state.globalAccess }, t }
    if (state.surface === 'conversation') {
      const slot = slots.get('conversation.view')
      const tabs = [{ id: 'chat', label: 'Chat' }, { id: 'trajectory', label: 'Trajectory' }, { id: 'context', label: 'Context' }, { id: 'fleet', label: 'Fleet' }, ...(slot ? [{ id: slot.options.id, label: slot.options.label() }] : [])]
      let element = null
      // Execute the matching Host's actual selected-view renderer, not a copy of its routing.
      renderToStaticMarkup(nativeReact.createElement(DefaultConversationViews, {
        useConversationViews: select => select(tabs), useInspectCall: select => select(null),
        useStore: select => select({ view: state.selectedView, viewRequest: null }),
        useSession: select => select({ blank: false }), useConversation: select => select({}),
        inputActions: { persistDraft() {} }, actions: { setDraft() {}, completeViewRequest() {} }, bindDraftPersistence: () => () => {}, openView() {},
        renderSlot: (name, owner, options) => {
          viewSelections.push({ name, only: options.only })
          if (slot && options.only === slot.options.id) element = React.createElement(slot.component, { ...slot.options.inject(), ...owner, ...shared })
          return null
        },
      }))
      return render.draw(element)
    }
    return render.draw(React.createElement(wrapper.component, { ...wrapper.options.inject(), sessionId: state.sessionId,
    useTabInfo: () => ({ tab: { visible: state.visible, signal: tabLifetime.signal, actions: occurrence?.tabActions, navigation: { revision: state.revision, params: state.params } } }),
    useAccess: name => { permissions.push(name); return typeof state.access === 'function' ? state.access(name) : state.access },
    useRemoteAccess: name => { globalPermissions.push(name); return typeof state.globalAccess === 'function' ? state.globalAccess(name) : state.globalAccess }, t,
  })) }
  const settle = async () => { let view; for (let i = 0; i < 3; i++) { view = draw(); await tick() } return draw() }
  return { state, draw, settle, dictionary, calls, handlers, types, slots, controller, stores, show, registry, permissions, globalPermissions, tabLifetime, form, controllers, viewSelections,
    conversation: selectedView => { state.surface = 'conversation'; state.selectedView = selectedView; return draw() },
    followTab: (sessionId, tab) => { followed = { sessionId, tab } },
    get mounted() { return mounted },
    entry: (sessionId = state.sessionId, messageId = 'message-A') => { const slot = slots.get('conversation.chat.assistant-actions'); return entryRender.draw(React.createElement(slot.component, { ...slot.options.inject(), sessionId, messageId, t })) },
    reset: () => events.get('connection/reset')(),
    unmount: () => render.close(),
    close: async () => { render.close(); entryRender.close(); controller.tabDomain.dispose(); for (const dispose of disposers.reverse()) await dispose() },
  }
}
export const button = (view, label) => view.nodes.find(n => n.type === 'button' && (n.children.includes(label) || n.props['aria-label'] === label))
export const selectRequest = view => view.nodes.find(n => n.type === 'select')
export function toggle(view, operation, open = true) { const node = view.nodes.find(n => n.type === 'details' && n.props['data-operation'] === operation); assert.ok(node, operation + ' disclosure'); node.props.onToggle({ currentTarget: { open } }) }
