import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getEventListeners } from 'node:events'
import {
  continueArgonRequestStream, parseUpstreamRetryDelayMs, computeReconnectDelayMs,
  MAX_SERVER_RETRY_DELAY_MS, MAX_SAME_TOKEN_RETRIES, MAX_THINKING_DROPOUT_HEALS,
  STREAM_INITIAL_TTFT_TIMEOUT_MS, STREAM_THINKING_TIMEOUT_MS,
  STREAM_TRANSITION_TIMEOUT_MS, STREAM_SLIDING_TIMEOUT_MS,
} from '../generate-content.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const never = () => new Promise(() => {})
const wire = raw => ({ headers: {}, json: async () => raw })
const row = (parts = [], finishReason, continuationToken, usageMetadata) => ({
  candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}), ...(continuationToken ? { continuationToken } : {}) }],
  ...(usageMetadata ? { usageMetadata } : {}),
})
const text = value => [{ text: value }]
const thought = [{ text: 'private thought', thought: true, thoughtSignature: 'opaque-signature' }]
const done = row(text('answer'), 'STOP')
const fail = status => Object.assign(new Error('fixture'), { status })
async function setup(hops, options = {}) {
  const requests = [], events = [], usage = [], observed = []
  const original = async request => {
    requests.push(request)
    const source = typeof hops === 'function' ? hops(requests.length, request) : hops[requests.length - 1]
    if (source instanceof Error) throw source
    if (!Array.isArray(source)) return source
    return (async function* () { for (const item of source) { if (item instanceof Error) throw item; yield wire(item) } })()
  }
  const tracker = {
    setApiVersion() {}, recordTokenUsage: value => usage.push(value),
    beginHop(meta) { const event = { ...meta }; events.push(event); return { onChunk() {}, recordTokenUsage(value) { observed.push(value) }, finish(value) { event.finished = value } } },
  }
  const stream = await continueArgonRequestStream({ isVertexAI: () => false }, original,
    { body: JSON.stringify(options.body ?? { contents: [{ role: 'user', parts: text('question') }] }), abortSignal: options.signal },
    { enabled: true, reconnectBackoff: { initialDelayMs: 0 }, tracker, ...options.meta })
  return { stream, requests, events, usage, observed }
}
async function run(hops, options) {
  const out = await setup(hops, options); out.chunks = []
  try { for await (const chunk of out.stream) out.chunks.push(await chunk.json()) } catch (error) { out.error = error }
  out.parts = out.chunks.flatMap(chunk => chunk.candidates?.[0]?.content?.parts ?? [])
  return out
}

