// Reuse existing host dependencies for offline tests; never install or modify them.
// Optional override: DSH_TEST_HOST_ROOT=/path/to/deepseek-harness npm test
import { registerHooks, findPackageJSON } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve, dirname, relative, sep } from 'node:path'
import { existsSync, realpathSync, statSync, lstatSync, openSync, readSync, closeSync, mkdirSync, mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

const roots = [
  process.env.DSH_TEST_HOST_ROOT,
  resolve(import.meta.dirname, '../../../deepseek-harness'),
  resolve(import.meta.dirname, '../../deepseek-harness'),
  resolve(homedir(), '.dsh/profiles/desktop'),
  ...(process.platform === 'win32' ? ['O:/DeepSeekHarness/resources/app.asar.unpacked/dsh'] : []),
].filter(Boolean).map(root => resolve(root)).filter(root => existsSync(root))
const anchors = new Set()
const piManifests = new Set()
const resolutionErrors = new Set(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'])
const asURL = path => pathToFileURL(path).href

for (const root of roots) {
  const local = []
  for (const sub of ['packages/llm/llm-pi-ai/package.json', 'package.json', 'apps/cli/package.json', 'packages/typert/protocol/package.json', 'packages/boot/app-boot/package.json']) {
    const manifest = resolve(root, sub)
    if (existsSync(manifest)) local.push(asURL(realpathSync(manifest)))
  }
  // Also accept a dependency directory or an unpacked tree without a root manifest.
  const modules = root.endsWith('node_modules') ? root : resolve(root, 'node_modules')
  if (existsSync(modules)) local.push(asURL(resolve(modules, '__dsh_test_anchor__.mjs')))
  for (const anchor of local) {
    anchors.add(anchor)
    for (const specifier of ['@deepseek-ai/dsh-llm-pi-ai', '@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-typert-protocol', '@earendil-works/pi-ai', '@google/genai']) {
      try {
        const manifest = realpathSync(findPackageJSON(specifier, anchor))
        const url = asURL(manifest)
        if (!anchors.has(url)) local.push(url)
        anchors.add(url)
        if (specifier === '@earendil-works/pi-ai') piManifests.add(manifest)
      } catch (error) {
        if (!resolutionErrors.has(error.code) && !['ENOENT', 'ENOTDIR'].includes(error.code)) throw error
      }
    }
  }
}

// Desktop keeps most JS peers inside ASAR. Plain Node cannot resolve that tree.
// Read only the requested package on demand, preserving nested node_modules;
// completed package directories are published atomically for parallel test workers.
function desktopArchive() {
  if (process.platform !== 'win32') return undefined
  const archive = 'O:/DeepSeekHarness/resources/app.asar'
  const host = resolve(archive, 'dsh')
  if (existsSync(resolve(host, 'node_modules/@deepseek-ai/dsh-llm-pi-ai/package.json'))) {
    anchors.add(asURL(resolve(host, 'package.json')))
    return undefined // Electron's ASAR-aware fs needs no extraction.
  }
  if (!existsSync(archive)) return undefined
  const fd = openSync(archive, 'r')
  try {
    const size = statSync(archive).size
    const read = (offset, length) => {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > 256 * 1024 * 1024 || offset + length > size) throw new Error('Invalid ASAR file bounds')
      const bytes = Buffer.alloc(length)
      let done = 0
      while (done < length) {
        const count = readSync(fd, bytes, done, length - done, offset + done)
        if (!count) throw new Error('Truncated ASAR file')
        done += count
      }
      return bytes
    }
    const prefix = read(0, 16)
    const headerSize = prefix.readUInt32LE(4), jsonSize = prefix.readUInt32LE(12)
    if (prefix.readUInt32LE(0) !== 4 || headerSize < 8 || headerSize > 64 * 1024 * 1024 || jsonSize > headerSize - 8) throw new Error('Invalid ASAR header')
    const headerBytes = read(16, jsonSize)
    const header = JSON.parse(headerBytes.toString('utf8'))
    const dataOffset = 8 + headerSize
    const identity = createHash('sha256').update('argon-offline-host-v1').update(headerBytes).update(String(size)).digest('hex').slice(0, 24)
    const workspace = realpathSync(resolve(import.meta.dirname, '..'))
    const cache = resolve(workspace, '.tmp/test-host', identity)
    const inside = (base, path) => {
      const rel = relative(base, path)
      return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !rel.includes(':') && !rel.startsWith(sep))
    }
    const safeParts = path => {
      const parts = path.split('/')
      if (parts.some(p => !p || p === '.' || p === '..' || /[\\:\0]/.test(p))) throw new Error('Unsafe ASAR path')
      return parts
    }
    const lookup = (path, seen = new Set()) => {
      let node = header
      for (const part of safeParts(path)) node = node?.files?.[part]
      if (node?.link) {
        const target = safeParts(node.link).join('/')
        if (!target.startsWith('dsh/node_modules/') || seen.has(target) || seen.size >= 32) throw new Error('Unsafe ASAR link')
        return lookup(target, new Set([...seen, target]))
      }
      return { node, path }
    }
    const ensureDirectory = path => {
      if (!inside(workspace, path)) throw new Error('Offline cache escaped workspace')
      let current = workspace
      for (const part of relative(workspace, path).split(sep).filter(Boolean)) {
        current = resolve(current, part)
        try { mkdirSync(current) } catch (error) { if (error.code !== 'EEXIST') throw error }
        const stat = lstatSync(current)
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe offline cache directory')
      }
    }
    const nodeModules = resolve(cache, 'node_modules')
    const anchor = asURL(resolve(nodeModules, '__dsh_test_anchor__.mjs'))
    const unpacked = archive + '.unpacked'
    const copy = (source, destination, ancestors = new Set()) => {
      const found = lookup(source)
      if (!found.node || ancestors.has(found.path)) throw new Error('Invalid or cyclic ASAR entry')
      const { node, path } = found
      if (node.files) {
        mkdirSync(destination)
        for (const name of Object.keys(node.files)) {
          safeParts(name)
          if (name.includes('/')) throw new Error('Unsafe ASAR entry name')
          copy(path + '/' + name, resolve(destination, name), new Set([...ancestors, path]))
        }
      } else {
        let bytes
        if (node.unpacked) {
          const target = realpathSync(resolve(unpacked, ...safeParts(path)))
          if (!inside(realpathSync(unpacked), target)) throw new Error('Unpacked ASAR path escaped its root')
          const input = openSync(target, 'r')
          try {
            if (!Number.isSafeInteger(node.size) || node.size < 0 || node.size > 256 * 1024 * 1024 || statSync(target).size !== node.size) throw new Error('Invalid unpacked ASAR size')
            bytes = Buffer.alloc(node.size)
            let done = 0
            while (done < bytes.length) {
              const count = readSync(input, bytes, done, bytes.length - done, done)
              if (!count) throw new Error('Truncated unpacked ASAR file')
              done += count
            }
          } finally { closeSync(input) }
        } else {
          if (!/^\d+$/.test(node.offset)) throw new Error('Invalid ASAR offset')
          bytes = read(dataOffset + Number(node.offset), node.size)
        }
        if (node.integrity?.algorithm === 'SHA256' && createHash('sha256').update(bytes).digest('hex') !== node.integrity.hash) throw new Error('ASAR integrity mismatch')
        writeFileSync(destination, bytes, { flag: 'wx' })
      }
    }
    return {
      anchor,
      ensure(specifier) {
        const parts = specifier.split('/')
        const name = parts.slice(0, specifier.startsWith('@') ? 2 : 1).join('/')
        safeParts(name)
        const source = 'dsh/node_modules/' + name
        if (!lookup(source).node) return false
        ensureDirectory(nodeModules)
        const target = resolve(nodeModules, ...name.split('/'))
        ensureDirectory(dirname(target))
        const complete = resolve(target, '.argon-offline-complete')
        if (existsSync(complete)) {
          if (lstatSync(target).isSymbolicLink()) throw new Error('Unsafe cached package link')
          return true
        }
        const staging = mkdtempSync(resolve(cache, 'extract-'))
        const packageDir = resolve(staging, 'package')
        try {
          copy(source, packageDir)
          writeFileSync(resolve(packageDir, '.argon-offline-complete'), identity, { flag: 'wx' })
          try { renameSync(packageDir, target) } catch (error) {
            if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code) || !existsSync(complete) || lstatSync(target).isSymbolicLink()) throw error
          }
        } finally { rmSync(staging, { recursive: true, force: true }) }
        return true
      },
      close() { closeSync(fd) },
    }
  } catch (error) { closeSync(fd); throw error }
}
let archiveFallback
let archiveChecked = false
registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context) } catch (error) {
      if (!resolutionErrors.has(error.code) || specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes(':')) throw error
      if (specifier.startsWith('@earendil-works/pi-ai/providers/')) {
        for (const manifest of piManifests) {
          const target = resolve(dirname(manifest), 'dist/providers', specifier.slice('@earendil-works/pi-ai/providers/'.length) + '.js')
          if (existsSync(target)) return next(asURL(target), context)
        }
      }
      // Real package anchors preserve pnpm's nested dependency resolution, including
      // pi-ai's Google SDK and the host's AJV. Production declares its own AJV.
      for (const parentURL of anchors) {
        try { return next(specifier, { ...context, parentURL }) } catch (fallbackError) {
          if (!resolutionErrors.has(fallbackError.code)) throw fallbackError
        }
      }
      if (!archiveChecked) {
        archiveChecked = true
        archiveFallback = desktopArchive()
        if (archiveFallback) process.once('exit', () => archiveFallback.close())
        // Electron may have added an ASAR-aware anchor without creating a cache.
        if (!archiveFallback) {
          for (const parentURL of anchors) {
            try { return next(specifier, { ...context, parentURL }) } catch (fallbackError) {
              if (!resolutionErrors.has(fallbackError.code)) throw fallbackError
            }
          }
        }
      }
      if (archiveFallback?.ensure(specifier)) return next(specifier, { ...context, parentURL: archiveFallback.anchor })
      error.message += '\nOffline host dependency unavailable; set DSH_TEST_HOST_ROOT to an existing DSH dependency tree.'
      throw error
    }
  },
})
