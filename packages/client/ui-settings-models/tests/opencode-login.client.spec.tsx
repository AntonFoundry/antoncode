// @vitest-environment jsdom
/** OpenCode login row button and dialog flow over a scripted wire face. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import {
  ModelsSection,
} from '../src/client/ModelsSection.tsx'
import { OpencodeLoginDialog } from '../src/client/OpencodeLoginDialog.tsx'
import { ClaudeLoginDialog } from '../src/client/ClaudeLoginDialog.tsx'

function OpencodeLoginDialogForTest(props: { api: ModelsSectionInjected['api'] }): React.JSX.Element {
  return (
    <OpencodeLoginDialog
      api={props.api}
      t={key => en[key]}
      readOnly={false}
      onClose={() => {}}
    />
  )
}
import type { ModelsSectionInjected } from '../src/client/ModelsSection.tsx'
import { ModelsSettingsStore } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t: ModelsSectionInjected['t'] = key => en[key]

let nextRpc = 0
function okValue<T>(value: T): { rpcId: string; result: { ok: true; value: T } } {
  nextRpc += 1
  return { rpcId: `r-${nextRpc}`, result: { ok: true, value } }
}

function wireNamespaces(): SettingsNamespaceView[] {
  return [
    {
      ns: 'llm-opencode',
      schema: JSON.parse(JSON.stringify(Schema.object({}).toJSON())) as unknown,
      value: {},
      applies: 'live',
      secrets: [],
      revision: 0,
    },
    {
      ns: 'llm-claude',
      schema: JSON.parse(JSON.stringify(Schema.object({
        profiles: Schema.dict(Schema.object({ note: Schema.string() })),
      }).toJSON())) as unknown,
      value: {},
      applies: 'live',
      secrets: [],
      revision: 0,
    },
  ]
}

interface FaceOverrides {
  oauthConfigured?: boolean
  claudeConfigured?: boolean
  oauthStatus?: (loginId: string) => { login: Record<string, unknown> }
}

function mountFace(overrides: FaceOverrides = {}): void {
  const cleared = new Set<string>()
  const api = {
    settings: {
      describe: vi.fn(() => Promise.resolve(okValue({ writable: true, hasDocument: false, namespaces: wireNamespaces() }))),
    },
    credentials: {
      describe: vi.fn((payload: { refs: string[] }) => Promise.resolve(okValue({
        credentials: Object.fromEntries(payload.refs.map(ref => [ref, {
          configured: (ref === 'OPENCODE_ZEN_OAUTH'
            ? (overrides.oauthConfigured ?? false)
            : ref === 'CLAUDE_CODE_OAUTH'
              ? (overrides.claudeConfigured ?? false)
              : false) && !cleared.has(ref),
          writable: true,
        }])),
      }))),
      set: vi.fn(() => Promise.resolve(okValue({}))),
      unset: vi.fn((payload: { ref: string }) => {
        cleared.add(payload.ref)
        return Promise.resolve(okValue({}))
      }),
    },
    llm: {
      providers: vi.fn(() => Promise.resolve(okValue({
        providers: [
          { provider: 'opencode-free', displayName: 'OpenCode Free', settingsNs: 'llm-opencode', settingsPath: [], active: true },
          { provider: 'claude-code', displayName: 'Claude Code', settingsNs: 'llm-claude', settingsPath: [], active: true },
        ],
      }))),
      models: vi.fn(() => Promise.resolve(okValue({ groups: [], failures: [] }))),
    },
    opencodeOAuth: {
      start: vi.fn(() => Promise.resolve(okValue({
        login: {
          loginId: 'login_1',
          status: 'pending',
          userCode: 'ABCD-1234',
          verificationUri: 'https://opencode.ai/device?code=ABCD-1234',
          intervalSeconds: 2,
          expiresInSeconds: 600,
        },
      }))),
      status: vi.fn((payload: { loginId: string }) => Promise.resolve(okValue(overrides.oauthStatus?.(payload.loginId) ?? {
        login: { loginId: payload.loginId, status: 'awaiting-org', orgs: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] },
      }))),
      select: vi.fn((payload: { loginId: string; orgID?: string }) => Promise.resolve(okValue({
        login: { loginId: payload.loginId, status: 'done', orgID: payload.orgID, allowedModelCount: 3 },
      }))),
      cancel: vi.fn((payload: { loginId: string }) => Promise.resolve(okValue({
        login: { loginId: payload.loginId, status: 'cancelled' },
      }))),
    },
    claudeOAuth: {
      start: vi.fn(() => Promise.resolve(okValue({
        login: {
          loginId: 'login_claude_1',
          status: 'pending',
          verificationUri: 'https://platform.claude.com/oauth/authorize?response_type=code',
        },
      }))),
      submit: vi.fn((payload: { loginId: string }) => Promise.resolve(okValue({
        login: { loginId: payload.loginId, status: 'done' },
      }))),
      cancel: vi.fn((payload: { loginId: string }) => Promise.resolve(okValue({
        login: { loginId: payload.loginId, status: 'cancelled' },
      }))),
    },
  } as unknown as ModelsSectionInjected['api']
  const controller = new ModelsSettingsStore(api)
  const injected: ModelsSectionInjected = {
    controller,
    useSnapshot: bindSnapshotSelector(controller.store),
    api,
    t,
  }
  render(<ModelsSection {...injected} />)
}

/** Click the dialog's login button (the row carries a same-named button). */
function clickDialogLogin(): void {
  const buttons = screen.getAllByRole('button', { name: 'Log in with OpenCode' })
  fireEvent.click(buttons[buttons.length - 1])
}