test('phase defaults and retry/heal budgets are explicit', () => {
  assert.deepEqual([STREAM_INITIAL_TTFT_TIMEOUT_MS, STREAM_THINKING_TIMEOUT_MS, STREAM_TRANSITION_TIMEOUT_MS, STREAM_SLIDING_TIMEOUT_MS], [180000, 180000, 180000, 120000])
  assert.equal(MAX_SERVER_RETRY_DELAY_MS, 60000)
  assert.equal(MAX_SAME_TOKEN_RETRIES, 3)
  assert.equal(MAX_THINKING_DROPOUT_HEALS, 1)
})
for (const [error, expected] of [
  [{ headers: new Headers({ 'retry-after': '6' }) }, 6200],
  [{ headers: { 'retry-after': '1.5' } }, 1700],
  [{ response: { headers: { 'Retry-After': '2' } } }, 2200],
  [{ details: [{ retryDelay: '1.5s' }] }, 1700],
  [{ error: { details: [{ metadata: { quotaResetDelay: '450ms' } }] } }, 650],
  [{ details: [{ quotaResetDelay: '12s' }] }, 12200],
  [{ details: [{ retryDelay: { seconds: '1', nanos: 500000000 } }] }, 1700],
  [{ message: 'Please retry in 1.5s' }, 1700],
  [{ message: 'retry after 450ms' }, 650],
  [{ message: 'retry after 3 seconds' }, 3200],
  [{ message: JSON.stringify({ error: { details: [{ retryDelay: '6s' }] } }) }, 6200],
  [{ details: [{ retryDelay: '0s' }] }, 200],
  [{ details: [{ retryDelay: '-1s' }] }, undefined],
  [{ headers: { 'retry-after': 'invalid' }, message: 'private detail' }, undefined],
]) test('parses retry hint ' + JSON.stringify(error), () => assert.equal(parseUpstreamRetryDelayMs(error), expected))
test('HTTP date and competing retry hints never retry before the server allowance', () => {
  const date = new Date(Date.now() + 3000).toUTCString()
  const result = parseUpstreamRetryDelayMs({ headers: { 'retry-after': date } })
  assert.ok(result >= 2100 && result <= 3200)
  assert.equal(parseUpstreamRetryDelayMs({ headers: { 'retry-after': '1' }, details: [{ retryDelay: '3s' }] }), 3200)
  assert.equal(computeReconnectDelayMs(1, () => 0.5, 6200), 6200)
  assert.equal(computeReconnectDelayMs(8, { jitterRatio: 0 }, 200), 10000)
  assert.equal(computeReconnectDelayMs(1, { initialDelayMs: 0 }, 200), 200)
})
test('long quota delay fails fast even with a checkpoint', async () => {
  for (const checkpoint of [false, true]) {
    const error = Object.assign(fail(429), { details: [{ retryDelay: '61s' }] })
    const out = await run(checkpoint ? [[row(text('A'), undefined, 'cp'), error]] : [error])
    assert.equal(out.error, error); assert.equal(out.requests.length, 1)
  }
  const out = await run([[{ error: { code: 429, details: [{ retryDelay: '61s' }] } }]])
  assert.equal(out.error.status, 429); assert.equal(out.requests.length, 1)
})
test('short server delay reaches hop metadata with its 200ms safety margin', async () => {
  const out = await run([Object.assign(fail(429), { headers: { 'retry-after': '0' } }), [done]])
  assert.equal(out.error, undefined)
  assert.equal(out.events[1].backoffDelayMs, 200)
})
for (const enabled of [false, true]) test('zero-commit retry, EOF and abort do not depend on long decode (enabled=' + enabled + ')', async () => {
  for (const first of [[], fail(503), fail(429)]) {
    const out = await run([first, [done]], { meta: { enabled } })
    assert.equal(out.error, undefined); assert.equal(out.requests.length, 2)
    assert.equal(out.events[1].trigger, 'retry-initial')
  }
  const empty = await run(() => [], { meta: { enabled } })
  assert.equal(empty.error.code, 'ARGON_INCOMPLETE_STREAM'); assert.equal(empty.requests.length, 4)
  const committed = await run([[row(text('live')), fail(503)], [done]], { meta: { enabled } })
  assert.equal(committed.error.status, 503); assert.equal(committed.requests.length, 1)
  const controller = new AbortController()
  const aborted = await setup(() => never(), { signal: controller.signal, meta: { enabled } })
  const next = aborted.stream.next(); await sleep(10); controller.abort()
  await assert.rejects(next, { name: 'AbortError' }); assert.equal(aborted.requests.length, 1)
})
test('disabled long decode never follows a checkpoint even on a retryable drop', async () => {
  const out = await run([[row(text('live'), undefined, 'cp'), fail(503)], [done]], { meta: { enabled: false } })
  assert.equal(out.error.status, 503); assert.equal(out.requests.length, 1)
  const continuation = await run([[row(text('live'), 'CONTINUATION', 'cp')], [done]], { meta: { enabled: false } })
  assert.equal(continuation.requests.length, 1)
})
test('missing or invalid basic observations are not inferred as known hop totals', async () => {
  const out = await run([[row(text('answer'), 'STOP', undefined, { candidatesTokenCount: 2, totalTokenCount: -1 })]])
  assert.equal(out.observed[0].promptTokens, undefined)
  assert.equal(out.observed[0].cachedTokens, undefined)
  assert.equal(out.observed[0].totalTokens, null)
  assert.equal(out.usage[0].reportedInputTokens, undefined)
  assert.equal(out.usage[0].totalTokens, null)
})
test('wire usage preserves unknown SDK fields without retaining them in diagnostic usage', async () => {
  const raw = { promptTokenCount: 10, candidatesTokenCount: 1, totalTokenCount: 11, newSdkMetadata: 'retained', promptTokensDetails: [{ modality: 'TEXT', tokenCount: 10 }] }
  const out = await run([[row(text('answer'), 'STOP', undefined, raw)]])
  assert.equal(out.chunks[0].usageMetadata.newSdkMetadata, 'retained')
  assert.deepEqual(out.chunks[0].usageMetadata.promptTokensDetails, raw.promptTokensDetails)
  assert.equal(Object.hasOwn(out.usage[0], 'promptTokensDetails'), false)
  assert.equal(Object.hasOwn(out.observed[0], 'promptTokensDetails'), false)
})

