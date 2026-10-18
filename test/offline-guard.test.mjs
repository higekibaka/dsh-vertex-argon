import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import tls from 'node:tls'
import dns from 'node:dns'
// This test intentionally fails if the offline preloader was omitted.
test('offline guard blocks external and unowned loopback targets before I/O', async () => {
  for (const url of ['https://example.invalid/', 'http://example.invalid/', 'http://127.0.0.1:1/']) await assert.rejects(fetch(url), /ARGON_OFFLINE_NETWORK_DENIED/)
  assert.throws(() => connect({ host: 'example.invalid', port: 443 }), /ARGON_OFFLINE_NETWORK_DENIED/)
  assert.throws(() => tls.connect({ host: 'example.invalid', port: 443 }), /ARGON_OFFLINE_NETWORK_DENIED/)
  await assert.rejects(dns.promises.lookup('example.invalid'), /ARGON_OFFLINE_NETWORK_DENIED/)
  const server = createServer()
  assert.throws(() => server.listen(0, '0.0.0.0'), /ARGON_OFFLINE_NETWORK_DENIED/)
})
test('offline guard permits only its own ephemeral loopback and revokes on close', async () => {
  const server = createServer((_request, response) => response.end('owned-fixture'))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = 'http://127.0.0.1:' + server.address().port
  try { assert.equal(await (await fetch(url)).text(), 'owned-fixture') }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  await assert.rejects(fetch(url), /ARGON_OFFLINE_NETWORK_DENIED/)
})
test('offline guard refuses a fixture redirect to the outside', async () => {
  const server = createServer((_request, response) => { response.writeHead(302, { location: 'https://example.invalid/' }); response.end() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try { await assert.rejects(fetch('http://127.0.0.1:' + server.address().port)) }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})
