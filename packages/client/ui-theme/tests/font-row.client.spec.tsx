// @vitest-environment jsdom
/** Font panel behavior: per-section previews, family menus driving the
 * family setters, steppers driving the scale/size setters with clamping at
 * the range edges. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createSnapshotStore, type SessionListState, type WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { FontRow } from '../src/client/FontRow.tsx'
import type { FontRowComponentProps } from '../src/client/FontRow.tsx'
import { DEFAULT_SELECTION } from '../src/client/font-runtime.ts'
import { createFontRowStore } from '../src/client/font-store.ts'

afterEach(cleanup)

const COPY: Record<string, string> = {
  'font.title': 'Fonts',
  'font.interface': 'Interface',
  'font.chat': 'Chat',
  'font.code': 'Code',
  'font.terminal': 'Terminal',
  'font.scale': 'Zoom',
  'font.size': 'Font size',
  'font.previewUi': 'Settings, sidebar, and window chrome',
  'font.previewChat': 'Conversation messages and composer',
}

function emptySessions() {
  const store = createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined })
  return bindSnapshotSelector(store)
}
function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceListState>({
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  })
  return bindSnapshotSelector(store)
}

function mount(selection: Partial<typeof DEFAULT_SELECTION> = {}) {
  const store = createFontRowStore().create()
  store.actions.sync({ ...DEFAULT_SELECTION, ...selection }, 0)
  const setters = {
    setUiFamily: vi.fn(),
    setUiScale: vi.fn(),
    setChatScale: vi.fn(),
    setMonoFont: vi.fn(),
    setMonoSize: vi.fn(),
    setTermSize: vi.fn(),
  }
  const props: FontRowComponentProps = {
    useSessions: emptySessions(),
    useWorkspaces: emptyWorkspaces(),
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    t: (key: string) => COPY[key] ?? key,
    ...setters,
  }
  render(<FontRow {...props} />)
  return setters
}

/** Stepper buttons of the nth section sharing one aria-label (Zoom appears
 * on Interface and Chat; Font size on Code and Terminal). */
function stepperOf(label: string, index = 0): [HTMLButtonElement, HTMLButtonElement] {
  const group = screen.getAllByRole('group').filter(
    group => group.getAttribute('aria-label') === label)[index]
  if (group === undefined) throw new Error(`stepper ${label}[${index}] missing`)
  return within(group).getAllByRole('button') as [HTMLButtonElement, HTMLButtonElement]
}

describe('FontRow', () => {
  it('renders the four sections with their current values', () => {
    mount({ uiFamily: 'georgia', uiScale: 120, monoSize: 18, termSize: 16 })
    expect(screen.getByText('Fonts')).toBeTruthy()
    for (const label of ['Interface', 'Chat', 'Code', 'Terminal']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    expect(screen.getByText('120%')).toBeTruthy()
    expect(screen.getByText('18')).toBeTruthy()
    expect(screen.getByText('16')).toBeTruthy()
  })

  it('previews the interface section in the selected family', () => {
    mount({ uiFamily: 'georgia' })
    const preview = screen.getByText(COPY['font.previewUi']!)
    expect(preview.style.getPropertyValue('font-family')).toContain('Georgia')
  })

  it('previews the code section in the selected family and size', () => {
    mount({ monoFont: 'menlo', monoSize: 18 })
    const preview = screen.getByText('fn main() { println!("ok") }')
    expect(preview.style.getPropertyValue('font-family')).toContain('Menlo')
    expect(preview.style.getPropertyValue('font-size')).toBe('18px')
  })

  it('scale steppers drive setUiScale/setChatScale and clamp at the range', () => {
    const setters = mount({ uiScale: 80, chatScale: 140 })
    const [uiDown, uiUp] = stepperOf('Zoom')
    expect(uiDown.disabled).toBe(true)
    fireEvent.click(uiUp)
    expect(setters.setUiScale).toHaveBeenCalledWith(81)
    // The second Zoom stepper (chat) is at its ceiling.
    const [chatDown, chatUp] = stepperOf('Zoom', 1)
    expect(chatUp.disabled).toBe(true)
    fireEvent.click(chatDown)
    expect(setters.setChatScale).toHaveBeenCalledWith(139)
  })

  it('size steppers drive setMonoSize/setTermSize and clamp at the range', () => {
    const setters = mount({ monoSize: 24, termSize: 10 })
    const [monoDown, monoUp] = stepperOf('Font size')
    expect(monoUp.disabled).toBe(true)
    fireEvent.click(monoDown)
    expect(setters.setMonoSize).toHaveBeenCalledWith(23)
    const [termDown, termUp] = stepperOf('Font size', 1)
    expect(termDown.disabled).toBe(true)
    fireEvent.click(termUp)
    expect(setters.setTermSize).toHaveBeenCalledWith(11)
  })

  it('family menu selections drive setUiFamily and setMonoFont', async () => {
    const setters = mount()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /System/ }))
    })
    await act(async () => {
      fireEvent.click(screen.getByText('Georgia'))
    })
    expect(setters.setUiFamily).toHaveBeenCalledWith('georgia')
    cleanup()
    const again = mount()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Monaco/ }))
    })
    await act(async () => {
      fireEvent.click(screen.getByText('Fira Code'))
    })
    expect(again.setMonoFont).toHaveBeenCalledWith('fira-code')
  })
})
