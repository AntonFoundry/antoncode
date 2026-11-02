// @vitest-environment jsdom
/** Font panel behavior: per-section previews, family menus driving the
 * family setters, steppers driving the scale/size setters with clamping at
 * the range edges. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { allowAllAccess, bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { FontRow } from '../src/client/FontRow.tsx'
import type { FontRowComponentProps } from '../src/client/FontRow.tsx'
import { DEFAULT_SELECTION } from '../src/client/font-runtime.ts'
import { createFontRowStore } from '../src/client/font-store.ts'

const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })
const useSessionStatus: GlobalStandardProps['useSessionStatus'] = selector => selector(new Map())

afterEach(cleanup)

const COPY: Record<string, string> = {
  'font.title': 'Fonts',
  'font.system': 'System',
  'font.interface': 'Interface',
  'font.chat': 'Chat',
  'font.code': 'Code',
  'font.terminal': 'Terminal',
  'font.size': 'Font size',
  'font.previewUi': 'Settings, sidebar, and window chrome',
  'font.previewChat': 'Conversation messages and composer',
}

function emptySessions() {
  const store = createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} })
  return bindSnapshotSelector(store)
}
function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceSnapshot>({
    items: [], worktrees: { byRepo: {}, prefs: {}, namesByWorkspaceId: {} },
    archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  })
  return bindSnapshotSelector(store)
}

function mount(selection: Partial<typeof DEFAULT_SELECTION> = {}, uiFonts: readonly string[] = []) {
  const store = createFontRowStore().create()
  store.actions.sync({ ...DEFAULT_SELECTION, ...selection }, 0)
  const setters = {
    setUiFamily: vi.fn(),
    setUiSize: vi.fn(),
    setChatSize: vi.fn(),
    setMonoFont: vi.fn(),
    setMonoSize: vi.fn(),
    setTermSize: vi.fn(),
  }
  const props: FontRowComponentProps = {
    useSessions: emptySessions(),
    useSessionStatus, usePanelInfo, useSessionRetainInfo: () => undefined, useResource,
    ...allowAllAccess,
    useWorkspaces: emptyWorkspaces(),
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    t: (key: string) => COPY[key] ?? key,
    uiFonts,
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
  it('renders the four sections with their current px values', () => {
    mount({ uiFamily: 'Georgia', uiSize: 17, monoSize: 18, termSize: 12 })
    expect(screen.getByText('Fonts')).toBeTruthy()
    for (const label of ['Interface', 'Chat', 'Code', 'Terminal']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    // Every section is a px stepper; interface shows 17px, code 18px, terminal 16px.
    expect(screen.getByText('17px')).toBeTruthy()
    expect(screen.getByText('18px')).toBeTruthy()
    expect(screen.getByText('12px')).toBeTruthy()
  })

  it('previews the interface section in the selected family stack', () => {
    mount({ uiFamily: 'Georgia' })
    const preview = screen.getByText(COPY['font.previewUi']!)
    // jsdom serializes the quoted family with double quotes.
    expect(preview.style.getPropertyValue('font-family')).toContain('"Georgia"')
  })

  it('previews the code section in the selected family and size', () => {
    mount({ monoFont: 'menlo', monoSize: 18 })
    const preview = screen.getByText('fn main() { println!("ok") }')
    expect(preview.style.getPropertyValue('font-family')).toContain('Menlo')
    expect(preview.style.getPropertyValue('font-size')).toBe('18px')
  })

  it('interface/chat steppers drive setUiSize/setChatSize and clamp at the range', () => {
    const setters = mount({ uiSize: 12, chatSize: 22 })
    const [uiDown, uiUp] = stepperOf('Font size')
    expect(uiDown.disabled).toBe(true)
    fireEvent.click(uiUp)
    expect(setters.setUiSize).toHaveBeenCalledWith(13)
    // The second stepper (chat) is at its ceiling.
    const [chatDown, chatUp] = stepperOf('Font size', 1)
    expect(chatUp.disabled).toBe(true)
    fireEvent.click(chatDown)
    expect(setters.setChatSize).toHaveBeenCalledWith(21)
  })

  it('code/terminal steppers drive setMonoSize/setTermSize and clamp at the range', () => {
    const setters = mount({ monoSize: 24, termSize: 10 })
    const [monoDown, monoUp] = stepperOf('Font size', 2)
    expect(monoUp.disabled).toBe(true)
    fireEvent.click(monoDown)
    expect(setters.setMonoSize).toHaveBeenCalledWith(23)
    const [termDown, termUp] = stepperOf('Font size', 3)
    expect(termDown.disabled).toBe(true)
    fireEvent.click(termUp)
    expect(setters.setTermSize).toHaveBeenCalledWith(11)
  })

  it('interface menu lists the installed system families and drives setUiFamily', async () => {
    const setters = mount({ uiFamily: 'system' }, ['Georgia', 'Helvetica Neue'])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /System/ }))
    })
    await act(async () => {
      fireEvent.click(screen.getByText('Georgia'))
    })
    expect(setters.setUiFamily).toHaveBeenCalledWith('Georgia')
  })

  it('the interface menu filter narrows the family list', async () => {
    mount({ uiFamily: 'system' }, ['Georgia', 'Helvetica Neue', 'Futura'])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /System/ }))
    })
    const filter = screen.getByPlaceholderText('Filter…') as HTMLInputElement
    await act(async () => {
      fireEvent.change(filter, { target: { value: 'hel' } })
    })
    expect(screen.getByText('Helvetica Neue')).toBeTruthy()
    expect(screen.queryByText('Georgia')).toBeNull()
  })

  it('family menu selections drive setMonoFont', async () => {
    const setters = mount()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Monaco/ }))
    })
    await act(async () => {
      fireEvent.click(screen.getByText('Fira Code'))
    })
    expect(setters.setMonoFont).toHaveBeenCalledWith('fira-code')
  })
})
