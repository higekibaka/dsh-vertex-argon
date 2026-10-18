// Load before SDKs. Only this process's ephemeral IPv4 loopback test servers may receive I/O.
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'
import https from 'node:https'
import dns from 'node:dns'
const hostRoot = process.env.DSH_TEST_HOST_ROOT
process.env = hostRoot ? { DSH_TEST_HOST_ROOT: hostRoot } : {}
const deny = () => { throw new Error('ARGON_OFFLINE_NETWORK_DENIED') }
const ports = new Set()
const listen = net.Server.prototype.listen
net.Server.prototype.listen = function (...args) {
  const first = args[0]
  const options = first && typeof first === 'object' ? first : { port: first, host: args[1] }
  if (options.port !== 0 || options.host !== '127.0.0.1') return deny()
  let port
  this.prependOnceListener('listening', () => { port = this.address().port; ports.add(port) })
  this.once('close', () => ports.delete(port))
  return listen.apply(this, args)
}
const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  const values = Array.isArray(args[0]) ? args[0] : args
  const first = values[0]
  const options = first && typeof first === 'object' ? first : { port: first, host: values[1] }
  if (options.host !== '127.0.0.1' || !ports.has(Number(options.port))) return deny()
  return connect.apply(this, args)
}
const nativeFetch = globalThis.fetch
// Reject before DNS or socket creation; redirects cannot escape an owned fixture.
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !ports.has(Number(url.port)) || url.username || url.password) return deny()
  return nativeFetch(input, { ...init, redirect: 'error' })
}
tls.connect = deny
http.request = deny; http.get = deny; https.request = deny; https.get = deny
// Node also calls lookup for literal listen addresses. Resolve that literal locally, never via DNS.
dns.lookup = (host, options, callback) => {
  if (host !== '127.0.0.1') return deny()
  if (typeof options === 'function') { callback = options; options = {} }
  queueMicrotask(() => options?.all ? callback(null, [{ address: host, family: 4 }]) : callback(null, host, 4))
}
dns.promises.lookup = async (host, options) => {
  if (host !== '127.0.0.1') return deny()
  return options?.all ? [{ address: host, family: 4 }] : { address: host, family: 4 }
}
for (const name of ['resolve', 'resolve4', 'resolve6']) { dns[name] = deny; dns.promises[name] = async () => deny() }
globalThis.WebSocket = class { constructor() { deny() } }
syncBuiltinESMExports()
