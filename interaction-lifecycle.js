// Local transport termination does not by itself cancel a stored cloud generation.
export const HOST_SHUTDOWN_CODE = 'ARGON_HOST_SHUTDOWN'

// An in-stream error event whose code is not listed here is treated as a remote
// terminal state: the cloud task is already over, so no reconnect and no /cancel.
// 'unknown' stays recoverable because an unclassified frame proves nothing.
const RECOVERABLE_STREAM_ERROR_CODES = ['authentication', 'unavailable', 'internal', 'deadline_exceeded', 'gateway_timeout', 'resource_exhausted', 'aborted', 'unknown']

export function normalizeStreamErrorCode(code) {
  return String(code ?? 'unknown').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64)
}

export function isRecoverableStreamErrorCode(code) {
  return RECOVERABLE_STREAM_ERROR_CODES.includes(normalizeStreamErrorCode(code).toLowerCase())
}

export function interactionExitReason(error, signal) {
  // A remote terminal error outranks a simultaneous local abort: both can arrive
  // on the same frame, and cancelling a task the cloud already finished would be
  // wrong. The recovery handle is reconciled against the cloud instead.
  if (error?.remoteTerminalError) return 'remote-error'
  if (signal?.aborted) {
    if (signal.reason?.code === HOST_SHUTDOWN_CODE) return 'host-shutdown'
    if (signal.reason?.name === 'TimeoutError') return 'read-interrupted'
    return 'user-stop'
  }
  if (error?.code === 'ARGON_INTERACTIONS_PROTOCOL' && !error.recoverableStreamError) return 'protocol-error'
  return 'read-interrupted'
}

export function cancelsRemoteInteraction(reason) {
  return ['user-stop', 'protocol-error', 'consumer-abandoned'].includes(reason)
}
