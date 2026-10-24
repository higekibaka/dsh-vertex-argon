import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { hostClientModule } from './host-internals.mjs'
import { SERVICE_TIERS, SERVICE_TIER_CAPABILITIES, resolveServicePolicy } from '../service-level.js'
import { Config } from '../index.js'
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
function render(value = {}, writable = true, { status = 'ready', language = 'zh', remote, api, globalAccess = true, formController, intl } = {}) {
  let declaration, settings, inspector, dictionary, dictionaries
  const writes = [], disposers = []
  let snapshot = {status,writable,value}
  const form = formController ?? { subscribe:()=>()=>{}, getSnapshot:()=>snapshot, set:async(key,next)=>{writes.push([key,next]);return true} }
  const React = { createElement:(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity)}), useState:initial=>[initial,()=>{}], useRef:initial=>({current:initial}), useCallback:fn=>fn, useEffect:()=>{}, useSyncExternalStore:(_sub,get)=>get(), Fragment:'fragment' }
  // A test may observe or replace the module's Intl surface without touching production code.
  vm.runInNewContext(source, { window:{__ModuleLoader__:{load:x=>declaration=x}}, console, Date, Symbol, Object, Map, WeakMap, AbortController, Intl: intl ?? Intl })
  const plugin=declaration.factory(name=>{assert.equal(name,'react');return React})
  const ctx={
    get:key=>key==='remote'?remote:key==='remote.vertexArgonDiagnostics'?api:undefined,
    effect:fn=>{const dispose=fn();if(typeof dispose==='function')disposers.push(dispose)},
    on:()=>{},
    sidebarRightTabs:{register:()=>()=>{}}, sidebarRight:{openTab:()=>{}},
    locale:{register:(_ns,dict)=>{dictionaries=dict;dictionary=dict[language];return()=>{}},bind:()=>key=>dictionary[key]},
    configForms:{get:()=>form,whileServed:(_ids,fn)=>fn()},
    slots:{inject:(_name,fn)=>fn(),entries:()=>[],subscribe:()=>()=>{},register:(options,component)=>{if(options.name==='settings.section')settings={options,component};if(options.name==='sidebar.right.pane.tab')inspector={options,component};return()=>{}}},
  }
  plugin.apply(ctx)
  assert.ok(settings)
  const tree=settings.component({...settings.options.inject(),useRemoteAccess:()=>globalAccess,t:key=>dictionary[key]})
  const all=[];const walk=x=>{if(!x||typeof x!=='object')return;all.push(x);for(const child of x.children??[])walk(child)};walk(tree)
  // Exercise the actual Operations disclosure to obtain the same recovery component;
  // only its business lifecycle is then isolated for the existing confirmation/CAS tests.
  const recovery=(overrides={})=>{
    const surface=inspector.component({...inspector.options.inject(),sessionId:'session-A',
      useTabInfo:()=>({tab:{visible:true,signal:new AbortController().signal,navigation:{revision:1,params:undefined}}}),
      useAccess:()=>false,useRemoteAccess:()=>globalAccess,t:key=>dictionary[key]})
    const body=surface.type(surface.props)
    const navigation=panelHarness(React,body,{})
    button(navigation.draw(),dictionary.inspectorOperations).props.onClick()
    const disclosure=navigation.draw().nodes.find(x=>x.props['data-operation']==='recovery')
    disclosure.props.onToggle({currentTarget:{open:true}})
    const element=navigation.draw().nodes.find(x=>typeof x.type==='function'&&x.props.loadRecovery)
    assert.ok(element,'Recovery is reachable only after Operations disclosure opens')
    navigation.close()
    return panelHarness(React,element,overrides)
  }
  return {tree,all,writes,dictionary,dictionaries,recovery,remoteProps:inspector.options.inject(),
    settingsPanel:()=>panelHarness(React,{type:settings.component,props:{...settings.options.inject(),useRemoteAccess:()=>globalAccess,t:key=>dictionary[key]}},{}),
    setForm:next=>{snapshot={...snapshot,...next}},close:async()=>{for(const d of disposers.reverse())await d()}}
}

// Hook-aware unit harness: effects and callbacks execute, but all service calls
// below are in-memory fixtures. It neither creates a GUI nor touches task stores.
function panelHarness(React,element,overrides) {
  const hooks=[],pendingEffects=[],cleanups=[]
  let cursor=0
  const props={...element.props,...overrides}
  const same=(a,b)=>a&&b&&a.length===b.length&&a.every((x,i)=>Object.is(x,b[i]))
  const draw=()=>{
    cursor=0
    const saved={...React}
    React.useState=initial=>{
      const i=cursor++
      if(!(i in hooks))hooks[i]=typeof initial==='function'?initial():initial
      return[hooks[i],next=>{hooks[i]=typeof next==='function'?next(hooks[i]):next}]
    }
    React.useRef=initial=>{
      const i=cursor++
      if(!(i in hooks))hooks[i]={current:initial}
      return hooks[i]
    }
    React.useCallback=(fn,deps)=>{
      const i=cursor++
      if(!same(hooks[i]?.deps,deps))hooks[i]={fn,deps}
      return hooks[i].fn
    }
    React.useEffect=(fn,deps)=>{
      const i=cursor++
      if(!same(hooks[i],deps)){hooks[i]=deps;pendingEffects.push(()=>{cleanups[i]?.();cleanups[i]=fn()})}
    }
    let tree
    try{tree=element.type(props)}finally{Object.assign(React,saved)}
    const nodes=[]
    const walk=x=>{if(!x||typeof x!=='object')return;nodes.push(x);for(const c of x.children??[])walk(c)}
    walk(tree)
    const text=nodes.flatMap(x=>x.children.filter(c=>typeof c==='string')).join(' ')
    return{tree,nodes,text}
  }
  const flush=async()=>{for(const effect of pendingEffects.splice(0))effect();await new Promise(setImmediate);return draw()}
  return{draw,flush,mount:async()=>{draw();return flush()},close:()=>{for(const cleanup of cleanups)cleanup?.()}}
}

