// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { Minibuffer } from '@deepseek-ai/dsh-client-ui-layout/src/client/Minibuffer.tsx'
import type { MinibufferCandidate } from '@deepseek-ai/dsh-client-ui-layout/src/client/Minibuffer.tsx'

/** Workspace-grouped candidates: two sessions under workspace A, one under B. */
function grouped(): MinibufferCandidate[] {
  return [
    { id: 'buffer:scratch', label: '*scratch*' },
    { id: 'buffer:session:s1', label: 'Session one', section: 'antoncode' },
    { id: 'buffer:session:s2', label: 'Session two', section: 'antoncode' },
    { id: 'buffer:session:s3', label: 'Session three', section: 'roadrash' },
  ]
}

describe('Minibuffer workspace sections', () => {
  // jsdom implements no layout: scrollIntoView does not exist, and the
  // minibuffer's active-row scroll-keep calls it on every mount. Stub it
  // globally; the scroll test asserts the calls.
  const scrollIntoView = vi.fn()
  beforeEach(() => {
    Element.prototype.scrollIntoView = scrollIntoView
  })
  afterEach(() => {
    cleanup()
    scrollIntoView.mockClear()
  })

  it('renders each section title once, above its group, as a non-row header', () => {
    const { container } = render(
      <Minibuffer prompt="Switch buffer" candidates={grouped()} onExecute={vi.fn()} onCancel={vi.fn()} />,
    )
    // The section titles render as divs (not candidate buttons) — two
    // workspaces, one header each, in first-appearance order.
    const buttons = [...container.querySelectorAll('button')]
    const headers = [...container.querySelectorAll('li > div')]
    expect(headers.map(h => h.textContent)).toEqual(['antoncode', 'roadrash'])
    // Every candidate is a button row; headers are not rows at all.
    expect(buttons.map(b => b.textContent)).toEqual(['*scratch*', 'Session one', 'Session two', 'Session three'])
  })

  it('motion steps candidate-to-candidate, skipping section headers', () => {
    const { container } = render(
      <Minibuffer prompt="Switch buffer" candidates={grouped()} onExecute={vi.fn()} onCancel={vi.fn()} />,
    )
    const input = container.querySelector('input')!
    const selected = (): string | undefined =>
      container.querySelector('button[data-selected]')?.textContent
    // Start on the first row; two downs land on "Session two" — the
    // workspace header between rows never takes a motion step.
    expect(selected()).toBe('*scratch*')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(selected()).toBe('Session one')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(selected()).toBe('Session two')
    // C-n is the same motion; C-p steps back over the header.
    fireEvent.keyDown(input, { key: 'n', ctrlKey: true })
    expect(selected()).toBe('Session three')
    fireEvent.keyDown(input, { key: 'p', ctrlKey: true })
    expect(selected()).toBe('Session two')
  })

  it('executes the highlighted session row; a header cannot be executed', () => {
    const onExecute = vi.fn()
    const { container } = render(
      <Minibuffer prompt="Switch buffer" candidates={grouped()} onExecute={onExecute} onCancel={vi.fn()} />,
    )
    const input = container.querySelector('input')!
    // Highlight the first session row and press Enter: the id is the
    // session-buffer id, never a workspace title.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onExecute).toHaveBeenCalledWith('buffer:session:s1')
  })

  it('filters by section text: a workspace name narrows to its sessions', () => {
    const { container } = render(
      <Minibuffer prompt="Switch buffer" candidates={grouped()} onExecute={vi.fn()} onCancel={vi.fn()} />,
    )
    const input = container.querySelector('input')!
    fireEvent.change(input, { target: { value: 'roadrash' } })
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons.map(b => b.textContent)).toEqual(['Session three'])
  })

  it('keeps the active row in view: motion scrolls the active row', () => {
    const many: MinibufferCandidate[] = Array.from({ length: 20 }, (_, i) => ({
      id: `buffer:session:s${i}`,
      label: `Session ${i}`,
      section: 'workspace',
    }))
    const { container } = render(
      <Minibuffer prompt="Switch buffer" candidates={many} onExecute={vi.fn()} onCancel={vi.fn()} />,
    )
    const input = container.querySelector('input')!
    scrollIntoView.mockClear()
    // Past the fold, motion must scroll the active row into view
    // ('nearest' — the theme-list behavior, shared by every prompt).
    for (let i = 0; i < 12; i++) fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(scrollIntoView).toHaveBeenCalled()
    expect(scrollIntoView.mock.calls.at(-1)?.[0]).toMatchObject({ block: 'nearest' })
  })

  it('preview fires with the active row id and null on cancel (theme-list contract)', () => {
    const onPreview = vi.fn()
    const { container } = render(
      <Minibuffer prompt="Load theme" candidates={grouped()} onExecute={vi.fn()} onCancel={vi.fn()} onPreview={onPreview} />,
    )
    const input = container.querySelector('input')!
    // Mount previews the first row; motion previews the new active row.
    expect(onPreview).toHaveBeenNthCalledWith(1, 'buffer:scratch')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(onPreview).toHaveBeenNthCalledWith(2, 'buffer:session:s1')
    // Cancel (C-g) previews null so the caller restores.
    fireEvent.keyDown(input, { key: 'g', ctrlKey: true })
    expect(onPreview).toHaveBeenLastCalledWith(null)
  })
})
