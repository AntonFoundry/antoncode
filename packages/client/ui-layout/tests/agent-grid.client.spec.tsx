// @vitest-environment jsdom
/**
 * Agent board spec: the pure board builder (workspace grouping, subagent
 * nesting through the parent chain, orphan recovery), the pane status
 * precedence, and the rendered board — pane statuses surface as data
 * attributes, clicks open the session, and the empty state explains itself.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

afterEach(cleanup)
import { AgentGrid, buildAgentBoard, paneStatus, paneActive } from '@deepseek-ai/dsh-client-ui-layout/src/client/AgentGrid.tsx'
import type { AgentSessionView } from '@deepseek-ai/dsh-client-ui-layout/src/client/AgentGrid.tsx'

function session(overrides: Partial<AgentSessionView> & { id: string }): AgentSessionView {
  return {
    displayTitle: overrides.id,
    running: false,
    updatedAt: 1_000,
    ...overrides,
  }
}

describe('buildAgentBoard', () => {
  const workspaces = [
    { workspaceId: 'ws-a', title: 'Alpha', sessionIds: ['root-a', 'sub-a', 'sub-nested'] },
    { workspaceId: 'ws-b', title: 'Beta', sessionIds: ['root-b'] },
  ]
  const sessions = {
    'root-a': session({ id: 'root-a' }),
    'sub-a': session({ id: 'sub-a', origin: 'subagent', parent: 'root-a' }),
    'sub-nested': session({ id: 'sub-nested', origin: 'subagent', parent: 'sub-a' }),
    'root-b': session({ id: 'root-b' }),
    'unlisted': session({ id: 'unlisted', origin: 'subagent', parent: 'root-b' }),
    'lost': session({ id: 'lost', origin: 'subagent', parent: 'gone' }),
  }

  it('groups panes under workspace titles, registry order', () => {
    const board = buildAgentBoard(workspaces, sessions)
    expect(board.map(group => group.title)).toEqual(['Alpha', 'Beta', 'Unattached'])
    expect(board[0]!.sessions.map(pane => pane.id)).toEqual(['root-a'])
  })

  it('attaches each subagent chip under its nearest rendered ancestor pane', () => {
    const board = buildAgentBoard(workspaces, sessions)
    const root = board[0]!.sessions[0]!
    // Both the direct child and the child-of-subchild surface as chips: the
    // pane shows one flat chip row, with the walk up the parent chain stopping
    // at the first pane (the only thing the board renders).
    expect(root.subagents.map(subagent => subagent.id)).toEqual(['sub-a', 'sub-nested'])
    // Registry-absent subagents whose chain reaches a pane attach there.
    expect(board[1]!.sessions[0]!.subagents.map(subagent => subagent.id)).toEqual(['unlisted'])
  })

  it('surfaces parentless subagents in the Unattached section', () => {
    const board = buildAgentBoard(workspaces, sessions)
    expect(board[2]!.sessions.map(pane => pane.id)).toEqual(['lost'])
  })

  it('renders no groups when nothing exists', () => {
    expect(buildAgentBoard([], {})).toEqual([])
  })
})

describe('paneStatus', () => {
  const base = { id: 'p', displayTitle: 'p', running: false, updatedAt: 0 }

  it('a blocking wait outranks running', () => {
    expect(paneStatus({ ...base, pendingInteraction: 'approval', running: true, subagents: [] })).toBe('pending')
  })

  it('any running subagent makes the pane running', () => {
    expect(paneActive({ ...base, subagents: [{ ...base, id: 's', running: true }] })).toBe(true)
    expect(paneStatus({ ...base, subagents: [{ ...base, id: 's', running: true }] })).toBe('running')
  })

  it('completed-while-away beats idle', () => {
    expect(paneStatus({ ...base, completed: true, subagents: [] })).toBe('done')
    expect(paneStatus({ ...base, subagents: [] })).toBe('idle')
  })
})

describe('AgentGrid rendering', () => {
  const groups = buildAgentBoard(
    [{ workspaceId: 'ws', title: 'Alpha', sessionIds: ['a', 'b'] }],
    {
      a: session({ id: 'a', displayTitle: 'Builder', running: true, updatedAt: Date.now() - 65_000 }),
      b: session({ id: 'b', displayTitle: 'Idle one', pendingInteraction: 'question', updatedAt: Date.now() }),
    },
  )

  it('tiles a pane per session with workspace header and status attributes', () => {
    const onOpen = vi.fn()
    const { container } = render(<AgentGrid groups={groups} currentSessionId="a" onOpen={onOpen} />)
    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.getByText('Builder')).toBeTruthy()
    const running = container.querySelector('[data-status="running"]')
    const pending = container.querySelector('[data-status="pending"]')
    expect(running).not.toBeNull()
    expect(pending).not.toBeNull()
    expect(running!.getAttribute('data-current')).toBe('true')
    // Running clock renders an elapsed label, not a wall-clock time.
    expect(running!.textContent).toContain('1m 05s')
  })

  it('opens the clicked session', () => {
    const onOpen = vi.fn()
    render(<AgentGrid groups={groups} currentSessionId={undefined} onOpen={onOpen} />)
    fireEvent.click(screen.getByText('Idle one'))
    expect(onOpen).toHaveBeenCalledWith('b')
    cleanup()
  })

  it('explains an empty board', () => {
    render(<AgentGrid groups={[]} currentSessionId={undefined} onOpen={vi.fn()} />)
    expect(screen.getByText('No sessions in this workspace yet.')).toBeTruthy()
    cleanup()
  })
})
