// Run tests against a DSH checkout's peer dependencies without installing copies.
// DSH_TEST_HOST_ROOT=/path/to/deepseek-harness node --experimental-transform-types --import ./test/host-loader.mjs --test test/*.test.mjs
import { registerHooks, findPackageJSON } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { realpathSync } from 'node:fs'

const root = process.env.DSH_TEST_HOST_ROOT
if (root) {
  const anchor = pathToFileURL(resolve(root, 'packages/llm/llm-pi-ai/package.json')).href
  const piManifest = realpathSync(findPackageJSON('@earendil-works/pi-ai', anchor))
  const piAnchor = pathToFileURL(piManifest).href
  const genaiManifest = findPackageJSON('@google/genai', piAnchor)
  registerHooks({
    resolve(specifier, context, next) {
      try { return next(specifier, context) } catch (error) {
        if (!['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(error.code) || specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes(':')) throw error
        if (specifier.startsWith('@earendil-works/pi-ai/providers/')) {
          return next(pathToFileURL(resolve(dirname(piManifest), 'dist/providers', specifier.slice('@earendil-works/pi-ai/providers/'.length) + '.js')).href, context)
        }
        if (specifier === '@google/genai') {
          return next(specifier, { ...context, parentURL: piAnchor })
        }
        // Test-only reuse of the matching validator; production declares its own dependency.
        if (specifier === 'ajv/dist/2020.js') {
          return next(specifier, { ...context, parentURL: pathToFileURL(resolve(root, 'packages/boot/app-boot/package.json')).href })
        }
        const anchors = [anchor, pathToFileURL(resolve(root, 'package.json')).href, pathToFileURL(resolve(root, 'apps/cli/package.json')).href]
        anchors.push(pathToFileURL(resolve(root, 'packages/typert/protocol/package.json')).href)
        if (genaiManifest) anchors.push(pathToFileURL(genaiManifest).href)
        for (const parentURL of anchors) {
          try { return next(specifier, { ...context, parentURL }) } catch {}
        }
        throw error
      }
    },
  })
}