test('initial empty streams retry exactly three times and are closed diagnostically', async () => {
  const out = await run(() => [])
  assert.equal(out.requests.length, 4)
  assert.equal(out.error.code, 'ARGON_INCOMPLETE_STREAM')
  assert.deepEqual(out.events.map(event => event.trigger), ['initial', 'retry-initial', 'retry-initial', 'retry-initial'])
  assert.ok(out.events.every(event => event.finished))
})
test('empty, rejected and SDK-aborted first hops all retry before any yield', async () => {
  for (const first of [[], fail(503), Object.assign(new Error('SDK timeout'), { name: 'AbortError' })]) {
    const out = await run([first, [done]])
    assert.equal(out.error, undefined); assert.equal(out.requests.length, 2)
    assert.equal(out.events[0].finished.aborted, false)
    assert.notEqual(out.requests[0].abortSignal, out.requests[1].abortSignal)
  }
})
test('already yielded metadata or text without a token can never retry', async () => {
  for (const first of [{ usageMetadata: { promptTokenCount: 10 } }, row(text('live'))]) {
    const out = await run([[first, fail(503)], [done]])
    assert.equal(out.error.status, 503); assert.equal(out.requests.length, 1)
    assert.equal(out.chunks.length, 1)
  }
})
test('first chunk escapes before a checkpoint without pulling the next upstream row', async () => {
  let pulled = false
  const out = await setup(() => (async function* () { yield wire(row(text('live'))); pulled = true; yield wire(done) })())
  assert.equal((await (await out.stream.next()).value.json()).candidates[0].content.parts[0].text, 'live')
  assert.equal(pulled, false)
  await out.stream.return()
})
for (const blockedAt of ['request', 'next', 'json']) test('initial watchdog interrupts blocked ' + blockedAt + ' and retries with fresh controllers', async () => {
  let returned = 0
  const out = await run(n => n > 1 ? [done] : blockedAt === 'request' ? never() : ({
    [Symbol.asyncIterator]() { return this },
    next: () => blockedAt === 'next' ? never() : Promise.resolve({ done: false, value: { json: never } }),
    return() { returned++; return never() },
  }), { meta: { phaseTimeouts: { initialTtft: 20 } } })
  assert.equal(out.error, undefined); assert.equal(out.requests.length, 2)
  assert.equal(out.events[0].finished.error.code, 'STREAM_PHASE_TIMEOUT')
  assert.equal(out.events[0].finished.error.status, 504)
  assert.match(out.events[0].finished.error.message, /initial-ttft/)
  assert.equal(out.requests[0].abortSignal.aborted, true)
  assert.notEqual(out.requests[0].abortSignal, out.requests[1].abortSignal)
  assert.equal(returned, blockedAt === 'request' ? 0 : 1)
})
for (const [phase, frames] of [['thinking', [row(thought)]], ['transition', [row(thought), {}]], ['streaming', [row(text('live'))]]]) {
  test(phase + ' watchdog handles stalled next without replaying committed chunks', async () => {
    let returned = false, index = 0
    const out = await run(() => ({ [Symbol.asyncIterator]() { return this }, next() { return index < frames.length ? Promise.resolve({ value: wire(frames[index++]), done: false }) : never() }, return() { returned = true; return never() } }),
      { meta: { phaseTimeouts: { initialTtft: 500, thinking: 20, transition: 20, streaming: 20 } } })
    assert.equal(out.error.code, 'STREAM_PHASE_TIMEOUT'); assert.match(out.error.message, new RegExp(phase))
    assert.equal(out.requests.length, 1); assert.equal(returned, true)
  })
}
test('idle budget does not count consumer pauses and resets on each upstream chunk', async () => {
  const out = await setup([[row(text('one')), row(text('two')), done]], { meta: { phaseTimeouts: { streaming: 20 } } })
  await out.stream.next(); await sleep(50)
  assert.equal(out.requests[0].abortSignal.aborted, false)
  await out.stream.next(); await sleep(50)
  const end = await out.stream.next(); assert.equal((await end.value.json()).candidates[0].finishReason, 'STOP')
  assert.equal((await out.stream.next()).done, true)
})
test('user abort interrupts a blocked next immediately and removes listeners', async () => {
  const controller = new AbortController()
  let returned = false
  const out = await setup(() => ({ [Symbol.asyncIterator]() { return this }, next: never, return() { returned = true; return never() } }), { signal: controller.signal })
  const next = out.stream.next(); await sleep(10); controller.abort()
  await assert.rejects(next, { name: 'AbortError' })
  assert.equal(out.requests.length, 1); assert.equal(returned, true)
  assert.equal(out.events[0].finished.aborted, true)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})
