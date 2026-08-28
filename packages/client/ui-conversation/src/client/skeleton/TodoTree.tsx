// TodoTree: the execution-tree seat in the sidebar's memory area (the single
// place session task state renders, replacing the former details-panel context
// entry). Renders the standing todo/write whole-tree snapshot — nodes nest up
// to three levels (task → child → grandchild) with indentation; cancelled
// nodes stay visible but struck through. Flat root items that share a
// "Prefix: " head (two or more) group under one synthetic collapsible branch
// so model-authored flat lists still read as a tree. No data of its own: the
// current session's `todos` projection (published reference-stable through the
// session list summary) feeds it, and an empty tree renders the quiet
// empty-state line so the sidebar region stays meaningful between plans.
// Branch collapse state lives in the entry-declared store (the seat unmounts
// on sidebar collapse, so component state would not survive those remounts).
// Mounted through the 'sidebar.memory' slot (list posture, root scope) via its
// inject wrapper; the collapsed rail shrinks to one expand affordance.

import type { Context } from '@deepseek-ai/cordis'
import { useId } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
// Pulls ui-sidebar's SlotMap merge (the 'sidebar.memory' entry) into this
// program so PropsRuntime<'sidebar.memory'> resolves; type-only by design.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// The domain's client-namespace pure-type outlet: one import edge delivers
// the `todos` projection-key merge (single source, no consumer-side restated
// declare) and the payload type. Type-only by construction — the outlet is
// free of host value imports, so no host Context merge enters this program.
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'
import type { GoalProjection } from '@deepseek-ai/dsh-goal/client'
import { IconChecklistOutline14, IconTriangleRightFill14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { createTodoTreeStore } from '../stores.ts'
import { NS } from '../locales.ts'
import css from './TodoTree.module.css'

/** Full props of the sidebar seat: sidebar owner share + store + locale. */
export type TodoTreeProps = PropsRuntime<'sidebar.memory'>
  & PropsStore<ReturnType<typeof createTodoTreeStore>>
  & PropsLocale<'conversation'>

/** Local exhaustiveness helper — client packages do not depend on `dsh-llm`. */
/* v8 ignore next 3 -- closed-union backstop; only reached if status is forged */
function assertNever(value: never): never {
  throw new Error(`unreachable todo status: ${String(value)}`)
}

/** Every node of the tree in depth-first order — one walk drives header counts. */
function flat(nodes: readonly TodoItem[]): readonly TodoItem[] {
  return nodes.flatMap(node => [node, ...flat(node.children ?? [])])
}

/** Root heads eligible for grouping: short "Prefix: " heads only ("Feature A: …"). */
const GROUP_HEAD = /^(.{1,48}?):\s+(.+)$/

/**
 * Branch rollup: any active child keeps the branch spinning; a fully settled
 * branch reads done (cancelled when nothing completed); work still owed reads
 * pending.
 * @param statuses - the children's own statuses.
 * @returns the synthetic branch status.
 */
function rollupStatus(statuses: readonly TodoItem['status'][]): TodoItem['status'] {
  if (statuses.includes('in_progress')) return 'in_progress'
  if (statuses.every(status => status === 'completed' || status === 'cancelled')) {
    return statuses.includes('completed') ? 'completed' : 'cancelled'
  }
  return 'pending'
}

/**
 * Groups flat root items that share a "Prefix: " head under one synthetic
 * branch node — "Feature A: x" and "Feature A: y" become branch "Feature A"
 * with the heads stripped from the leaves. Deliberately-nested nodes
 * (children present) and prefixes hit only once pass through untouched, and
 * grouping applies at the root level only. Original order is preserved: a
 * branch sits where its first member sat.
 * @param todos - the standing whole-tree snapshot (root level is grouped).
 * @returns the display forest.
 */
export function groupTodos(todos: readonly TodoItem[]): readonly TodoItem[] {
  interface Pending { at: number; stripped: TodoItem[]; original: TodoItem }
  const forest: TodoItem[] = []
  const pending = new Map<string, Pending>()
  for (const node of todos) {
    if ((node.children?.length ?? 0) > 0) { forest.push(node); continue }
    const head = GROUP_HEAD.exec(node.content)
    if (head === null) { forest.push(node); continue }
    const key = head[1]
    const rest = head[2]
    if (key === undefined || rest === undefined) { forest.push(node); continue }
    let entry = pending.get(key)
    if (entry === undefined) {
      entry = { at: forest.length, stripped: [], original: node }
      pending.set(key, entry)
      // Placeholder keeps the branch at its first member's position.
      forest.push({ content: key, status: 'pending', children: [] })
    }
    entry.stripped.push({ ...node, content: rest })
  }
  for (const [title, entry] of pending) {
    if (entry.stripped.length < 2) {
      forest[entry.at] = entry.original
      continue
    }
    forest[entry.at] = {
      content: title,
      status: rollupStatus(entry.stripped.map(item => item.status)),
      children: [...entry.stripped],
    }
  }
  return forest
}

/** Status glyphs share the figma 14×14 artboard; the 16×16 `.glyph` cell centers them. */
function CompletedGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true" className={css.glyphCompleted}>
      <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M10.9631 5.71411L7.70154 8.97571C7.48011 9.19714 7.27736 9.40099 7.09229 9.54993C6.89742 9.70669 6.66314 9.85279 6.3634 9.90027C6.2049 9.92534 6.04339 9.92534 5.88489 9.90027C5.58515 9.85279 5.35087 9.70669 5.15601 9.54993C4.97093 9.40099 4.76818 9.19714 4.54675 8.97571L3.03516 7.46411L3.96313 6.53613L5.47473 8.04773C5.7169 8.28989 5.86196 8.43389 5.97888 8.52795C6.08597 8.61409 6.10875 8.60701 6.08997 8.604C6.11259 8.60758 6.13571 8.60758 6.15833 8.604C6.13954 8.60701 6.16232 8.61409 6.26941 8.52795C6.38633 8.43389 6.53139 8.28989 6.77356 8.04773L10.0352 4.78613L10.9631 5.71411Z"
        fill="currentColor"
      />
    </svg>
  )
}

