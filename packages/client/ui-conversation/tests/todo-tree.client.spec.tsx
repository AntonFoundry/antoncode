// @vitest-environment jsdom
/**
 * Todo tree acceptance: the sidebar execution-tree body (nested three-level
 * rows, per-status counts including several `in_progress` at once, quiet empty
 * state) and its seat component reading the current session's `todos`
 * projection through the session list summary, plus the collapsed-rail form.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { TodoItem } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { TodoTreeProps } from '../src/client/skeleton/TodoTree.tsx'
import { TodoTree, TodoTreeBody, todoTreeEntry } from '../src/client/skeleton/TodoTree.tsx'
import { NS, zh } from '../src/client/locales.ts'
import { createTodoTreeStore } from '../src/client/stores.ts'

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
    expect(screen.getByText('待办树')).toBeTruthy()
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

  it('renders the session goal as the leading card when one is active', () => {
    render(<TodoTreeBody todos={LIST} t={t} goal={{
      goal: { objective: '交付 v0', phase: 'active', maxGoalRounds: 10 },
      roundsStarted: 2,
      createdAt: 0,
      updatedAt: 0,
    }} />)
    const goalCard = screen.getByTestId('todo-goal')
    expect(goalCard.getAttribute('data-phase')).toBe('active')
    expect(screen.getByText('目标')).toBeTruthy()
    expect(screen.getByText('交付 v0')).toBeTruthy()
    expect(screen.getByText('第 2/10 轮')).toBeTruthy()
  })

  it('renders no goal card while the goal is absent', () => {
    render(<TodoTreeBody todos={LIST} t={t} goal={null} />)
    expect(screen.queryByTestId('todo-goal')).toBeNull()
  })
})

/** Session-list state slice the seat reads: current id + per-session summaries. */
interface SessionsStubState {
  current: string | undefined
  byId: Record<string, { projectionValues?: { todos?: readonly TodoItem[] | null; goal?: unknown } }>
}

/** One active goal snapshot as the projection publishes it. */
const GOAL = {
  goal: { objective: '交付 v0', phase: 'active', maxGoalRounds: 10 },
  roundsStarted: 2,
  createdAt: 0,
  updatedAt: 0,
}

/** Seat props stub: the seat reads the sessions list and the tree store; the rest of the share is unused. */
function seatProps(
  store: ReturnType<typeof createSnapshotStore<SessionsStubState>>,
  overrides: Partial<Pick<TodoTreeProps, 'wide' | 'expandSidebar'>> = {},
  tree = createTodoTreeStore().create(),
): TodoTreeProps {
  const useSessions = (selector: (state: SessionsStubState) => unknown) =>
    bindSnapshotSelector(store)(state => selector(state))
  return {
    useSessions,
    useStore: (selector: (state: { collapsed: string[] }) => unknown) =>
      bindSnapshotSelector(tree.store)(state => selector(state)),
    actions: tree.actions,
    wide: true,
    expandSidebar: vi.fn(),
    t,
    ...overrides,
  } as unknown as TodoTreeProps
}

describe('TodoTree seat', () => {
  it('reads the current session todos projection and follows pushed updates', () => {
    const store = createSnapshotStore<SessionsStubState>({
      current: 's1',
      byId: { s1: { projectionValues: { todos: undefined } } },
    })
    render(<TodoTree {...seatProps(store)} />)
    // Capability absent (no baseline/frame yet) renders the quiet empty state,
    // not a blank panel: the sidebar seat stays meaningful between plans.
    expect(screen.getByTestId('todo-tree-empty')).toBeTruthy()
    act(() => { store.set({ current: 's1', byId: { s1: { projectionValues: { todos: LIST, goal: GOAL } } } }) })
    expect(screen.getByText('1 已完成 · 1 进行中 · 1 待处理')).toBeTruthy()
    // The session's goal leads the card the moment the projection publishes it.
    expect(screen.getByTestId('todo-goal')).toBeTruthy()
    // The pre-first-write whole value (null) returns to the empty state.
    act(() => { store.set({ current: 's1', byId: { s1: { projectionValues: { todos: null } } } }) })
    expect(screen.getByTestId('todo-tree-empty')).toBeTruthy()
  })

  it('renders the empty state while no session is current', () => {
    const store = createSnapshotStore<SessionsStubState>({ current: undefined, byId: {} })
    render(<TodoTree {...seatProps(store)} />)
    expect(screen.getByTestId('todo-tree-empty')).toBeTruthy()
  })

  it('renders one expand affordance in the collapsed rail instead of the tree', () => {
    const store = createSnapshotStore<SessionsStubState>({
      current: 's1',
      byId: { s1: { projectionValues: { todos: LIST } } },
    })
    const expandSidebar = vi.fn()
    render(<TodoTree {...seatProps(store, { wide: false, expandSidebar })} />)
    const rail = screen.getByRole('button', { name: '展开任务树' })
    expect(screen.queryByTestId('todo-tree')).toBeNull()
    fireEvent.click(rail)
    expect(expandSidebar).toHaveBeenCalledTimes(1)
  })

  it('registers into the sidebar memory seat', () => {
    expect(todoTreeEntry.name).toBe('conversation-todo-tree')
    expect(todoTreeEntry.inject).toEqual(['slots'])
    const register = vi.fn(() => () => undefined)
    const inject = vi.fn((_name: string, callback: () => () => void) => callback())
    todoTreeEntry.apply({ slots: { inject, register } } as never)
    expect(inject).toHaveBeenCalledWith('sidebar.memory', expect.any(Function))
    expect(register).toHaveBeenCalledWith(
      { name: 'sidebar.memory', id: 'todo-tree', order: 0, locale: NS, store: expect.anything() },
      TodoTree,
    )
  })
})

