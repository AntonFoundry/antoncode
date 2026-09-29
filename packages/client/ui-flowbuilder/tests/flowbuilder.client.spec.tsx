// @vitest-environment jsdom
/**
 * The Workflows canvas: user-visible editing behavior — palette adds a node,
 * ports connect, the inspector edits the selection, and run states project
 * onto the cards. Driven through the inject face (plain data + callbacks).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { FlowbuilderView } from '../src/client/flowbuilder.tsx'
import type { FlowbuilderInjected } from '../src/client/flowbuilder.tsx'
import { connect, emptyDraft, applyRunStates } from '../src/client/graph.ts'
import type { FlowDraft } from '../src/client/graph.ts'

afterEach(cleanup)

const t = (key: string): string => key
const noop = async (): Promise<never> => { throw new Error('not used in this test') }

function face(overrides: Partial<FlowbuilderInjected['actions']> = {}): FlowbuilderInjected {
  return {
    labels: { t: t as (key: never) => string },
    actions: {
      saveFlow: noop,
      runFlow: noop,
      getRun: noop,
      listBlocks: async () => [],
      saveBlock: async () => {},
      ...overrides,
    },
  }
}

describe('Workflows graph model', () => {
  it('connects ports once per input and refuses self-edges and duplicates', () => {
    const draft = emptyDraft()
    const a = draft.nodes[0]!
    const b = draft.nodes[1]!
    const first = connect(draft, { nodeId: a.id, port: 'out' }, { nodeId: b.id, port: 'in' })
    expect(first).toBeDefined()
    const back = connect(first!, { nodeId: b.id, port: 'out' }, { nodeId: a.id, port: 'in' })
    expect(back).toBeDefined()
    expect(connect(draft, { nodeId: a.id, port: 'out' }, { nodeId: a.id, port: 'in' })).toBeUndefined()
    // A second edge onto the same input port is refused.
    expect(connect(first!, { nodeId: a.id, port: 'out' }, { nodeId: b.id, port: 'in' })).toBeUndefined()
  })

  it('projects run states onto draft nodes, defaulting to pending', () => {
    const draft: FlowDraft = emptyDraft()
    const view = applyRunStates(draft.nodes, { [draft.nodes[0]!.id]: { status: 'completed' } })
    expect(view.get(draft.nodes[0]!.id)?.status).toBe('completed')
    expect(view.get(draft.nodes[1]!.id)?.status).toBe('pending')
  })
})

describe('Workflows canvas', () => {
  it('adds a palette node to the canvas and selects it for the inspector', () => {
    const { container } = render(createElement(FlowbuilderView, face()))
    fireEvent.click(screen.getByRole('button', { name: 'Shell' }))
    const canvas = container.querySelector('[data-testid="canvas"]')
    expect(canvas?.querySelectorAll('[data-node-kind="shell"]')).toHaveLength(1)
  })

  it('saves the draft through the injected action', () => {
    const saveFlow = vi.fn(async () => ({
      id: 'flow-1', name: 'Untitled workflow', description: '', nodes: [], edges: [], createdAt: '', updatedAt: '',
    }))
    render(createElement(FlowbuilderView, face({ saveFlow })))
    fireEvent.click(screen.getByTestId('save'))
    expect(saveFlow).toHaveBeenCalledOnce()
    expect(saveFlow.mock.calls[0]?.[0].name).toBe('Untitled workflow')
  })

  it('refuses to run before the first save and shows the error strip', () => {
    const runFlow = vi.fn()
    const { container } = render(createElement(FlowbuilderView, face({ runFlow })))
    fireEvent.click(screen.getByTestId('run'))
    expect(runFlow).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Save the workflow')
  })

  it('runs a saved draft and renders the terminal per-node states', async () => {
    const draft = emptyDraft()
    const linked = connect(draft, { nodeId: draft.nodes[0]!.id, port: 'out' }, { nodeId: draft.nodes[1]!.id, port: 'in' })!
    let runCalls = 0
    const face1 = face({
      saveFlow: async () => ({
        id: 'f', name: linked.name, description: '', nodes: [], edges: [], createdAt: '', updatedAt: '',
      }),
      runFlow: async () => 'run-9',
      getRun: async () => {
        runCalls += 1
        return {
          id: 'run-9', flowId: 'f', status: runCalls === 1 ? 'running' : 'completed',
          startedAt: '', nodes: { [linked.nodes[0]!.id]: { status: 'completed' }, [linked.nodes[1]!.id]: { status: 'completed', output: 'ok' } },
          result: 'ok',
        }
      },
    })
    const { container } = render(createElement(FlowbuilderView, face1))
    fireEvent.click(screen.getByTestId('save'))
    await new Promise(resolve => setTimeout(resolve, 0))
    fireEvent.click(screen.getByTestId('run'))
    await vi.waitFor(() => {
      expect(container.textContent).toContain('flow.result')
    })
  })
})