/** In-progress: business-blue ring fading out; CSS spins the svg. */
function ProgressGlyph() {
  const gradientId = useId()
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true" className={css.glyphProgress}>
      <defs>
        <linearGradient id={gradientId} x1="2.5" y1="12" x2="10.5" y2="3.5" gradientUnits="userSpaceOnUse">
          <stop stopColor="currentColor" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <circle cx="7" cy="7" r="6.4" stroke={`url(#${gradientId})`} strokeWidth="1.2" />
    </svg>
  )
}

/** Pending: dashed unstarted ring (figma dash 2.4 2.4). */
function PendingGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true" className={css.glyphPending}>
      <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2.4 2.4" />
    </svg>
  )
}

/** Cancelled: caption-grey ring struck through — retired, not unfinished. */
function CancelledGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true" className={css.glyphCancelled}>
      <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4.5 9.5L9.5 4.5M9.5 9.5L4.5 4.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function StatusGlyph({ status }: { status: TodoItem['status'] }) {
  switch (status) {
    case 'completed': return <CompletedGlyph />
    case 'in_progress': return <ProgressGlyph />
    case 'pending': return <PendingGlyph />
    case 'cancelled': return <CancelledGlyph />
    /* v8 ignore next -- closed TodoItem status union */
    default: return assertNever(status)
  }
}

/** Header summary: "·"-joined per-status counts over the whole tree.
 * Zero-count segments are omitted as noise (a non-empty tree keeps at least one). */
export function progressLabel(todos: readonly TodoItem[], t: TodoTreeProps['t']): string {
  const nodes = flat(todos)
  const done = nodes.filter(item => item.status === 'completed').length
  const active = nodes.filter(item => item.status === 'in_progress').length
  const cancelled = nodes.filter(item => item.status === 'cancelled').length
  const pending = nodes.length - done - active - cancelled
  // En spaces (U+2002): HTML collapses runs of ASCII spaces, so widening the
  // separator breathing room needs a literal wide space.
  return [
    ...done > 0 ? [t('todo.progress.done', { done })] : [],
    ...active > 0 ? [t('todo.progress.active', { active })] : [],
    ...pending > 0 ? [t('todo.progress.pending', { pending })] : [],
    ...cancelled > 0 ? [t('todo.progress.cancelled', { cancelled })] : [],
  ].join('\u2002·\u2002')
}

/**
 * One nesting level of the tree; children indent under their parent. Branch
 * rows (nodes with children) toggle their subtree; the chevron cell mirrors
 * the 16px glyph column so nested rows align under their branch's glyph.
 */
