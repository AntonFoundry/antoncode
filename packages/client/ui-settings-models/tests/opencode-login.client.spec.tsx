// @vitest-environment jsdom
/** Models subscription login dialogs and their authenticated Remote operations. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpencodeLoginDialog } from '../src/client/OpencodeLoginDialog.tsx'
import { ClaudeLoginDialog } from '../src/client/ClaudeLoginDialog.tsx'
import { createModelsOperations, type ModelsOperations, type OpencodeLoginOperations, type ClaudeLoginOperations } from '../src/client/operations.ts'
import { en } from '../src/client/locales.ts'

const t = (key: keyof typeof en): string => en[key]
afterEach(() => { cleanup(); vi.useRealTimers() })

function credentials(configured = false): Pick<ModelsOperations, 'describeCredential' | 'removeCredential'> {
  return {
    describeCredential: vi.fn(async () => ({ kind: 'described' as const, configured })),
    removeCredential: vi.fn(async () => undefined),
  }
}

function opencodeFlow(): OpencodeLoginOperations {
  return {
    start: vi.fn(async () => ({ kind: 'login' as const, login: {
      loginId: 'open-1', status: 'pending' as const, userCode: 'ABCD-1234',
      verificationUri: 'https://opencode.example/device',
    } })),
    status: vi.fn(async () => ({ kind: 'login' as const, login: {
      loginId: 'open-1', status: 'awaiting-org' as const,
      orgs: [{ id: 'org-1', name: 'Workspace One' }],
    } })),
    select: vi.fn(async () => ({ kind: 'login' as const, login: { loginId: 'open-1', status: 'done' as const } })),
    cancel: vi.fn(async () => ({ kind: 'login' as const, login: { loginId: 'open-1', status: 'cancelled' as const } })),
  }
}

function claudeFlow(): ClaudeLoginOperations {
  return {
    start: vi.fn(async () => ({ kind: 'login' as const, login: {
      loginId: 'claude-1', status: 'pending' as const,
      verificationUri: 'https://claude.example/authorize',
    } })),
    submit: vi.fn(async () => ({ kind: 'login' as const, login: { loginId: 'claude-1', status: 'done' as const } })),
    cancel: vi.fn(async () => ({ kind: 'login' as const, login: { loginId: 'claude-1', status: 'cancelled' as const } })),
  }
}

describe('OpenCode login', () => {
  it('shows the device code, lets the user select a workspace, and reports completion', async () => {
    const login = opencodeFlow()
    const onClose = vi.fn()
    render(<OpencodeLoginDialog operations={credentials()} login={login} t={t} readOnly={false} onClose={onClose} />)
    fireEvent.click(await screen.findByRole('button', { name: en.opencodeLogin }))
    expect(await screen.findByText('ABCD-1234')).toBeTruthy()
    expect(screen.getByRole('link', { name: en.opencodeLoginOpenLink }).getAttribute('href')).toBe('https://opencode.example/device')
    await waitFor(() => { expect(screen.getByText('Workspace One')).toBeTruthy() }, { timeout: 3000 })
    fireEvent.click(screen.getByRole('radio', { name: 'Workspace One' }))
    fireEvent.click(screen.getByRole('button', { name: en.opencodeLoginConfirm }))
    await waitFor(() => { expect(login.select).toHaveBeenCalledWith('open-1', 'org-1') })
    expect(await screen.findByText(en.opencodeLoginDone)).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: en.close }).at(-1)!)
    expect(onClose).toHaveBeenCalledWith(true)
  })

  it('shows an existing session and removes its credential on logout', async () => {
    const operations = credentials(true)
    const onClose = vi.fn()
    render(<OpencodeLoginDialog operations={operations} login={opencodeFlow()} t={t} readOnly={false} onClose={onClose} />)
    expect(await screen.findByText(en.opencodeLoginActive)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.opencodeLoginLogout }))
    await waitFor(() => { expect(operations.removeCredential).toHaveBeenCalledWith('OPENCODE_ZEN_OAUTH') })
    expect(onClose).toHaveBeenCalledWith(true)
  })
})

describe('Claude login', () => {
  it('submits the pasted approval code and reports completion', async () => {
    const login = claudeFlow()
    render(<ClaudeLoginDialog operations={credentials()} login={login} t={t} readOnly={false} onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: en.claudeLogin }))
    expect(await screen.findByRole('link', { name: en.claudeLoginOpenLink })).toHaveProperty('href', 'https://claude.example/authorize')
    fireEvent.change(screen.getByLabelText(en.claudeLoginPasteLabel), { target: { value: 'code#state' } })
    fireEvent.click(screen.getByRole('button', { name: en.claudeLoginSubmit }))
    await waitFor(() => { expect(login.submit).toHaveBeenCalledWith('claude-1', 'code#state') })
    expect(await screen.findByText(en.claudeLoginDone)).toBeTruthy()
  })

  it('shows the active subscription without starting a new login', async () => {
    const login = claudeFlow()
    render(<ClaudeLoginDialog operations={credentials(true)} login={login} t={t} readOnly={false} onClose={() => {}} />)
    expect(await screen.findByText(en.claudeLoginActive)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.claudeLoginRelogin })).toBeTruthy()
    expect(login.start).not.toHaveBeenCalled()
  })
})

it('maps the OAuth Remote answers into login operations and keeps refusal messages', async () => {
  const oauth = {
    startOpencode: vi.fn(async () => ({ ok: true as const, value: { loginId: 'open-1', status: 'pending' as const } })),
    statusOpencode: vi.fn(async () => ({ ok: false as const, error: { message: 'approval expired' } })),
    selectOpencode: vi.fn(async () => ({ ok: true as const, value: { loginId: 'open-1', status: 'done' as const } })),
    cancelOpencode: vi.fn(async () => ({ ok: true as const, value: { loginId: 'open-1', status: 'cancelled' as const } })),
    startClaude: vi.fn(async () => ({ ok: true as const, value: { loginId: 'claude-1', status: 'pending' as const } })),
    submitClaude: vi.fn(async () => ({ ok: true as const, value: { loginId: 'claude-1', status: 'done' as const } })),
    cancelClaude: vi.fn(async () => ({ ok: true as const, value: { loginId: 'claude-1', status: 'cancelled' as const } })),
  }
  const operations = createModelsOperations({ remote: { oauth } } as never)
  expect(await operations.opencodeLogin?.start()).toMatchObject({ kind: 'login', login: { loginId: 'open-1' } })
  expect(await operations.opencodeLogin?.status('open-1')).toEqual({ kind: 'refused', message: 'approval expired' })
  expect(await operations.opencodeLogin?.select('open-1', 'org')).toMatchObject({ kind: 'login', login: { status: 'done' } })
  expect(oauth.selectOpencode).toHaveBeenCalledWith('open-1', 'org')
  expect(await operations.claudeLogin?.submit('claude-1', 'code#state')).toMatchObject({ kind: 'login', login: { status: 'done' } })
  expect(oauth.submitClaude).toHaveBeenCalledWith('claude-1', 'code#state')
})
