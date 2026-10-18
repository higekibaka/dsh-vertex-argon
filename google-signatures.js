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

function unsigned(message) {
  return { ...message, api: 'dsh-foreign', content: message.content.map(block => {
    const { textSignature, thinkingSignature, thoughtSignature, ...rest } = block
    return rest
  }) }
}

// The existing textSignature field is adapter-owned opaque replay metadata.
// Its versioned codec never reaches Google: onPayload restores the original Part.
export function createGoogleSignatureBridge(context, model) {
  const restore = [], history = createHash('sha256')
  const messages = context.messages.map(message => {
    const previousHistory = history.copy().digest('hex')
    history.update(historyRecord(message))
    if (message.role !== 'assistant') return message
    const same = message.api === model.api && message.provider === model.provider && message.model === model.id
    const codes = message.content.map(block => block.type === 'text' ? decode(block.textSignature) : undefined)
    const hasCodes = codes.some(code => code !== undefined)
    const contentDigest = hasCodes ? digest(message.content) : undefined
    if (hasCodes && (!same || codes.some((code, index) => code !== undefined && (!code || message.content[index].text !== '' || code.contentDigest !== contentDigest || code.historyDigest !== previousHistory)))) return unsigned(message)
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
    return hasCodes ? { ...message, content } : message
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
        const onlySignature = typeof part.thoughtSignature === 'string' && Object.keys(part).filter(key => part[key] !== undefined).every(key => key === 'thoughtSignature' || key === 'thought')
        if (onlySignature) {
          if (!part.thoughtSignature || (part.thought !== undefined && typeof part.thought !== 'boolean')) throw failure('Google returned an invalid standalone signature.')
          bytes += 320 // Include the local versioned codec and content binding in the retention bound.
          if (bytes > 64 * 1024 * 1024) throw failure('Google signature replay metadata exceeded the bounded response buffer.')
          close()
          const block = { type: 'text', text: '' }, index = start(block)
          standalone.set(index, { signature: part.thoughtSignature, ...(part.thought === undefined ? {} : { thought: part.thought }) })
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
          if (part.thoughtSignature) current[type === 'text' ? 'textSignature' : 'thinkingSignature'] = part.thoughtSignature
          emit({ type: type === 'text' ? 'text_delta' : 'thinking_delta', contentIndex: content.length - 1, delta: part.text })
        }
        if (part.functionCall) {
          close()
          const call = part.functionCall
          const id = call.id && !usedToolIds.has(call.id) ? call.id : 'argon_' + randomUUID().replaceAll('-', '')
          usedToolIds.add(id)
          const block = { type: 'toolCall', id, name: call.name || '', arguments: call.args ?? {}, ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}) }
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
