/**
 * Agent-mode board: the frame's tree area tiled with one live pane per
 * session, grouped under workspace section headers, with subagent sessions
 * nested under the session that spawned them. Pure presentation over plain
 * summary data: {@link buildAgentBoard} derives the grouping from the
 * workspace registry and the retained session-list mirror, and the component
 * renders it — status, preset, elapsed clock, subagent chips — with no
 * subscription machinery of its own.
 * @module
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { CSSProperties } from 'react'
import css from './WmFrame.module.css'

/** One real-pty terminal tile on the board (structural subset of WmBuffer). */
export interface AgentTerminalTile {
  id: string
  kind: 'terminal'
  sessionId: string | undefined
  title: string
}

/** One derived activity line (structural twin of the runtime wire value). */
export interface AgentTailLine {
  kind: 'user' | 'tool' | 'assistant' | 'error'
  label: string
}

/** The one session summary fact the board needs, per pane. */
export interface AgentSessionView {
  id: string
  displayTitle: string
  /** Session working directory — the footer strip's path half. */
  cwd?: string
  /** Agent preset the session runs, absent when the deployment composes none. */
  agentPreset?: string
  running: boolean
  /** Coarse durable origin; `'subagent'` nests the pane under its parent. */
  origin?: 'subagent'
  parent?: string
  /** The sidebar's amber-dot wait, surfaced here as a pane status. */
  pendingInteraction?: 'approval' | 'plan-review' | 'question'
  /** Finished while unselected and not yet opened — the green done state. */
  completed?: boolean
  updatedAt: number
}

/** One workspace section of the board. */
export interface AgentWorkspaceGroup {
  workspaceId: string
  title: string
  /** Top-level sessions, newest first; each carries its nested subagents. */
  sessions: readonly AgentSessionPane[]
}

/** A top-level session pane with its nested subagent panes. */
export interface AgentSessionPane extends AgentSessionView {
  subagents: readonly AgentSessionView[]
}

/**
 * Derive the board from the workspace registry and the retained session
 * summaries. Workspaces render in registry order; a workspace lists its
 * registered sessions plus any subagent whose ancestor chain resolves into
 * the workspace (subagents are typically absent from the registry's
 * sessionIds). A subagent nests under its nearest rendered ancestor — the
 * walk up the parent chain stops at the first non-subagent session. A
 * subagent whose chain leaves every known workspace surfaces in a trailing
 * ungrouped section, so a running pane is never invisible.
 * @param workspaces - registry items in display order.
 * @param sessions - summaries by id across all workspaces.
 * @returns one group per workspace that owns at least one session, plus an
 *   `Unattached` section when orphaned subagents exist.
 */
