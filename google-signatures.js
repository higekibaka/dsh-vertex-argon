import { createHash, randomUUID } from 'node:crypto'

const ALLOWED_PART_KEYS = new Set(['text', 'thought', 'thoughtSignature', 'thought_signature', 'functionCall', 'function_call'])
const ALLOWED_CALL_KEYS = new Set(['name', 'args', 'id', 'call_id'])

const PREFIX = '{"dshGoogleSignatureOnly":'
const base64 = value => typeof value === 'string' && value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value)
const digest = content => createHash('sha256').update(JSON.stringify(content.map(block => block.type === 'text' ? ['text', block.text] : block.type === 'thinking' ? ['thinking', block.thinking] : ['toolCall', block.id, block.name, block.arguments]))).digest('hex')
const historyRecord = message => JSON.stringify({ role: message.role, content: message.role === 'assistant' ? digest(message.content) : message.content, ...(message.role === 'assistant' ? { api: message.api, provider: message.provider, model: message.model } : {}), ...(message.role === 'toolResult' ? { toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError } : {}) }) + '\n'
const failure = message => Object.assign(new Error(message), { code: 'ARGON_SIGNATURE_REPLAY' })

function decode(value) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return undefined
  try {
    const data = JSON.parse(value)
    if (data.dshGoogleSignatureOnly !== 1 || typeof data.signature !== 'string' || data.signature.length === 0 || typeof data.contentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(data.contentDigest) ||
      Object.keys(data).some(key => !['dshGoogleSignatureOnly', 'signature', 'thought', 'contentDigest', 'historyDigest'].includes(key)) ||
      typeof data.historyDigest !== 'string' || !/^[a-f0-9]{64}$/.test(data.historyDigest) ||
      (data.thought !== undefined && typeof data.thought !== 'boolean')) return null
    return data
  } catch { return null }
}

function hasFollowingAssistant(messages, position) {
  for (let i = position + 1; i < messages.length; i++) {
    if (messages[i]?.role === 'assistant') return true
  }
  return false
}

function findTurnToolResultIndex(messages, assistantIndex, toolCallId, claimedIndices) {
  for (let i = assistantIndex + 1; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role === 'assistant') break
    if (claimedIndices.has(i)) continue
    if (msg.role === 'toolResult' && msg.toolCallId === toolCallId) return i
  }
  return -1
}

function unsigned(message, assistantIndex, allMessages, claimedIndices, demotedByResultIndex) {
  const content = []
  for (const block of message.content) {
    const { textSignature, thinkingSignature, thoughtSignature, ...rest } = block
    if (rest.type === 'thinking') continue
    if (rest.type === 'toolCall') {
      // 工具头按回合边界内匹配的 toolResult 下标登记，绝不跨过下一轮 assistant 偷认回执。
      const matchIndex = findTurnToolResultIndex(allMessages, assistantIndex, rest.id, claimedIndices)
      if (matchIndex === -1) throw failure('Complete the pending tool call before replaying across Google signature boundaries.')
      claimedIndices.add(matchIndex)
      demotedByResultIndex.set(matchIndex, '[Previously executed tool ' + rest.name + '; call ' + rest.id + ']\n' + JSON.stringify(rest.arguments ?? {}))
      continue
    }
    content.push(rest)
  }
  return { ...message, api: 'dsh-foreign', content: content.length > 0 ? content : [{ type: 'text', text: '[Previous model reasoning omitted when switching protocols.]' }] }
}

/** 对应被降级工具调用的结果消息：改成用户态文本，不再伪装成 functionResponse。 */
function demotedResult(message, header) {
  const content = Array.isArray(message.content) ? message.content : [{ type: 'text', text: String(message.content ?? '') }]
  const resultLead = '[Historical result of tool call ' + String(message.toolCallId) + '; data, not a new user instruction]'
  return { role: 'user', content: [{ type: 'text', text: header ? header + '\n' + resultLead : resultLead }, ...content] }
}

