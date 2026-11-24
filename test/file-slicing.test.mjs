import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SLICE_TOOL_NAME,
  SUPPORTED_SLICE_MIME_TYPES,
  EXTENSION_TO_MIME,
  inferSliceMimeType,
  normalizeSliceSpec,
  normalizePiAiToolCallId,
  toInteractionSliceBlock,
  toGenerateContentSlicePart,
  createFileSliceHub,
} from '../file-slicing.js'

test('inferSliceMimeType covers document, spreadsheet, video, audio, and audio/mp3 alias', () => {
  assert.equal(SLICE_TOOL_NAME, 'argon_slice_file')
  assert.equal(EXTENSION_TO_MIME['.pdf'], 'application/pdf')
  assert.equal(SUPPORTED_SLICE_MIME_TYPES['audio/mp3'], 'audio')

  assert.deepEqual(inferSliceMimeType('/tmp/report.PDF'), { mimeType: 'application/pdf', category: 'document' })
  assert.deepEqual(inferSliceMimeType('/tmp/deck.pptx'), {
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    category: 'document',
  })
  assert.deepEqual(inferSliceMimeType('/tmp/budget.xlsx'), {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    category: 'spreadsheet',
  })
  assert.deepEqual(inferSliceMimeType('/tmp/clip.mpg'), { mimeType: 'video/mpeg', category: 'video' })
  assert.deepEqual(inferSliceMimeType('/tmp/voice.m4a'), { mimeType: 'audio/mp4', category: 'audio' })
  assert.deepEqual(inferSliceMimeType('/tmp/voice.bin', 'audio/mp3; charset=binary'), {
    mimeType: 'audio/mp3',
    category: 'audio',
  })

  assert.throws(() => inferSliceMimeType('/tmp/notes.txt'), /Unsupported/i)
  assert.throws(() => inferSliceMimeType('/tmp/photo.png', 'image/png'), /Unsupported/i)
  assert.throws(() => inferSliceMimeType('/tmp/noext'), /Unsupported/i)
})

test('normalizeSliceSpec validates per-category rules, preserves decimal offsets without scientific notation, and rejects cross-category fields', () => {
  // Document
  assert.deepEqual(
    normalizeSliceSpec('document', {
      startPage: 2,
      endPage: 5,
      contentLayers: ['page_text', 'page_image', 'page_text'],
      resolution: 'high',
    }),
    { startPage: 2, endPage: 5, contentLayers: ['page_text', 'page_image'], resolution: 'high' },
  )
  assert.throws(() => normalizeSliceSpec('document', { startPage: 5, endPage: 2 }), /endPage/i)
  assert.throws(() => normalizeSliceSpec('document', { contentLayers: ['page_text'], resolution: 'high' }), /resolution/i)
  assert.throws(() => normalizeSliceSpec('document', { sheetIndex: 1 }), /not allowed/i)
  assert.throws(() => normalizeSliceSpec('document', { startOffset: 5 }), /not allowed/i)
  assert.throws(() => normalizeSliceSpec('document', { fps: 2 }), /not allowed/i)

  // Spreadsheet
  assert.deepEqual(
    normalizeSliceSpec('spreadsheet', {
      sheetIndex: 2,
      visibleCells: 'a1:d20',
      contentLayers: ['data', 'visual', 'data'],
      resolution: 'ultra_high',
    }),
    { sheetIndex: 2, visibleCells: 'A1:D20', contentLayers: ['data', 'visual'], resolution: 'ultra_high' },
  )
  assert.throws(() => normalizeSliceSpec('spreadsheet', { resolution: 'medium' }), /visual/i)
  assert.throws(() => normalizeSliceSpec('spreadsheet', { contentLayers: ['data', 'formulas'], resolution: 'low' }), /visual/i)
  assert.throws(() => normalizeSliceSpec('spreadsheet', { visibleCells: 'A0:B2' }), /visibleCells/i)
  assert.throws(() => normalizeSliceSpec('spreadsheet', { startPage: 1 }), /not allowed/i)

  // Video + no scientific notation on sub-microsecond offsets
  assert.deepEqual(
    normalizeSliceSpec('video', {
      startOffset: '0.0000001s',
      endOffset: 25,
      fps: 2,
      contentLayers: ['frames', 'audio', 'frames'],
      resolution: 'medium',
    }),
    { startOffset: '0.0000001s', endOffset: '25s', fps: 2, contentLayers: ['frames', 'audio'], resolution: 'medium' },
  )
  assert.deepEqual(
    normalizeSliceSpec('video', { startOffset: 1e-7, endOffset: 1 }),
    { startOffset: '0.0000001s', endOffset: '1s' },
  )
  assert.throws(() => normalizeSliceSpec('video', { startOffset: 20, endOffset: 20 }), /strictly greater/i)
  assert.throws(() => normalizeSliceSpec('video', { fps: 0 }), /fps/i)
  assert.throws(() => normalizeSliceSpec('video', { fps: 25 }), /fps/i)
  assert.throws(() => normalizeSliceSpec('video', { contentLayers: ['audio', 'transcript'], resolution: 'high' }), /frames/i)
  assert.throws(() => normalizeSliceSpec('video', { visibleCells: 'A1' }), /not allowed/i)

  // Audio
  assert.deepEqual(
    normalizeSliceSpec('audio', { startOffset: 0, endOffset: '42.5s' }),
    { startOffset: '0s', endOffset: '42.5s' },
  )
  assert.throws(() => normalizeSliceSpec('audio', { startOffset: 10, endOffset: 5 }), /strictly greater/i)
  assert.throws(() => normalizeSliceSpec('audio', { contentLayers: ['audio'] }), /not allowed/i)
  assert.throws(() => normalizeSliceSpec('audio', { resolution: 'low' }), /not allowed/i)
  assert.throws(() => normalizeSliceSpec('audio', { fps: 1 }), /not allowed/i)
})