describe('OpencodeLoginDialog', () => {
  it('opens from the OpenCode row and completes the device flow', async () => {
    mountFace()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Log in with OpenCode' })).toBeTruthy()
    })
    clickDialogLogin()
    await waitFor(() => {
      expect(screen.getByText(en.opencodeLoginIntro)).toBeTruthy()
    })
    clickDialogLogin()
    await waitFor(() => {
      expect(screen.getByText('ABCD-1234')).toBeTruthy()
    }, { timeout: 6000 })
    expect(screen.getByRole('link', { name: en.opencodeLoginOpenLink }).getAttribute('href'))
      .toBe('https://opencode.ai/device?code=ABCD-1234')
    await waitFor(() => {
      expect(screen.getByText(en.opencodeLoginPickWorkspace)).toBeTruthy()
    }, { timeout: 6000 })
    fireEvent.click(screen.getByLabelText('B'))
    fireEvent.click(screen.getByRole('button', { name: en.opencodeLoginConfirm }))
    await waitFor(() => {
      expect(screen.getByText(en.opencodeLoginDone)).toBeTruthy()
    })
  })

  it('shows logout on the row while the session is active', async () => {
    mountFace({ oauthConfigured: true })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Log out' })).toBeTruthy()
    })
    expect(screen.queryByRole('button', { name: 'Log in with OpenCode' })).toBeNull()
  })

  it('surfaces a denied approval inline', async () => {
    mountFace({
      oauthStatus: loginId => ({
        login: { loginId, status: 'denied', error: 'access denied by operator' },
      }),
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Log in with OpenCode' })).toBeTruthy()
    })
    clickDialogLogin()
    await waitFor(() => {
      expect(screen.getByText(en.opencodeLoginIntro)).toBeTruthy()
    })
    clickDialogLogin()
    await waitFor(() => {
      expect(screen.getByText('access denied by operator')).toBeTruthy()
    }, { timeout: 6000 })
  })
})

describe('OpencodeLoginDialog session states', () => {
  function mountDialog(configured: boolean): void {
    const api = {
      credentials: {
        describe: vi.fn(() => Promise.resolve(okValue({
          credentials: { OPENCODE_ZEN_OAUTH: { configured, writable: true } },
        }))),
        set: vi.fn(() => Promise.resolve(okValue({}))),
        unset: vi.fn(() => Promise.resolve(okValue({}))),
      },
      opencodeOAuth: {
        start: vi.fn(),
        status: vi.fn(),
        select: vi.fn(),
        cancel: vi.fn(),
      },
    } as unknown as ModelsSectionInjected['api']
    render(
      <OpencodeLoginDialogForTest api={api} />,
    )
  }

  it('shows the active session with logout and re-login', async () => {
    mountDialog(true)
    await waitFor(() => {
      expect(screen.getByText(en.opencodeLoginActive)).toBeTruthy()
    })
    expect(screen.getByRole('button', { name: en.opencodeLoginLogout })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.opencodeLoginRelogin })).toBeTruthy()
  })
})

describe('ClaudeLoginDialog session states', () => {
  function mountClaudeDialog(configured: boolean): void {
    const api = {
      credentials: {
        describe: vi.fn(() => Promise.resolve(okValue({
          credentials: { CLAUDE_CODE_OAUTH: { configured, writable: true } },
        }))),
        set: vi.fn(() => Promise.resolve(okValue({}))),
        unset: vi.fn(() => Promise.resolve(okValue({}))),
      },
      claudeOAuth: {
        start: vi.fn(),
        submit: vi.fn(),
        cancel: vi.fn(),
      },
    } as unknown as ModelsSectionInjected['api']
    render(
      <ClaudeLoginDialog
        api={api}
        t={key => en[key]}
        readOnly={false}
        onClose={() => {}}
      />,
    )
  }

  it('shows the active subscription with logout and re-login', async () => {
    mountClaudeDialog(true)
    await waitFor(() => {
      expect(screen.getByText(en.claudeLoginActive)).toBeTruthy()
    })
    expect(screen.getByRole('button', { name: en.claudeLoginLogout })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.claudeLoginRelogin })).toBeTruthy()
  })
})

