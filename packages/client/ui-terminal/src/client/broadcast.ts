/**
 * The terminal broadcast store: multi-cursor state shared by every mounted
 * terminal view. `broadcast` on means keystrokes typed into any one
 * terminal write into ALL joined sessions; `sessions` is the mounted set
 * (views join on mount, leave on unmount). Declared at the
 * `terminal.view` register — the framework instantiates one instance and
 * every view reads the same snapshots, so a broadcast toggle in any view
 * (or via `M-x multi-cursor`'s toggle event) flips all of them together.
 * @module @deepseek-ai/dsh-client-ui-terminal/client/broadcast
 */

import { defineStore } from '@deepseek-ai/dsh-client-runtime/client'

/** Broadcast store state: the toggle plus the mounted terminal sessions. */
export type BroadcastState = { broadcast: boolean; sessions: readonly string[] }

/** Annotation twin of the actions literal (declared return type). */
export type BroadcastActions = {
  setBroadcast: (draft: BroadcastState, on: boolean) => void
  join: (draft: BroadcastState, sessionId: string) => void
  leave: (draft: BroadcastState, sessionId: string) => void
}

/**
 * Create the broadcast store handle. No persistence: broadcast is a
 * per-sessions intent, and the mounted set is live view state.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createBroadcastStore(): import('@deepseek-ai/dsh-client-runtime/client').EngineStoreHandle<BroadcastState, BroadcastActions> {
  return defineStore({
    init: (): BroadcastState => ({ broadcast: false, sessions: [] }),
    actions: {
      setBroadcast: (d, on: boolean) => { d.broadcast = on },
      join: (d, sessionId: string) => {
        if (!d.sessions.includes(sessionId)) d.sessions = [...d.sessions, sessionId]
      },
      leave: (d, sessionId: string) => { d.sessions = d.sessions.filter(s => s !== sessionId) },
    },
  })
}
