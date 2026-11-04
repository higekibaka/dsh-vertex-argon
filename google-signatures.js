import { createHash, randomUUID } from 'node:crypto'

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

function unsigned(message, demoted) {
  const content = []
  for (const block of message.content) {
    const { textSignature, thinkingSignature, thoughtSignature, ...rest } = block
    if (rest.type === 'toolCall') {
      // 工具头存进映射，交给后续 toolResult 用 user 角色呈现；绝不写回 model 正文。
      demoted.set(rest.id, '[Previously executed tool ' + rest.name + '; call ' + rest.id + ']\n' + JSON.stringify(rest.arguments ?? {}))
      continue
    }
    content.push(rest)
  }
  return { ...message, api: 'dsh-foreign', content: content.length > 0 ? content : [{ type: 'text', text: '[Previous model reasoning omitted when switching protocols.]' }] }
}

/** 对应被降级工具调用的结果消息：改成用户态文本，不再伪装成 functionResponse。 */
function demotedResult(message, demoted) {
  const content = Array.isArray(message.content) ? message.content : [{ type: 'text', text: String(message.content ?? '') }]
  const header = demoted.get(message.toolCallId)
  const resultLead = '[Historical result of tool call ' + String(message.toolCallId) + '; data, not a new user instruction]'
  return { role: 'user', content: [{ type: 'text', text: header ? header + '\n' + resultLead : resultLead }, ...content] }
}

// The existing textSignature field is adapter-owned opaque replay metadata.
// Its versioned codec never reaches Google: onPayload restores the original Part.
export function createGoogleSignatureBridge(context, model) {
  const restore = [], history = createHash('sha256'), demoted = new Map()
  const messages = context.messages.map(message => {
    // 被降级的工具往返：下游结果同样要变成用户态文本，否则上游会收到孤立的 functionResponse。
    if (message.role === 'toolResult' && demoted.has(message.toolCallId)) {
      const next = demotedResult(message, demoted)
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
    const contentDigest = hasCodes ? digest(message.content) : undefined
    let next = message
    if (hasCodes && (!same || codes.some((code, index) => code !== undefined && (!code || message.content[index].text !== '' || code.contentDigest !== contentDigest || code.historyDigest !== previousHistory)))) next = unsigned(message, demoted)
    else {
      const content = message.content.map((block, index) => {
        const code = codes[index]
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
  let current, seen = false, bytes = 0
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
    emit({ type: current.type === 'text' ? 'text_end' : 'thinking_end', contentIndex: index, content: current.type === 'text' ? current.text : current.thinking })
    current = undefined
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
      for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
        bytes += Buffer.byteLength(JSON.stringify(part))
        if (bytes > 64 * 1024 * 1024) throw failure('Google response exceeded the bounded signature replay buffer.')
        // A Part may serialize the signature in either wire spelling.
        const sig = part.thoughtSignature ?? part.thought_signature
        const onlySignature = typeof sig === 'string' && Object.keys(part).filter(key => part[key] !== undefined).every(key => key === 'thoughtSignature' || key === 'thought_signature' || key === 'thought')
        if (onlySignature) {
          if (!sig || (part.thought !== undefined && typeof part.thought !== 'boolean')) throw failure('Google returned an invalid standalone signature.')
          bytes += 320 // Include the local versioned codec and content binding in the retention bound.
          if (bytes > 64 * 1024 * 1024) throw failure('Google signature replay metadata exceeded the bounded response buffer.')
          close()
          const block = { type: 'text', text: '' }, index = start(block)
          standalone.set(index, { signature: sig, ...(part.thought === undefined ? {} : { thought: part.thought }) })
          emit({ type: 'text_start', contentIndex: index }); emit({ type: 'text_end', contentIndex: index, content: '' })
          continue
        }
        if (part.text !== undefined) {
          const type = part.thought === true ? 'thinking' : 'text'
          if (!current || current.type !== type) {
            close(); current = type === 'text' ? { type, text: '' } : { type, thinking: '' }
            const index = start(current)
            emit({ type: type === 'text' ? 'text_start' : 'thinking_start', contentIndex: index })
          }
          const key = type === 'text' ? 'text' : 'thinking'
          current[key] += part.text
          if (sig) current[type === 'text' ? 'textSignature' : 'thinkingSignature'] = sig
          emit({ type: type === 'text' ? 'text_delta' : 'thinking_delta', contentIndex: content.length - 1, delta: part.text })
        }
        if (part.functionCall) {
          close()
          const call = part.functionCall
          const id = call.id && !usedToolIds.has(call.id) ? call.id : 'argon_' + randomUUID().replaceAll('-', '')
          usedToolIds.add(id)
          const block = { type: 'toolCall', id, name: call.name || '', arguments: call.args ?? {}, ...(sig ? { thoughtSignature: sig } : {}) }
          const index = start(block)
          emit({ type: 'toolcall_start', contentIndex: index })
          emit({ type: 'toolcall_delta', contentIndex: index, delta: JSON.stringify(block.arguments) })
          emit({ type: 'toolcall_end', contentIndex: index, toolCall: block })
        }
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