describe('OAuth session rows', () => {
  it('lights the status dot green from the session while the key is missing', async () => {
    mountFace({ oauthConfigured: true })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Log out' })).toBeTruthy()
    })
    const dot = screen.getByRole('img', { name: en.oauthSessionActive })
    expect(dot.getAttribute('title')).toBe(en.oauthSessionActive)
    expect(dot.className).toContain('credentialDotConfigured')
    expect(screen.queryByRole('button', { name: 'Log in with OpenCode' })).toBeNull()
  })

  it('logs out from the row button and drops the session', async () => {
    mountFace({ oauthConfigured: true })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Log out' })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Log in with OpenCode' })).toBeTruthy()
    })
  })

  it('offers Delete on shipped rows with a stored session and resets it', async () => {
    mountFace({ oauthConfigured: true })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Log out' })).toBeTruthy()
    })
    const remove = screen.getByRole('button', { name: /Remove stored credentials for/ })
    fireEvent.click(remove)
    await waitFor(() => {
      expect(screen.getByText(/Remove stored credentials for/)).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: en.resetCredentialsConfirm }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Log in with OpenCode' })).toBeTruthy()
    })
  })
})

describe('ClaudeLoginDialog', () => {
  it('opens from the Claude row and completes the paste-back flow', async () => {
    mountFace()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Log in with Claude' })).toBeTruthy()
    })
    const buttons = screen.getAllByRole('button', { name: 'Log in with Claude' })
    fireEvent.click(buttons[buttons.length - 1])
    await waitFor(() => {
      expect(screen.getByText(en.claudeLoginIntro)).toBeTruthy()
    })
    const dialogButtons = screen.getAllByRole('button', { name: 'Log in with Claude' })
    fireEvent.click(dialogButtons[dialogButtons.length - 1])
    await waitFor(() => {
      expect(screen.getByText(en.claudeLoginCodeHint)).toBeTruthy()
    })
    expect(screen.getByRole('link', { name: en.claudeLoginOpenLink }).getAttribute('href'))
      .toBe('https://platform.claude.com/oauth/authorize?response_type=code')
    fireEvent.change(screen.getByLabelText(en.claudeLoginPasteLabel), { target: { value: 'past-ed' } })
    fireEvent.click(screen.getByRole('button', { name: en.claudeLoginSubmit }))
    await waitFor(() => {
      expect(screen.getByText(en.claudeLoginDone)).toBeTruthy()
    })
  })

  it('shows the active subscription with logout and re-login', async () => {
    mountFace({ claudeConfigured: true })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Log out' })).toBeTruthy()
    })
    const buttons = screen.getAllByRole('button', { name: 'Log out' })
    expect(buttons.length).toBeGreaterThan(0)
  })

  it('reopens the login dialog from the row of a configured subscription', async () => {
    mountFace({ claudeConfigured: true })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: en.claudeLoginRelogin })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: en.claudeLoginRelogin }))
    await waitFor(() => {
      expect(screen.getByText(en.claudeLoginActive)).toBeTruthy()
    })
    // The dialog's own re-login restarts the paste-back flow without logging out first.
    const relogin = screen.getAllByRole('button', { name: en.claudeLoginRelogin })
    fireEvent.click(relogin[relogin.length - 1])
    await waitFor(() => {
      expect(screen.getByText(en.claudeLoginCodeHint)).toBeTruthy()
    })
    expect(screen.getByRole('link', { name: en.claudeLoginOpenLink }).getAttribute('href'))
      .toBe('https://platform.claude.com/oauth/authorize?response_type=code')
    fireEvent.change(screen.getByLabelText(en.claudeLoginPasteLabel), { target: { value: 'past-ed' } })
    fireEvent.click(screen.getByRole('button', { name: en.claudeLoginSubmit }))
    await waitFor(() => {
      expect(screen.getByText(en.claudeLoginDone)).toBeTruthy()
    })
  })
})

describe('OpenCode session row', () => {
  it('reopens the login dialog from the row of a configured workspace session', async () => {
    mountFace({ oauthConfigured: true })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: en.opencodeLoginRelogin })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: en.opencodeLoginRelogin }))
    await waitFor(() => {
      expect(screen.getByText(en.opencodeLoginActive)).toBeTruthy()
    })
  })
})
