/**
 * Vanilla-DOM renderers over derived board runs: the health strip, one run
 * card, and the three-column triage board. Pure functions of their inputs;
 * the React views mount their output.
 */
import { HEALTH_COLOR, NEEDS_YOU, STATE_COLOR, type PlanRow, type Run, type RunAction } from './contract.ts'

/** Health pill input: engine name → health vocabulary (absent engines omitted). */
export type HealthMap = Record<string, 'up' | 'degraded' | 'down' | undefined>

/** Callback the board invokes when the user acts on a run. */
export type ActFn = (sessionId: string, action: RunAction) => void

/** Creates one DOM element; `on*` attribute keys become event listeners. */
function h(
  tag: string,
  attrs: Record<string, string | ((event: Event) => void) | undefined> = {},
  ...kids: Array<Node | string | null | undefined>
): HTMLElement {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v as (event: Event) => void)
    else if (k === 'style') el.style.cssText = v as string
    else (el as unknown as Record<string, unknown>)[k] = v
  }
  el.append(...kids.filter(k => k !== null && k !== undefined))
  return el
}

/**
 * Global chrome: engine-health pills plus the triage counters.
 * @param health - Engine name → health (falsy entries skip their pill).
 * @param counters - Needs-you / running / failed counts.
 * @returns The strip element.
 */
export function healthStrip(health: HealthMap = {}, counters: { needsYou?: number; running?: number; failed?: number } = {}): HTMLElement {
  const strip = h('div', { style: 'display:flex;gap:6px;align-items:center;padding:6px 10px;border-bottom:1px solid #374151' })
  for (const [key, v] of Object.entries(health)) {
    if (!v) continue
    strip.append(h('span', { title: `${key}: ${v}`, style: `width:10px;height:10px;border-radius:9999px;background:${HEALTH_COLOR[v]}` }))
  }
  strip.append(h('span', {
    style: 'margin-left:auto;font-size:11px;color:#9ca3af',
    textContent: `Needs you ${counters.needsYou ?? 0} · Running ${counters.running ?? 0} · Failed ${counters.failed ?? 0}`,
  }))
  return strip
}

/** Glyph per plan-row status, mirroring the conversation todo tree's vocabulary. */
const PLAN_GLYPH: Record<PlanRow['status'], string> = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
  cancelled: '×',
}

/**
 * Collapsible mission-plan section: the session's todo tree, flattened, with a
 * done/total count in the summary line.
 * @param plan - Flattened plan rows in depth-first order.
 * @returns The details element.
 */
function planSection(plan: readonly PlanRow[]): HTMLElement {
  const doneCount = plan.filter(row => row.status === 'completed').length
  const details = h('details', { style: 'margin-top:6px' })
  details.append(h('summary', {
    style: 'font-size:10px;color:#9ca3af;cursor:pointer',
    textContent: `Plan ${doneCount}/${plan.length}`,
  }))
  for (const row of plan) {
    details.append(h('div', {
      style: `font-size:10px;color:${row.status === 'completed' ? '#6b7280' : '#d1d5db'}${row.status === 'in_progress' ? ';font-weight:600' : ''}`,
      textContent: `${PLAN_GLYPH[row.status]} ${row.content}`,
    }))
  }
  return details
}

/**
 * Create one run card with its state, optional plan, errors, and recursively nested children.
 * @param run - Derived run data rendered without changing it.
 * @param onAct - Callback invoked with this run's id when cancellation is selected on an active card.
 * @param depth - Child nesting depth controlling indentation; defaults to zero.
 * @returns Detached DOM card; the caller owns insertion and removal.
 */
export function runCard(run: Run, onAct: ActFn, depth = 0): HTMLElement {
  const card = h('div', {
    style: `border:1px solid ${STATE_COLOR[run.state]}44;border-radius:8px;padding:8px;margin:8px 0;background:#111827${depth ? `;margin-left:${16 * depth}px` : ''}`,
  })
  card.append(h('div', { style: 'display:flex;gap:6px;align-items:baseline' },
    h('strong', { textContent: run.title }),
    h('span', { style: 'font-size:10px;color:#9ca3af', textContent: `${run.role} · ${run.tier} · ${run.mode}` })))
  card.append(h('div', { style: `font-size:11px;color:${STATE_COLOR[run.state]}`, textContent: run.state }))
  if (run.state === 'running' || run.state === 'blocked') {
    const row = h('div', { style: 'display:flex;gap:6px;margin-top:6px' })
    for (const a of ['kill'] as const) {
      row.append(h('button', { textContent: a, onclick: () =>{  onAct(run.id, a) } }))
    }
    card.append(row)
  }
  if (run.state === 'stalemate') {
    card.append(h('div', { style: 'font-size:11px;color:#a855f7', textContent: 'escalate: human breaks tie' }))
  }
  if (run.plan !== undefined && run.plan.length > 0) {
    card.append(planSection(run.plan))
  }
  for (const e of run.errors) {
    card.append(h('div', { style: 'font-size:10px;color:#ef4444', textContent: `${e.sig} ×${e.count} (${e.lastSeen})` }))
  }
  for (const c of run.children) card.append(runCard(c, onAct, depth + 1))
  return card
}

/**
 * Triage board: NEEDS YOU | RUNNING | DONE columns.
 * @param runs - Root runs to triage (children render inside their card).
 * @param onAct - Action callback forwarded to every card.
 * @returns The board element.
 */
export function triageBoard(runs: readonly Run[], onAct: ActFn): HTMLElement {
  const cols: Array<[string, (r: Run) => boolean]> = [
    ['NEEDS YOU', r => NEEDS_YOU.includes(r.state)],
    ['RUNNING', r => r.state === 'running' || r.state === 'queued'],
    ['DONE', r => r.state === 'done'],
  ]
  const board = h('div', { style: 'flex:1;display:flex;gap:12px;padding:12px;overflow:hidden' })
  for (const [title, pred] of cols) {
    const col = h('div', { style: 'flex:1;overflow-y:auto' },
      h('div', { style: 'font-size:11px;color:#9ca3af;margin-bottom:8px', textContent: title }))
    for (const r of runs.filter(pred)) col.append(runCard(r, onAct))
    board.append(col)
  }
  return board
}