test('consumer return aborts source and removes the user listener', async () => {
  const controller = new AbortController()
  const out = await setup([[row(text('live')), done]], { signal: controller.signal })
  await out.stream.next(); await out.stream.return()
  assert.equal(out.requests[0].abortSignal.aborted, true)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  assert.ok(out.events[0].finished)
})
test('thought-only STOP heals with signed model replay, stable initial watermark and eleven usage fields', async () => {
  const u = { promptTokenCount: 10, cachedContentTokenCount: 2, candidatesTokenCount: 0, thoughtsTokenCount: 3, toolUsePromptTokenCount: 1, totalTokenCount: 14 }
  const v = { promptTokenCount: 14, candidatesTokenCount: 2, thoughtsTokenCount: 1, toolUsePromptTokenCount: 2, totalTokenCount: 19 }
  const out = await run([[row(thought, 'STOP', undefined, u)], [row(text('answer'), 'STOP', undefined, v)]])
  assert.equal(out.error, undefined); assert.equal(out.requests.length, 2)
  const body = JSON.parse(out.requests[1].body)
  assert.deepEqual(body.contents[1], { role: 'model', parts: thought })
  assert.equal(body.contents[2].parts[0].text, 'Continue and provide the final response or tool call.')
  assert.equal(out.chunks[0].candidates[0].finishReason, undefined)
  assert.equal(out.chunks.at(-1).candidates[0].finishReason, 'STOP')
  assert.equal(out.events[1].trigger, 'thinking-dropout-heal')
  assert.deepEqual(out.usage.at(-1), { reportedInputTokens: 10, reportedCacheTokens: 2, outputTokens: 2, thoughtsTokens: 4, totalTokens: 19, billedPromptTokens: 24, billedCachedTokens: 2, billedOutputTokens: 2, billedThoughtsTokens: 4, billedToolTokens: 3, billedTotalTokens: 33 })
  assert.deepEqual(out.observed[0], { promptTokens: 10, cachedTokens: 2, outputTokens: 0, thoughtsTokens: 3, totalTokens: 14 })
})
test('thought-only STOP prefers its supplied token, including signature-only parts', async () => {
  const signature = { thought_signature: 'second-signature' }
  const out = await run([[row(thought), row([signature], 'STOP', 'heal-cp')], [done]])
  assert.equal(out.error, undefined)
  assert.equal(JSON.parse(out.requests[1].body).continuationToken, 'heal-cp')
  assert.equal(JSON.parse(out.requests[1].body).contents.length, 1)
  assert.ok(out.parts.some(part => part.thought_signature === signature.thought_signature))
})
test('thought-only STOP auto-heal is bounded once per request', async () => {
  const out = await run(() => [row(thought, 'STOP')])
  assert.equal(out.error, undefined); assert.equal(out.requests.length, 2)
  assert.equal(out.chunks.at(-1).candidates[0].finishReason, 'STOP')
})
for (const [name, frames, meta] of [
  ['visible text', [row([...thought, ...text('answer')], 'STOP')], {}],
  ['tool call', [row([...thought, { functionCall: { name: 'fn', args: {} } }], 'STOP')], {}],
  ['disabled', [row(thought, 'STOP')], { enabled: false }],
  ['safety', [{ ...row(thought, 'STOP'), promptFeedback: { blockReason: 'SAFETY' } }], {}],
  ['max tokens', [row(thought, 'MAX_TOKENS')], {}],
  ['explicit error', [row(thought, 'STOP'), { error: { code: 503 } }], {}],
]) test('does not heal ' + name, async () => {
  const out = await run([frames], { meta }); assert.equal(out.requests.length, 1)
  if (name === 'explicit error') assert.equal(out.error.code, 'ARGON_STREAM_ERROR')
})
test('post-STOP visible content cancels healing and restores a single terminal marker', async () => {
  const out = await run([[row(thought, 'STOP'), row(text('late answer'))]])
  assert.equal(out.requests.length, 1); assert.equal(out.error, undefined)
  assert.equal(out.chunks.filter(chunk => chunk.candidates?.[0]?.finishReason === 'STOP').length, 1)
})

test('a later explicit terminal frame does not receive a duplicate synthetic STOP', async () => {
  for (const finish of ['STOP', 'MAX_TOKENS']) {
    const out = await run([[row(thought, 'STOP'), row(text('late answer'), finish)]])
    assert.equal(out.requests.length, 1); assert.equal(out.error, undefined)
    assert.deepEqual(out.chunks.flatMap(chunk => chunk.candidates?.[0]?.finishReason ?? []), [finish])
  }
})

test('synthetic heal preserves signature-only parts without a continuation token', async () => {
  const signature = { thought_signature: 'standalone-signed-part' }
  const out = await run([[row(thought), row([signature], 'STOP')], [done]])
  assert.equal(out.error, undefined)
  assert.deepEqual(JSON.parse(out.requests[1].body).contents.at(-2).parts, [...thought, signature])
})

test('phase timeout after a checkpoint discards the uncommitted tail and resumes safely', async () => {
  let i = 0
  const frames = [row(text('A'), undefined, 'cp'), row(text('discard'))]
  const out = await run(n => n > 1 ? [done] : ({
    [Symbol.asyncIterator]() { return this },
    next() { return i < frames.length ? Promise.resolve({ value: wire(frames[i++]), done: false }) : never() },
    return: async () => ({ done: true }),
  }), { meta: { phaseTimeouts: { streaming: 20 } } })
  assert.equal(out.error, undefined)
  assert.equal(out.parts.map(part => part.text ?? '').join(''), 'Aanswer')
  assert.equal(JSON.parse(out.requests[1].body).continuationToken, 'cp')
  assert.equal(out.events[0].finished.error.code, 'STREAM_PHASE_TIMEOUT')
})
test('user abort while parsing JSON rejects without retry and catches late upstream rejection', async () => {
  const controller = new AbortController()
  let rejectJson
  const out = await setup(() => ({
    [Symbol.asyncIterator]() { return this },
    next: async () => ({ done: false, value: { json: () => new Promise((_, reject) => { rejectJson = reject }) } }),
    return: async () => ({ done: true }),
  }), { signal: controller.signal })
  const next = out.stream.next()
  await sleep(10); controller.abort()
  await assert.rejects(next, { name: 'AbortError' })
  rejectJson(new Error('late JSON rejection'))
  await sleep(0)
  assert.equal(out.requests.length, 1)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})
