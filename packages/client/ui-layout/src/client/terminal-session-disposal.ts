/** Remote terminal disposal owned by one layout plugin instance. */
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'

/**
 * Create a terminal disposer that shares each in-flight request by session id.
 * Failed Remote results reject unchanged; settlement permits a later request.
 * @param guiTerminal - the typed terminal Remote's disposal method.
 * @returns a callback that resolves only after the Host acknowledges disposal.
 */
export function createTerminalSessionDisposer(
  guiTerminal: Pick<ClientRemote['guiTerminal'], 'dispose'>,
): (sessionId: string) => Promise<void> {
  const pending = new Map<string, Promise<void>>()
  return (sessionId) => {
    const existing = pending.get(sessionId)
    if (existing !== undefined) return existing
    const operation = Promise.resolve().then(async () => {
      const result = await guiTerminal.dispose({ sessionId })
      if (!result.ok) throw result.error
    }).finally(() => {
      pending.delete(sessionId)
    })
    pending.set(sessionId, operation)
    return operation
  }
}
