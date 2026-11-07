// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import type { ChatNodeViewProps } from '../src/client/contract/slots.ts'
import { SentMessageActions } from '../src/client/chat/SentMessageActions.tsx'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { en } from '../src/client/locale.ts'

afterEach(cleanup)
const t: ChatNodeViewProps['t'] = makeTranslate(en, commonEn)

function fixture({ running = false, allowed = true, durable = true } = {}) {
  const removeFrom = vi.fn(async (_seq: number) => {})
  const props: Parameters<typeof SentMessageActions>[0] = {
    node: {
      key: 'sent-message', id: 'sent-message', kind: 'user', target: 'chat', anchorSeq: 7,
      location: { kind: 'session' }, visibility: 'visible',
      data: { kind: 'user', seq: 7, time: 1000, content: [], source: { kind: 'user' },
        ...(durable ? { messageId: 'sent-message' as MessageId } : {}),
      },
    },
    text: 'Replace this request', t, removeFrom, reportRemoveFailure: vi.fn(),
    useSession: select => select({ running, removed: false } as never),
    useAccess: () => allowed,
  }
  return { props, removeFrom }
}

function openRemoval() {
  fireEvent.click(screen.getByRole('button', { name: 'More message actions' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from here' }))
}

describe('sent-message tail removal', () => {
  it('requires acknowledgement, preserves copy, and submits the exact durable message once', async () => {
    const { props, removeFrom } = fixture()
    render(<SentMessageActions {...props} />)
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy()
    openRemoval()
    expect(screen.getByText(en['message.remove.description'])).toBeTruthy()
    expect({
      action: en['message.remove.action'],
      title: screen.getByRole('dialog').querySelector('h2')?.textContent,
      description: en['message.remove.description'],
      acknowledge: en['message.remove.acknowledge'],
      confirm: en['message.remove.confirm'],
    }).toMatchInlineSnapshot(`
      {
        "acknowledge": "I understand that the original conversation stays unchanged",
        "action": "Remove from here",
        "confirm": "Create branch",
        "description": "Continue in a new conversation without this message and everything after it. The original conversation stays unchanged. You can send a replacement message.",
        "title": "Continue in a new conversation?",
      }
    `)
    const confirm = screen.getByRole('button', { name: 'Create branch' })
    expect(confirm.hasAttribute('disabled')).toBe(true)
    fireEvent.click(confirm)
    expect(removeFrom).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    await waitFor(() => { expect(removeFrom).toHaveBeenCalledExactlyOnceWith(7) })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('reports unexpected callback rejection and releases the pending confirmation', async () => {
    const { props } = fixture()
    const error = new Error('unexpected callback rejection')
    const reportRemoveFailure = vi.fn()
    render(<SentMessageActions {...props} removeFrom={() => Promise.reject(error)} reportRemoveFailure={reportRemoveFailure} />)
    openRemoval()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Create branch' }))
    await waitFor(() => { expect(reportRemoveFailure).toHaveBeenCalledExactlyOnceWith(error) })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('cancels without forking and resets acknowledgement on reopening', () => {
    const { props, removeFrom } = fixture()
    render(<SentMessageActions {...props} />)
    openRemoval()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    openRemoval()
    expect(screen.getByRole('button', { name: 'Create branch' }).hasAttribute('disabled')).toBe(true)
    expect(removeFrom).not.toHaveBeenCalled()
  })

  it('keeps running actions unavailable and rechecks state while confirmation is open', () => {
    const { props, removeFrom } = fixture()
    const view = render(<SentMessageActions {...props} />)
    openRemoval()
    fireEvent.click(screen.getByRole('checkbox'))
    view.rerender(<SentMessageActions {...props} useSession={fixture({ running: true }).props.useSession} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create branch' }))
    expect(removeFrom).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'More message actions' }))
    expect(screen.getByRole('menuitem', { name: 'Remove from here' }).hasAttribute('disabled')).toBe(true)
  })

  it.each([{ allowed: false }, { durable: false }])('hides removal without access or durable identity: %o', (options) => {
    render(<SentMessageActions {...fixture(options).props} />)
    expect(screen.queryByRole('button', { name: 'More message actions' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy()
  })
})
