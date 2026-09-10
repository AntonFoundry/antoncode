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

/** Default render props: every call site gets the full required face. Pane
 *  level specs render inside the first group's space (the overview shows only
 *  workspace preview cards). */
function gridProps(overrides: Partial<Parameters<typeof AgentGrid>[0]> = {}): Parameters<typeof AgentGrid>[0] {
  const base = {
    groups: [],
    currentSessionId: undefined,
    onOpen: vi.fn(),
    onInterrupt: vi.fn(),
    sort: 'recent',
    paneWidth: 340,
    onPrefsChange: vi.fn(),
    onPrompt: vi.fn(),
    fetchTail: vi.fn(async () => undefined),
    terminals: [],
    renderTerminal: vi.fn(() => null),
    onSpawnTerminal: vi.fn(),
    ...overrides,
  }
  return { workspace: base.groups[0]?.workspaceId, ...base }
}

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
    const { container } = render(<AgentGrid {...gridProps({ groups, currentSessionId: 'a', onOpen })} />)
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
    render(<AgentGrid {...gridProps({ groups, onOpen })} />)
    fireEvent.click(screen.getByText('Idle one'))
    expect(onOpen).toHaveBeenCalledWith('b')
    cleanup()
  })

  it('explains an empty board', () => {
    render(<AgentGrid {...gridProps()} />)
    expect(screen.getByText('No sessions in this workspace yet.')).toBeTruthy()
    cleanup()
  })
})

describe('AgentGrid overview level', () => {
  const groups = buildAgentBoard(
    [
      { workspaceId: 'ws-a', title: 'Alpha', sessionIds: ['a', 'b'] },
      { workspaceId: 'ws-b', title: 'Beta', sessionIds: ['c'] },
    ],
    {
      a: session({ id: 'a', displayTitle: 'Builder', running: true, updatedAt: Date.now() }),
      b: session({ id: 'b', displayTitle: 'Idle one', updatedAt: Date.now() - 1000 }),
      c: session({ id: 'c', displayTitle: 'Loner', updatedAt: Date.now() - 2000 }),
    },
  )

  it('the overview shows every workspace as one preview card with mini tiles, no panes', () => {
    const { container } = render(<AgentGrid {...gridProps({ groups, workspace: undefined })} />)
    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.getByText('Beta')).toBeTruthy()
    // Running marker rides the card count, and mini tiles carry titles + dots.
    expect(container.querySelector('[data-level="overview"]')).not.toBeNull()
    expect(container.querySelectorAll('[class*="miniDot"]')).toHaveLength(3)
    // No full panes at this level: nothing expandable, no composer inputs.
    expect(container.querySelectorAll('[class*="agentPane"][data-status]')).toHaveLength(0)
  })

  it('clicking a preview card zooms into that workspace through the prefs write', () => {
    const onPrefsChange = vi.fn()
    render(<AgentGrid {...gridProps({ groups, onPrefsChange, workspace: undefined })} />)
    fireEvent.click(screen.getByText('Beta'))
    expect(onPrefsChange).toHaveBeenCalledWith({ workspace: 'ws-b' })
    cleanup()
  })

  it('Esc backs out one level: pane zoom, then workspace, then nothing', () => {
    const onPrefsChange = vi.fn()
    const one = render(<AgentGrid {...gridProps({ groups, onPrefsChange, workspace: 'ws-a', zoomed: 'a' })} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onPrefsChange).toHaveBeenLastCalledWith({ zoomed: undefined })
    one.unmount()
    onPrefsChange.mockClear()
    const two = render(<AgentGrid {...gridProps({ groups, onPrefsChange, workspace: 'ws-a' })} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onPrefsChange).toHaveBeenCalledWith({ workspace: undefined })
    two.unmount()
    onPrefsChange.mockClear()
    const three = render(<AgentGrid {...gridProps({ groups, onPrefsChange, workspace: undefined })} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onPrefsChange).not.toHaveBeenCalled()
    three.unmount()
  })

  it('the space level shows the max-out control that returns to every space', () => {
    const onPrefsChange = vi.fn()
    const { container } = render(<AgentGrid {...gridProps({ groups, onPrefsChange, workspace: 'ws-a' })} />)
    fireEvent.click(container.querySelector('[aria-label="Show every space"]')!)
    expect(onPrefsChange).toHaveBeenCalledWith({ workspace: undefined })
  })
})

describe('AgentGrid controls', () => {
  const groups = buildAgentBoard(
    [{ workspaceId: 'ws', title: 'Alpha', sessionIds: ['a', 'b'] }],
    {
      a: session({ id: 'a', displayTitle: 'Builder', running: true, updatedAt: Date.now() }),
      b: session({ id: 'b', displayTitle: 'Idle one', updatedAt: Date.now() - 1000 }),
    },
  )

  it('stop appears only on active panes and interrupts without opening', () => {
    const onOpen = vi.fn()
    const onInterrupt = vi.fn()
    const { container } = render(<AgentGrid {...gridProps({ groups, onOpen, onInterrupt })} />)
    const stops = [...container.querySelectorAll('[aria-label="Stop"]')]
    expect(stops).toHaveLength(1)
    fireEvent.click(stops[0]!)
    expect(onInterrupt).toHaveBeenCalledWith('a')
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('zoom shows one pane; Esc leaves zoom through the prefs write', () => {
    // Zoom is a persisted preference: the board renders zoomed from props and
    // unzoom asks the prefs owner (the workspace stash) to clear it.
    const onPrefsChange = vi.fn()
    const { container } = render(<AgentGrid {...gridProps({ groups, onPrefsChange, zoomed: 'a' })} />)
    expect(container.querySelector('[data-zoom]')).not.toBeNull()
    expect(container.querySelectorAll('[class*="agentPane"][data-status]')).toHaveLength(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onPrefsChange).toHaveBeenCalledWith({ zoomed: undefined })
  })

  it('the preference bar reports writes to the workspace stash', () => {
    const onPrefsChange = vi.fn()
    const { container, unmount } = render(<AgentGrid {...gridProps({ groups, onPrefsChange })} />)
    const buttons = [...container.querySelectorAll('[aria-label="Toggle sort"]')]
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0]!)
    expect(onPrefsChange).toHaveBeenCalledWith({ sort: 'status' })
    unmount()
  })

  it('status sort puts active panes first', () => {
    const { container } = render(<AgentGrid {...gridProps({ groups, sort: 'status' })} />)
    const titles = [...container.querySelectorAll('[class*="agentPaneTitle"]')].map(node => node.textContent)
    expect(titles.indexOf('Builder')).toBeLessThan(titles.indexOf('Idle one'))
  })
})