test('late request resolution after timeout closes the orphan source', async () => {
  let resolveRequest, closed = false
  const out = await run(n => n > 1 ? [done] : new Promise(resolve => { resolveRequest = resolve }), { meta: { phaseTimeouts: { initialTtft: 20 } } })
  assert.equal(out.error, undefined)
  resolveRequest({ [Symbol.asyncIterator]() { return this }, next: never, return() { closed = true; return Promise.resolve({ done: true }) } })
  await sleep(0)
  assert.equal(closed, true)
})
test('abort during checkpoint flush stops before yielding any more buffered rows', async () => {
  const controller = new AbortController()
  const out = await setup([[row(text('checkpoint'), undefined, 'cp'), row(text('buffer-1')), row(text('buffer-2'), 'STOP')]], { signal: controller.signal })
  await out.stream.next()
  const firstBuffered = await out.stream.next()
  assert.equal((await firstBuffered.value.json()).candidates[0].content.parts[0].text, 'buffer-1')
  controller.abort()
  await assert.rejects(out.stream.next(), { name: 'AbortError' })
  assert.equal(out.requests.length, 1)
})
test('consumer return within a checkpoint flush accounts only the rows actually yielded', async () => {
  const usage = count => ({ promptTokenCount: 10, candidatesTokenCount: count, totalTokenCount: 10 + count })
  const out = await setup([[row(text('A'), undefined, 'cp', usage(1)), row(text('B'), undefined, undefined, usage(2)), row(text('C'), 'STOP', undefined, usage(3))]])
  await out.stream.next(); await out.stream.next(); await out.stream.return()
  assert.equal(out.usage.at(-1).outputTokens, 2)
  assert.equal(out.usage.at(-1).billedOutputTokens, 3)
})

// An empty heartbeat frame carries no text, thought, checkpoint or finish
// reason; it must never renew the idle budget of the phase it is stuck in.
async function emptyHeartbeatRun(prefix = []) {
  let index = 0
  const controller = new AbortController()
  const out = await setup(() => ({
    [Symbol.asyncIterator]() { return this },
    next() {
      if (index < prefix.length) return Promise.resolve({ value: wire(prefix[index++]), done: false })
      index++
      return sleep(2).then(() => ({ value: wire({}), done: false }))
    },
    return() { return Promise.resolve({ done: true }) },
  }), { signal: controller.signal, meta: { phaseTimeouts: { initialTtft: 40, thinking: 40, transition: 40, streaming: 40 } } })
  out.hearted = 0
  const consume = (async () => {
    try { for await (const chunk of out.stream) { out.hearted++; void chunk } } catch (error) { out.error = error }
  })()
  try {
    await Promise.race([consume, sleep(3000).then(() => { throw new Error('empty heartbeat frames kept the watchdog alive') })])
  } finally {
    // Never leave a regressed watchdog looping in the runner.
    controller.abort()
    await consume.catch(() => {})
  }
  return out
}
for (const [label, prefix] of [['initial-ttft', []], ['thinking then transition', [row(thought)]]]) {
  test(label + ' empty heartbeat frames cannot extend the phase timeout', async () => {
    const out = await emptyHeartbeatRun(prefix)
    assert.equal(out.error?.code, 'STREAM_PHASE_TIMEOUT')
    assert.equal(out.requests.length, 1)
    assert.ok(out.hearted > 1, 'the stream kept receiving heartbeat frames before the timeout')
  })
}
test('empty heartbeat frames time out in the transition phase they entered', async () => {
  const out = await emptyHeartbeatRun()
  assert.equal(out.error?.code, 'STREAM_PHASE_TIMEOUT')
  assert.match(out.error.message, /transition/)
})