/** A model-authored flat plan: repeated "Feature A:"/"Feature B:" heads, one standalone tail. */
const FLAT_PLAN: TodoItem[] = [
  { content: 'Feature A: host session.forkExcluding RPC', status: 'completed' },
  { content: 'Feature A: chat UI hover ellipsis menu', status: 'in_progress' },
  { content: 'Feature A: build and deploy the bundle', status: 'pending' },
  { content: 'Feature B: workspace activity sort', status: 'pending' },
  { content: 'Feature B: build ui-workspace, deploy, verify', status: 'pending' },
  { content: 'Restart runtime, verify both features live', status: 'pending' },
]

describe('grouped flat plans', () => {
  it('groups shared heads under one expanded branch and strips them from leaves', () => {
    render(<TodoTreeBody todos={FLAT_PLAN} t={t} />)
    expect(screen.getByText('Feature A')).toBeTruthy()
    expect(screen.getByText('host session.forkExcluding RPC')).toBeTruthy()
    // The head is the branch's text; leaves never repeat it.
    expect(screen.queryByText('Feature A: host session.forkExcluding RPC')).toBeNull()
    // The standalone tail keeps its full text as an ordinary leaf.
    expect(screen.getByText('Restart runtime, verify both features live')).toBeTruthy()
    // Branch rows are disclosure buttons, expanded by default.
    expect(screen.getByRole('button', { name: 'Feature A' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps a prefix hit only once as an ordinary full-text leaf', () => {
    render(<TodoTreeBody todos={[{ content: 'Note: only one', status: 'pending' }]} t={t} />)
    expect(screen.getByText('Note: only one')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Note' })).toBeNull()
  })

  it('rolls branch status up from the children', () => {
    render(<TodoTreeBody todos={[
      { content: 'A: one', status: 'completed' },
      { content: 'A: two', status: 'in_progress' },
      { content: 'B: one', status: 'completed' },
      { content: 'B: two', status: 'completed' },
      { content: 'C: one', status: 'cancelled' },
      { content: 'C: two', status: 'cancelled' },
      { content: 'D: one', status: 'completed' },
      { content: 'D: two', status: 'pending' },
    ]} t={t} />)
    expect(screen.getByText('A').closest('li')?.getAttribute('data-status')).toBe('in_progress')
    expect(screen.getByText('B').closest('li')?.getAttribute('data-status')).toBe('completed')
    expect(screen.getByText('C').closest('li')?.getAttribute('data-status')).toBe('cancelled')
    expect(screen.getByText('D').closest('li')?.getAttribute('data-status')).toBe('pending')
  })

  it('hides a collapsed branch leaves until toggled open', () => {
    const onToggle = vi.fn()
    render(<TodoTreeBody todos={FLAT_PLAN} t={t} collapsed={['Feature A']} onToggle={onToggle} />)
    expect(screen.queryByText('host session.forkExcluding RPC')).toBeNull()
    // Sibling branches keep their leaves.
    expect(screen.getByText('workspace activity sort')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Feature A' }).getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Feature A' }))
    expect(onToggle).toHaveBeenCalledWith('Feature A')
  })

  it('keeps deliberately nested data as authored (grouping is root-level only)', () => {
    const TREE: TodoItem[] = [
      {
        content: '交付功能',
        status: 'in_progress',
        children: [
          { content: '实现: 核心', status: 'completed' },
          { content: '实现: 收尾', status: 'pending' },
        ],
      },
    ]
    render(<TodoTreeBody todos={TREE} t={t} />)
    // A single "实现:" head at a child level stays full-text and ungrouped.
    expect(screen.getByText('实现: 核心')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '实现' })).toBeNull()
  })
})

describe('todo tree collapse store', () => {
  it('toggles branch titles in both directions', () => {
    const tree = createTodoTreeStore().create()
    expect(tree.store.getSnapshot().collapsed).toEqual([])
    tree.actions.toggle('Feature A')
    expect(tree.store.getSnapshot().collapsed).toEqual(['Feature A'])
    tree.actions.toggle('Feature A')
    expect(tree.store.getSnapshot().collapsed).toEqual([])
  })

  it('seats collapse branches through the declared store face', () => {
    const sessions = createSnapshotStore<SessionsStubState>({
      current: 's1',
      byId: { s1: { projectionValues: { todos: FLAT_PLAN } } },
    })
    const tree = createTodoTreeStore().create()
    render(<TodoTree {...seatProps(sessions, {}, tree)} />)
    expect(screen.getByText('host session.forkExcluding RPC')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Feature A' }))
    expect(tree.store.getSnapshot().collapsed).toEqual(['Feature A'])
    // The store write flows back through the selector: the branch closes.
    expect(screen.queryByText('host session.forkExcluding RPC')).toBeNull()
    expect(screen.getByRole('button', { name: 'Feature A' }).getAttribute('aria-expanded')).toBe('false')
  })
})