describe('AgentGrid pane composer', () => {
  const groups = buildAgentBoard(
    [{ workspaceId: 'ws', title: 'Alpha', sessionIds: ['a', 'b'] }],
    {
      a: session({ id: 'a', displayTitle: 'Builder', running: true, agentPreset: 'code', cwd: '/repo', updatedAt: Date.now() }),
      b: session({ id: 'b', displayTitle: 'Idle one', updatedAt: Date.now() - 1000 }),
    },
  )

  it('sends queued prompts from an idle pane and clears the draft', () => {
    const onPrompt = vi.fn()
    const onOpen = vi.fn()
    const { container } = render(<AgentGrid {...gridProps({ groups, onPrompt, onOpen })} />)
    const input = container.querySelector('[aria-label="Prompt Idle one"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'fix the lint' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPrompt).toHaveBeenCalledWith('b', 'fix the lint', 'queue')
    expect(input.value).toBe('')
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('steers a running pane', () => {
    const onPrompt = vi.fn()
    const { container } = render(<AgentGrid {...gridProps({ groups, onPrompt })} />)
    const input = container.querySelector('[aria-label="Prompt Builder"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'also run the e2e' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPrompt).toHaveBeenCalledWith('a', 'also run the e2e', 'steer')
  })

  it('shows the model·cwd strip and a Working label on running panes', () => {
    const { container } = render(<AgentGrid {...gridProps({ groups })} />)
    expect(container.textContent).toContain('code')
    expect(container.textContent).toContain('/repo')
    expect(container.textContent).toMatch(/Working · /)
  })
})

describe('AgentGrid activity tails', () => {
  it('renders fetched tail lines in the pane body', async () => {
    const groups = buildAgentBoard(
      [{ workspaceId: 'ws', title: 'Alpha', sessionIds: ['a'] }],
      { a: session({ id: 'a', displayTitle: 'Builder', running: true, updatedAt: Date.now() }) },
    )
    const fetchTail = vi.fn(async () => ([
      { kind: 'tool' as const, label: 'Ran bash pnpm test' },
      { kind: 'assistant' as const, label: 'All green.' },
    ]))
    const { container } = render(<AgentGrid {...gridProps({ groups, fetchTail })} />)
    await vi.waitFor(() => {
      const tail = container.querySelector('[data-testid="tail-a"]')
      expect(tail).not.toBeNull()
      expect(tail!.textContent).toContain('Ran bash pnpm test')
      expect(tail!.textContent).toContain('All green.')
    })
  })

  it('never renders a tail when the fetch is unavailable', () => {
    const groups = buildAgentBoard(
      [{ workspaceId: 'ws', title: 'Alpha', sessionIds: ['a'] }],
      { a: session({ id: 'a', displayTitle: 'Builder', updatedAt: Date.now() }) },
    )
    const { container } = render(<AgentGrid {...gridProps({ groups, fetchTail: async () => undefined })} />)
    expect(container.querySelector('[data-testid="tail-a"]')).toBeNull()
  })
})

describe('AgentGrid terminal tiles', () => {
  const groups = buildAgentBoard(
    [{ workspaceId: 'ws', title: 'Alpha', sessionIds: ['a'] }],
    { a: session({ id: 'a', displayTitle: 'Builder', updatedAt: Date.now() }) },
  )
  const terminals = [{ id: 'term-1', kind: 'terminal' as const, sessionId: 'pty-1', title: 'bash' }]

  it('renders a Terminals section with a view per tile', () => {
    const renderTerminal = vi.fn(() => null)
    const { container, getByText } = render(
      <AgentGrid {...gridProps({ groups, terminals, renderTerminal })} />,
    )
    expect(getByText('Terminals')).toBeTruthy()
    expect(getByText('bash')).toBeTruthy()
    expect(renderTerminal).toHaveBeenCalledWith('pty-1')
    expect(container.querySelector('[data-terminal-tile]')).not.toBeNull()
  })

  it('the board bar spawns a terminal through the WM command', () => {
    const onSpawnTerminal = vi.fn()
    const { container, getByText } = render(
      <AgentGrid {...gridProps({ groups, terminals, onSpawnTerminal })} />,
    )
    fireEvent.click(container.querySelector('[aria-label="New terminal"]')!)
    expect(onSpawnTerminal).toHaveBeenCalledTimes(1)
    expect(getByText('Terminals')).toBeTruthy()
  })

  it('hides the terminals section when zoomed', () => {
    // Zoom arrives as a prop (the persisted preference), not local state.
    const { container } = render(
      <AgentGrid {...gridProps({ groups, terminals, zoomed: 'a' })} />,
    )
    expect(container.querySelector('[data-terminal-tile]')).toBeNull()
  })
})