// Long-decode checkpoints renew the idle budget only when the token is new; a
// repeated token is a stall, not progress.
async function stalledFrameRun(frameFor, phaseTimeouts) {
 let index = 0
 const controller = new AbortController()
 const out = await setup(() => ({
  [Symbol.asyncIterator]() { return this },
  next() { return sleep(2).then(() => ({ value: wire(frameFor(index++)), done: false })) },
  return() { return Promise.resolve({ done: true }) },
 }), { signal: controller.signal, meta: { phaseTimeouts } })
 out.frames = 0
 const consume = (async () => { try { for await (const chunk of out.stream) { out.frames++; void chunk } } catch (error) { out.error = error } })()
 try {
  await Promise.race([consume, sleep(3000).then(() => { throw new Error('stalled frames kept the watchdog alive') })])
 } finally {
  // Never leave a regressed watchdog looping in the runner.
  controller.abort()
  await consume.catch(() => {})
 }
 return out
}
test('a repeated continuation token cannot renew the watchdog', async () => {
 const out = await stalledFrameRun(() => ({ candidates: [{ content: { role: 'model', parts: [] }, continuationToken: 'cp' }] }), { initialTtft: 60, thinking: 60, transition: 60, streaming: 60 })
 assert.equal(out.error?.code, 'STREAM_PHASE_TIMEOUT')
 assert.match(out.error.message, /transition/)
 // A repeated token never renews the idle budget, so every hop stalls the same
 // way and the existing bounded same-token retry budget ends the stream.
 assert.ok(out.requests.length > 1 && out.requests.length <= 5, String(out.requests.length))
 assert.ok(out.events.every(event => event.finished))
})
test('an empty thought frame cannot renew the watchdog', async () => {
 const out = await stalledFrameRun(() => ({ candidates: [{ content: { role: 'model', parts: [{ thought: true, text: '' }] } }] }), { initialTtft: 60, thinking: 40, transition: 40, streaming: 40 })
 assert.equal(out.error?.code, 'STREAM_PHASE_TIMEOUT')
 assert.match(out.error.message, /thinking/)
 assert.equal(out.requests.length, 1)
 assert.ok(out.frames > 1, 'the stream kept receiving empty thought frames before the timeout')
})
// Pseudo progress must never renew the idle budget: alternating empty frames
// cannot ping-pong between phases, and a re-used signature or an empty
// {} functionCall is not output.
test('alternating empty and empty-thought frames cannot renew the watchdog', async () => {
 const out = await stalledFrameRun(index => index % 2
  ? { candidates: [{ content: { role: 'model', parts: [{ thought: true, text: '' }] } }] }
  : {}, { initialTtft: 60, thinking: 40, transition: 40, streaming: 40 })
 assert.equal(out.error?.code, 'STREAM_PHASE_TIMEOUT')
 assert.equal(out.requests.length, 1)
 assert.ok(out.frames > 2, 'the stream kept receiving alternating empty frames before the timeout')
})
// Every signature already delivered in this hop is remembered, so neither an
// A/B/A/B alternation nor a frame carrying the same two signatures can pass for
// fresh output. Only a genuinely unseen signature renews the idle budget.
const repeatedSignatureFrames = [
 ['a single repeated signature', () => ({ candidates: [{ content: { role: 'model', parts: [{ thought: true, text: '', thoughtSignature: 'same-signature' }] } }] })],
 ['two alternating signatures', index => ({ candidates: [{ content: { role: 'model', parts: [{ thought: true, text: '', thoughtSignature: index % 2 ? 'sig-a' : 'sig-b' }] } }] })],
 ['a two-signature frame', () => ({ candidates: [{ content: { role: 'model', parts: [{ thought: true, text: '', thoughtSignature: 'sig-a' }, { thought: true, text: '', thoughtSignature: 'sig-b' }] } }] })],
]
for (const [label, frameFor] of repeatedSignatureFrames) {
 test('a repeated thought signature cannot renew the watchdog: ' + label, async () => {
  const out = await stalledFrameRun(frameFor, { initialTtft: 60, thinking: 40, transition: 40, streaming: 40 })
  assert.equal(out.error?.code, 'STREAM_PHASE_TIMEOUT')
  assert.match(out.error.message, /thinking/)
  assert.equal(out.requests.length, 1)
  assert.ok(out.frames > 1, 'the stream kept receiving known signatures before the timeout')
 })
}
test('an empty functionCall frame cannot renew the watchdog', async () => {
 const out = await stalledFrameRun(() => ({ candidates: [{ content: { role: 'model', parts: [{ functionCall: {} }] } }] }), { initialTtft: 60, thinking: 40, transition: 40, streaming: 40 })
 assert.equal(out.error?.code, 'STREAM_PHASE_TIMEOUT')
 assert.match(out.error.message, /transition/)
 assert.equal(out.requests.length, 1)
 assert.ok(out.frames > 1, 'the stream kept receiving empty functionCall frames before the timeout')
})
test('a newly signed thought frame renews the watchdog', async () => {
 let index = 0, ended = false
 const out = await run(() => ({
  [Symbol.asyncIterator]() { return this },
  next() {
   const n = index++
   if (n < 30) return sleep(2).then(() => ({ value: wire({ candidates: [{ content: { role: 'model', parts: [{ thought: true, text: '', thoughtSignature: 'sig-' + n }] } }] }), done: false }))
   if (ended) return Promise.resolve({ done: true })
   ended = true
   return Promise.resolve({ value: wire(done), done: false })
  },
  return() { return Promise.resolve({ done: true }) },
 }), { meta: { phaseTimeouts: { initialTtft: 500, thinking: 40, transition: 40, streaming: 40 } } })
 assert.equal(out.error, undefined)
 assert.equal(out.requests.length, 1)
 assert.ok(out.parts.length >= 30, 'every signed frame is delivered')
})

