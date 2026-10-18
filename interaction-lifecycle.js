// Local transport termination does not by itself cancel a stored cloud generation.
export const HOST_SHUTDOWN_CODE = 'ARGON_HOST_SHUTDOWN'

export function interactionExitReason(error, signal) {
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
