/**
 * Tool-card expansion mode: the global collapsed/expanded preference shared
 * by every ToolRow, plus the DOM event that flips it. The chat-header toggle
 * (registered by this package's apply into the header utilities slot)
 * dispatches {@link dispatchCardMode}; every mounted row listens and applies
 * the mode. The preference persists at `dsh.tool.cards.expanded` so newly
 * mounted cards start in the chosen posture.
 * @module @deepseek-ai/dsh-client-ui-tool/client/card-mode
 */

const KEY = 'dsh.tool.cards.expanded'

/** The DOM event name the header toggle dispatches (detail: boolean). */
export const CARD_MODE_EVENT = 'ui-tool:card-mode'

/**
 * Seed posture for a newly mounted row: the persisted global preference,
 * defaulting to collapsed (a run of tool calls stays a compact list).
 * @returns whether rows should mount expanded.
 */
export function cardModeDefault(): boolean {
  try { return window.localStorage.getItem(KEY) === 'expanded' } catch { return false }
}

/**
 * Persist the global posture (new cards mount in it).
 * @param expanded - whether cards should be expanded.
 */
export function setCardModePersisted(expanded: boolean): void {
  try { window.localStorage.setItem(KEY, expanded ? 'expanded' : 'collapsed') } catch { /* private mode */ }
}

/**
 * Fan the posture out to every mounted row.
 * @param expanded - whether cards should be expanded.
 */
export function dispatchCardMode(expanded: boolean): void {
  window.dispatchEvent(new CustomEvent(CARD_MODE_EVENT, { detail: expanded }))
}
