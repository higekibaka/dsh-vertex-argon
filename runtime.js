import { createRequire, findPackageJSON } from 'node:module'
import { pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

// DSH desktop hosts plugins outside its ASAR dependency tree. Resolve shared
// services from the running host entry, never install a second service copy.
export async function shared(specifier) {
  try { return await import(specifier) }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !process.argv[1]) throw error
    const host = pathToFileURL(process.argv[1])
    const require = createRequire(host)
    let target
    if (specifier.startsWith('@earendil-works/pi-ai/providers/')) {
      const sub = specifier.slice('@earendil-works/pi-ai/providers/'.length)
      const manifest = findPackageJSON('@earendil-works/pi-ai', host)
      if (!manifest) throw error
      target = resolve(dirname(manifest), 'dist/providers/' + sub + '.js')
    } else target = require.resolve(specifier)
    return import(pathToFileURL(target).href)
  }
}