function recoveryRecord(overrides={}) {
  return{key:'a'.repeat(64),sessionHash:'b'.repeat(12),stage:'unknown',updatedAt:'2026-10-17T01:00:00.000Z',releasedAt:null,uncertainAt:'2026-10-17T00:59:00.000Z',hasRemoteId:false,active:false,...overrides}
}
const releaseSuccess={ok:true,released:true,remoteAction:'none',newRequestStarted:false}
const button=(view,label)=>view.nodes.find(x=>x.type==='button'&&x.children.includes(label))
const checkbox=view=>view.nodes.find(x=>x.type==='input'&&x.props.type==='checkbox')
const plain=value=>JSON.parse(JSON.stringify(value))
function recoveryFixture(options={}) {
  let records=options.records??[recoveryRecord()]
  const calls={mounts:[],lists:[],releases:[],unmounts:0}
  const remote={$mount:async descriptor=>{calls.mounts.push(descriptor);return()=>{calls.unmounts++}}}
  const api={
    listRecovery:async request=>{calls.lists.push(plain(request));return{ok:true,value:{ok:true,records}}},
    releaseUnknown:async request=>{
      calls.releases.push(plain(request))
      records=records.map(row=>row.key===request.key?{...row,releasedAt:'2026-10-17T02:00:00.000Z',updatedAt:'2026-10-17T02:00:00.000Z'}:row)
      return{ok:true,value:releaseSuccess}
    },
  }
  const r=render({},options.writable??true,{...options,remote,api})
  const panel=r.recovery()
  return{r,panel,api,calls,setRecords:next=>{records=next},close:async()=>{panel.close();await r.close()}}
}
test('protocol controls default to GenerateContent without granting cloud storage',async()=>{
  const r=render()
  const group=r.all.find(x=>x.props['aria-label']==='Gemini API protocol')
  const interactions=group.children.find(x=>x.props['aria-pressed']===false)
  await interactions.props.onClick()
  assert.deepEqual(r.writes,[['googleProtocol','interactions']])
  const storage=r.all.find(x=>x.props['aria-labelledby']==='argon-storage-label')
  const background=r.all.find(x=>x.props['aria-labelledby']==='argon-background-label')
  assert.equal(storage.props['aria-checked'],false);assert.equal(background.props.disabled,true)
  await storage.props.onClick()
  assert.deepEqual(r.writes.at(-1),['allowInteractionStorage',true])
  assert.ok(!r.writes.some(([key])=>key==='interactionsBackground'))
  await r.close()
})
test('reset restores both protocols and revokes background/storage options',async()=>{
  const r=render({googleProtocol:'interactions',vertexProtocol:'interactions',interactionsBackground:true,allowInteractionStorage:true})
  assert.equal(typeof r.dictionary.resetDefaults,'string')
  const resets=r.all.filter(x=>x.type==='button'&&x.children.includes(r.dictionary.resetDefaults))
  assert.equal(resets.length,1)
  await resets[0].props.onClick()
  assert.equal(r.writes.length,16)
  assert.deepEqual(Object.fromEntries(r.writes),{showInModelPicker:true,reasoning:'medium',longDecode:true,maxTokens:65536,contextWindow:1048576,googleProtocol:'generate-content',vertexProtocol:'generate-content',interactionsBackground:false,allowInteractionStorage:false,retainRawResponses:false,googleServiceTier:'standard',vertexServiceTier:'standard',vertexPaygoOnly:false,proxyEnabled:false,proxyBaseUrl:'http://127.0.0.1:8045/v1beta',proxyApiKey:''})
  await r.close()
})
test('incompatible Vertex budget is visibly warned, never silently clamped',async()=>{
  const r=render({vertexProtocol:'interactions',maxTokens:131072})
  assert.ok(r.all.some(x=>x.props.role==='alert'))
  assert.equal(r.writes.length,0)
  await r.close()
})
test('read-only forms disable every settings mutation',async()=>{
  const r=render({},false)
  const changes=r.all.filter(x=>x.type==='button'&&(x.props.role==='switch'||Object.hasOwn(x.props,'aria-pressed')||x.children.includes(r.dictionary.resetDefaults)))
  assert.ok(changes.length>=9)
  for(const button of changes){assert.equal(button.props.disabled,true);await button.props.onClick?.()}
  assert.equal(r.writes.length,0)
  await r.close()
})

test('raw retention consent is off by default, only user-writable, and reset revokes it',async()=>{
  const initial=render()
  const toggle=initial.all.find(x=>x.props['aria-labelledby']==='argon-retain-raw-label')
  assert.equal(toggle.props.role,'switch');assert.equal(toggle.props['aria-checked'],false)
  assert.equal(toggle.props['aria-describedby'],'argon-retain-raw-hint')
  assert.equal(initial.writes.length,0)
  await toggle.props.onClick()
  assert.deepEqual(initial.writes,[['retainRawResponses',true]])
  initial.setForm({writable:false});await toggle.props.onClick()
  assert.equal(initial.writes.length,1,'retained callbacks cannot grant consent after access is lost')
  await initial.close()
  const enabled=render({retainRawResponses:true})
  await enabled.all.find(x=>x.type==='button'&&x.children.includes(enabled.dictionary.resetDefaults)).props.onClick()
  assert.deepEqual(enabled.writes.find(([key])=>key==='retainRawResponses'),['retainRawResponses',false])
  await enabled.close()
})

test('Operations recovery denies global reads without borrowing session access',async()=>{
  const {fixture,button:findButton,toggle}=await import('./client-inspector-fixture.mjs')
  const f=fixture({globalAccess:false})
  try{
    await f.settle();findButton(f.draw(),f.dictionary.inspectorOperations).props.onClick()
    toggle(f.draw(),'recovery');const view=await f.settle()
    assert.ok(view.text.includes(f.dictionary.inspectorDenied))
    assert.equal(f.calls.some(x=>x.method==='listRecovery'),false)
  }finally{await f.close()}
})


const tierGroup=(r,key)=>r.all.find(x=>x.props['data-tier-field']===key)
const tierButton=(r,key,tier)=>tierGroup(r,key).children.find(x=>x.children.includes(r.dictionary['tier_'+tier]))
const paygoButton=r=>r.all.find(x=>x.props['aria-labelledby']==='argon-paygo-label')
const protocolButton=(r,route,protocol)=>r.all.find(x=>x.props['aria-label']===(route==='google'?'Gemini API':'Vertex AI')+' protocol').children.find(x=>x.children.includes(protocol==='interactions'?r.dictionary.protocolExperimental:'GenerateContent'))

test('tier defaults are Standard/Standard/PayGo off without writes or implied billing evidence',async()=>{
  for(const language of ['en','zh']){
    const r=render({},true,{language})
    for(const key of ['googleServiceTier','vertexServiceTier'])assert.equal(tierButton(r,key,'standard').props['aria-pressed'],true)
    assert.equal(paygoButton(r).props['aria-checked'],false)
    assert.equal(r.writes.length,0)
    const summary=r.all.find(x=>x.props['aria-label']===r.dictionary.summaryLabel)
    assert.ok(summary.children.join('').includes(r.dictionary.tier_standard))
    assert.ok(r.all.some(x=>x.children.includes(r.dictionary.tierHint)))
    await r.close()
  }
})