function TodoNodes({ nodes, depth, collapsed, onToggle }: {
  nodes: readonly TodoItem[]
  depth: number
  collapsed: readonly string[]
  onToggle: (id: string) => void
}) {
  return (
    <ul className={depth === 0 ? css.list : css.nest} data-depth={depth}>
      {nodes.map((node, index) => {
        const children = node.children ?? []
        const branch = children.length > 0
        const open = branch && !collapsed.includes(node.content)
        return (
          <li key={`${depth}:${index}:${node.content}`} data-status={node.status}>
            {branch ? (
              <button
                type="button"
                className={css.row}
                aria-expanded={open}
                title={node.content}
                onClick={() => { onToggle(node.content) }}
              >
                <span className={css.disclose} aria-hidden>
                  <IconTriangleRightFill14 size={10} className={open ? css.chevronOpen : css.chevron} />
                </span>
                <span className={css.glyph} aria-hidden><StatusGlyph status={node.status} /></span>
                <span className={css.content}>{node.content}</span>
              </button>
            ) : (
              <div className={css.item} title={node.content}>
                <span className={css.glyph} aria-hidden><StatusGlyph status={node.status} /></span>
                <span className={css.content}>{node.content}</span>
              </div>
            )}
            {branch && open && (
              <div className={css.branch}>
                <TodoNodes nodes={children} depth={depth + 1} collapsed={collapsed} onToggle={onToggle} />
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Presentational tree body — also the test seam: plain data in, DOM out.
 * @param todos - the whole tree from the projection.
 * @param t - locale seat.
 * @param compact - omit the count header (a surrounding panel owns its title).
 * @param goal - the session's current goal, rendered as the card's leading
 *   section; absent or cleared goals render nothing.
 * @param collapsed - branch titles whose subtrees stay hidden.
 * @param onToggle - collapse toggle for a branch title.
 */
export function TodoTreeBody({ todos, t, compact = false, goal, collapsed = [], onToggle = () => {} }: {
  todos: readonly TodoItem[]
  t: TodoTreeProps['t']
  compact?: boolean
  goal?: GoalProjection | null | undefined
  collapsed?: readonly string[]
  onToggle?: (id: string) => void
}) {
  return (
    <section className={css.root} data-testid="todo-tree">
      {!compact && (
        <div className={css.header}>
          <span className={css.lead} aria-hidden><IconChecklistOutline14 /></span>
          <span className={css.title}>{t('todo.title')}</span>
          <span className={css.progress}>{progressLabel(todos, t)}</span>
        </div>
      )}
      {goal != null && (
        <div className={css.goal} data-phase={goal.goal.phase} data-testid="todo-goal">
          <div className={css.goalHead}>
            <strong>{t('todo.goal.title')}</strong>
            <span className={css.goalMeta}>
              <em data-phase>{goal.goal.phase}</em>
              <small>{t('todo.goal.round', { started: goal.roundsStarted, max: goal.goal.maxGoalRounds ?? 0 })}</small>
            </span>
          </div>
          <p className={css.goalObjective}>{goal.goal.objective}</p>
        </div>
      )}
      {todos.length === 0
        ? <div className={css.empty} data-testid="todo-tree-empty">{t('todo.empty')}</div>
        : <TodoNodes nodes={groupTodos(todos)} depth={0} collapsed={collapsed} onToggle={onToggle} />}
    </section>
  )
}

/**
 * Seat component: reads the current session's `todos` projection through the
 * session list summary (no session or pre-first-write null renders the quiet
 * empty state); branch collapse rides the entry-declared store; the collapsed
 * rail renders one expand affordance instead.
 */
export function TodoTree({ wide, expandSidebar, useSessions, useStore, actions, t }: TodoTreeProps) {
  const todos = useSessions(list =>
    list.current === undefined ? undefined : list.byId[list.current]?.projectionValues?.todos)
  const goal = useSessions(list =>
    list.current === undefined ? undefined : list.byId[list.current]?.projectionValues?.goal)
  const collapsed = useStore(state => state.collapsed)
  if (!wide) {
    return (
      <button
        type="button"
        className={css.railButton}
        aria-label={t('todo.railExpand')}
        onClick={() => { expandSidebar() }}
      >
        <IconChecklistOutline14 />
      </button>
    )
  }
  return <TodoTreeBody todos={todos ?? []} t={t} goal={goal} collapsed={collapsed} onToggle={id => actions.toggle(id)} />
}

/**
 * The execution tree as a plain registrant plugin (list posture), following
 * the atomic slot declaration across independent activation and reload.
 */
export const todoTreeEntry = {
  name: 'conversation-todo-tree',
  inject: ['slots'],
  /**
   * Register the tree into the sidebar's memory area — the execution-tree
   * seat — above any later-stacked memory registrants. The collapse store is
   * created at apply time so its identity follows this fiber.
   * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
   */
  apply(ctx: Context): void {
    const store = createTodoTreeStore()
    ctx.slots.inject('sidebar.memory', () =>
      ctx.slots.register({ name: 'sidebar.memory', id: 'todo-tree', order: 0, locale: NS, store }, TodoTree))
  },
}
