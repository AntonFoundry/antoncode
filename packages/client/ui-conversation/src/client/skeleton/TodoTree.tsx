// TodoTree: the c0ntext execution-tree seat in the details panel (the single
// place session task state renders, replacing the former composer plan strip).
// Renders the standing todo/write whole-tree snapshot — nodes nest up to three
// levels (task → child → grandchild) with indentation; cancelled nodes stay
// visible but struck through. No data of its own: the host-computed 'todos'
// projection feeds it, and an empty tree renders the quiet empty-state line so
// the c0ntext panel stays meaningful between plans. Mounted through the
// 'conversation.details.context' slot (list posture) via its inject wrapper.

import type { Context } from '@deepseek-ai/cordis'
import { useId } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// The domain's client-namespace pure-type outlet: one import edge delivers
// the `todos` projection-key merge (single source, no consumer-side restated
// declare) and the payload type. Type-only by construction — the outlet is
// free of host value imports, so no host Context merge enters this program.
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'
import { IconChecklistOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from '../locales.ts'
import css from './TodoTree.module.css'

/** Full props of a context-seat entry: session standard kit + the locale seat. */
export type TodoTreeProps = PropsRuntime<'conversation.details.context'> & PropsLocale<'conversation'>

/** Local exhaustiveness helper — client packages do not depend on `dsh-llm`. */
/* v8 ignore next 3 -- closed-union backstop; only reached if status is forged */
function assertNever(value: never): never {
  throw new Error(`unreachable todo status: ${String(value)}`)
}

/** Every node of the tree in depth-first order — one walk drives header counts. */
function flat(nodes: readonly TodoItem[]): readonly TodoItem[] {
  return nodes.flatMap(node => [node, ...flat(node.children ?? [])])
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

/** Header summary: "·"-joined per-status counts over the whole tree; zero-count segments are omitted as noise (a non-empty tree keeps at least one). */
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

/** One nesting level of the tree; children indent under their parent. */
function TodoNodes({ nodes, depth }: { nodes: readonly TodoItem[]; depth: number }) {
  return (
    <ul className={depth === 0 ? css.list : css.nest} data-depth={depth}>
      {nodes.map(node => (
        <li key={node.content} data-status={node.status}>
          <div className={css.item}>
            <span className={css.glyph} aria-hidden><StatusGlyph status={node.status} /></span>
            <span className={css.content}>{node.content}</span>
          </div>
          {(node.children?.length ?? 0) > 0 && (
            <div className={css.branch}>
              <TodoNodes nodes={node.children!} depth={depth + 1} />
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

/**
 * Presentational tree body — also the test seam: plain data in, DOM out.
 * @param todos - the whole tree from the projection.
 * @param t - locale seat.
 * @param compact - omit the count header (the details panel owns its title).
 */
export function TodoTreeBody({ todos, t, compact = false }: {
  todos: readonly TodoItem[]
  t: TodoTreeProps['t']
  compact?: boolean
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
      {todos.length === 0
        ? <div className={css.empty} data-testid="todo-tree-empty">{t('todo.empty')}</div>
        : <TodoNodes nodes={todos} depth={0} />}
    </section>
  )
}

/** Seat component: reads the host-computed 'todos' projection (absent or null renders the empty state). */
export function TodoTree({ useProjection, t }: TodoTreeProps) {
  const todos = useProjection('todos')
  return <TodoTreeBody todos={todos ?? []} t={t} />
}

/**
 * The execution tree as a plain registrant plugin (list posture), following
 * the atomic slot declaration across independent activation and reload.
 */
export const todoTreeEntry = {
  name: 'conversation-todo-tree',
  inject: ['slots'],
  /**
   * Register the tree into the details panel's context seat.
   * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
   */
  apply(ctx: Context): void {
    ctx.slots.inject('conversation.details.context', () =>
      ctx.slots.register({ name: 'conversation.details.context', id: 'todo-tree', order: 0, locale: NS }, TodoTree))
  },
}