test('all Client route/protocol/tier options match Host capability truth in both languages',async()=>{
  for(const language of ['en','zh'])for(const [routeProtocol,allowed] of Object.entries(SERVICE_TIER_CAPABILITIES)){
    const [route,protocol]=routeProtocol.split('/'),prefix=route==='google-vertex'?'vertex':'google',key=prefix+'ServiceTier'
    const r=render({[prefix+'Protocol']:protocol},true,{language})
    for(const tier of SERVICE_TIERS){
      const control=tierButton(r,key,tier),supported=allowed.includes(tier)
      assert.equal(control.props.disabled,!supported,routeProtocol+' '+tier)
      assert.equal(typeof control.props['aria-describedby'],'string')
      if(!supported)assert.equal(control.props.title,r.dictionary.tierNotVerified)
      assert.equal((()=>{try{resolveServicePolicy({[key]:tier},route,protocol);return true}catch{return false}})(),supported)
      const count=r.writes.length;await control.props.onClick()
      assert.equal(r.writes.length,count+Number(supported),'even retained/forced disabled callback must be gated')
      if(supported)assert.deepEqual(r.writes.at(-1),[key,tier])
    }
    await r.close()
  }
})

test('protocol switching cannot silently change tiers, PayGo or save an incompatible combination',async()=>{
  for(const prefix of ['google','vertex'])for(const tier of SERVICE_TIERS)for(const protocol of ['generate-content','interactions'])for(const paygo of [false,true]){
    const value={[prefix+'ServiceTier']:tier,vertexPaygoOnly:paygo},r=render(value)
    const route=prefix==='vertex'?'google-vertex':'google-generative-ai'
    let supported=true;try{resolveServicePolicy(value,route,protocol)}catch{supported=false}
    const control=protocolButton(r,prefix,protocol)
    assert.equal(control.props.disabled,!supported)
    await control.props.onClick()
    assert.deepEqual(r.writes,supported?[[prefix+'Protocol',protocol]]:[])
    assert.equal(value[prefix+'ServiceTier'],tier);assert.equal(value.vertexPaygoOnly,paygo)
    await r.close()
  }
})

test('unsupported saved selections remain visible and can only be explicitly corrected',async()=>{
  for(const language of ['en','zh']){
    const r=render({googleProtocol:'generate-content',googleServiceTier:'flex',vertexProtocol:'interactions',vertexServiceTier:'priority',vertexPaygoOnly:true},true,{language})
    assert.equal(tierButton(r,'googleServiceTier','flex').props['aria-pressed'],true)
    assert.equal(tierButton(r,'googleServiceTier','flex').props.disabled,false, 'saved Gemini GC Flex is now supported without silent rewriting')
    for(const [key,tier] of [['vertexServiceTier','priority']]){
      const control=tierButton(r,key,tier)
      assert.equal(control.props['aria-pressed'],true);assert.equal(control.props.disabled,true)
      await control.props.onClick()
    }
    assert.ok(r.all.filter(x=>x.props.role==='alert').every(x=>x.children.join('').includes(r.dictionary.tierMismatch)))
    assert.equal(paygoButton(r).props['aria-checked'],true);assert.equal(paygoButton(r).props.disabled,false)
    assert.deepEqual(r.writes,[])
    await paygoButton(r).props.onClick()
    await tierButton(r,'vertexServiceTier','standard').props.onClick()
    assert.deepEqual(r.writes,[['vertexPaygoOnly',false],['vertexServiceTier','standard']])
    await r.close()
    const unknown=render({googleServiceTier:'external-unknown'},true,{language})
    assert.ok(unknown.all.some(x=>x.children.join('').includes(unknown.dictionary.tierUnknown+'external-unknown')))
    assert.deepEqual(unknown.writes,[]);await unknown.close()
  }
})

test('PayGo-only UI matches Host routing gate and never changes a service tier',async()=>{
  for(const protocol of ['generate-content','interactions'])for(const selected of [false,true]){
    const r=render({vertexProtocol:protocol,vertexPaygoOnly:selected})
    const control=paygoButton(r),next=!selected
    let supported=true;try{resolveServicePolicy({vertexPaygoOnly:next},'google-vertex',protocol)}catch{supported=false}
    assert.equal(control.props.disabled,!supported)
    await control.props.onClick();assert.deepEqual(r.writes,supported?[['vertexPaygoOnly',next]]:[])
    await r.close()
  }
})

test('retained tier callbacks recheck live readiness, permission and protocol compatibility',async()=>{
  for(const change of [{writable:false},{status:'loading'},{status:'unavailable'},{value:{vertexProtocol:'interactions'}}]){
    const r=render({vertexProtocol:'generate-content'})
    const control=tierButton(r,'vertexServiceTier','priority');assert.equal(control.props.disabled,false)
    r.setForm(change);await control.props.onClick();assert.deepEqual(r.writes,[]);await r.close()
  }
  const r=render();const switchProtocol=protocolButton(r,'vertex','interactions'),paygo=paygoButton(r)
  r.setForm({value:{vertexServiceTier:'priority'}});await switchProtocol.props.onClick()
  r.setForm({value:{vertexProtocol:'interactions'}});await paygo.props.onClick()
  assert.deepEqual(r.writes,[]);await r.close()
})

