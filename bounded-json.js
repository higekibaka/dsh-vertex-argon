// Limits apply to decoded response bytes, not a potentially compressed/false header.
export function queryReadError(code) {
  return Object.assign(new Error(code === 'ARGON_QUERY_TOO_LARGE' ? 'Interaction response exceeded the query size limit.' : 'Interaction query returned an invalid JSON response.'), {code})
}

export async function abortable(promise, signal) {
  let onAbort
  try {
    const stopped = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, {once:true})
      if (signal.aborted) onAbort()
    })
    return await Promise.race([promise, stopped])
  } finally { signal.removeEventListener('abort', onAbort) }
}

export async function readBoundedJson(response, maxBytes, signal) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) throw queryReadError('ARGON_QUERY_RESPONSE')
  const cancelBody = () => { try { Promise.resolve(response.body?.cancel()).catch(() => {}) } catch {} }
  const type = response.headers?.get('content-type')?.split(';')[0].trim().toLowerCase()
  if (!type || !(type === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/.test(type)) || !response.body) {
    cancelBody(); throw queryReadError('ARGON_QUERY_RESPONSE')
  }
  const declared = response.headers.get('content-length')
  if (declared && /^[0-9]+$/.test(declared) && Number(declared) > maxBytes) {
    cancelBody(); throw queryReadError('ARGON_QUERY_TOO_LARGE')
  }
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', {fatal:true})
  let bytes = 0, cancelled = false, complete = false
  const text = []
  const cancel = () => { if (!cancelled) { cancelled = true; try { Promise.resolve(reader.cancel()).catch(() => {}) } catch {} } }
  signal.addEventListener('abort', cancel, {once:true})
  try {
    for (;;) {
      signal.throwIfAborted()
      const {value, done} = await abortable(reader.read(), signal)
      signal.throwIfAborted()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) throw queryReadError('ARGON_QUERY_TOO_LARGE')
      try { text.push(decoder.decode(value, {stream:true})) } catch { throw queryReadError('ARGON_QUERY_RESPONSE') }
    }
    let value
    try { text.push(decoder.decode()); value = JSON.parse(text.join('')) } catch { throw queryReadError('ARGON_QUERY_RESPONSE') }
    signal.throwIfAborted()
    complete = true
    return value
  } finally {
    signal.removeEventListener('abort', cancel)
    if (!complete) cancel()
    try { reader.releaseLock() } catch {}
  }
}