export function buildAgentBoard(
  workspaces: ReadonlyArray<{ workspaceId: string; title: string; sessionIds: readonly string[] }>,
  sessions: Readonly<Record<string, AgentSessionView>>,
): readonly AgentWorkspaceGroup[] {
  const groups: AgentWorkspaceGroup[] = []
  const placed = new Set<string>()
  for (const workspace of workspaces) {
    const own = workspace.sessionIds
      .map(id => sessions[id])
      .filter((session): session is AgentSessionView => session !== undefined)
    if (own.length === 0) continue
    const group: AgentWorkspaceGroup = { workspaceId: workspace.workspaceId, title: workspace.title, sessions: [] }
    groups.push(group)
    // Newest first within the section, matching the sidebar's ordering.
    own.sort((a, b) => b.updatedAt - a.updatedAt)
    const panes = new Map<string, AgentSessionPane>()
    for (const session of own) {
      if (session.origin !== 'subagent') {
        const pane: AgentSessionPane = { ...session, subagents: [] }
        panes.set(session.id, pane)
        placed.add(session.id)
      }
    }
    // Attach every remaining session (subagents the registry lists, plus
    // registry-absent subagents whose ancestor chain reaches this workspace)
    // to its nearest rendered ancestor.
    const pending = new Map<string, AgentSessionView>()
    for (const session of own) {
      if (panes.has(session.id) || placed.has(session.id)) continue
      pending.set(session.id, session)
    }
    const incoming = Object.values(sessions).filter(session => session.origin === 'subagent'
      && !placed.has(session.id) && !pending.has(session.id))
    // An incoming subagent belongs here when walking its parent chain stays
    // inside known sessions and terminates at one of this workspace's panes.
    for (const session of [...pending.values(), ...incoming]) {
      const seen = new Set<string>([session.id])
      let current = session
      while (current.origin === 'subagent' && current.parent !== undefined && !seen.has(current.parent)) {
        seen.add(current.parent)
        const parent = sessions[current.parent]
        if (parent === undefined) break
        const parentPane = panes.get(parent.id)
        if (parentPane !== undefined) {
          parentPane.subagents = [...parentPane.subagents, session]
          placed.add(session.id)
          break
        }
        current = parent
      }
    }
    group.sessions = [...panes.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }
  // Registry-absent subagents that resolved into a group's pane are placed;
  // anything still unplaced (parent outside every known workspace) trails.
  const orphans = Object.values(sessions).filter(session => session.origin === 'subagent' && !placed.has(session.id))
  if (orphans.length > 0) {
    groups.push({
      workspaceId: '',
      title: 'Unattached',
      sessions: orphans
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(session => ({ ...session, subagents: [] })),
    })
  }
  return groups
}

/**
 * Whether a pane is running: the session itself, or any nested subagent.
 * @param pane - the top-level session pane.
 * @returns true when any part of the pane's tree is executing.
 */
export function paneActive(pane: AgentSessionPane): boolean {
  return pane.running || pane.subagents.some(subagent => subagent.running)
}

/** Board pane header states, resolved from the summary facts. */
export type AgentPaneStatus = 'running' | 'pending' | 'done' | 'idle'

/**
 * Resolve a pane's header status: a blocking wait outranks running, a
 * finished-while-away reminder outranks idle.
 * @param pane - the top-level session pane.
 * @returns the pane's status.
 */
export function paneStatus(pane: AgentSessionPane): AgentPaneStatus {
  if (pane.pendingInteraction !== undefined) return 'pending'
  if (paneActive(pane)) return 'running'
  if (pane.completed === true) return 'done'
  return 'idle'
}

/** Seconds-precision label for a running pane's elapsed clock. */
function elapsedLabel(from: number, now: number): string {
  const total = Math.max(0, Math.floor((now - from) / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`
}

/** One workspace section: its header row plus the session panes. */
function WorkspaceSection(props: {
  group: AgentWorkspaceGroup
  currentSessionId: string | undefined
  now: number
  zoomed: string | undefined
  onZoom: (sessionId: string | undefined) => void
  onOpen: (sessionId: string) => void
  onInterrupt: (sessionId: string) => void
  onPrompt: (sessionId: string, text: string, mode: 'queue' | 'steer') => void
  fetchTail: (sessionId: string) => Promise<readonly AgentTailLine[] | undefined>
  /** Tail lines by session id, fetched at the board level. */
  tails: Readonly<Record<string, readonly AgentTailLine[]>>
}) {
  return (
    <>
      <div
        className={css.agentWsHeader}
        data-current-section={props.group.sessions.some(s => s.id === props.currentSessionId) || undefined}
      >
        <span className={css.agentWsTitle}>{props.group.title}</span>
        <span className={css.agentWsCount}>{props.group.sessions.length}</span>
      </div>
      {(props.zoomed === undefined
        ? props.group.sessions
        : props.group.sessions.filter(session => session.id === props.zoomed)
      ).map(session => (
        <SessionPane
          key={session.id}
          pane={session}
          currentSessionId={props.currentSessionId}
          now={props.now}
          zoomed={props.zoomed === session.id}
          onZoom={props.onZoom}
          onOpen={props.onOpen}
          onInterrupt={props.onInterrupt}
          onPrompt={props.onPrompt}
          fetchTail={props.fetchTail}
          tail={props.tails[session.id]}
        />
      ))}
    </>
  )
}

/** One session pane: status header, zoom, stop, subagent chips, updated line. */
function SessionPane(props: {
  pane: AgentSessionPane
  currentSessionId: string | undefined
  now: number
  zoomed: boolean
  onZoom: (sessionId: string | undefined) => void
  onOpen: (sessionId: string) => void
  onInterrupt: (sessionId: string) => void
  onPrompt: (sessionId: string, text: string, mode: 'queue' | 'steer') => void
  /** Fetch this pane's activity tail (undefined = unavailable this round). */
  fetchTail: (sessionId: string) => Promise<readonly AgentTailLine[] | undefined>
  /** This pane's current tail lines (fetched at the board level). */
  tail: readonly AgentTailLine[] | undefined
}) {
  const status = paneStatus(props.pane)
  const runningSubagents = props.pane.subagents.filter(subagent => subagent.running).length
  const active = status === 'running' || status === 'pending'
  // Pane-local composer draft. The pane is a div (it hosts an input), so
  // click-to-open lives on the header only; typing here must not navigate.
  const [draft, setDraft] = useState('')
  const send = (): void => {
    const text = draft.trim()
    if (text.length === 0) return
    props.onPrompt(props.pane.id, text, active ? 'steer' : 'queue')
    setDraft('')
  }
  return (
    <div
      role="button"
      tabIndex={0}
      className={css.agentPane}
      data-status={status}
      data-zoomed={props.zoomed || undefined}
      data-current={props.pane.id === props.currentSessionId || undefined}
      onClick={() => { props.onOpen(props.pane.id) }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return
        props.onOpen(props.pane.id)
      }}
    >
      <span className={css.agentPaneHead}>
        <span className={css.agentStatusDot} aria-label={status} />
        <span className={css.agentPaneTitle}>{props.pane.displayTitle || props.pane.id}</span>
        {props.pane.agentPreset === undefined ? null : <span className={css.agentPanePreset}>{props.pane.agentPreset}</span>}
        <span className={css.agentPaneClock}>
          {status === 'running' ? `Working · ${elapsedLabel(props.pane.updatedAt, props.now)}` : new Date(props.pane.updatedAt).toLocaleTimeString()}
        </span>
        <span
          role="button"
          tabIndex={0}
          className={css.agentPaneAction}
          aria-label={props.zoomed ? 'Unzoom' : 'Zoom'}
          title={props.zoomed ? 'Unzoom (Esc)' : 'Zoom pane'}
          onClick={(event) => {
            event.stopPropagation()
            props.onZoom(props.zoomed ? undefined : props.pane.id)
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.stopPropagation()
            props.onZoom(props.zoomed ? undefined : props.pane.id)
          }}
        >
          {props.zoomed ? '⤡' : '⤢'}
        </span>
      </span>
      {props.pane.subagents.length === 0
        ? null
        : (
          <span className={css.agentPaneSubs}>
            {props.pane.subagents.map(subagent => (
              <span
                key={subagent.id}
                className={css.agentSubChip}
                data-running={subagent.running || undefined}
                title={subagent.displayTitle}
              >
                {subagent.running ? '●' : '○'} {subagent.displayTitle}
              </span>
            ))}
            {runningSubagents > 0 ? <span className={css.agentSubRun}>{`${runningSubagents} running`}</span> : null}
          </span>
        )}
      {(props.tail ?? []).length > 0 && (
        <span className={css.agentPaneTail} data-testid={`tail-${props.pane.id}`}>
          {(props.tail ?? []).map((line, index) => (
            <span key={index} className={css.agentTailLine} data-kind={line.kind} title={line.label}>
              {line.label}
            </span>
          ))}
        </span>
      )}
      <span className={css.agentPaneFoot}>
        {props.pane.pendingInteraction !== undefined ? <span className={css.agentPaneWait}>{props.pane.pendingInteraction}</span> : null}
        {status === 'running' || status === 'pending'
          ? (
            <span
              role="button"
              tabIndex={0}
              className={css.agentPaneStop}
              aria-label="Stop"
              title="Interrupt the active turn"
              onClick={(event) => {
                event.stopPropagation()
                props.onInterrupt(props.pane.id)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.stopPropagation()
                props.onInterrupt(props.pane.id)
              }}
            >
              Stop
            </span>
          )
          : null}
        <span className={css.agentPaneUpdated}>{`updated ${new Date(props.pane.updatedAt).toLocaleTimeString()}`}</span>
      </span>
      <input
        type="text"
        className={css.agentPaneInput}
        value={draft}
        placeholder={active ? 'Steer the running turn…' : 'Ask anything…'}
        aria-label={`Prompt ${props.pane.displayTitle || props.pane.id}`}
        onClick={(event) => { event.stopPropagation() }}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Enter') {
            event.preventDefault()
            send()
          }
        }}
        onChange={(event) => { setDraft(event.target.value) }}
      />
      <span className={css.agentPaneStrip} title={props.pane.cwd ?? undefined}>
        <span className={css.agentPaneStripModel}>{props.pane.agentPreset ?? 'default'}</span>
        {props.pane.cwd === undefined ? null : <span className={css.agentPaneStripCwd}>{`· ${props.pane.cwd}`}</span>}
      </span>
    </div>
  )
}

/**
 * The full agent board: workspace-grouped session panes tiling the frame's
 * tree area. The elapsed clock ticks once per second while anything runs;
 * otherwise the board is static over its snapshot props.
 * @param props - the derived board, the focused session, and the open action.
 * @returns the board element tree.
 */
/** Sort a section's panes by the board preference. */
function sortPanes(panes: readonly AgentSessionPane[], sort: 'recent' | 'status'): AgentSessionPane[] {
  const weight = (pane: AgentSessionPane): number =>
    paneStatus(pane) === 'running' || paneStatus(pane) === 'pending' ? 0 : 1
  return [...panes].sort((a, b) => {
    if (sort === 'status' && weight(a) !== weight(b)) return weight(a) - weight(b)
    return b.updatedAt - a.updatedAt
  })
}

export function AgentGrid(props: {
  groups: readonly AgentWorkspaceGroup[]
  currentSessionId: string | undefined
  onOpen: (sessionId: string) => void
  /** Interrupt one session's active turn (the pane stop control). */
  onInterrupt: (sessionId: string) => void
  /** Pane order within each section. */
  sort: 'recent' | 'status'
  /** Minimum pane width driving the auto-fit column count. */
  paneWidth: number
  /** Viewing-preference writes (persisted with the owning workspace's stash). */
  onPrefsChange: (next: { sort?: 'recent' | 'status'; paneWidth?: number }) => void
  /** Prompt one session by id (the pane composer); steer while running. */
  onPrompt: (sessionId: string, text: string, mode: 'queue' | 'steer') => void
  /** Fetch one pane's activity tail (undefined = unavailable this round). */
  fetchTail: (sessionId: string) => Promise<readonly AgentTailLine[] | undefined>
  /** Real-pty terminal tiles (WM terminal buffers), rendered after sessions. */
  terminals: readonly AgentTerminalTile[]
  /** The terminal.view slot occupant renderer, bound by the frame. */
  renderTerminal: (sessionId: string | undefined) => ReactNode
  /** WM command runner — the tile spawn action opens a new pty. */
  onSpawnTerminal: () => void
}) {
  const [zoomed, setZoomed] = useState<string | undefined>(undefined)
  // Esc leaves zoom (tmux z semantics); the keydown listener is frame-local.
  useEffect(() => {
    if (zoomed === undefined) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setZoomed(undefined)
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [zoomed])
  const anyRunning = props.groups.some(group => group.sessions.some(paneActive))
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!anyRunning) return
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { window.clearInterval(timer) }
  }, [anyRunning])

  // Activity tails: fetch every pane on mount (and as the pane set changes),
  // then refresh on an interval — active panes only, so idle sessions cost
  // nothing after their first read.
  const [tails, setTails] = useState<Record<string, readonly AgentTailLine[]>>({})
  const paneIds = useMemo(
    () => props.groups.flatMap(group => group.sessions.map(session => session.id)),
    [props.groups],
  )
  const activeIds = useMemo(
    () => new Set(props.groups.flatMap(group => group.sessions.filter(paneActive).map(session => session.id))),
    [props.groups],
  )
  const fetchRef = useRef(props.fetchTail)
  fetchRef.current = props.fetchTail
  const idsKey = paneIds.join(',')
  useEffect(() => {
    let cancelled = false
    const ids = idsKey.length === 0 ? [] : idsKey.split(',')
    const pull = (id: string): void => {
      void fetchRef.current(id).then((tail) => {
        if (cancelled || tail === undefined) return
        setTails(current => ({ ...current, [id]: tail }))
      })
    }
    for (const id of ids) pull(id)
    const timer = window.setInterval(() => {
      for (const id of ids) {
        if (activeIds.has(id)) pull(id)
      }
    }, 4000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [idsKey, activeIds])
  const empty = props.groups.every(group => group.sessions.length === 0)
  if (empty) {
    return <div className={css.codeEmpty}><p>No sessions in this workspace yet.</p></div>
  }
  const sorted = props.groups.map(group => ({ ...group, sessions: sortPanes(group.sessions, props.sort) }))
  return (
    <div
      className={css.agentBoard}
      data-agent-board
      data-zoom={zoomed !== undefined || undefined}
      style={{ '--agent-pane-min': `${props.paneWidth}px` } as CSSProperties}
    >
      <div className={css.agentBoardBar}>
        <span className={css.agentBoardBarLabel}>Board</span>
        <span
          role="button"
          tabIndex={0}
          className={css.agentPaneAction}
          aria-label="Toggle sort"
          title={`Sort: ${props.sort === 'recent' ? 'newest first' : 'active first'}`}
          onClick={() => { props.onPrefsChange({ sort: props.sort === 'recent' ? 'status' : 'recent' }) }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            props.onPrefsChange({ sort: props.sort === 'recent' ? 'status' : 'recent' })
          }}
        >
          {props.sort === 'recent' ? '↕ newest' : '↕ active'}
        </span>
        <span
          role="button"
          tabIndex={0}
          className={css.agentPaneAction}
          aria-label="New terminal"
          title="Spawn a real-pty terminal tile"
          onClick={() => { props.onSpawnTerminal() }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            props.onSpawnTerminal()
          }}
        >
          + terminal
        </span>
        <span
          role="button"
          tabIndex={0}
          className={css.agentPaneAction}
          aria-label="Pane width"
          title={props.paneWidth <= 340 ? 'Wider panes' : 'Narrower panes'}
          onClick={() => { props.onPrefsChange({ paneWidth: props.paneWidth <= 340 ? 480 : 340 }) }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            props.onPrefsChange({ paneWidth: props.paneWidth <= 340 ? 480 : 340 })
          }}
        >
          {props.paneWidth <= 340 ? '⊞ wide' : '⊞ compact'}
        </span>
      </div>
      {sorted.map(group => (
        <section key={group.workspaceId} className={css.agentWs}>
          <WorkspaceSection
            group={group}
            currentSessionId={props.currentSessionId}
            now={now}
            zoomed={zoomed}
            onZoom={setZoomed}
            onOpen={props.onOpen}
            onInterrupt={props.onInterrupt}
            onPrompt={props.onPrompt}
            fetchTail={props.fetchTail}
            tails={tails}
          />
        </section>
      ))}
      {props.terminals.length > 0 && zoomed === undefined && (
        <section className={css.agentWs}>
          <div className={css.agentWsHeader}>
            <span className={css.agentWsTitle}>Terminals</span>
            <span className={css.agentWsCount}>{props.terminals.length}</span>
          </div>
          {props.terminals.map(tile => (
            <section key={tile.id} className={css.agentTerminalTile} data-terminal-tile>
              <div className={css.agentPaneHead}>
                <span className={css.agentStatusDot} data-kind="terminal" />
                <span className={css.agentPaneTitle}>{tile.title}</span>
              </div>
              <div className={css.agentTerminalBody}>{props.renderTerminal(tile.sessionId)}</div>
            </section>
          ))}
        </section>
      )}
    </div>
  )
}
