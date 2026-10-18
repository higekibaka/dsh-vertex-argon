import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { fixture, button } from './client-inspector-fixture.mjs'

for (const language of ['en', 'zh']) for (const surface of ['sidebar', 'conversation']) test('paid JSON feature is absent, other operations remain: ' + language + '/' + surface, async () => {
  const f = fixture({ language })
  try {
    if (surface === 'conversation') f.conversation('dsh-vertex-argon/inspector')
    let view = await f.settle()
    button(view, f.dictionary.inspectorOperations).props.onClick(); view = await f.settle()
    assert.equal(view.nodes.some(node => node.props.className?.includes('argon-json')), false)
    assert.deepEqual(view.nodes.filter(node => node.type === 'details').map(node => node.props['data-operation']).filter(Boolean), ['query', 'recovery'])
    assert.equal(Object.keys(f.dictionary).some(key => key.startsWith('json')), false)
    assert.equal(f.permissions.includes('commands/execute'), false)
    assert.equal(f.calls.some(call => call.method === 'execute'), false)
    f.reset(); await f.settle()
    assert.equal(f.calls.some(call => call.method === 'execute'), false)
  } finally { await f.close() }
})

test('distribution excludes retired standalone JSON command and active client cannot invoke it', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.files.includes('structured-result-command.js'), false)
  const client = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const host = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  assert.equal(/argon-json|JsonResultPanel|executeJson|jsonAccess|remote\.commands/.test(client), false)
  assert.equal(/structured-result-command|createStructuredResult|authorized JSON/.test(host), false)
})
