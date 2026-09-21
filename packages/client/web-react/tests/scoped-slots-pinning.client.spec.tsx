// @vitest-environment jsdom
/**
 * Pinned-slot dispatch account (`RenderOpts.scopeSessionId`): a renderSlot
 * occurrence carrying a session id resolves its entries' provide bundle BY
 * id — not from the enclosing current-session provider — and wraps the
 * subtree in SessionPinProvider, so NESTED slot dispatch inside the pinned
 * window resolves the same pinned bundle. This is the seam the wm session
 * buffers use to show a non-current session in one pane.
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import type { SessionMaybeProvideInfo, SessionProvideInfo, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { createSlotRenderer, type SlotRendererHost } from '@deepseek-ai/dsh-client-web-react'

function observable<T>(initial: T) {
  let value = initial
  const subs = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn) } },
    set: (next: T) => { value = next; for (const fn of [...subs]) fn() },
  }
}

/**
 * Host fake with two resolvable sessions. The current session is s1; the
 * pinning specs dispatch entries scoped to s2 through provideInfoFor.
 */
function makeHost() {
  const absentInfo: SessionMaybeProvideInfo = { sessionId: undefined, hooks: { session: undefined }, props: {} }
  const provide = observable<SessionMaybeProvideInfo>(absentInfo)
  const infos = new Map<string, SessionProvideInfo>()
  const entries = new Map<string, StoredEntry[]>()
  const rootEntry: StoredEntry = {
    component: (props: { renderSlot: (key: string, owner: object, opts?: object) => React.ReactNode }) => (
      <>{props.renderSlot('k.session', {}, { scopeSessionId: 's2' })}</>
    ),
    options: {},
    children: { 'k.session': { kind: 'single', scope: 'session' } },
  }
  const host: SlotRendererHost = {
    subscribe: () => () => {},
    getVersion: () => 0,
    entriesOf: key => key === 'root' ? [rootEntry] : entries.get(key) ?? [],
    entriesOfSlot: key => key === 'root' ? [rootEntry] : entries.get(key) ?? [],
    reportEntryError: () => {},
    specOf: key => key === 'k.session'
      ? { kind: 'single', scope: 'session' }
      : key === 'k.inner'
        ? { kind: 'single', scope: 'session' }
        : undefined,
    isLive: () => true,
    storeOf: () => undefined,
    sessions: {
      list: observable<unknown>({ ids: [] }),
      provideInfo: provide,
      // The pinning feed: identity-stable per-session bundles.
      provideInfoFor: id => infos.get(id) ?? absentInfo,
    },
    workspaces: { list: observable<unknown>({ items: [] }) },
  }
  for (const id of ['s1', 's2']) {
    infos.set(id, {
      sessionId: id,
      hooks: { session: { getSnapshot: () => ({ sid: id }), subscribe: () => () => {} } },
      props: {},
    })
  }
  provide.set(infos.get('s1')!)
  return { host, register: (key: string, entry: StoredEntry) => {
    const list = entries.get(key) ?? []
    list.push(entry)
    entries.set(key, list)
  } }
}

/** Session-scope probe: renders the framework-injected session id. */
function sessionEntry(label: string): { component: StoredEntry['component']; options: StoredEntry['options']; children?: StoredEntry['children'] } {
  return {
    component: (props: { sessionId?: string; renderSlot?: (key: string, owner: object) => React.ReactNode }) => (
      <span data-testid={label}>{props.sessionId ?? 'none'}{props.renderSlot?.('k.inner', {})}</span>
    ),
    options: {},
  }
}

describe('pinned slot dispatch (scopeSessionId)', () => {
  it('resolves the entry bundle by session id, not the enclosing current session', () => {
    const h = makeHost()
    const entry = sessionEntry('pinned') as unknown as StoredEntry
    h.register('k.session', entry)
    const view = render(<>{createSlotRenderer().renderRoot(h.host, {})}</>)
    // Current is s1; the occurrence pinned to s2 renders s2's id.
    expect(view.container.textContent).toBe('s2')
  })

  it('SessionPinProvider covers nested dispatch: a child slot resolves the same pinned bundle', () => {
    const h = makeHost()
    const entry = sessionEntry('pinned') as unknown as StoredEntry
    entry.children = { 'k.inner': { kind: 'single', scope: 'session' } }
    h.register('k.session', entry)
    const inner = sessionEntry('inner') as unknown as StoredEntry
    h.register('k.inner', inner)
    const view = render(<>{createSlotRenderer().renderRoot(h.host, {})}</>)
    // Outer: pinned s2. Inner (dispatched with NO opts): still s2 — the pin
    // provider overrode the enclosing current-session context (s1).
    expect(view.container.textContent).toBe('s2s2')
  })
})
