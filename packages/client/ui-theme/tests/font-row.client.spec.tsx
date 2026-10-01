// @vitest-environment jsdom
/** FontRow behavior: preview in the selected family/size, family menu
 * selection drives setMonoFont, size stepper drives setMonoSize with range
 * clamping at the buttons. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createSnapshotStore, type SessionListState, type WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { FontRow } from '../src/client/FontRow.tsx'
import type { FontRowComponentProps } from '../src/client/FontRow.tsx'
import { createFontRowStore } from '../src/client/font-store.ts'

afterEach(cleanup)

const COPY: Record<string, string> = {
  'font.title': 'Fonts',
  'font.size': 'Font size',
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

function mount(monoFont = 'monaco', monoSize = 15) {
  const store = createFontRowStore().create()
  store.actions.sync(monoFont, monoSize, 0)
  const setMonoFont = vi.fn()
  const setMonoSize = vi.fn()
  const props: FontRowComponentProps = {
    useSessions: emptySessions(),
    useWorkspaces: emptyWorkspaces(),
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    t: (key: string) => COPY[key] ?? key,
    setMonoFont,
    setMonoSize,
  }
  render(<FontRow {...props} />)
  return { store, setMonoFont, setMonoSize }
}

describe('FontRow', () => {
  it('renders the title, active label, preview, and current size', () => {
    mount('menlo', 17)
    expect(screen.getByText('Fonts')).toBeTruthy()
    expect(screen.getByText('Menlo')).toBeTruthy()
    expect(screen.getByText('17')).toBeTruthy()
  })

  it('previews in the selected family and size', () => {
    mount('menlo', 17)
    const preview = screen.getByText('fn main() { println!("ok") }')
    expect(preview.style.getPropertyValue('font-size')).toBe('17px')
    expect(preview.style.getPropertyValue('font-family')).toContain('Menlo')
  })

  it('size stepper buttons drive setMonoSize and clamp at the range', () => {
    const { setMonoSize } = mount('monaco', 10)
    const stepper = screen.getByRole('group')
    const [down, up] = within(stepper).getAllByRole('button')
    expect(down.disabled).toBe(true)
    fireEvent.click(up)
    expect(setMonoSize).toHaveBeenCalledWith(11)
    cleanup()
    const mid = mount('monaco', 24)
    const stepButtons = within(screen.getByRole('group')).getAllByRole('button')
    expect(stepButtons[1]!.disabled).toBe(true)
    fireEvent.click(stepButtons[0]!)
    expect(mid.setMonoSize).toHaveBeenCalledWith(23)
  })

  it('family menu selection drives setMonoFont', async () => {
    const { setMonoFont } = mount('monaco', 15)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Monaco/ }))
    })
    await act(async () => {
      fireEvent.click(screen.getByText('Fira Code'))
    })
    expect(setMonoFont).toHaveBeenCalledWith('fira-code')
  })
})