test('normalizePiAiToolCallId replaces unsafe chars and truncates to 64 chars', () => {
  assert.equal(normalizePiAiToolCallId('call:abc/123.def'), 'call_abc_123_def')
  const longId = 'a'.repeat(80)
  assert.equal(normalizePiAiToolCallId(longId).length, 64)
})

test('toInteractionSliceBlock and toGenerateContentSlicePart serialize all 4 categories accurately', () => {
  const docRec = {
    uri: 'https://generativelanguage.googleapis.com/v1beta/files/doc1',
    mimeType: 'application/pdf',
    category: 'document',
    displayName: 'slice_111_report.pdf',
    slice: { startPage: 1, endPage: 3, contentLayers: ['page_text', 'page_image'], resolution: 'high' },
  }
  assert.deepEqual(toInteractionSliceBlock(docRec), {
    type: 'document',
    uri: docRec.uri,
    mime_type: 'application/pdf',
    resolution: 'high',
    processing: {
      type: 'static',
      page_options: { start_page: 1, end_page: 3, content_layers: ['page_text', 'page_image'] },
    },
  })
  assert.deepEqual(toGenerateContentSlicePart(docRec), {
    displayName: 'slice_111_report.pdf',
    part: {
      fileData: { fileUri: docRec.uri, mimeType: 'application/pdf', displayName: 'slice_111_report.pdf' },
      documentMetadata: { startPage: 1, endPage: 3, contentLayers: ['PAGE_TEXT', 'PAGE_IMAGE'] },
      mediaResolution: { level: 'MEDIA_RESOLUTION_HIGH' },
    },
  })

  const sheetRec = {
    uri: 'https://generativelanguage.googleapis.com/v1beta/files/sheet1',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    category: 'spreadsheet',
    displayName: 'slice_222_book.xlsx',
    slice: { sheetIndex: 2, visibleCells: 'A1:C10', contentLayers: ['data', 'visual'], resolution: 'medium' },
  }
  assert.deepEqual(toInteractionSliceBlock(sheetRec), {
    type: 'document',
    uri: sheetRec.uri,
    mime_type: sheetRec.mimeType,
    resolution: 'medium',
    processing: {
      type: 'static',
      spreadsheet_options: { sheet_index: 2, visible_cells: 'A1:C10', content_layers: ['data', 'visual'] },
    },
  })
  assert.deepEqual(toGenerateContentSlicePart(sheetRec), {
    displayName: 'slice_222_book.xlsx',
    part: {
      fileData: { fileUri: sheetRec.uri, mimeType: sheetRec.mimeType, displayName: 'slice_222_book.xlsx' },
      spreadsheetMetadata: { sheetIndex: 2, visibleCells: 'A1:C10', contentLayers: ['DATA', 'VISUAL'] },
      mediaResolution: { level: 'MEDIA_RESOLUTION_MEDIUM' },
    },
  })

  const vidRec = {
    uri: 'https://generativelanguage.googleapis.com/v1beta/files/vid1',
    mimeType: 'video/mp4',
    category: 'video',
    displayName: 'slice_333_demo.mp4',
    slice: { startOffset: '5s', endOffset: '20s', fps: 1.5, contentLayers: ['frames', 'transcript'], resolution: 'ultra_high' },
  }
  assert.deepEqual(toInteractionSliceBlock(vidRec), {
    type: 'video',
    uri: vidRec.uri,
    mime_type: 'video/mp4',
    resolution: 'ultra_high',
    processing: {
      type: 'static',
      start_offset: '5s',
      end_offset: '20s',
      fps: 1.5,
      content_layers: ['frames', 'transcript'],
    },
  })
  assert.deepEqual(toGenerateContentSlicePart(vidRec), {
    displayName: 'slice_333_demo.mp4',
    part: {
      fileData: { fileUri: vidRec.uri, mimeType: 'video/mp4', displayName: 'slice_333_demo.mp4' },
      videoMetadata: { startOffset: '5s', endOffset: '20s', fps: 1.5, contentLayers: ['FRAMES', 'TRANSCRIPT'] },
      mediaResolution: { level: 'MEDIA_RESOLUTION_ULTRA_HIGH' },
    },
  })

  const audRec = {
    uri: 'https://generativelanguage.googleapis.com/v1beta/files/aud1',
    mimeType: 'audio/mpeg',
    category: 'audio',
    displayName: 'slice_444_call.mp3',
    slice: { startOffset: '0s', endOffset: '30s' },
  }
  assert.deepEqual(toInteractionSliceBlock(audRec), {
    type: 'audio',
    uri: audRec.uri,
    mime_type: 'audio/mpeg',
    processing: { type: 'static', start_offset: '0s', end_offset: '30s' },
  })
  assert.deepEqual(toGenerateContentSlicePart(audRec), {
    displayName: 'slice_444_call.mp3',
    part: {
      fileData: { fileUri: audRec.uri, mimeType: 'audio/mpeg', displayName: 'slice_444_call.mp3' },
      audioMetadata: { startOffset: '0s', endOffset: '30s' },
    },
  })
})

