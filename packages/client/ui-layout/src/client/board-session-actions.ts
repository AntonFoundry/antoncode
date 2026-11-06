/** Exact-pane Session commands and projection-only board model reads. */
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-agent/types'

/** Session operations captured by the layout's apply closure, never passed to components. */
type BoardSessions = Pick<ISessions, 'using' | 'subagentAddress' | 'list' | 'refreshProjections'>

/**
 * Create board callbacks with temporary operation ownership and unchanged failures.
 * Commands release their reference after settlement, including acquisition cancellation;
 * model reads inspect projections without retaining or opening a conversation.
 * @param sessions - injected Session Controller operations owned by the layout plugin.
 * @param signal - plugin lifetime signal; cancels acquisition and prompt admission.
 * @returns exact-pane callbacks; command rejection preserves the original error object.
 */
export function createBoardSessionActions(sessions: BoardSessions, signal?: AbortSignal) {
  return {
    interruptSession: async (paneId: string): Promise<void> => {
      const id = paneId as SessionId
      await sessions.using(sessions.subagentAddress(id) ?? id, { source: 'controllerOperation', signal }, async (reference) => {
        signal?.throwIfAborted()
        const result = await reference.binding.session.cancel()
        if (!result.ok) throw result.error
      })
    },
    promptSession: async (paneId: string, text: string, mode: 'queue' | 'steer'): Promise<void> => {
      const id = paneId as SessionId
      await sessions.using(sessions.subagentAddress(id) ?? id, { source: 'controllerOperation', signal }, async (reference) => {
        signal?.throwIfAborted()
        const result = await reference.binding.session.prompt([{ type: 'text', text }], mode, signal)
        if (!result.ok) throw result.error
      })
    },
    fetchSessionModel: async (paneId: string): Promise<string | undefined> => {
      signal?.throwIfAborted()
      const id = paneId as SessionId
      let projection = sessions.list.getSnapshot().projectionsBySession[id]
      if (projection?.values.modelSelection === undefined) {
        await sessions.refreshProjections(id)
        signal?.throwIfAborted()
        projection = sessions.list.getSnapshot().projectionsBySession[id]
      }
      if (projection?.error !== null && projection?.error !== undefined) throw projection.error
      const selection = projection?.values.modelSelection
      const route = selection?.next ?? selection?.lastUsed
      return route === undefined || route === null ? undefined : `${route.provider}/${route.model}`
    },
  }
}
