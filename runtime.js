import { createRequire, findPackageJSON } from 'node:module'
import { pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

function findPiAiManifest(host) {
  for (const anchor of [import.meta.url, host].filter(Boolean)) {
    try {
      const direct = findPackageJSON('@earendil-works/pi-ai', anchor)
      if (direct) return direct
    } catch {}
    try {
      const llmPi = findPackageJSON('@deepseek-ai/dsh-llm-pi-ai', anchor)
      if (llmPi) {
        const nested = findPackageJSON('@earendil-works/pi-ai', pathToFileURL(llmPi))
        if (nested) return nested
      }
    } catch {}
  }
  return undefined
}

// DSH desktop hosts plugins outside its ASAR dependency tree. Resolve shared
// services from the running host entry, never install a second service copy.
export async function shared(specifier) {
  try { return await import(specifier) }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
    const host = process.argv[1] ? pathToFileURL(process.argv[1]) : undefined
    let target
    if (specifier.startsWith('@earendil-works/pi-ai/providers/')) {
      const sub = specifier.slice('@earendil-works/pi-ai/providers/'.length)
      const manifest = findPiAiManifest(host)
      if (!manifest) throw error
      target = resolve(dirname(manifest), 'dist/providers/' + sub + '.js')
    } else if (specifier === '@google/genai') {
      const piManifest = findPiAiManifest(host)
      const anchor = piManifest ? pathToFileURL(piManifest) : host
      if (!anchor) throw error
      const manifest = findPackageJSON('@google/genai', anchor)
      if (!manifest) throw error
      target = resolve(dirname(manifest), 'dist/node/index.mjs')
    } else {
      if (!host) throw error
      const require = createRequire(host)
      target = require.resolve(specifier)
    }
    return import(pathToFileURL(target).href)
  }
}