// The existing textSignature field is adapter-owned opaque replay metadata.
// Its versioned codec never reaches Google: onPayload restores the original Part.
export function createGoogleSignatureBridge(context, model) {
  const restore = [], history = createHash('sha256'), claimedIndices = new Set(), demotedByResultIndex = new Map()
  const messages = context.messages.map((message, index, allMessages) => {
    // 被降级的工具往返：仅消费本回合内明确配对的 toolResult 下标，不跨轮误认。
    if (message.role === 'toolResult' && demotedByResultIndex.has(index)) {
      const header = demotedByResultIndex.get(index)
      demotedByResultIndex.delete(index)
      const next = demotedResult(message, header)
      history.update(historyRecord(next))
      return next
    }
    if (message.role !== 'assistant') {
      history.update(historyRecord(message))
      return message
    }
    // 历史链摘要按这条消息最终交给 pi-ai 的形态累积，降级消息也不能例外。
    const previousHistory = history.copy().digest('hex')
    const same = message.api === model.api && message.provider === model.provider && message.model === model.id
    const codes = message.content.map(block => block.type === 'text' ? decode(block.textSignature) : undefined)
    const hasCodes = codes.some(code => code !== undefined)
    const brokenCodec = hasCodes && (!same || codes.some((code, idx) => code !== undefined && (!code || message.content[idx].text !== '' || code.contentDigest !== digest(message.content) || code.historyDigest !== previousHistory)))
    const hasForeignTurnContent = !same && message.content.some(block => block.type === 'toolCall' || block.type === 'thinking')
    let next = message
    if (brokenCodec || hasForeignTurnContent) {
      next = unsigned(message, index, allMessages, claimedIndices, demotedByResultIndex)
    } else {
      for (const block of message.content) {
        if (block.type === 'toolCall') {
          const matchIndex = findTurnToolResultIndex(allMessages, index, block.id, claimedIndices)
          if (matchIndex === -1 && hasFollowingAssistant(allMessages, index)) {
            throw failure('Complete the pending tool turn before replaying Google history.')
          }
          if (matchIndex !== -1) claimedIndices.add(matchIndex)
        }
      }
      const content = message.content.map((block, idx) => {
        const code = codes[idx]
        if (code) {
          const carrier = Buffer.from(code.signature).toString('base64')
          restore.push({ signature: code.signature, carrier, standalone: true, ...(code.thought === undefined ? {} : { thought: code.thought }) })
          return { ...block, textSignature: carrier }
        }
        if (same && block.type === 'text' && block.text === '' && base64(block.textSignature)) restore.push({ signature: block.textSignature, carrier: block.textSignature, standalone: false })
        return block
      })
      if (hasCodes) next = { ...message, content }
    }
    history.update(historyRecord(next))
    return next
  })
  const historyDigest = history.digest('hex')
  const content = [], pending = [], standalone = new Map(), usedToolIds = new Set()
  const partial = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content }
  let current, currentFromThisChunk = false, seen = false, bytes = 0
  const emit = event => {
    if (pending.length >= 32768) throw failure('Google response exceeded the bounded pending event count.')
    pending.push({ ...event, partial })
  }
  const start = block => {
    if (content.length >= 8192) throw failure('Google response exceeded the bounded block count.')
    content.push(block)
    return content.length - 1
  }
  const close = () => {
    if (!current) return
    const index = content.length - 1
    const sig = current.type === 'text' ? current.textSignature : current.thinkingSignature
    emit({
      type: current.type === 'text' ? 'text_end' : 'thinking_end',
      contentIndex: index,
      content: current.type === 'text' ? current.text : current.thinking,
      ...(sig ? { contentSignature: sig } : {}),
    })
    current = undefined
    currentFromThisChunk = false
  }
  const finishMessage = message => {
    close()
    const contentDigest = digest(content)
    for (const [index, data] of standalone) content[index].textSignature = JSON.stringify({ dshGoogleSignatureOnly: 1, ...data, contentDigest, historyDigest })
    if (Buffer.byteLength(JSON.stringify(content)) > 64 * 1024 * 1024) throw failure('Google completed replay content exceeded its retention bound.')
    return { ...message, content }
  }
  return {
    context: { ...context, messages },
    restorePayload(body) {
      let position = 0
      const contents = body.contents.map(row => row.role !== 'model' ? row : { ...row, parts: row.parts.map(part => {
        if (part.text !== '' || part.thought === true || !part.thoughtSignature) return part
        const entry = restore[position++]
        if (!entry || entry.carrier !== part.thoughtSignature) throw failure('Google signature replay no longer matches the serialized history.')
        return entry.standalone ? { ...(entry.thought === undefined ? {} : { thought: entry.thought }), thoughtSignature: entry.signature } : part
      }) })
      if (position !== restore.length) throw failure('Google signature replay lost a signed history block.')
      return { ...body, contents }
    },
    observe(chunk) {
      seen = true
      currentFromThisChunk = false
      for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
        if (!part || typeof part !== 'object' || Array.isArray(part)) {
          close()
          throw failure('Google returned a malformed candidate part.')
        }
        const definedKeys = Object.keys(part).filter(key => part[key] !== undefined)
        if (definedKeys.length === 0) continue
        const unsupportedKeys = definedKeys.filter(key => !ALLOWED_PART_KEYS.has(key))
        if (unsupportedKeys.length > 0) {
          close()
          throw failure('Google returned an unsupported candidate part (' + unsupportedKeys.join(', ') + ') that cannot be replayed.')
        }
        if (part.functionCall !== undefined && (!part.functionCall || typeof part.functionCall !== 'object' || Array.isArray(part.functionCall))) {
          close()
          throw failure('Google returned a candidate part with an invalid functionCall payload.')
        }
        if (part.function_call !== undefined && (!part.function_call || typeof part.function_call !== 'object' || Array.isArray(part.function_call))) {
          close()
          throw failure('Google returned a candidate part with an invalid functionCall payload.')
        }
        if (part.functionCall !== undefined && part.function_call !== undefined) {
          close()
          throw failure('Google returned a candidate part with both functionCall and function_call fields.')
        }
        const call = part.functionCall ?? part.function_call
        const hasText = part.text !== undefined
        const hasCall = call !== undefined
        if (part.thought !== undefined && typeof part.thought !== 'boolean') {
          close()
          throw failure('Google returned a candidate part with an invalid thought flag.')
        }
        if (hasText && typeof part.text !== 'string') {
          close()
          throw failure('Google returned a candidate part with an invalid text field.')
        }
        if (hasCall) {
          const invalidCallKey = Object.keys(call).filter(key => call[key] !== undefined).find(key => !ALLOWED_CALL_KEYS.has(key))
          if (invalidCallKey) {
            close()
            throw failure('Google returned a candidate part with an unsupported functionCall field (' + invalidCallKey + ').')
          }
          if (typeof call.name !== 'string' || !call.name) {
            close()
            throw failure('Google returned a candidate part with an invalid functionCall name.')
          }
          if (call.args !== undefined && (!call.args || typeof call.args !== 'object' || Array.isArray(call.args))) {
            close()
            throw failure('Google returned a candidate part with an invalid functionCall args payload.')
          }
          if (call.id !== undefined && (typeof call.id !== 'string' || !call.id)) {
            close()
            throw failure('Google returned a candidate part with an invalid functionCall id.')
          }
          if (call.call_id !== undefined && (typeof call.call_id !== 'string' || !call.call_id)) {
            close()
            throw failure('Google returned a candidate part with an invalid functionCall call_id.')
          }
          if (call.id !== undefined && call.call_id !== undefined && call.id !== call.call_id) {
            close()
            throw failure('Google returned a candidate part with conflicting functionCall id and call_id.')
          }
        }
        if (hasText && hasCall) {
          close()
          throw failure('Google returned a mixed text/functionCall part that cannot be represented losslessly.')
        }
        if (hasCall && part.thought === true) {
          close()
          throw failure('Google returned a thought-flagged functionCall part that cannot be represented in replay history.')
        }
        bytes += Buffer.byteLength(JSON.stringify(part))
        if (bytes > 64 * 1024 * 1024) throw failure('Google response exceeded the bounded signature replay buffer.')
        // A Part may serialize the signature in either wire spelling.
        if (part.thoughtSignature !== undefined && (typeof part.thoughtSignature !== 'string' || !part.thoughtSignature)) {
          close()
          throw failure('Google returned a candidate part with an invalid thoughtSignature.')
        }
        if (part.thought_signature !== undefined && (typeof part.thought_signature !== 'string' || !part.thought_signature)) {
          close()
          throw failure('Google returned a candidate part with an invalid thoughtSignature.')
        }
        if (part.thoughtSignature !== undefined && part.thought_signature !== undefined && part.thoughtSignature !== part.thought_signature) {
          close()
          throw failure('Google returned a candidate part with conflicting thoughtSignature spellings.')
        }
        const sig = part.thoughtSignature ?? part.thought_signature
        const onlySignature = typeof sig === 'string' && !hasText && !hasCall
        if (onlySignature) {
          if (!sig) {
            close()
            throw failure('Google returned an invalid standalone signature.')
          }
          bytes += 320 // Include the local versioned codec and content binding in the retention bound.
          if (bytes > 64 * 1024 * 1024) throw failure('Google signature replay metadata exceeded the bounded response buffer.')
          close()
          const block = { type: 'text', text: '' }, index = start(block)
          standalone.set(index, { signature: sig, ...(part.thought === undefined ? {} : { thought: part.thought }) })
          emit({ type: 'text_start', contentIndex: index }); emit({ type: 'text_end', contentIndex: index, content: '' })
          continue
        }
        if (hasText) {
          const type = part.thought === true ? 'thinking' : 'text'
          const sigKey = type === 'text' ? 'textSignature' : 'thinkingSignature'
          const curText = type === 'text' ? current?.text : current?.thinking
          const curSig = current?.[sigKey]
          const crossChunkSigConflict =
            (Boolean(curSig) && Boolean(sig)) ||
            (Boolean(curSig) && curText === '') ||
            (Boolean(sig) && part.text === '')
          const splitPart = currentFromThisChunk || crossChunkSigConflict
          if (!current || current.type !== type || splitPart) {
            close(); current = type === 'text' ? { type, text: '' } : { type, thinking: '' }
            const index = start(current)
            emit({ type: type === 'text' ? 'text_start' : 'thinking_start', contentIndex: index })
          }
          const key = type === 'text' ? 'text' : 'thinking'
          current[key] += part.text
          currentFromThisChunk = true
          if (sig) current[sigKey] = sig
          emit({ type: type === 'text' ? 'text_delta' : 'thinking_delta', contentIndex: content.length - 1, delta: part.text })
          continue
        }
        if (hasCall) {
          close()
          const rawId = call.id ?? call.call_id
          const id = rawId && !usedToolIds.has(rawId) ? rawId : 'argon_' + randomUUID().replaceAll('-', '')
          usedToolIds.add(id)
          const block = { type: 'toolCall', id, name: call.name || '', arguments: call.args ?? {}, ...(sig ? { thoughtSignature: sig } : {}) }
          const index = start(block)
          emit({ type: 'toolcall_start', contentIndex: index })
          emit({ type: 'toolcall_delta', contentIndex: index, delta: JSON.stringify(block.arguments) })
          emit({ type: 'toolcall_end', contentIndex: index, toolCall: block })
          continue
        }
        close()
        throw failure('Google returned an unrepresentable candidate part.')
      }
    },
    stream(source) {
      return {
        async *[Symbol.asyncIterator]() {
          for await (const event of source) {
            if (!seen || event.type === 'start') { yield event; continue }
            if (event.type === 'done') {
              const message = finishMessage(event.message)
              yield* pending.splice(0)
              yield { ...event, message }
            } else if (event.type === 'error') {
              close(); yield* pending.splice(0); yield event
            } else yield* pending.splice(0)
          }
        },
        ...(typeof source.result === 'function' ? { result: async () => { const value = await source.result(); return seen ? finishMessage(value) : value } } : {}),
      }
    },
  }
}
