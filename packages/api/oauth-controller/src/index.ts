/** Authenticated Models-page operations for the Host-owned subscription login flows. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm-opencode'
import type {} from '@deepseek-ai/dsh-llm-claude'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { ClaudeLoginView, OpencodeLoginView } from './types.ts'

export type { ClaudeLoginView, OpencodeLoginOrg, OpencodeLoginView } from './types.ts'

/** Token-free progress and completion for OpenCode and Claude logins. */
export class OAuthController extends TypertRemoteService {
  /** @param ctx - Host context containing the login flows installed by the LLM plugins. */
  constructor(ctx: Context) { super(ctx, 'oauthController', { namespace: 'oauth' }) }

  /**
   * Start an OpenCode device-code login without exposing credentials.
   * @returns pending login progress and its device code.
   */
  @Remote
  async startOpencode(): Promise<OpencodeLoginView> { return this.opencode().start() }

  /**
   * Read token-free progress for an existing OpenCode login.
   * @param loginId - active login id.
   * @returns current login progress.
   * @throws RemoteError when the login no longer exists or the flow is unavailable.
   */
  @Remote
  statusOpencode(loginId: string): OpencodeLoginView {
    const view = this.opencode().snapshot(loginId)
    if (view === undefined) throw new RemoteError('gateway/bad-request', 'OpenCode login no longer exists', {})
    return view
  }

  /**
   * Persist an approved OpenCode login for the selected workspace.
   * @param loginId - approved login id.
   * @param orgID - billed workspace id; omission leaves the session unbilled.
   * @returns persisted login progress.
   * @throws Error when approval, credential persistence, or the login flow fails.
   */
  @Remote
  async selectOpencode(loginId: string, orgID?: string): Promise<OpencodeLoginView> {
    return this.opencode().select(loginId, orgID)
  }

  /**
   * Cancel an existing OpenCode login.
   * @param loginId - active login id.
   * @returns terminal login progress.
   * @throws RemoteError when the login no longer exists or the flow is unavailable.
   */
  @Remote
  cancelOpencode(loginId: string): OpencodeLoginView {
    const view = this.opencode().cancel(loginId)
    if (view === undefined) throw new RemoteError('gateway/bad-request', 'OpenCode login no longer exists', {})
    return view
  }

  /**
   * Start a Claude browser-approval login without exposing credentials.
   * @returns pending login progress and its approval link.
   */
  @Remote
  startClaude(): ClaudeLoginView { return this.claude().start() }

  /**
   * Exchange a browser approval code and persist the Claude session.
   * @param loginId - pending login id.
   * @param pasted - browser approval code, optionally followed by its #state.
   * @returns persisted login progress.
   * @throws Error when approval, credential persistence, or the login flow fails.
   */
  @Remote
  async submitClaude(loginId: string, pasted: string): Promise<ClaudeLoginView> {
    return this.claude().submit(loginId, pasted)
  }

  /**
   * Cancel an existing Claude login.
   * @param loginId - active login id.
   * @returns terminal login progress.
   * @throws RemoteError when the login no longer exists or the flow is unavailable.
   */
  @Remote
  cancelClaude(loginId: string): ClaudeLoginView {
    const view = this.claude().cancel(loginId)
    if (view === undefined) throw new RemoteError('gateway/bad-request', 'Claude login no longer exists', {})
    return view
  }

  private opencode() {
    const flow = this.ctx.get('opencodeOAuth')
    if (flow === undefined) throw new RemoteError('gateway/internal', 'OpenCode login is unavailable', {})
    return flow
  }

  private claude() {
    const flow = this.ctx.get('claudeOAuth')
    if (flow === undefined) throw new RemoteError('gateway/internal', 'Claude login is unavailable', {})
    return flow
  }
}

export default OAuthController