test('round8 healing budget deduction (R7-P2-5): deducts Hop 1 spent tokens and refuses heal when exhausted', async () => {
  const u30 = { promptTokenCount: 10, candidatesTokenCount: 0, thoughtsTokenCount: 30, totalTokenCount: 40 }
  const uDone = { promptTokenCount: 50, candidatesTokenCount: 12, thoughtsTokenCount: 5, totalTokenCount: 67 }
  const partial = await run([[row(thought, 'STOP', undefined, u30)], [row(text('healed'), 'STOP', undefined, uDone)]], {
    body: { contents: [{ role: 'user', parts: text('question') }], generationConfig: { maxOutputTokens: 100 } },
  })
  assert.equal(partial.error, undefined)
  assert.equal(partial.requests.length, 2)
  assert.equal(JSON.parse(partial.requests[1].body).generationConfig.maxOutputTokens, 70)

  const uExhausted = { promptTokenCount: 10, candidatesTokenCount: 0, thoughtsTokenCount: 100, totalTokenCount: 110 }
  const exhausted = await run([[row(thought, 'STOP', undefined, uExhausted)], [row(text('never-called'), 'STOP')]], {
    body: { contents: [{ role: 'user', parts: text('question') }], generationConfig: { maxOutputTokens: 100 } },
  })
  assert.equal(exhausted.error, undefined)
  assert.equal(exhausted.requests.length, 1)
  assert.equal(exhausted.chunks.at(-1).candidates[0].finishReason, 'STOP')

  // ExtraBody precedence on synthetic heal and byte preservation on checkpointed hopToken heal.
  const extraCaller = { generationConfig: { maxOutputTokens: 100 } }
  const extraRequests = [], extraStream = await continueArgonRequestStream(
    { isVertexAI: () => false },
    async req => {
      extraRequests.push(req)
      const list = extraRequests.length === 1 ? [row(thought, 'STOP', undefined, u30)] : [row(text('ok'), 'STOP', undefined, uDone)]
      return (async function* () { for (const f of list) yield wire(f) })()
    },
    { body: JSON.stringify({ contents: [{ role: 'user', parts: text('q') }], generationConfig: { maxOutputTokens: 200 } }), httpOptions: { extraBody: extraCaller } },
    { enabled: true, reconnectBackoff: { initialDelayMs: 0 } },
  )
  for await (const _ of extraStream) {}
  assert.equal(extraRequests.length, 2)
  assert.equal(extraRequests[1].httpOptions.extraBody.generationConfig.maxOutputTokens, 70)
  assert.equal(extraCaller.generationConfig.maxOutputTokens, 100)

  const cpHeal = await run([[row(thought, 'STOP', 'cp-keep', u30)], [row(text('cp-ok'), 'STOP', undefined, uDone)]], {
    body: { contents: [{ role: 'user', parts: text('question') }], generationConfig: { maxOutputTokens: 100 } },
  })
  assert.equal(cpHeal.requests.length, 2)
  assert.equal(JSON.parse(cpHeal.requests[1].body).generationConfig.maxOutputTokens, 100)
  assert.equal(JSON.parse(cpHeal.requests[1].body).continuationToken, 'cp-keep')
})

test('round9 healing guards (R8-P1-5 & R8-P2-2): forbids synthetic replay after prior committed output and refuses !hopToken heal without accountable usage', async () => {
  // R8-P1-5: Hop 1 commits visible prefix 'A' with checkpoint 'cp-1'; Hop 2 returns thought-only STOP without hopToken.
  const u1 = { promptTokenCount: 10, candidatesTokenCount: 1, thoughtsTokenCount: 2, totalTokenCount: 13 }
  const u2 = { promptTokenCount: 13, candidatesTokenCount: 0, thoughtsTokenCount: 4, totalTokenCount: 17 }
  const priorCommitted = await run([
    [row(text('A'), 'CONTINUATION', 'cp-1', u1)],
    [row(thought, 'STOP', undefined, u2)],
    [row(text('should-not-run'), 'STOP')],
  ])
  assert.equal(priorCommitted.error, undefined)
  assert.equal(priorCommitted.requests.length, 2)
  assert.equal(priorCommitted.parts.map(p => p.text).join(''), 'Aprivate thought')
  assert.equal(priorCommitted.chunks.at(-1).candidates[0].finishReason, 'STOP')

  // R8-P2-2: explicit maxOutputTokens with missing or invalid Hop 1 usage refuses synthetic !hopToken heal.
  for (const badUsage of [
    undefined,
    { promptTokenCount: 10, candidatesTokenCount: 0, thoughtsTokenCount: -1, totalTokenCount: 40 },
    { promptTokenCount: 10 },
  ]) {
    const out = await run([
      [row(thought, 'STOP', undefined, badUsage)],
      [row(text('should-not-run'), 'STOP')],
    ], {
      body: { contents: [{ role: 'user', parts: text('question') }], generationConfig: { maxOutputTokens: 100 } },
    })
    assert.equal(out.error, undefined)
    assert.equal(out.requests.length, 1)
    assert.equal(out.chunks.at(-1).candidates[0].finishReason, 'STOP')
  }
})