test('tier writes use the real revision-fenced ConfigFormController and Host schema',async()=>{
  const {ConfigFormController}=await hostClientModule('@deepseek-ai/dsh-client-ui-settings','packages/client/ui-settings/src/client/config-form.ts')
  const resolve=value=>Object.fromEntries(Object.entries(Config(value)).map(([key,item])=>[key,item.get()]))
  let namespace={ns:'local-vertex-argon',revision:7,value:resolve({googleProtocol:'generate-content'})}
  const listeners=new Set(),calls=[]
  const mirror={getSnapshot:()=>({view:{writable:true,namespaces:[namespace]}}),subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},acceptView:view=>{namespace=view;for(const listener of listeners)listener()},load:async()=>{}}
  const ctx={remote:{settings:{mutate:async(ns,ops,revision)=>{
    const wire=JSON.parse(JSON.stringify({ns,ops,revision}));calls.push(wire)
    assert.equal(wire.ns,namespace.ns);assert.equal(wire.revision,namespace.revision)
    const value={...namespace.value}
    for(const op of wire.ops){assert.equal(op.op,'set');assert.equal(op.path.length,1);value[op.path[0]]=op.value}
    return{ok:true,value:{...namespace,revision:revision+1,value:resolve(value)}}
  }}}}
  const controller=new ConfigFormController(ctx,{namespace:namespace.ns,decode:resolve},mirror,{})
  const r=render({},true,{formController:controller})
  try{
    await tierButton(r,'googleServiceTier','flex').props.onClick()
    await tierButton(r,'vertexServiceTier','priority').props.onClick()
    await paygoButton(r).props.onClick()
    assert.deepEqual(calls.map(x=>x.ops),[
      [{op:'set',path:['googleServiceTier'],value:'flex'}],
      [{op:'set',path:['vertexServiceTier'],value:'priority'}],
      [{op:'set',path:['vertexPaygoOnly'],value:true}],
    ])
    assert.deepEqual(calls.map(x=>x.revision),[7,8,9])
    assert.equal(controller.getSnapshot().value.googleProtocol,'generate-content')
    assert.equal(controller.getSnapshot().value.googleServiceTier,'flex')
    assert.equal(controller.getSnapshot().value.vertexServiceTier,'priority')
    assert.equal(controller.getSnapshot().value.vertexPaygoOnly,true)
    assert.deepEqual(resolveServicePolicy(controller.getSnapshot().value,'google-vertex','generate-content').headers,{'X-Vertex-AI-LLM-Shared-Request-Type':'priority','X-Vertex-AI-LLM-Request-Type':'shared'})
    const panel=r.settingsPanel()
    try {
      let view=await panel.mount()
      await view.nodes.find(node=>node.props['aria-labelledby']==='argon-proxy-enabled').props.onClick()
      view=panel.draw();view.nodes.find(node=>node.props.name==='proxyBaseUrl').props.onChange({target:{value:'https://proxy.example/v1beta'}})
      await button(panel.draw(),r.dictionary.proxySaveBaseUrl).props.onClick()
      view=panel.draw();view.nodes.find(node=>node.props.name==='proxyApiKey').props.onChange({target:{value:'dedicated-proxy-key'}})
      await view.nodes.find(node=>node.props.name==='proxyApiKey').props.onBlur()
      assert.deepEqual(calls.slice(3).map(call=>call.ops),[
        [{op:'set',path:['proxyEnabled'],value:true}],
        [{op:'set',path:['proxyBaseUrl'],value:'https://proxy.example/v1beta'}],
        [{op:'set',path:['proxyApiKey'],value:'dedicated-proxy-key'}],
      ])
      assert.deepEqual(calls.slice(3).map(call=>call.revision),[10,11,12])
      assert.equal(controller.getSnapshot().value.proxyApiKey,'dedicated-proxy-key')
    } finally { panel.close() }

  }finally{await r.close();await controller.dispose()}
})

test('in-flight tier save blocks retained competing settings and reset callbacks',async()=>{
  let settle;const calls=[]
  const formController={getSnapshot:()=>({status:'ready',writable:true,value:{googleProtocol:'interactions'}}),subscribe:()=>()=>{},set:(key,value)=>{calls.push([key,value]);return new Promise(resolve=>{settle=resolve})}}
  const r=render({},true,{formController})
  try{
    const pending=tierButton(r,'googleServiceTier','flex').props.onClick()
    await tierButton(r,'googleServiceTier','priority').props.onClick()
    await protocolButton(r,'google','generate-content').props.onClick()
    await r.all.find(x=>x.type==='button'&&x.children.includes(r.dictionary.resetDefaults)).props.onClick()
    assert.deepEqual(calls,[['googleServiceTier','flex']])
    settle(true);await pending
  }finally{await r.close()}
})

test('tier mutation failures show errors without claiming the configured value changed',async()=>{
  const formController={getSnapshot:()=>({status:'ready',writable:true,value:{googleProtocol:'interactions'}}),subscribe:()=>()=>{},set:async()=>false}
  const r=render({},true,{formController}),panel=r.settingsPanel()
  try{
    let view=await panel.mount()
    const group=view.nodes.find(x=>x.props['data-tier-field']==='googleServiceTier')
    await group.children.find(x=>x.children.includes(r.dictionary.tier_priority)).props.onClick()
    view=panel.draw()
    assert.ok(view.nodes.some(x=>x.props.role==='alert'&&x.children.includes(r.dictionary.error)))
    assert.equal(view.nodes.find(x=>x.props['data-tier-field']==='googleServiceTier').children.find(x=>x.children.includes(r.dictionary.tier_standard)).props['aria-pressed'],true)
  }finally{panel.close();await r.close()}
})

test('English and Chinese dictionaries cover the same nonempty keys',async()=>{
  const r=render()
  assert.deepEqual(Object.keys(r.dictionaries.zh).sort(),Object.keys(r.dictionaries.en).sort())
  for(const dict of Object.values(r.dictionaries)){
    for(const [key,value]of Object.entries(dict))assert.ok(typeof value==='string'&&(value.length>0||['diagHopsDroppedPrefix','diagHopsDroppedSuffix'].includes(key)),key)
    assert.ok((dict.diagHopsDroppedPrefix+dict.diagHopsDroppedSuffix).trim().length>0)
  }
  await r.close()
})
test('long decode is on by default without automatically granting background or storage',async()=>{
  const r=render()
  assert.equal(r.all.find(x=>x.props['aria-labelledby']==='vertex-argon-longdecode-label').props['aria-checked'],true)
  assert.equal(r.all.find(x=>x.props['aria-labelledby']==='argon-storage-label').props['aria-checked'],false)
  assert.equal(r.all.find(x=>x.props['aria-labelledby']==='argon-background-label').props['aria-checked'],false)
  assert.equal(r.writes.length,0)
  await r.close()
})
test('effective budget honours mode and small-window branches without overwriting raw values',async()=>{
  for(const [value,expected]of [[{longDecode:false,maxTokens:131072},65536],[{longDecode:false,maxTokens:131072,contextWindow:10000},10000],[{maxTokens:1048576},917504]]){
    const r=render(value)
    const effective=r.all.find(x=>x.children.some(c=>typeof c==='string'&&c.startsWith(r.dictionary.effectiveBudget)))
    assert.ok(effective,'effective configured budget must remain visible')
    assert.ok(effective.children.join('').includes(expected.toLocaleString()))
    assert.equal(r.writes.length,0)
    await r.close()
  }
})
test('selecting a large-budget Interactions route changes only that protocol field',async()=>{
  const r=render({maxTokens:131072})
  const group=r.all.find(x=>x.props['aria-label']==='Gemini API protocol')
  await group.children.find(x=>x.props['aria-pressed']===false).props.onClick()
  assert.deepEqual(r.writes,[['googleProtocol','interactions']])
  await r.close()
  const limited=render({vertexProtocol:'interactions',longDecode:false,maxTokens:131072})
  assert.ok(!limited.all.some(x=>x.props.role==='alert'),'the current effective64K budget is not a Vertex large-budget conflict')
  assert.equal(limited.writes.length,0)
  await limited.close()
})

