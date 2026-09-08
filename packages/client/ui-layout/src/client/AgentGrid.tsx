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
import { useEffect, useState } from 'react'
import css from './WmFrame.module.css'

/** The one session summary fact the board needs, per pane. */
export interface AgentSessionView {
  id: string
  displayTitle: string
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
  onOpen: (sessionId: string) => void
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
      {props.group.sessions.map(session => (
        <SessionPane key={session.id} pane={session} currentSessionId={props.currentSessionId} now={props.now} onOpen={props.onOpen} />
      ))}
    </>
  )
}

/** One session pane: status header, subagent chips, updated line. */
function SessionPane(props: {
  pane: AgentSessionPane
  currentSessionId: string | undefined
  now: number
  onOpen: (sessionId: string) => void
}) {
  const status = paneStatus(props.pane)
  const runningSubagents = props.pane.subagents.filter(subagent => subagent.running).length
  return (
    <button
      type="button"
      className={css.agentPane}
      data-status={status}
      data-current={props.pane.id === props.currentSessionId || undefined}
      onClick={() => { props.onOpen(props.pane.id) }}
    >
      <span className={css.agentPaneHead}>
        <span className={css.agentStatusDot} aria-label={status} />
        <span className={css.agentPaneTitle}>{props.pane.displayTitle || props.pane.id}</span>
        {props.pane.agentPreset === undefined ? null : <span className={css.agentPanePreset}>{props.pane.agentPreset}</span>}
        <span className={css.agentPaneClock}>
          {status === 'running' ? elapsedLabel(props.pane.updatedAt, props.now) : new Date(props.pane.updatedAt).toLocaleTimeString()}
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
      <span className={css.agentPaneFoot}>
        {props.pane.pendingInteraction !== undefined ? <span className={css.agentPaneWait}>{props.pane.pendingInteraction}</span> : null}
        <span className={css.agentPaneUpdated}>{`updated ${new Date(props.pane.updatedAt).toLocaleTimeString()}`}</span>
      </span>
    </button>
  )
}

/**
 * The full agent board: workspace-grouped session panes tiling the frame's
 * tree area. The elapsed clock ticks once per second while anything runs;
 * otherwise the board is static over its snapshot props.
 * @param props - the derived board, the focused session, and the open action.
 * @returns the board element tree.
 */
export function AgentGrid(props: {
  groups: readonly AgentWorkspaceGroup[]
  currentSessionId: string | undefined
  onOpen: (sessionId: string) => void
}) {
  const anyRunning = props.groups.some(group => group.sessions.some(paneActive))
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!anyRunning) return
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { window.clearInterval(timer) }
  }, [anyRunning])
  const empty = props.groups.every(group => group.sessions.length === 0)
  if (empty) {
    return <div className={css.codeEmpty}><p>No sessions in this workspace yet.</p></div>
  }
  return (
    <div className={css.agentBoard} data-agent-board>
      {props.groups.map(group => (
        <WorkspaceSection key={group.workspaceId} group={group} currentSessionId={props.currentSessionId} now={now} onOpen={props.onOpen} />
      ))}
    </div>
  )
}
