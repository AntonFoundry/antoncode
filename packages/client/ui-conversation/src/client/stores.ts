/**
 * Per-session chat store shared by conversation and details registrations.
 * The plugin creates its handle at apply time so identity follows the fiber.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { CallId, ChatStoreState, SelectionTarget } from './contract/views.ts'

/** Declared action shape used to give the exported factory a stable return type. */
type ChatActions = {
  select: (draft: ChatStoreState, target: SelectionTarget | null) => void
  setDraft: (draft: ChatStoreState, text: string) => void
  setView: (draft: ChatStoreState, view: string) => void
  setInspect: (draft: ChatStoreState, target: { callId: CallId } | null) => void
}

/**
 * Declares the per-session chat state and write surface.
 * @returns the store handle.
 */
export function createChatStore(): EngineStoreHandle<ChatStoreState, ChatActions> {
  return defineStore({
    // Anchored to the contract shape: consumers read the store through
    // PropsStore<ChatStore>'s SnapshotSelectorHook<ChatStoreState>, so init
    // and the contract cannot drift.
    init: (): ChatStoreState => ({ selection: null, draft: '', view: null, inspect: null }),
    persist: 'dsh.conversation.chat',
    actions: {
      select: (d, target: SelectionTarget | null) => { d.selection = target },
      setDraft: (d, text: string) => { d.draft = text },
      setView: (d, view: string) => { d.view = view },
      setInspect: (d, target: { callId: CallId } | null) => { d.inspect = target },
    },
  })
}

/** Branch-collapse state of the sidebar todo tree, keyed by branch title. */
export interface TodoTreeStoreState {
  collapsed: string[]
}

/** Declared action shape used to give the exported factory a stable return type. */
type TodoTreeActions = {
  toggle: (draft: TodoTreeStoreState, id: string) => void
}

/**
 * Declares the todo tree's branch-collapse state and write surface. The seat
 * unmounts whenever the sidebar collapses to the rail, so the state lives in
 * a store instead of component state to survive those remounts.
 * @returns the store handle.
 */
export function createTodoTreeStore(): EngineStoreHandle<TodoTreeStoreState, TodoTreeActions> {
  return defineStore({
    init: (): TodoTreeStoreState => ({ collapsed: [] }),
    persist: 'dsh.conversation.todoTree',
    actions: {
      toggle: (d, id: string) => {
        const at = d.collapsed.indexOf(id)
        if (at >= 0) d.collapsed.splice(at, 1)
        else d.collapsed.push(id)
      },
    },
  })
}