test('summary does not present fallback defaults as loaded data',async()=>{
  for(const status of ['loading','unavailable']){
    const r=render({},true,{status})
    assert.ok(!r.all.some(x=>x.props.role==='region'&&x.props['aria-label']===r.dictionary.summaryLabel))
    assert.ok(r.all.some(x=>x.props.role==='status'&&x.children.includes(r.dictionary[status==='loading'?'loading':'unavailable'])))
    await r.close()
  }
  const readonly=render({maxTokens:131072},false)
  assert.ok(readonly.all.some(x=>x.children.includes(readonly.dictionary.readonlyBanner)))
  await readonly.close()
})
test('budget conflict names only affected routes and sits beside protocol choices',async()=>{
  for(const route of ['google','vertex']){
    const r=render({[route+'Protocol']:'interactions',maxTokens:131072})
    const alerts=r.all.filter(x=>x.props.role==='alert')
    assert.equal(alerts.length,1)
    const text=alerts[0].children.join('')
    assert.ok(text.includes(route==='google'?'Gemini API':'Vertex AI'))
    assert.ok(!text.includes(route==='google'?'Vertex AI':'Gemini API'))
    const header=r.all.findIndex(x=>x.type==='h3'&&x.children.includes(r.dictionary.protocolTitle))
    const budget=r.all.findIndex(x=>x.type==='h3'&&x.children.includes(r.dictionary.budgetTitle))
    assert.ok(r.all.indexOf(alerts[0])>header&&r.all.indexOf(alerts[0])<budget)
    await r.close()
  }
})
test('diagnosis exposes request ceiling, omitted details and termination with token watermark',async()=>{
  const {fixture,button:findButton,selectRequest,detail,row}=await import('./client-inspector-fixture.mjs')
  for(const language of ['zh','en']){
    const f=fixture({language})
    try{
      f.handlers.getRequest=async()=>({...detail(),record:{...row(),configuredMaxTokens:98304,hopsDropped:2,remoteCancellation:'confirmed',protocol:'interactions',hops:[{finishReason:'stop'}]}})
      let view=await f.settle()
      await selectRequest(view).props.onChange({target:{value:row().id}});view=await f.settle()
      assert.ok(view.text.includes('98304'));assert.ok(view.text.includes('hopsDropped'));assert.ok(view.text.includes('confirmed'))
      assert.ok(view.text.includes(f.dictionary.inspectorRequestSummary));assert.ok(view.nodes.some(node=>node.props['aria-label']===f.dictionary.inspectorTokenWatermark))
      assert.ok(view.text.includes('In: — · Cache: —'))
      assert.equal(findButton(view,f.dictionary.inspectorRaw).props['aria-expanded'],false)
      assert.equal(f.calls.some(x=>x.method==='readResponse'),false)
    }finally{await f.close()}
  }
})
test('diagnosis refresh remains read-only and reports failure instead of empty success',async()=>{
  const {fixture,button:findButton}=await import('./client-inspector-fixture.mjs')
  const f=fixture()
  try{
    await f.settle();f.handlers.listRequests=async()=>({ok:false})
    await findButton(f.draw(),f.dictionary.inspectorRefresh).props.onClick()
    const view=await f.settle()
    assert.ok(view.nodes.some(x=>x.props.role==='alert'&&x.children.includes(f.dictionary.inspectorError)))
    assert.deepEqual(f.calls.map(x=>x.method),['listRequests','listRequests'])
    assert.ok(!view.text.includes(f.dictionary.inspectorEmpty))
  }finally{await f.close()}
})
test('Settings contains defaults only, not duplicated diagnostics or recovery controls',async()=>{
  const r=render()
  try{
    assert.equal(r.all.some(x=>typeof x.type==='function'&&(x.props.loadDiagnostics||x.props.loadRecovery)),false)
    assert.equal(r.all.some(x=>x.children.includes(r.dictionary.recoveryTitle)),false)
  }finally{await r.close()}
})

test('recovery requires explicit checkbox plus confirm and never starts a new request',async()=>{
  const f=recoveryFixture();const {r,panel,calls}=f
  try{
    let view=await panel.mount()
    assert.deepEqual(calls.lists,[{limit:20}]);assert.equal(calls.releases.length,0)
    assert.equal(checkbox(view),undefined)
    await button(view,r.dictionary.recoveryRelease).props.onClick()
    view=panel.draw()
    assert.equal(calls.releases.length,0)
    assert.equal(checkbox(view).props.checked,false)
    const confirm=button(view,r.dictionary.recoveryConfirm)
    assert.equal(confirm.props.disabled,true)
    await confirm.props.onClick() // A disabled button's callback must also refuse.
    assert.equal(calls.releases.length,0)
    checkbox(view).props.onChange({target:{checked:true}})
    assert.equal(calls.releases.length,0)
    view=panel.draw()
    assert.equal(button(view,r.dictionary.recoveryConfirm).props.disabled,false)
    const act=button(view,r.dictionary.recoveryConfirm).props.onClick
    const first=act();await act();await first;await act()
    assert.deepEqual(calls.releases,[{key:'a'.repeat(64),expectedUpdatedAt:'2026-10-17T01:00:00.000Z',acknowledgeRisk:true}])
    view=panel.draw()
    assert.ok(view.text.includes(r.dictionary.recoverySuccess))
    assert.ok(view.text.includes(r.dictionary.recoveryReleased))
    assert.equal(button(view,r.dictionary.recoveryRelease),undefined)
    assert.equal(calls.lists.length,2)
    assert.equal(r.writes.length,0)
  }finally{await f.close()}
})

test('cancel and refresh discard acknowledgement and invalidate old confirmation callbacks',async()=>{
  const f=recoveryFixture();const {r,panel,calls}=f
  try{
    await panel.mount()
    button(panel.draw(),r.dictionary.recoveryRelease).props.onClick()
    checkbox(panel.draw()).props.onChange({target:{checked:true}})
    const stale=button(panel.draw(),r.dictionary.recoveryConfirm).props.onClick
    button(panel.draw(),r.dictionary.recoveryCancel).props.onClick()
    assert.equal(checkbox(panel.draw()),undefined)
    await stale();assert.equal(calls.releases.length,0)
    button(panel.draw(),r.dictionary.recoveryRelease).props.onClick()
    assert.equal(checkbox(panel.draw()).props.checked,false)
    checkbox(panel.draw()).props.onChange({target:{checked:true}})
    const beforeRefresh=button(panel.draw(),r.dictionary.recoveryConfirm).props.onClick
    await button(panel.draw(),r.dictionary.recoveryRefresh).props.onClick()
    assert.equal(checkbox(panel.draw()),undefined)
    await beforeRefresh();assert.equal(calls.releases.length,0)
  }finally{await f.close()}
})