test('createFileSliceHub ref-counted shared AbortController, revokeConsent, maxInFlightUploads, closed guard, endpointBase isolation, and 48h expiry clamp', async () => {
  let clock = 1_000_000
  const ttl48h = 48 * 3600_000
  const hub = createFileSliceHub({
    now: () => clock,
    maxInFlightUploads: 2,
    safetyExpiryMarginMs: 5 * 60_000,
    defaultTtlMs: ttl48h,
  })

  // 1. Failed upload never poisons cache
  await assert.rejects(() => hub.getOrUpload({
    principalHash: 'pA',
    sha256: 'hash1',
    mimeType: 'application/pdf',
    uploadFn: async () => { throw new Error('transient') },
  }))

  // 2. Shared in-flight: caller 1 aborts -> caller 2 STILL resolves; sharedSignal NOT aborted!
  let resolveUpload1
  let sharedSignal1
  let uploadCalls = 0
  const ac1 = new AbortController()
  const ac2 = new AbortController()
  const p1 = hub.getOrUpload({
    principalHash: 'pA',
    endpointBase: 'https://gw-a.example',
    sha256: 'hash1',
    mimeType: 'application/pdf',
    signal: ac1.signal,
    uploadFn: sharedSig => {
      uploadCalls++
      sharedSignal1 = sharedSig
      return new Promise(r => { resolveUpload1 = r })
    },
  })
  const p2 = hub.getOrUpload({
    principalHash: 'pA',
    endpointBase: 'https://gw-a.example',
    sha256: 'hash1',
    mimeType: 'application/pdf',
    signal: ac2.signal,
    uploadFn: () => { throw new Error('should dedup') },
  })
  assert.equal(uploadCalls, 1)
  ac1.abort()
  await assert.rejects(() => p1, err => err.name === 'AbortError')
  assert.equal(sharedSignal1.aborted, false) // caller 2 still waiting!

  // Remote expirationTime > 48h is clamped to now() + 48h
  resolveUpload1({
    name: 'files/f1',
    uri: 'https://gw-a.example/v1beta/files/f1',
    mimeType: 'application/pdf',
    sizeBytes: 100,
    expirationTimeMs: clock + 100 * 3600_000,
  })
  const r2 = await p2
  assert.equal(r2.reusedUpload, true)
  assert.equal(r2.expirationTimeMs, clock + ttl48h)

  // 3. Different endpointBase does NOT hit gw-a cache
  const rGwB = await hub.getOrUpload({
    principalHash: 'pA',
    endpointBase: 'https://gw-b.example',
    sha256: 'hash1',
    mimeType: 'application/pdf',
    uploadFn: async () => {
      uploadCalls++
      return { name: 'files/f_b', uri: 'https://gw-b.example/v1beta/files/f_b' }
    },
  })
  assert.equal(uploadCalls, 2)
  assert.equal(rGwB.reusedUpload, false)

  // 4. Both callers aborting DOES abort underlying sharedSignal
  let sharedSignal2
  const b1 = new AbortController()
  const b2 = new AbortController()
  const pb1 = hub.getOrUpload({
    principalHash: 'pA',
    sha256: 'hash2',
    mimeType: 'application/pdf',
    signal: b1.signal,
    uploadFn: sharedSig => {
      sharedSignal2 = sharedSig
      return new Promise((_r, rej) => {
        sharedSig.addEventListener('abort', () => rej(sharedSig.reason), { once: true })
      })
    },
  })
  const pb2 = hub.getOrUpload({
    principalHash: 'pA',
    sha256: 'hash2',
    mimeType: 'application/pdf',
    signal: b2.signal,
    uploadFn: () => { throw new Error('should dedup') },
  })
  b1.abort()
  await assert.rejects(() => pb1, err => err.name === 'AbortError')
  assert.equal(sharedSignal2.aborted, false)
  b2.abort()
  await assert.rejects(() => pb2, err => err.name === 'AbortError')
  assert.equal(sharedSignal2.aborted, true)

  // Immediate re-entry after all waiters abort starts a fresh upload (never inherits aborted flight!)
  let freshAfterAbortCalls = 0
  const reenteredAfterAbort = await hub.getOrUpload({
    principalHash: 'pA',
    sha256: 'hash2',
    mimeType: 'application/pdf',
    uploadFn: async sig => {
      freshAfterAbortCalls++
      assert.equal(sig.aborted, false)
      return { name: 'files/f_reentered', uri: 'https://generativelanguage.googleapis.com/v1beta/files/f_reentered' }
    },
  })
  assert.equal(freshAfterAbortCalls, 1)
  assert.equal(reenteredAfterAbort.reusedUpload, false)
  assert.equal(reenteredAfterAbort.name, 'files/f_reentered')

  // 5. maxInFlightUploads limit & revokeConsent() (including immediate re-entry on same key!)
  let revSig1, revSig2
  const inflight1 = hub.getOrUpload({
    principalHash: 'pA',
    sha256: 'slot1',
    mimeType: 'application/pdf',
    uploadFn: sig => {
      revSig1 = sig
      return new Promise((_r, rej) => sig.addEventListener('abort', () => rej(sig.reason), { once: true }))
    },
  })
  const inflight2 = hub.getOrUpload({
    principalHash: 'pA',
    sha256: 'slot2',
    mimeType: 'application/pdf',
    uploadFn: sig => {
      revSig2 = sig
      return new Promise((_r, rej) => sig.addEventListener('abort', () => rej(sig.reason), { once: true }))
    },
  })
  await assert.rejects(
    () => hub.getOrUpload({
      principalHash: 'pA',
      sha256: 'slot3',
      mimeType: 'application/pdf',
      uploadFn: async () => ({ name: 'files/x', uri: 'https://generativelanguage.googleapis.com/v1beta/files/x' }),
    }),
    err => err.code === 'ARGON_SLICE_TOO_MANY_UPLOADS',
  )
  hub.revokeConsent()
  assert.equal(revSig1.aborted, true)
  assert.equal(revSig2.aborted, true)
  // Immediately re-enter on the EXACT SAME key ('slot1') before awaiting inflight1 settlement
  const reenteredAfterRevokePromise = hub.getOrUpload({
    principalHash: 'pA',
    sha256: 'slot1',
    mimeType: 'application/pdf',
    uploadFn: async sig => {
      assert.equal(sig.aborted, false)
      return { name: 'files/slot1_fresh', uri: 'https://generativelanguage.googleapis.com/v1beta/files/slot1_fresh' }
    },
  })
  await assert.rejects(() => inflight1, err => err.code === 'ARGON_FILE_SLICING_DISABLED')
  await assert.rejects(() => inflight2, err => err.code === 'ARGON_FILE_SLICING_DISABLED')
  const reenteredAfterRevoke = await reenteredAfterRevokePromise
  assert.equal(reenteredAfterRevoke.reusedUpload, false)
  assert.equal(reenteredAfterRevoke.name, 'files/slot1_fresh')

  // Hub remains open after revokeConsent()
  const afterRevoke = await hub.getOrUpload({
    principalHash: 'pA',
    sha256: 'slot-after',
    mimeType: 'application/pdf',
    uploadFn: async () => ({ name: 'files/ok', uri: 'https://generativelanguage.googleapis.com/v1beta/files/ok' }),
  })
  assert.equal(afterRevoke.name, 'files/ok')

  // 6. Closed hub rejects getOrUpload without calling uploadFn
  hub.close()
  let ranAfterClose = false
  await assert.rejects(
    () => hub.getOrUpload({
      principalHash: 'pA',
      sha256: 'slot-closed',
      mimeType: 'application/pdf',
      uploadFn: async () => { ranAfterClose = true; return { name: 'files/no', uri: 'https://generativelanguage.googleapis.com/v1beta/files/no' } },
    }),
    err => err.code === 'ARGON_SLICE_CLOSED',
  )
  assert.equal(ranAfterClose, false)
})

