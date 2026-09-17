// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SettingsRootComponentProps, SettingsWindowComponentProps } from '../src/client/shell-contract.ts'
import { SettingsRoot, SettingsWindow } from '../src/client/SettingsRoot.tsx'

afterEach(cleanup)

type Row = { id: string; order: number; label: string }
type Step = { id: string; order: number }

const ROWS: Row[] = [
  { id: 'general', order: 0, label: 'General' },
  { id: 'models', order: 10, label: 'Models' },
  { id: 'agent-presets', order: 20, label: 'Agent presets' },
]

/** Slot-content stand-ins: the shells render whatever the seats contribute. */
const SEAT_CONTENT: Record<string, string> = {
  'settings.trigger': 'Settings',
  'settings.header': 'Settings Title',
  'settings.action': 'Open configuration file',
}

const unusedHook = (() => { throw new Error('unused by the settings shells') }) as never

describe('SettingsRoot trigger', () => {
  function mount({ wide = true, onboardingActive = true, steps = [
    { id: 'welcome', order: -100 },
    { id: 'credential', order: 0 },
  ] }: { wide?: boolean; onboardingActive?: boolean; steps?: Step[] } = {}) {
    const renderSlot = vi.fn(
      ((key: string) => SEAT_CONTENT[key] ?? null) as SettingsRootComponentProps['renderSlot'],
    )
    const openWindow = vi.fn()
    const openSection = vi.fn()
    const useSessions = ((select: (state: unknown) => unknown) => select(onboardingActive
      ? { phase: 'ready', current: undefined, byId: {} }
      : {
        phase: 'ready',
        current: 'active-session',
        byId: { 'active-session': { blank: false } },
      })) as never
    const props: SettingsRootComponentProps = {
      useSessions,
      useWorkspaces: unusedHook,
      wide,
      openWindow,
      openSection,
      useOnboardingSteps: select => select(steps),
      renderSlot,
    }
    const view = render(<SettingsRoot {...props} />)
    return { view, renderSlot, openWindow, openSection }
  }

  it('renders the trigger seat content as the accessible name (no aria-label of its own)', () => {
    const { renderSlot, openWindow } = mount()
    const trigger = screen.getByRole('button', { name: 'Settings' })
    expect(trigger.hasAttribute('aria-label')).toBe(false)
    expect(renderSlot).toHaveBeenCalledWith('settings.trigger', { wide: true })
    // The window's open state is the layout's, not the trigger's.
    expect(trigger.hasAttribute('aria-expanded')).toBe(false)
    fireEvent.click(trigger)
    expect(openWindow).toHaveBeenCalledOnce()
  })

  it('hands the rail state to the trigger seat', () => {
    const { renderSlot } = mount({ wide: false })
    expect(renderSlot).toHaveBeenCalledWith('settings.trigger', { wide: false })
  })

  it('mounts onboarding steps in order and forwards the shared openSection action', () => {
    const { renderSlot, openWindow, openSection } = mount()
    const first = renderSlot.mock.calls.find(call => call[0] === 'settings.onboarding')
    expect(first?.[1]).toMatchObject({ stepId: 'welcome' })
    expect(first?.[2]).toEqual({ only: 'welcome' })
    act(() => {
      (first?.[1] as { complete: () => void }).complete()
      ;(first?.[1] as { complete: () => void }).complete()
    })
    const onboardingCalls = renderSlot.mock.calls.filter(call => call[0] === 'settings.onboarding')
    const second = onboardingCalls.at(-1)
    expect(second?.[1]).toMatchObject({ stepId: 'credential' })
    expect(second?.[2]).toEqual({ only: 'credential' })
    // A step's openSection is the shell's shared action: select + open.
    act(() => {
      (second?.[1] as { openSection: (id: string) => void }).openSection('models')
    })
    expect(openSection).toHaveBeenCalledWith('models')
    expect(openWindow).not.toHaveBeenCalled()
  })

  it('paints no takeover chrome of its own around the mounted step', () => {
    // The chrome (mask, opaque stage, #root inert) belongs to the step via
    // the step-owned dialog surface — a mounted-but-deciding step that
    // renders null must show and block nothing (the reload white-flash fix;
    // onboarding-surface.spec.tsx pins the primitive's half).
    const appRoot = document.createElement('div')
    appRoot.id = 'root'
    document.body.append(appRoot)
    const { view } = mount()
    expect(view.container.querySelector('[class*="onboarding"]')).toBeNull()
    expect(document.body.querySelector('[class*="onboarding"]')).toBeNull()
    expect(appRoot.inert).not.toBe(true)
    view.unmount()
    appRoot.remove()
  })

  it('mounts no step while a live session owns the workspace', () => {
    const { renderSlot } = mount({ onboardingActive: false })
    const inactive = renderSlot.mock.calls.filter(call => call[0] === 'settings.onboarding')
    expect(inactive).toHaveLength(0)
  })
})