test('read-only and not-ready callbacks cannot mutate configuration or recovery state',async()=>{
  for(const state of [{writable:false,status:'ready'},{writable:true,status:'loading'},{writable:true,status:'unavailable'}]){
    const f=recoveryFixture(state);const {r,panel,calls}=f
    try{
      const view=await panel.mount()
      const open=button(view,r.dictionary.recoveryRelease)
      assert.equal(open.props.disabled,true);await open.props.onClick()
      assert.equal(checkbox(panel.draw()),undefined)
      for(const node of r.all.filter(x=>x.type==='button'&&x.props.onClick))await node.props.onClick()
      const res=await r.remoteProps.releaseRecovery({key:'a'.repeat(64),expectedUpdatedAt:'2026-10-17T01:00:00.000Z',acknowledgeRisk:true})
      assert.equal(res.ok,false)
      assert.equal(calls.releases.length,0);assert.equal(r.writes.length,0)
      await button(panel.draw(),r.dictionary.recoveryRefresh).props.onClick()
      assert.equal(calls.lists.length,2,'read-only refresh is still available')
    }finally{await f.close()}
  }
})

test('retained writable callbacks hard-stop when form permissions or readiness change',async()=>{
  for(const next of [{writable:false},{status:'loading'},{status:'unavailable'}]){
    const f=recoveryFixture();const {r,panel,calls}=f
    try{
      await panel.mount()
      button(panel.draw(),r.dictionary.recoveryRelease).props.onClick()
      const check=checkbox(panel.draw()).props.onChange
      check({target:{checked:true}})
      const confirm=button(panel.draw(),r.dictionary.recoveryConfirm).props.onClick
      const cancel=button(panel.draw(),r.dictionary.recoveryCancel).props.onClick
      r.setForm(next)
      check({target:{checked:false}});await confirm();cancel()
      assert.equal(checkbox(panel.draw()).props.checked,true,'read-only handlers must not change confirmation state')
      assert.equal(button(panel.draw(),r.dictionary.recoveryConfirm).props.disabled,true)
      for(const node of r.all.filter(x=>x.type==='button'&&x.props.onClick))await node.props.onClick()
      assert.equal(calls.releases.length,0);assert.equal(r.writes.length,0)
    }finally{await f.close()}
  }
})

test('active, known-ID, released and unsupported stages never offer release actions',async()=>{
  const blocked=[{active:true},{hasRemoteId:true},{releasedAt:'2026-10-17T01:30:00.000Z'},{stage:'accepted'},{stage:'cancel-failed'}]
  for(const patch of blocked){
    const f=recoveryFixture({records:[recoveryRecord(patch)]});const {r,panel,calls}=f
    try{
      const view=await panel.mount()
      assert.equal(button(view,r.dictionary.recoveryRelease),undefined)
      assert.equal(button(view,r.dictionary.recoveryConfirm),undefined)
      if(patch.hasRemoteId)assert.ok(view.text.includes(r.dictionary.recoveryKnownId))
      if(patch.active)assert.ok(view.text.includes(r.dictionary.recoveryActive))
      if(patch.releasedAt)assert.ok(view.text.includes(r.dictionary.recoveryReleased)&&view.text.includes(new Date(patch.releasedAt).toLocaleString()))
      assert.equal(calls.releases.length,0)
    }finally{await f.close()}
  }
  const f=recoveryFixture({records:[recoveryRecord({stage:'creating'})]})
  try{assert.ok(button(await f.panel.mount(),f.r.dictionary.recoveryRelease))}finally{await f.close()}
})

test('refreshed active, known-ID, released or changed versions block retained handlers',async()=>{
  for(const patch of [{active:true},{hasRemoteId:true},{releasedAt:'2026-10-17T01:30:00.000Z'},{updatedAt:'2026-10-17T01:10:00.000Z'}]){
    const f=recoveryFixture();const {r,panel,calls}=f
    try{
      await panel.mount()
      const oldOpen=button(panel.draw(),r.dictionary.recoveryRelease).props.onClick
      oldOpen();checkbox(panel.draw()).props.onChange({target:{checked:true}})
      const oldConfirm=button(panel.draw(),r.dictionary.recoveryConfirm).props.onClick
      f.setRecords([recoveryRecord(patch)])
      await button(panel.draw(),r.dictionary.recoveryRefresh).props.onClick()
      oldOpen();await oldConfirm()
      assert.equal(calls.releases.length,0)
      assert.equal(checkbox(panel.draw()),undefined)
    }finally{await f.close()}
  }
})

test('server release errors and malformed success stay visible without fake release',async()=>{
  for(const response of [{ok:false,error:'Record changed; refresh required'},{ok:true},{ok:true,released:true,remoteAction:'cancel',newRequestStarted:false},{ok:true,released:true,remoteAction:'none',newRequestStarted:true}]){
    const f=recoveryFixture();const {r,panel,api}=f
    api.releaseUnknown=async()=>({ok:true,value:response})
    try{
      await panel.mount()
      button(panel.draw(),r.dictionary.recoveryRelease).props.onClick()
      checkbox(panel.draw()).props.onChange({target:{checked:true}})
      await button(panel.draw(),r.dictionary.recoveryConfirm).props.onClick()
      const view=panel.draw()
      assert.ok(view.nodes.some(x=>x.props.role==='alert'))
      if(response.error)assert.ok(view.text.includes(response.error))
      assert.ok(!view.text.includes(r.dictionary.recoverySuccess))
      assert.ok(!view.text.includes(r.dictionary.recoveryReleased))
      assert.ok(button(view,r.dictionary.recoveryRelease))
      assert.equal(checkbox(view),undefined,'retry requires a new risk confirmation')
    }finally{await f.close()}
  }
})

test('refresh failure is an error, not an empty success, and blocks stale actions',async()=>{
  const f=recoveryFixture();const {r,panel,api,calls}=f
  try{
    await panel.mount()
    const open=button(panel.draw(),r.dictionary.recoveryRelease).props.onClick
    open();checkbox(panel.draw()).props.onChange({target:{checked:true}})
    const confirm=button(panel.draw(),r.dictionary.recoveryConfirm).props.onClick
    api.listRecovery=async()=>({ok:false,error:{message:'Recovery store unavailable'}})
    await button(panel.draw(),r.dictionary.recoveryRefresh).props.onClick()
    const view=panel.draw()
    assert.ok(view.text.includes('Recovery store unavailable'))
    assert.ok(view.nodes.some(x=>x.props.role==='alert'))
    assert.ok(!view.text.includes(r.dictionary.recoverySuccess))
    assert.ok(!view.text.includes(r.dictionary.recoveryEmpty))
    assert.equal(button(view,r.dictionary.recoveryRelease).props.disabled,true)
    open();await confirm();assert.equal(calls.releases.length,0)
    api.listRecovery=async()=>{throw new Error('Transport failed')}
    await button(panel.draw(),r.dictionary.recoveryRefresh).props.onClick()
    assert.ok(panel.draw().text.includes('Read failed')||panel.draw().text.includes('Transport failed'))
  }finally{await f.close()}
})