test('createFileSliceHub enforces session-global active window, sliceId binding, collision refusal, endpointBase isolation, and isError skip', () => {
  let clock = 10_000_000
  const hub = createFileSliceHub({
    maxActiveSlicesPerSession: 6,
    safetyExpiryMarginMs: 5 * 60_000,
    defaultTtlMs: 48 * 3600_000,
    now: () => clock,
  })

  const records = []
  for (let i = 1; i <= 8; i++) {
    records.push(hub.registerSlice({
      sessionId: 'sess-1',
      callId: `call:${i}/slice`,
      route: 'google-generative-ai',
      principalHash: 'principal-A',
      endpointBase: 'https://gw-a.example',
      uri: `https://gw-a.example/v1beta/files/f${i}`,
      name: `files/f${i}`,
      mimeType: 'application/pdf',
      category: 'document',
      displayName: `slice_${i}_doc.pdf`,
      slice: { startPage: i, endPage: i },
      expirationTimeMs: i === 2 ? clock + 60_000 : clock + 48 * 3600_000,
    }))
  }

  // 1. Session-global active window: truncated request containing ONLY old slice #1 still resolves as 'offloaded' (never resurrects!)
  const truncated = hub.resolveForRequest({
    sessionId: 'sess-1',
    route: 'google-generative-ai',
    principalHash: 'principal-A',
    endpointBase: 'https://gw-a.example',
    allowGeminiFilesApi: true,
    protocol: 'interactions',
    entries: [{ key: 'k1', callId: records[0].callId, sliceId: records[0].sliceId }],
  })
  assert.equal(truncated.get('k1').status, 'offloaded')
  assert.match(truncated.get('k1').notice, /offloaded from the active window/i)

  // 2. EndpointBase isolation: gw-b gets empty map
  assert.equal(
    hub.resolveForRequest({
      sessionId: 'sess-1',
      route: 'google-generative-ai',
      principalHash: 'principal-A',
      endpointBase: 'https://gw-b.example',
      allowGeminiFilesApi: true,
      protocol: 'interactions',
      entries: [{ key: 'k8', callId: records[7].callId, sliceId: records[7].sliceId }],
    }).size,
    0,
  )

  // 3. Interactions rejects normalized alias fallback (must match exact callId)
  const intNormalized = hub.resolveForRequest({
    sessionId: 'sess-1',
    route: 'google-generative-ai',
    principalHash: 'principal-A',
    endpointBase: 'https://gw-a.example',
    allowGeminiFilesApi: true,
    protocol: 'interactions',
    toolCallIds: [records[7].normalizedCallId],
  })
  assert.equal(intNormalized.size, 0)

  // 4. Duplicate entries & isError skipping
  const dupAndErr = hub.resolveForRequest({
    sessionId: 'sess-1',
    route: 'google-generative-ai',
    principalHash: 'principal-A',
    endpointBase: 'https://gw-a.example',
    allowGeminiFilesApi: true,
    protocol: 'generate-content',
    entries: [
      { key: 'err-row', callId: records[7].normalizedCallId, sliceId: records[7].sliceId, isError: true },
      { key: 'ok-1', callId: records[7].normalizedCallId, sliceId: records[7].sliceId },
      { key: 'ok-dup', callId: records[7].normalizedCallId, sliceId: records[7].sliceId },
    ],
  })
  assert.equal(dupAndErr.has('err-row'), false)
  assert.equal(dupAndErr.get('ok-1').status, 'active')
  assert.equal(dupAndErr.has('ok-dup'), false) // same record cannot be injected twice

  // 5. Collision ambiguity without sliceId refuses injection (even when one raw ID equals the normalized ID: 'a_b' vs 'a:b'); with sliceId binds 1:1
  const col1 = hub.registerSlice({
    sessionId: 'sess-col',
    callId: 'a_b',
    principalHash: 'p1',
    uri: 'https://generativelanguage.googleapis.com/v1beta/files/c1',
    name: 'files/c1',
    mimeType: 'application/pdf',
    category: 'document',
    displayName: 'slice_c1.pdf',
    slice: { startPage: 1 },
  })
  const col2 = hub.registerSlice({
    sessionId: 'sess-col',
    callId: 'a:b', // normalizes to same 'a_b' as raw 'a_b'
    principalHash: 'p1',
    uri: 'https://generativelanguage.googleapis.com/v1beta/files/c2',
    name: 'files/c2',
    mimeType: 'application/pdf',
    category: 'document',
    displayName: 'slice_c2.pdf',
    slice: { startPage: 2 },
  })
  assert.equal(col1.normalizedCallId, 'a_b')
  assert.equal(col2.normalizedCallId, 'a_b')

  // Ambiguous normalized lookup without sliceId -> refused even when querying 'a_b'!
  const ambiguous = hub.resolveForRequest({
    sessionId: 'sess-col',
    route: 'google-generative-ai',
    principalHash: 'p1',
    allowGeminiFilesApi: true,
    protocol: 'generate-content',
    entries: [{ key: '0', callId: 'a_b' }],
  })
  assert.equal(ambiguous.size, 0)

  // Explicit sliceId disambiguates 1:1!
  const exact = hub.resolveForRequest({
    sessionId: 'sess-col',
    route: 'google-generative-ai',
    principalHash: 'p1',
    allowGeminiFilesApi: true,
    protocol: 'generate-content',
    entries: [
      { key: 'first', callId: col1.normalizedCallId, sliceId: col1.sliceId },
      { key: 'second', callId: col2.normalizedCallId, sliceId: col2.sliceId },
    ],
  })
  assert.equal(exact.get('first').part.documentMetadata.startPage, 1)
  assert.equal(exact.get('second').part.documentMetadata.startPage, 2)
})