test('round10 healing fixes (R9-P2-2 & R9-P2-6): rejects contradictory negative usage diff and never heals after STOP was delivered', async () => {
  // R9-P2-2: promptTokenCount=20, totalTokenCount=19 gives raw diff -1 (< 0) without explicit thoughtsTokenCount -> unaccountable, must refuse !hopToken heal.
  const contradictoryUsage = { promptTokenCount: 20, candidatesTokenCount: 0, totalTokenCount: 19 }
  const negDiff = await run([
    [row(thought, 'STOP', undefined, contradictoryUsage)],
    [row(text('never-called'), 'STOP')],
  ], {
    body: { contents: [{ role: 'user', parts: text('question') }], generationConfig: { maxOutputTokens: 100 } },
  })
  assert.equal(negDiff.error, undefined)
  assert.equal(negDiff.requests.length, 1)
  assert.equal(negDiff.chunks.at(-1).candidates[0].finishReason, 'STOP')

  // Even when candidatesTokenCount & thoughtsTokenCount exist, total < prompt + toolUse is inconsistent -> unaccountable.
  const contradictoryWithExplicit = { promptTokenCount: 20, candidatesTokenCount: 0, thoughtsTokenCount: 5, totalTokenCount: 19 }
  const negExplicit = await run([
    [row(thought, 'STOP', undefined, contradictoryWithExplicit)],
    [row(text('never-called'), 'STOP')],
  ], {
    body: { contents: [{ role: 'user', parts: text('question') }], generationConfig: { maxOutputTokens: 100 } },
  })
  assert.equal(negExplicit.error, undefined)
  assert.equal(negExplicit.requests.length, 1)

  // R9-P2-6: thought-only STOP arrives before valid usageMetadata -> STOP is delivered once, and EOF must NOT trigger hop 2.
  const delayedUsage = await run([
    [
      row(thought, 'STOP'),
      { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0, thoughtsTokenCount: 5, totalTokenCount: 15 } },
    ],
    [row(text('must-not-heal-after-stop'), 'STOP')],
  ], {
    body: { contents: [{ role: 'user', parts: text('question') }], generationConfig: { maxOutputTokens: 100 } },
  })
  assert.equal(delayedUsage.error, undefined)
  assert.equal(delayedUsage.requests.length, 1)
  const stopFrames = delayedUsage.chunks.filter(c => c.candidates?.[0]?.finishReason === 'STOP')
  assert.equal(stopFrames.length, 1)
})

test('round11 fixes (R10-P2-2 & R10-P2-7): unbudgeted contradictory usage refuses heal and missing output breakdown never shrinks totalTokenCount', async () => {
  // R10-P2-2: even when maxOutputTokens is omitted on continueArgonRequestStream, contradictory reported usage must refuse !hopToken heal.
  const reqs = []
  const stream = await continueArgonRequestStream(
    { isVertexAI: () => true },
    async req => {
      reqs.push(req)
      const list = reqs.length === 1
        ? [row(thought, 'STOP', undefined, { promptTokenCount: 20, candidatesTokenCount: 0, totalTokenCount: 19 })]
        : [row(text('must-not-run'), 'STOP')]
      return (async function* () { for (const f of list) yield wire(f) })()
    },
    { body: JSON.stringify({ contents: [{ role: 'user', parts: text('q') }] }) },
    { enabled: true, reconnectBackoff: { initialDelayMs: 0 } },
  )
  const chunks = []
  for await (const c of stream) chunks.push(await c.json())
  assert.equal(reqs.length, 1)
  assert.equal(chunks.at(-1).candidates[0].finishReason, 'STOP')

  // R10-P2-7: { promptTokenCount: 20, totalTokenCount: 30 } without output sub-counters keeps totalTokenCount === 30.
  const out = await run([[row(text('ok'), 'STOP', undefined, { promptTokenCount: 20, totalTokenCount: 30 })]])
  assert.equal(out.error, undefined)
  assert.equal(out.chunks.at(-1).usageMetadata.totalTokenCount, 30)
  assert.equal(out.chunks.at(-1).usageMetadata.billedTotalTokenCount, 30)
  assert.equal(out.usage.at(-1).totalTokens, 30)
  assert.equal(out.usage.at(-1).billedTotalTokens, 30)
})