test('confirmed release stays audited and cannot repeat if subsequent refresh fails',async()=>{
  const f=recoveryFixture();const {r,panel,api,calls}=f
  try{
    await panel.mount()
    button(panel.draw(),r.dictionary.recoveryRelease).props.onClick()
    checkbox(panel.draw()).props.onChange({target:{checked:true}})
    const confirm=button(panel.draw(),r.dictionary.recoveryConfirm).props.onClick
    api.listRecovery=async()=>({ok:true,value:{ok:false,error:'Refresh failed after release'}})
    await confirm();await confirm()
    const view=panel.draw()
    assert.ok(view.text.includes(r.dictionary.recoverySuccess))
    assert.ok(view.text.includes(r.dictionary.recoveryReleased))
    assert.ok(view.text.includes('Refresh failed after release'))
    assert.equal(button(view,r.dictionary.recoveryRelease),undefined)
    assert.equal(calls.releases.length,1)
  }finally{await f.close()}
})

test('recovery refresh, locale parity, recent-unreleased order and redaction',async()=>{
  const records=[
    recoveryRecord({key:'c'.repeat(64),sessionHash:'c'.repeat(12),updatedAt:'2026-10-17T03:00:00.000Z',releasedAt:'2026-10-17T03:00:00.000Z'}),
    recoveryRecord({key:'d'.repeat(64),sessionHash:'d'.repeat(12)}),
    recoveryRecord({key:'e'.repeat(64),sessionHash:'e'.repeat(12),updatedAt:'2026-10-17T02:00:00.000Z',body:'PRIVATE_BODY',apiKey:'PRIVATE_KEY',interactionId:'PRIVATE_REMOTE_ID'}),
  ]
  for(const language of ['zh','en']){
    const f=recoveryFixture({records,language});const {r,panel,calls}=f
    try{
      let view=await panel.mount()
      for(const label of ['recoveryTitle','recoveryHint','recoveryRefresh','recoveryReleased'])assert.ok(view.text.includes(r.dictionary[label]))
      assert.ok(view.text.indexOf('e'.repeat(12))<view.text.indexOf('d'.repeat(12)))
      assert.ok(view.text.indexOf('d'.repeat(12))<view.text.indexOf('c'.repeat(12)))
      for(const secret of ['PRIVATE_BODY','PRIVATE_KEY','PRIVATE_REMOTE_ID','e'.repeat(64)])assert.ok(!view.text.includes(secret))
      button(view,r.dictionary.recoveryRelease).props.onClick()
      view=panel.draw()
      assert.ok(view.text.includes(r.dictionary.recoveryRisk))
      assert.ok(button(view,r.dictionary.recoveryConfirm));assert.ok(button(view,r.dictionary.recoveryCancel))
      await button(view,r.dictionary.recoveryRefresh).props.onClick()
      assert.deepEqual(calls.lists,[{limit:20},{limit:20}]);assert.equal(calls.releases.length,0)
      assert.equal(r.writes.length,0)
    }finally{await f.close()}
  }
})

test('typed recovery descriptors mount once, validate contracts, unwrap envelopes and dispose',async()=>{
  const f=recoveryFixture();const {r,panel,calls,api}=f
  try{
    await panel.mount()
    assert.equal(calls.mounts.length,1)
    const spec=calls.mounts[0]
    assert.equal(spec.package,'dsh-vertex-argon')
    assert.deepEqual(Array.from(spec.descriptors,x=>x.method),['listRecovery','releaseUnknown','listRequests','getRequest','readResponse','queryInteraction','readQueryResponse'])
    for(const method of ['listRecovery','releaseUnknown']){
      const descriptor=spec.descriptors.find(x=>x.method===method)
      assert.equal(descriptor.id,'dsh-vertex-argon#vertexArgonDiagnostics/'+method)
      assert.equal(descriptor.service,'vertexArgonDiagnostics');assert.equal(descriptor.namespace,'vertexArgonDiagnostics')
      assert.equal(descriptor.invocation.kind,'direct')
      for(const [direction,codec] of [['request',descriptor.parameters[0].codec],['result',descriptor.result]]){
        assert.equal(codec.mode,'strict');assert.equal(codec.typeSymbol,'dsh-vertex-argon/'+method+'/'+direction)
        assert.equal(typeof codec.create().parse,'function')
      }
    }
    const list=spec.descriptors.find(x=>x.method==='listRecovery')
    assert.deepEqual(plain(list.parameters[0].codec.create().parse({limit:20})),{limit:20})
    assert.throws(()=>list.parameters[0].codec.create().parse({limit:0}))
    assert.throws(()=>list.result.create().parse({ok:true,records:[{...recoveryRecord(),active:undefined}]}))
    assert.throws(()=>list.result.create().parse({ok:true,records:[{...recoveryRecord(),sessionHash:123456789012}]}))
    assert.throws(()=>list.result.create().parse({ok:true,records:[{...recoveryRecord(),updatedAt:'2026-10-17T01:00:00'}]}))
    const release=spec.descriptors.find(x=>x.method==='releaseUnknown')
    assert.throws(()=>release.parameters[0].codec.create().parse({key:'a'.repeat(64),expectedUpdatedAt:recoveryRecord().updatedAt,acknowledgeRisk:false}))
    assert.throws(()=>release.parameters[0].codec.create().parse({key:'bad',expectedUpdatedAt:recoveryRecord().updatedAt,acknowledgeRisk:true}))
    assert.throws(()=>release.result.create().parse({ok:true,released:true}))
    api.listRecovery=async()=>({ok:true,records:[]})
    assert.deepEqual(plain(await r.remoteProps.loadRecovery()),{ok:true,records:[]})
    assert.equal(calls.mounts.length,1)
  }finally{await f.close()}
  assert.equal(calls.unmounts,1)
})

