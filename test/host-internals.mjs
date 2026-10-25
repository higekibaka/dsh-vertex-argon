// Test-only access to real host implementations, from a checkout or shipped bundles.
// Bundle instrumentation only exports existing bindings; it never replaces their bodies.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const modules = new Map()
const internalNames = {
  '@deepseek-ai/dsh-client-ui-sidebar-right': ['createSidebarRightController', 'SidebarRightTabRegistry', 'createSidebarRightStore'],
  '@deepseek-ai/dsh-client-ui-settings': ['ConfigFormController'],
  '@deepseek-ai/dsh-client-ui-conversation': ['DefaultConversationViews'],
}
const checkout = path => process.env.DSH_TEST_HOST_ROOT && resolve(process.env.DSH_TEST_HOST_ROOT, path)
const shipped = (name, path) => new URL(path, import.meta.resolve(name + '/package.json'))
let seeds
let reactRuntime

export function hostReactRuntime() {
  if (reactRuntime) return reactRuntime
  const anchors = [checkout('apps/web/package.json'), import.meta.url,
    ...(process.platform === 'win32' ? ['O:/AI/kt/outdoor-gear-landing/node_modules/__argon_ssr_anchor__.cjs'] : [])].filter(Boolean)
  for (const anchor of anchors) {
    const local = createRequire(anchor)
    try {
      const React = local('react'), server = local('react-dom/server')
      assert.equal(React.version, local('react-dom/package.json').version, 'React and SSR must share an exact version')
      assert.equal(createRequire(local.resolve('react-dom/server'))('react'), React, 'SSR and tested factories must use the same React instance')
      reactRuntime = { React, renderToStaticMarkup: server.renderToStaticMarkup, require: local }
      return reactRuntime
    } catch (error) {
      if (!['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'].includes(error.code)) throw error
    }
  }
  throw new Error('Real React and react-dom/server are required for offline UI tests')
}

async function clientSeeds() {
  if (seeds) return seeds
  const html = readFileSync(shipped('@deepseek-ai/dsh-web-frontend', 'dist/index.html'), 'utf8')
  const entry = html.match(/<script\b[^>]*\bsrc="([^"]+\.js)"/)
  assert.ok(entry, 'Host Web entry must exist')
  const url = shipped('@deepseek-ai/dsh-web-frontend', 'dist/' + entry[1].replace(/^\//, ''))
  let source = readFileSync(url, 'utf8')
  const imports = {}
  const document = { compatMode: 'CSS1Compat', createElement: () => ({ relList: { supports: () => true }, style: {} }) }
  // The production shell's static module table contains the actual store/slots/UI libraries.
  const importPattern = /import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["'];?/g
  for (const match of source.matchAll(importPattern)) {
    let vendor = readFileSync(new URL(match[2], url), 'utf8')
    vendor = vendor.replace(/export\s*\{([^}]+)\};?/, (_all, bindings) => 'return {' + bindings.split(',').map(binding => { const [local, exported = local] = binding.trim().split(/\s+as\s+/); return exported + ':' + local }).join(',') + '};')
    imports[match[2]] = new Function('document', vendor)(document)
  }
  source = source.replace(importPattern, (_all, bindings, specifier) => 'const {' + bindings.replace(/\s+as\s+/g, ':') + '} = imports[' + JSON.stringify(specifier) + '];')
  const seed = source.match(/function\s+([\w$]+)\(\)\{return\{react:/)
  // The boot boundary minifier assigns a version-specific local name.
  const boot = source.search(/const [\w$]+=globalThis\.dshDesktopBoot\b/)
  assert.ok(seed && boot > 0, 'Recognized real host static module table and boot boundary are required')
  source = source.slice(0, boot).replaceAll('import.meta.url', JSON.stringify(url.href))
  // Only the Vite preload feature check runs; never mount or start the host application.
  seeds = new Function('imports', 'window', 'document', source + ';return ' + seed[1] + '();')(imports, undefined, document)
  const runtime = hostReactRuntime()
  seeds = { ...seeds, '@deepseek-ai/cordis': await import('@deepseek-ai/cordis'),
    react: runtime.React, 'react/jsx-runtime': runtime.require('react/jsx-runtime'),
    'react-dom': runtime.require('react-dom'), 'react-dom/client': runtime.require('react-dom/client') }
  return seeds
}

function clientBundle(name) {
  if (modules.has(name)) return modules.get(name)
  const url = shipped(name, 'lib/client.js')
  let source = readFileSync(url, 'utf8')
  const names = internalNames[name] ?? []
  const boundary = source.lastIndexOf('return module.exports;')
  assert.ok(boundary >= 0, 'Real host client factory must return its exports')
  if (names.length) source = source.slice(0, boundary) + 'Object.assign(module.exports, {' + names.join(',') + '});\n' + source.slice(boundary)
  let declaration
  new Function('window', source)({ __ModuleLoader__: { load(value) { declaration = value } } })
  assert.equal(declaration?.id, name)
  const result = declaration.factory(specifier => {
    if (Object.hasOwn(seeds, specifier)) return seeds[specifier]
    if (specifier.startsWith('@deepseek-ai/dsh-client-')) return clientBundle(specifier.replace(/\/client$/, ''))
    return require(fileURLToPath(import.meta.resolve(specifier)))
  })
  modules.set(name, result)
  return result
}

export async function hostClientModule(name, sourcePath) {
  const path = checkout(sourcePath)
  if (path && existsSync(path)) return import(pathToFileURL(path).href)
  await clientSeeds()
  return clientBundle(name)
}

export async function hostAssistantStream() {
  const path = checkout('packages/core/agent-loop/src/assistant-stream.ts')
  if (path && existsSync(path)) return import(pathToFileURL(path).href)
  let source = readFileSync(shipped('@deepseek-ai/dsh-agent-loop', 'lib/index.js'), 'utf8')
  assert.match(source, /\b(?:class|var) AssistantStreamAttempt\b/)
  source = source.replace(/from\s+(["'])([^"']+)\1/g, (_all, _quote, specifier) => 'from ' + JSON.stringify(import.meta.resolve(specifier)))
  return import('data:text/javascript;base64,' + Buffer.from(source + '\nexport { AssistantStreamAttempt };').toString('base64'))
}
