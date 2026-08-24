// @vitest-environment jsdom
/**
 * Todo tree acceptance: the c0ntext execution-tree body (nested three-level
 * rows, per-status counts including several `in_progress` at once, quiet empty
 * state) and its seat component reading the host-computed 'todos' projection.
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { TodoItem } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { TodoTreeProps } from '../src/client/skeleton/TodoTree.tsx'
import { TodoTree, TodoTreeBody, todoTreeEntry } from '../src/client/skeleton/TodoTree.tsx'
import { NS, zh } from '../src/client/locales.ts'

// Mirrors the real lookup chain (conversation namespace, then common).
const t: TodoTreeProps['t'] = makeTranslate(zh, commonZh)

afterEach(cleanup)

const LIST: TodoItem[] = [
  { content: '搭骨架', status: 'completed' },
  { content: '写组件', status: 'in_progress' },
  { content: '补测试', status: 'pending' },
]

/** A parallel plan: three tasks running at once (concurrent subagents). */
const PARALLEL: TodoItem[] = [
  { content: '搭骨架', status: 'completed' },
  { content: '写组件', status: 'in_progress' },
  { content: '跑后台构建', status: 'in_progress' },
  { content: '读源码', status: 'in_progress' },
  { content: '补测试', status: 'pending' },
]

describe('TodoTreeBody', () => {
  it('renders the quiet empty state while the tree is empty', () => {
    render(<TodoTreeBody todos={[]} t={t} />)
    expect(screen.getByTestId('todo-tree-empty')).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('shows the per-status count summary over the whole tree', () => {
    render(<TodoTreeBody todos={LIST} t={t} />)
    expect(screen.getByTestId('todo-tree')).toBeTruthy()
    expect(screen.getByText('任务')).toBeTruthy()
    expect(screen.getByText('1 已完成 · 1 进行中 · 1 待处理')).toBeTruthy()
    // The tree renders expanded — there is no collapse state to hide progress.
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
  })

  it('omits the completed segment while nothing is done yet', () => {
    render(<TodoTreeBody todos={[
      { content: '写组件', status: 'in_progress' },
      { content: '补测试', status: 'pending' },
    ]} t={t} />)
    expect(screen.getByText('1 进行中 · 1 待处理')).toBeTruthy()
    expect(screen.queryByText(/已完成/)).toBeNull()
  })

  it('shows one row per node with its status glyph', () => {
    render(<TodoTreeBody todos={LIST} t={t} />)
    const items = screen.getAllByRole('listitem')
    expect(items.map(li => li.getAttribute('data-status'))).toEqual(['completed', 'in_progress', 'pending'])
    expect(screen.getByText('搭骨架')).toBeTruthy()
    expect(screen.getByText('写组件')).toBeTruthy()
    // Each status row carries an SVG glyph (not a text bullet).
    expect(items.every(li => li.querySelector('svg') !== null)).toBe(true)
  })

  it('marks every parallel active node, and counts them all in the header', () => {
    render(<TodoTreeBody todos={PARALLEL} t={t} />)
    // An unconditional in-progress cap would make this tree unreachable: three
    // nodes carry the in-progress glyph at once, and the header counts all three.
    const statuses = screen.getAllByRole('listitem').map(li => li.getAttribute('data-status'))
    expect(statuses.filter(s => s === 'in_progress')).toHaveLength(3)
    expect(screen.getByText('跑后台构建')).toBeTruthy()
    expect(screen.getByText('读源码')).toBeTruthy()
    expect(screen.getByText('1 已完成 · 3 进行中 · 1 待处理')).toBeTruthy()
  })

  it('renders a nested three-level tree with a cancelled leaf struck through', () => {
    const TREE: TodoItem[] = [
      {
        content: '交付功能',
        status: 'in_progress',
        children: [
          {
            content: '实现',
            status: 'completed',
            children: [{ content: '核心逻辑', status: 'completed' }],
          },
          { content: '旧方案', status: 'cancelled' },
        ],
      },
    ]
    render(<TodoTreeBody todos={TREE} t={t} />)
    // All four nodes across the three levels are present; each row's text
    // includes its own subtree (the li wraps the nested branch).
    expect(screen.getAllByRole('listitem').map(li => li.textContent))
      .toEqual(['交付功能实现核心逻辑旧方案', '实现核心逻辑', '核心逻辑', '旧方案'])
    // Cancelled nodes keep their row but carry the retired styling hook.
    expect(screen.getByText('旧方案').closest('[data-status]')?.getAttribute('data-status')).toBe('cancelled')
    // Header counts span the whole tree; the cancelled node counts separately.
    expect(screen.getByText('2 已完成 · 1 进行中 · 1 已取消')).toBeTruthy()
  })

  it('an all-completed tree collapses the summary to the done count alone', () => {
    render(<TodoTreeBody todos={[{ content: '都完了', status: 'completed' }]} t={t} />)
    expect(screen.getByText('都完了')).toBeTruthy()
    expect(screen.getByText('1 已完成')).toBeTruthy()
    expect(screen.queryByText(/进行中|待处理/)).toBeNull()
  })
})

/** Seat props stub: the seat reads the 'todos' projection only; the rest of the share is unused. */
function seatProps(store: ReturnType<typeof createSnapshotStore<{ value: readonly TodoItem[] | null | undefined }>>): TodoTreeProps {
  const useProjection = (_key: string, selector?: (v: unknown) => unknown) =>
    bindSnapshotSelector(store)(s => (selector ?? (v => v))(s.value))
  return { useProjection, t } as unknown as TodoTreeProps
}

describe('TodoTree seat', () => {
  it('reads the host-computed todos projection and follows pushed updates', () => {
    const store = createSnapshotStore<{ value: readonly TodoItem[] | null | undefined }>({ value: undefined })
    render(<TodoTree {...seatProps(store)} />)
    // Capability absent (no baseline/frame yet) renders the quiet empty state,
    // not a blank panel: the c0ntext seat stays meaningful between plans.
    expect(screen.getByTestId('todo-tree-empty')).toBeTruthy()
    act(() => { store.set({ value: LIST }) })
    expect(screen.getByText('1 已完成 · 1 进行中 · 1 待处理')).toBeTruthy()
    // The pre-first-write whole value (null) returns to the empty state.
    act(() => { store.set({ value: null }) })
    expect(screen.getByTestId('todo-tree-empty')).toBeTruthy()
  })

  it('registers into the details panel context seat', () => {
    expect(todoTreeEntry.name).toBe('conversation-todo-tree')
    expect(todoTreeEntry.inject).toEqual(['slots'])
    const register = vi.fn(() => () => undefined)
    const inject = vi.fn((_name: string, callback: () => () => void) => callback())
    todoTreeEntry.apply({ slots: { inject, register } } as never)
    expect(inject).toHaveBeenCalledWith('conversation.details.context', expect.any(Function))
    expect(register).toHaveBeenCalledWith({ name: 'conversation.details.context', id: 'todo-tree', order: 0, locale: NS }, TodoTree)
  })
})