test('one cached Intl formatter per module replaces per-value formatter construction',async()=>{
  const calls={date:[],number:[]}
  const spy=Object.create(Intl)
  spy.DateTimeFormat=function(...args){calls.date.push(args);return new Intl.DateTimeFormat(...args)}
  spy.NumberFormat=function(...args){calls.number.push(args);return new Intl.NumberFormat(...args)}
  const r=render({maxTokens:1048576},true,{intl:spy})
  const panel=r.settingsPanel()
  try{
    assert.equal(calls.date.length,0,'Debug does not allocate an unused time formatter')
    assert.equal(calls.number.length,1,'the module builds exactly one NumberFormat')
    const view=await panel.mount()
    panel.draw();panel.draw()
    assert.equal(calls.date.length,0,'rerenders never allocate an unused time formatter')
    assert.equal(calls.number.length,1,'a rerender must reuse the cached number formatter')
    for(const text of ['786,432','1,048,576','917,504'])assert.ok(view.text.includes(text),text)
  }finally{panel.close();await r.close()}
})


test('client formatting never falls back to a per-call locale constructor',async()=>{
  assert.equal(source.includes('.toLocaleTimeString('),false,'retired short-time helper must remain absent')
  assert.equal(source.match(/\.toLocaleString\(\)/g)?.length,3,'only the three Date#toLocaleString recovery timestamps remain')
  assert.equal(source.match(/timeFormatter\.format\(/g)?.length,undefined)
  assert.equal(source.match(/numberFormatter\.format\(/g)?.length,2,'token text and budget share one formatter')
})
const proxyInput = (view, key) => view.nodes.find(node => node.type === 'input' && node.props.name === key)
for (const language of ['zh','en']) test('proxy settings default off, isolate password input and save only on blur/button: '+language,async()=>{
  const r=render({},true,{language}), panel=r.settingsPanel()
  try{
    let view=await panel.mount()
    const toggle=view.nodes.find(node=>node.props['aria-labelledby']==='argon-proxy-enabled')
    assert.equal(toggle.props['aria-checked'],false)
    assert.equal(proxyInput(view,'proxyBaseUrl').props.value,'http://127.0.0.1:8045/v1beta')
    assert.equal(proxyInput(view,'proxyApiKey').props.value,'')
    assert.equal(proxyInput(view,'proxyApiKey').props.type,'password')
    assert.equal(proxyInput(view,'proxyApiKey').props.placeholder,'sk-... / ANTIGRAVITY_API_KEY')
    assert.equal(r.writes.length,0)
    assert.ok(view.text.includes(r.dictionary.proxyHint));assert.ok(view.text.includes(r.dictionary.proxySaveHint))
    await toggle.props.onClick();assert.deepEqual(r.writes,[['proxyEnabled',true]])
    view=panel.draw();proxyInput(view,'proxyBaseUrl').props.onChange({target:{value:'https://proxy.example/v1beta'}})
    assert.equal(r.writes.length,1,'typing never writes')
    await proxyInput(panel.draw(),'proxyBaseUrl').props.onBlur()
    assert.deepEqual(r.writes.at(-1),['proxyBaseUrl','https://proxy.example/v1beta'])
    view=panel.draw();proxyInput(view,'proxyApiKey').props.onChange({target:{value:'proxy-key'}})
    await button(panel.draw(),r.dictionary.proxySaveApiKey).props.onClick()
    assert.deepEqual(r.writes.at(-1),['proxyApiKey','proxy-key'])
    const count=r.writes.length;await proxyInput(panel.draw(),'proxyApiKey').props.onBlur();assert.equal(r.writes.length,count,'successful save clears dirty state')
    assert.ok(!panel.draw().text.includes('proxy-key'),'key is never echoed as plain text')
  }finally{panel.close();await r.close()}
})

for(const state of [{status:'ready',writable:false},{status:'loading',writable:true},{status:'unavailable',writable:true}])test('proxy draft and retained save are denied by current form state '+JSON.stringify(state),async()=>{
  const r=render(),panel=r.settingsPanel()
  try{
    let view=await panel.mount();proxyInput(view,'proxyApiKey').props.onChange({target:{value:'draft-key'}})
    const save=button(panel.draw(),r.dictionary.proxySaveApiKey).props.onClick
    const blur=proxyInput(panel.draw(),'proxyApiKey').props.onBlur
    r.setForm(state);view=panel.draw()
    assert.equal(proxyInput(view,'proxyApiKey').props.disabled,true)
    await save();await blur();assert.equal(r.writes.length,0)
    panel.close();await save();assert.equal(r.writes.length,0)
  }finally{panel.close();await r.close()}
})

test('proxy save failure retains draft, blocks duplicate blur and never echoes the key in the error',async()=>{
  let resolve;const pending=new Promise(r=>{resolve=r}),writes=[]
  const form={getSnapshot:()=>({status:'ready',writable:true,value:{}}),subscribe:()=>()=>{},set:(key,value)=>{writes.push([key,value]);return pending}}
  const r=render({},true,{formController:form}),panel=r.settingsPanel()
  try{
    let view=await panel.mount();proxyInput(view,'proxyApiKey').props.onChange({target:{value:'private-draft'}})
    const blur=proxyInput(panel.draw(),'proxyApiKey').props.onBlur
    const work=blur();await blur();await button(panel.draw(),r.dictionary.proxySaveApiKey).props.onClick()
    assert.equal(writes.length,1)
    resolve(false);await work;view=panel.draw()
    assert.equal(proxyInput(view,'proxyApiKey').props.value,'private-draft');assert.ok(view.text.includes(r.dictionary.error));assert.ok(!view.text.includes('private-draft'))
  }finally{resolve(false);panel.close();await r.close()}
})

test('proxy reset clears dedicated key and dirty fields without touching foreign credentials',async()=>{
  let snapshot={status:'ready',writable:true,value:{proxyEnabled:true,proxyBaseUrl:'https://custom.example',proxyApiKey:'stored-key',googleApiKey:'foreign-key'}}
  const writes=[],form={getSnapshot:()=>snapshot,subscribe:()=>()=>{},set:async(key,value)=>{writes.push([key,value]);snapshot={...snapshot,value:{...snapshot.value,[key]:value}};return true}}
  const r=render({},true,{formController:form}),panel=r.settingsPanel()
  try{
    let view=await panel.mount();proxyInput(view,'proxyApiKey').props.onChange({target:{value:'dirty-key'}})
    await button(panel.draw(),r.dictionary.resetDefaults).props.onClick();view=panel.draw()
    assert.deepEqual(writes.filter(([key])=>key.startsWith('proxy')),[['proxyEnabled',false],['proxyBaseUrl','http://127.0.0.1:8045/v1beta'],['proxyApiKey','']])
    assert.equal(proxyInput(view,'proxyApiKey').props.value,'');assert.equal(snapshot.value.googleApiKey,'foreign-key')
  }finally{panel.close();await r.close()}
})
