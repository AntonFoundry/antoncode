// @vitest-environment jsdom
/** plan_write / exit_plan_mode atomic Tool presentation: the plan-reference block. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { PlanRow, planToolview } from '../src/client/tool/toolviews/plan-row.tsx'
import { CONVERSATION_NS as NS } from '../src/client/locale.ts'
import { zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'

type PlanRowProps = Parameters<typeof PlanRow>[0]

const t: PlanRowProps['t'] = makeTranslate(zh, commonZh)

afterEach(cleanup)

const resultNode = (argsRaw: string, over?: Partial<ToolResultNode>): ToolResultNode => ({
  kind: 'tool-result', seq: 10, time: 2_000, callTime: 1_000, callId: 'c1',
  name: 'plan_write', args: PartialArguments.fromText(argsRaw),
  call: { name: 'plan_write', argsRaw },
  content: [], isError: false, subCalls: [], ...over,
})

function rowProps(block: unknown, openFile = vi.fn()): PlanRowProps {
  return {
    callId: 'c1', toolName: 'plan_write', block,
    openFile,
    sessionId: 's1',
    useSessions: () => undefined,
    t,
  } as unknown as PlanRowProps
}

describe('PlanRow', () => {
  const PLAN = '# Fix the wake word pipeline\n\nTwo showstoppers block detection.\n\n## Steps\n1. Fix VAD.'
  const ARGS = JSON.stringify({ plan: PLAN, title: 'Wake Word Fix' })

  it('renders the plan title and a summary that names the first heading line and the saved path', () => {
    render(<PlanRow {...rowProps(resultNode(ARGS))} />)
    expect(screen.getByText('Wake Word Fix')).toBeTruthy()
    // The summary doubles as the row's file link, so the saved markdown path
    // stays part of the visible reference.
    expect(screen.getByRole('button', { name: 'Fix the wake word pipeline · implementation_plan.md' })).toBeTruthy()
  })

  it('defaults the title to the locale row title when args carry none', () => {
    render(<PlanRow {...rowProps(resultNode(JSON.stringify({ plan: PLAN })))} />)
    expect(screen.getByText('实施计划')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Fix the wake word pipeline · implementation_plan.md' })).toBeTruthy()
  })

  it('names the saved path alone when the plan markdown has no non-empty line', () => {
    render(<PlanRow {...rowProps(resultNode(JSON.stringify({ plan: ' \n \n', path: 'plans/custom.md' })))} />)
    expect(screen.getByRole('button', { name: 'plans/custom.md' })).toBeTruthy()
  })

  it('opening the summary link travels the owner openFile face with the saved path', () => {
    const openFile = vi.fn()
    render(<PlanRow {...rowProps(resultNode(ARGS), openFile)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Fix the wake word pipeline · implementation_plan.md' }))
    expect(openFile).toHaveBeenCalledWith('implementation_plan.md')
  })

  it('reads running-call args the same way', () => {
    const running = render(
      <PlanRow {...rowProps({ callId: 'c1', name: 'plan_write', argsRaw: ARGS, turn: 1, step: 1, time: 1_000, callView: null, subCalls: [] })} />,
    )
    expect(running.container.querySelector('[data-state="running"]')).not.toBeNull()
    expect(screen.getByText('Wake Word Fix')).toBeTruthy()
  })

  it('falls back to the generic summary on malformed errored args (summary link keeps the default path)', () => {
    const view = render(<PlanRow {...rowProps(resultNode('not json', { isError: true }))} />)
    expect(view.container.querySelector('[data-state="error"]')).not.toBeNull()
    // No errorSummary line: the generic summary doubles as the link and the
    // default plan path stays the link's target.
    expect(screen.getByRole('button', { name: 'plan_write · not json' })).toBeTruthy()
  })

  it.each([
    { label: 'null root', argsRaw: 'null' },
    { label: 'non-object root', argsRaw: '42' },
    { label: 'non-string plan', argsRaw: '{"plan":42}' },
  ])('falls back to the generic summary on valid JSON with an invalid shape ($label)', ({ argsRaw }) => {
    render(<PlanRow {...rowProps(resultNode(argsRaw))} />)
    expect(screen.getByText(`plan_write · ${argsRaw}`)).toBeTruthy()
  })

  it('treats exit_plan_mode calls with the same block material', () => {
    const args = JSON.stringify({ plan: PLAN, path: 'plans/exit.md' })
    render(<PlanRow {...rowProps(resultNode(args, { call: { name: 'exit_plan_mode', argsRaw: args } }))} />)
    expect(screen.getByText('实施计划')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Fix the wake word pipeline · plans/exit.md' })).toBeTruthy()
  })

  it('registers one component under both plan tool names, and each disposes', () => {
    const registered: { key: string; locale: unknown; disposed: boolean }[] = []
    let disposeInjection = (): void => {}
    const ctx = {
      slots: {
        inject: (_name: string, callback: () => Iterable<() => void>) => {
          const active = [...callback()]
          disposeInjection = () => { for (const dispose of [...active].reverse()) dispose() }
          return disposeInjection
        },
        register: ({ key, locale }: { name: string; key: string; locale?: string }) => {
          const entry = { key, locale, disposed: false }
          registered.push(entry)
          return () => { entry.disposed = true }
        },
      },
    }
    planToolview.apply(ctx as never)
    expect(planToolview.name).toBe('plan-toolview')
    expect(planToolview.inject).toEqual(['slots'])
    expect(registered.map(r => r.key).sort()).toEqual(['exit_plan_mode', 'plan_write'])
    expect(registered.map(r => r.locale)).toEqual([NS, NS])
    disposeInjection()
    expect(registered.every(r => r.disposed)).toBe(true)
  })
})
