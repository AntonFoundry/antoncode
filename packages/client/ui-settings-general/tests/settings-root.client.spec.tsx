// @vitest-environment jsdom
import type { ShortcutCatalogEntry, ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEffect, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { allowAllAccess, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SettingsRootComponentProps, SettingsWindowComponentProps } from '../src/client/shell-contract.ts'
import { SettingsRoot, SettingsWindow } from '../src/client/SettingsRoot.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { DesktopUpdateView } from '../src/types.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

const scrollIntoView = vi.fn()
let scrollIntoViewDescriptor: PropertyDescriptor | undefined

beforeEach(() => {
  scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
  scrollIntoView.mockClear()
})

afterEach(() => {
  cleanup()
  if (scrollIntoViewDescriptor === undefined) Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  else Object.defineProperty(Element.prototype, 'scrollIntoView', scrollIntoViewDescriptor)
  vi.useRealTimers()
})

type Row = { id: string; order: number; label: string }
type Step = { id: string; order: number }

/** Slot-content stand-ins: the shell renders whatever the seats contribute. */
const SEAT_CONTENT: Record<string, string> = {
  'settings.trigger': 'Settings',
  'settings.header': 'Settings Title',
  'settings.action': 'Open configuration file',
}

const ROWS: Row[] = [
  { id: 'general', order: 0, label: 'General' },
  { id: 'models', order: 10, label: 'Models' },
  { id: 'agent-presets', order: 20, label: 'Agent presets' },
]

type AttentionSnapshot = Parameters<Parameters<SettingsRootComponentProps['useSessionStatus']>[0]>[0]
type ConnectionSnapshot = Parameters<Parameters<SettingsRootComponentProps['useConnectionState']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()
const useSessionStatus: SettingsRootComponentProps['useSessionStatus'] = selector => selector(noAttention)

function mount({
  shortcuts = [],
  wide = true,
  dictionary = en,
  connectionState = 'connected',
  desktopUpdate = { failed: false, opening: false },
  onboardingActive = true,
  mainView = true,
  settingsOpen = false,
  steps = [
    { id: 'welcome', order: -100 },
    { id: 'credential', order: 0 },
  ],
}: {
  shortcuts?: readonly ShortcutCatalogEntry[]
  wide?: boolean
  dictionary?: typeof en | typeof zh
  connectionState?: ConnectionSnapshot
  desktopUpdate?: DesktopUpdateView
  onboardingActive?: boolean
  mainView?: boolean
  settingsOpen?: boolean
  steps?: Step[]
} = {}) {
  // Mutable sources standing in for the bound hooks; the setters play
  // connection and window-state changes through the same observable contract.
  let currentConnectionState = connectionState
  let currentSettingsOpen = settingsOpen
  const connectionListeners = new Set<() => void>()
  const openListeners = new Set<() => void>()
  const reconnect = vi.fn()
  const openSection = vi.fn()
  const openWindow = vi.fn(() => {
    act(() => {
      currentSettingsOpen = true
      for (const fn of [...openListeners]) fn()
    })
  })
  const renderSlot = vi.fn(
    ((key: string, _owner: unknown, opts?: { only?: string; fallback?: import('react').ReactNode }) =>
      SEAT_CONTENT[key] ?? opts?.fallback),
  )
  const activeId = SessionId('active-session')
  const sessions: SessionListState = {
    ids: [activeId],
    byId: {
      [activeId]: {
        id: activeId,
        displayTitle: 'Active',
        blank: onboardingActive,
        running: false,
        retainedBy: mainView ? { mainView: 1 } : {},
        updatedAt: 0,
      },
    },
    phase: 'ready', projectionsBySession: {},
  }
  const unusedHook = (() => { throw new Error('unused by SettingsRoot') }) as never
  const props: SettingsRootComponentProps = {
    useShortcuts: select => select(shortcuts),
    useSessions: select => select(sessions),
    useSessionStatus,
    usePanelInfo, useSessionRetainInfo: () => undefined, useResource,
    useWorkspaces: unusedHook,
    ...allowAllAccess,
    wide,
    reconnect,
    openDesktopUpdate: () => {},
    useDesktopUpdate: select => select(desktopUpdate),
    t: makeTranslate(dictionary),
    useConnectionState: (select) => {
      const [, force] = useState(0)
      useEffect(() => {
        const listener = () => { force(n => n + 1) }
        connectionListeners.add(listener)
        return () => { connectionListeners.delete(listener) }
      }, [])
      return select(currentConnectionState)
    },
    useOnboardingSteps: select => select(steps),
    useSettingsOpen: (select) => {
      const [, force] = useState(0)
      useEffect(() => {
        const listener = () => { force(n => n + 1) }
        openListeners.add(listener)
        return () => { openListeners.delete(listener) }
      }, [])
      return select(currentSettingsOpen)
    },
    openWindow,
    openSection,
    renderSlot: (key, owner, opts) => opts === undefined ? renderSlot(key, owner) : renderSlot(key, owner, opts),
  }
  const view = render(<SettingsRoot {...props} />)
  const setConnectionState = (next: typeof currentConnectionState) => {
    act(() => {
      currentConnectionState = next
      for (const fn of [...connectionListeners]) fn()
    })
  }
  const setDesktopUpdate = (next: DesktopUpdateView) => {
    desktopUpdate = next
    view.rerender(<SettingsRoot {...props} />)
  }
  const setShortcuts = (next: readonly ShortcutCatalogEntry[]) => {
    shortcuts = next
    view.rerender(<SettingsRoot {...props} />)
  }
  /** Turn the mounted Session blank, which is what makes an onboarding step appear. */
  const setOnboardingActive = (next: boolean) => {
    const session = sessions.byId[activeId]
    if (session === undefined) throw new Error('expected the mounted Session')
    act(() => { sessions.byId[activeId] = { ...session, blank: next } })
    view.rerender(<SettingsRoot {...props} />)
  }
  return { view, renderSlot, reconnect, openWindow, openSection, setConnectionState, setDesktopUpdate, setShortcuts, setOnboardingActive }
}

describe('SettingsRoot trigger', () => {
  it('shows installation instead of expected backend reconnection and restores connection feedback after failure', () => {
    const presentation = { phase: 'installing' as const, version: '1.0.1' }
    const f = mount({ dictionary: zh, connectionState: 'connecting',
      desktopUpdate: { failed: false, opening: false, presentation } })
    expect(screen.getByRole('button', { name: '正在准备重启…' })).toBeTruthy()
    expect(screen.queryByText('重新连接中')).toBeNull()
    f.setDesktopUpdate({ failed: false, opening: false,
      presentation: { phase: 'error', version: presentation.version, failure: 'install' } })
    expect(screen.queryByRole('button', { name: '重试更新' })).toBeNull()
    expect(screen.getByText('重新连接中')).toBeTruthy()
  })
  it.each([
    { column: 'expanded English', wide: true, dictionary: en, name: 'Settings' },
    { column: 'collapsed English', wide: false, dictionary: en, name: 'Settings' },
    { column: 'expanded Chinese', wide: true, dictionary: zh, name: '设置' },
    { column: 'collapsed Chinese', wide: false, dictionary: zh, name: '设置' },
  ])('uses the locale name and accepts keyboard-style activation for the $column trigger', ({
    wide, dictionary, name,
  }) => {
    const { renderSlot } = mount({ wide, dictionary })
    const trigger = screen.getByRole('button', { name })
    expect(trigger.getAttribute('aria-label')).toBe(name)
    expect(renderSlot).toHaveBeenCalledWith('settings.trigger', { wide })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    trigger.focus()
    fireEvent.click(trigger, { detail: 0 })
    // The trigger opens the layout-owned window and mirrors its open state.
    expect(screen.getByRole('button', { name, expanded: true })).toBeTruthy()
  })

  it('shows outage, retry progress, and a two-second recovery confirmation', () => {
    vi.useFakeTimers()
    const mounted = mount()
    expect(screen.queryByRole('button', { name: 'Disconnected, reconnect now' })).toBeNull()

    mounted.setConnectionState('disconnected')
    const indicator = screen.getByRole('button', { name: 'Disconnected, reconnect now' })
    expect(indicator.textContent).toContain('Disconnected')
    expect(indicator.hasAttribute('title')).toBe(false)
    expect(indicator.querySelector('svg')).toBeTruthy()
    fireEvent.click(indicator)
    expect(mounted.reconnect).toHaveBeenCalledOnce()

    mounted.setConnectionState('connecting')
    expect(screen.getByRole('button', { name: 'Reconnecting, reconnect now' }).textContent)
      .toContain('Reconnecting...')

    // An attempt that resolves instantly still shows the connecting pill for
    // its 800ms minimum before the confirmation replaces it.
    mounted.setConnectionState('connected')
    expect(screen.queryByRole('status')).toBeNull()
    act(() => { vi.advanceTimersByTime(800) })
    expect(screen.getByRole('status', { name: 'Connected' })).toBeTruthy()
    // The confirmation window is measured from visibility, not the transition.
    act(() => { vi.advanceTimersByTime(1_999) })
    expect(screen.getByRole('status', { name: 'Connected' })).toBeTruthy()
    // The confirmation window closes at 2s, then the pill fades for 150ms.
    act(() => { vi.advanceTimersByTime(1) })
    act(() => { vi.advanceTimersByTime(150) })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('keeps the attempt label steady through the hold and confirms for the full window', () => {
    vi.useFakeTimers()
    const mounted = mount({ dictionary: zh })
    mounted.setConnectionState('connecting')
    const attempt = screen.getByRole('button', { name: '连接中断，正在重试，点击立即重连' })
    expect(attempt.textContent).toContain('重新连接中')
    fireEvent.click(attempt)
    expect(mounted.reconnect).toHaveBeenCalledOnce()
    expect(attempt.textContent).toContain('重新连接中')
    // An attempt that resolves mid-hold keeps its label until the hold ends.
    act(() => { vi.advanceTimersByTime(100) })
    mounted.setConnectionState('connected')
    expect(screen.getByRole('button', { name: '连接中断，正在重试，点击立即重连' }).textContent)
      .toContain('重新连接中')
    act(() => { vi.advanceTimersByTime(700) })
    expect(screen.getByRole('status', { name: '连接成功' })).toBeTruthy()
    // The full two-second confirmation follows the delayed appearance.
    act(() => { vi.advanceTimersByTime(1_999) })
    expect(screen.getByRole('status', { name: '连接成功' })).toBeTruthy()
    act(() => { vi.advanceTimersByTime(1) })
    act(() => { vi.advanceTimersByTime(150) })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('skips the hold when the attempt already stayed visible long enough', () => {
    vi.useFakeTimers()
    const mounted = mount()
    mounted.setConnectionState('connecting')
    act(() => { vi.advanceTimersByTime(800) })
    mounted.setConnectionState('connected')
    expect(screen.getByRole('status', { name: 'Connected' })).toBeTruthy()
    act(() => { vi.advanceTimersByTime(2_000) })
    act(() => { vi.advanceTimersByTime(150) })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('keeps the reconnect indicator out of the collapsed rail', () => {
    mount({ wide: false, connectionState: 'disconnected' })
    expect(screen.queryByRole('button', { name: 'Disconnected, reconnect now' })).toBeNull()
  })
})

describe('SettingsRoot window state', () => {
  it('exposes the settings-window open state through aria-expanded', () => {
    mount({ settingsOpen: true })
    const trigger = screen.getByRole('button', { name: 'Settings' })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
  })

  it('hands the rail state to the trigger seat', () => {
    const { renderSlot } = mount({ wide: false })
    expect(renderSlot).toHaveBeenCalledWith('settings.trigger', { wide: false })
  })
})

describe('SettingsRoot onboarding', () => {
  it('mounts onboarding steps in order and transfers ownership only on completion', () => {
    const mounted = mount()
    const { renderSlot } = mounted
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
    expect(mounted.openSection).toHaveBeenCalledWith('models')
    expect(mounted.openWindow).not.toHaveBeenCalled()

    cleanup()
    const inactive = mount({ onboardingActive: false }).renderSlot.mock.calls
      .filter(call => call[0] === 'settings.onboarding')
    expect(inactive).toHaveLength(0)
  })

  it('keeps onboarding active before a main Session is retained', () => {
    const { renderSlot } = mount({ mainView: false })

    expect(renderSlot.mock.calls.some(call => call[0] === 'settings.onboarding')).toBe(true)
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

})

const unusedHook = (() => { throw new Error('unused by the settings shells') }) as never

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
      ((key: string, _owner: unknown, opts?: { only?: string }) => {
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
      useSessionStatus,
      usePanelInfo, useSessionRetainInfo: () => undefined, useResource,
      useWorkspaces: unusedHook,
      ...allowAllAccess,
      t: ((key: string) => (key === 'title' ? '设置' : key)) as never,
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

  it('carries non-modal dialog semantics named from the settings copy', () => {
    mount()
    const dialog = screen.getByRole('dialog', { name: '设置' })
    // Window semantics, not modal behavior: assistive tech may leave the
    // surface, and the attribute says so explicitly.
    expect(dialog.getAttribute('aria-modal')).toBe('false')
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

  it('scrolls a focused nav cell into view', () => {
    mount()
    const models = screen.getByRole('button', { name: 'Models' })
    fireEvent.focus(models)
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest', inline: 'nearest' })
    expect(scrollIntoView.mock.instances.at(-1)).toBe(models)
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
        { id: 'archived-sessions', order: 40, label: 'Archived sessions' },
        { id: 'contributed', order: 50, label: 'Contributed' },
      ],
    })
    // Each product glyph names its sprite symbol id in data-icon.
    const glyphs = ['General', 'Models', 'Agent presets', 'Plugins', 'Archived sessions', 'Contributed']
      .map(name => screen.getByRole('button', { name }).querySelector('svg')?.getAttribute('data-icon'))

    expect(glyphs.every(glyph => glyph !== undefined && glyph !== '')).toBe(true)
    // The five ids the shell names get their own glyph; every other section —
    // including one this package never heard of — shares the gear.
    expect(new Set(glyphs.slice(0, 5)).size).toBe(5)
    expect(glyphs[5]).toBe(glyphs[0])
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

it('explicitly reopens one onboarding editor during an existing session', () => {
  const { renderSlot } = mount({ onboardingActive: false })
  const launcher = renderSlot.mock.calls.find(call => call[0] === 'settings.launcher')
  act(() => { if (typeof launcher?.[1] === 'object' && launcher[1] !== null && 'openOnboarding' in launcher[1] && typeof launcher[1].openOnboarding === 'function') launcher[1].openOnboarding('credential') })
  const call = renderSlot.mock.calls.filter(call => call[0] === 'settings.onboarding').at(-1)
  expect(call?.[1]).toMatchObject({ stepId: 'credential', explicit: true })
  act(() => { (call?.[1] as { complete: () => void }).complete() })
  renderSlot.mockClear()
  expect(screen.queryByTestId('onboarding')).toBeNull()
})

it('opens the settings window from the contributed sidebar launcher and mirrors its open state', () => {
  const { renderSlot, openWindow } = mount()
  const launcher = renderSlot.mock.calls.find(call => call[0] === 'settings.launcher')!
  expect(launcher[1]).toMatchObject({ settingsOpen: false })
  act(() => { if (typeof launcher[1] === 'object' && launcher[1] !== null && 'openSettings' in launcher[1] && typeof launcher[1].openSettings === 'function') launcher[1].openSettings() })
  expect(openWindow).toHaveBeenCalledOnce()
  expect(renderSlot.mock.calls.filter(call => call[0] === 'settings.launcher').at(-1)?.[1]).toMatchObject({ settingsOpen: true })
})

it('shows the effective settings binding on focus and exposes it to assistive technology', () => {
  mount({ shortcuts: [{ id: 'settings.open' as ShortcutCommandId, label: 'Open settings', aliases: [], keys: ['⌘', ','], aria: 'Meta+,', binding: { code: 'Comma', modifiers: ['meta'] }, modified: false, conflicts: [], issue: null }] })
  const trigger = screen.getByRole('button', { name: 'Settings' })
  expect(trigger.getAttribute('aria-keyshortcuts')).toBe('Meta+,')
  fireEvent.focus(trigger)
  expect(screen.getByRole('tooltip').getAttribute('aria-label')).toBe('Settings ⌘ ,')
})

it('passes current Settings key labels to the launcher and removes them when unbound', () => {
  const row: ShortcutCatalogEntry = { id: 'settings.open' as ShortcutCommandId, label: 'Open settings', aliases: [], keys: ['⌘', ','], aria: 'Meta+,', binding: { code: 'Comma', modifiers: ['meta'] }, modified: false, conflicts: [], issue: null }
  const { renderSlot, setShortcuts } = mount({ shortcuts: [row] })
  const launcher = () => renderSlot.mock.calls.filter(call => call[0] === 'settings.launcher').at(-1)?.[1]
  expect(launcher()).toMatchObject({ settingsShortcut: { keys: ['⌘', ','], aria: 'Meta+,' } })

  setShortcuts([{ ...row, keys: ['Ctrl', 'Shift', 'S'], aria: 'Control+Shift+S', binding: { code: 'KeyS', modifiers: ['control', 'shift'] }, modified: true }])
  expect(launcher()).toMatchObject({ settingsShortcut: { keys: ['Ctrl', 'Shift', 'S'], aria: 'Control+Shift+S' } })

  setShortcuts([{ ...row, keys: [], aria: undefined, binding: null, modified: true }])
  expect(launcher()).not.toHaveProperty('settingsShortcut')
})