describe('SettingsWindow body', () => {
  function mount({
    rows = ROWS,
    activeId = undefined as string | undefined,
  }: { rows?: Row[]; activeId?: string | undefined } = {}) {
    // Mutable sources standing in for the bound hooks; the bump helpers play
    // ledger and selection changes through the same observable contract.
    let currentRows = rows
    let currentActive = { activeId }
    const listeners = new Set<() => void>()
    const renderSlot = vi.fn(
      ((key: string, owner: unknown, opts?: { only?: string }) => {
        if (key === 'settings.section') return <div data-testid={`section-${opts?.only ?? 'all'}`} />
        return SEAT_CONTENT[key] ?? null
      }) as SettingsWindowComponentProps['renderSlot'],
    )
    const closeWindow = vi.fn()
    const setActiveSection = vi.fn((id: string | undefined) => {
      currentActive = { activeId: id }
      for (const fn of [...listeners]) fn()
    })
    const props: SettingsWindowComponentProps = {
      useSessions: unusedHook,
      useWorkspaces: unusedHook,
      useSections: (select) => {
        const [, force] = useState(0)
        listeners.add(() => { force(n => n + 1) })
        return select(currentRows)
      },
      useActiveSection: (select) => {
        const [, force] = useState(0)
        listeners.add(() => { force(n => n + 1) })
        return select(currentActive)
      },
      closeWindow,
      setActiveSection: setActiveSection as never,
      renderSlot,
    }
    const view = render(<SettingsWindow {...props} />)
    const setRows = (next: Row[]) => {
      act(() => {
        currentRows = next
        for (const fn of [...listeners]) fn()
      })
    }
    return { view, renderSlot, closeWindow, setActiveSection, setRows }
  }

  it('names nothing as a dialog: the WM pane owns the window chrome', () => {
    mount()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('projects rows, marks the first active, and renders only that section', () => {
    const { renderSlot } = mount()
    expect(screen.getByRole('button', { name: 'General' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('button', { name: 'Models' }).getAttribute('aria-current')).toBeNull()
    expect(screen.getByTestId('section-general')).toBeTruthy()
    // The section receives the window close action as its `close` prop.
    const sectionCall = renderSlot.mock.calls.find(call => call[0] === 'settings.section')!
    expect(sectionCall[1]).toMatchObject({ close: expect.any(Function) })
  })

  it('renders the header title and action seats', () => {
    const { renderSlot } = mount()
    expect(screen.getByText('Settings Title')).toBeTruthy()
    expect(screen.getByText('Open configuration file')).toBeTruthy()
    expect(renderSlot).toHaveBeenCalledWith('settings.action', {})
  })

  it('switches the rendered section on nav click through the shared setter', () => {
    const { setActiveSection } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    expect(setActiveSection).toHaveBeenCalledWith('models')
  })

  it('renders the section the shared source selects', () => {
    const { setActiveSection } = mount({ activeId: 'models' })
    // Selecting through the shared setter replays the observable, and the
    // window re-renders onto the selected section.
    act(() => { setActiveSection('models') })
    expect(screen.getByRole('button', { name: 'Models' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByTestId('section-models')).toBeTruthy()
    expect(screen.queryByTestId('section-general')).toBeNull()
  })

  it('gives every section a nav glyph, distinct for the ids the shell knows', () => {
    mount({
      rows: [
        { id: 'general', order: 0, label: 'General' },
        { id: 'models', order: 10, label: 'Models' },
        { id: 'agent-presets', order: 20, label: 'Agent presets' },
        { id: 'plugins', order: 30, label: 'Plugins' },
        { id: 'contributed', order: 40, label: 'Contributed' },
      ],
    })
    // Glyphs carry no id of their own, so the drawn paths are what tells them apart.
    const glyphs = ['General', 'Models', 'Agent presets', 'Plugins', 'Contributed']
      .map(name => screen.getByRole('button', { name }).querySelector('svg')?.innerHTML)

    expect(glyphs.every(glyph => glyph !== undefined && glyph !== '')).toBe(true)
    // The four ids the shell names get their own glyph; every other section —
    // including one this package never heard of — shares the gear.
    expect(new Set(glyphs.slice(0, 4)).size).toBe(4)
    expect(glyphs[4]).toBe(glyphs[0])
  })

  it('falls back to the first row when the active entry unregisters', () => {
    const { setRows } = mount({ activeId: 'models' })
    setRows([{ id: 'general', order: 0, label: 'General' }])
    expect(screen.queryByRole('button', { name: 'Models' })).toBeNull()
    expect(screen.getByTestId('section-general')).toBeTruthy()
  })

  it('renders an empty content column when the ledger is empty', () => {
    const { renderSlot } = mount({ rows: [] })
    const sectionCalls = renderSlot.mock.calls.filter(c => c[0] === 'settings.section')
    expect(sectionCalls).toHaveLength(0)
  })
})
