/** Terminal disposal acknowledgements and per-session in-flight ownership over a mocked Remote. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { createTerminalSessionDisposer } from '../src/client/terminal-session-disposal.ts'

type GuiTerminal = Pick<ClientRemote['guiTerminal'], 'dispose'>
type DisposalResult = Awaited<ReturnType<GuiTerminal['dispose']>>

const receipt = { ok: true, value: { disposed: true } } satisfies DisposalResult

describe('terminal Session disposal', () => {
  it('addresses the requested session and resolves void only after its Remote acknowledgement', async () => {
    const acknowledgement = Promise.withResolvers<DisposalResult>()
    const called = Promise.withResolvers<undefined>()
    const dispose = vi.fn<GuiTerminal['dispose']>().mockImplementation(() => {
      called.resolve(undefined)
      return acknowledgement.promise
    })
    const disposeSession = createTerminalSessionDisposer({ dispose })
    const settled = vi.fn()
    const operation = disposeSession('terminal-one').then(settled)
    onTestFinished(async () => {
      acknowledgement.resolve(receipt)
      await operation
    })

    await called.promise
    expect(dispose).toHaveBeenCalledExactlyOnceWith({ sessionId: 'terminal-one' })
    expect(settled).not.toHaveBeenCalled()
    acknowledgement.resolve(receipt)
    await expect(operation).resolves.toBeUndefined()
    expect(settled).toHaveBeenCalledExactlyOnceWith(undefined)
  })

  it('shares an in-flight disposal for concurrent calls addressing the same session', async () => {
    const acknowledgement = Promise.withResolvers<DisposalResult>()
    const called = Promise.withResolvers<undefined>()
    const dispose = vi.fn<GuiTerminal['dispose']>().mockImplementation(() => {
      called.resolve(undefined)
      return acknowledgement.promise
    })
    const disposeSession = createTerminalSessionDisposer({ dispose })
    const first = disposeSession('terminal-one')
    const second = disposeSession('terminal-one')
    onTestFinished(async () => {
      acknowledgement.resolve(receipt)
      await Promise.all([first, second])
    })

    await called.promise
    expect(dispose).toHaveBeenCalledExactlyOnceWith({ sessionId: 'terminal-one' })
    acknowledgement.resolve(receipt)
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('allows another session to finish while the first session awaits acknowledgement', async () => {
    const acknowledgement = Promise.withResolvers<DisposalResult>()
    const called = Promise.withResolvers<undefined>()
    const dispose = vi.fn<GuiTerminal['dispose']>().mockImplementation(({ sessionId }) => {
      if (sessionId === 'terminal-one') {
        called.resolve(undefined)
        return acknowledgement.promise
      }
      return Promise.resolve(receipt)
    })
    const disposeSession = createTerminalSessionDisposer({ dispose })
    const settled = vi.fn()
    const first = disposeSession('terminal-one').then(settled)
    onTestFinished(async () => {
      acknowledgement.resolve(receipt)
      await first
    })

    await called.promise
    await expect(disposeSession('terminal-two')).resolves.toBeUndefined()
    expect(dispose.mock.calls).toEqual([
      [{ sessionId: 'terminal-one' }],
      [{ sessionId: 'terminal-two' }],
    ])
    expect(settled).not.toHaveBeenCalled()
    acknowledgement.resolve(receipt)
    await first
  })

  it('rejects concurrent callers with the exact Remote error and permits a later retry', async () => {
    const acknowledgement = Promise.withResolvers<DisposalResult>()
    const called = Promise.withResolvers<undefined>()
    const denied = new RemoteError('terminal/unavailable', 'The terminal is unavailable', {})
    const dispose = vi.fn<GuiTerminal['dispose']>()
      .mockImplementationOnce(() => {
        called.resolve(undefined)
        return acknowledgement.promise
      })
      .mockResolvedValue(receipt)
    const disposeSession = createTerminalSessionDisposer({ dispose })
    const first = disposeSession('terminal-one')
    const second = disposeSession('terminal-one')
    const outcomes = Promise.all([
      expect(first).rejects.toBe(denied),
      expect(second).rejects.toBe(denied),
    ])
    onTestFinished(async () => {
      acknowledgement.resolve({ ok: false, error: denied })
      await Promise.allSettled([first, second])
    })

    await called.promise
    expect(dispose).toHaveBeenCalledTimes(1)
    acknowledgement.resolve({ ok: false, error: denied })
    await outcomes
    await expect(disposeSession('terminal-one')).resolves.toBeUndefined()
    expect(dispose.mock.calls).toEqual([
      [{ sessionId: 'terminal-one' }],
      [{ sessionId: 'terminal-one' }],
    ])
  })

  it('turns a synchronous Remote throw into a rejection and permits retry', async () => {
    const failure = new Error('Remote transport is unavailable')
    const dispose = vi.fn<GuiTerminal['dispose']>()
      .mockImplementationOnce(() => { throw failure })
      .mockResolvedValueOnce(receipt)
    const disposeSession = createTerminalSessionDisposer({ dispose })

    await expect(disposeSession('terminal-one')).rejects.toBe(failure)
    await expect(disposeSession('terminal-one')).resolves.toBeUndefined()
    expect(dispose).toHaveBeenCalledTimes(2)
  })

  it('preserves a rejected Remote call and releases the session for retry', async () => {
    const failure = new Error('Remote transport disconnected')
    const dispose = vi.fn<GuiTerminal['dispose']>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(receipt)
    const disposeSession = createTerminalSessionDisposer({ dispose })

    await expect(disposeSession('terminal-one')).rejects.toBe(failure)
    await expect(disposeSession('terminal-one')).resolves.toBeUndefined()
    expect(dispose).toHaveBeenCalledTimes(2)
    expect(dispose).toHaveBeenNthCalledWith(1, { sessionId: 'terminal-one' })
    expect(dispose).toHaveBeenNthCalledWith(2, { sessionId: 'terminal-one' })
  })
})
