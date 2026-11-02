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

  /** @returns a pending OpenCode login and its device code. */
  @Remote
  async startOpencode(): Promise<OpencodeLoginView> { return this.opencode().start() }

  /** @param loginId - active login id. @returns its current safe progress. */
  @Remote
  statusOpencode(loginId: string): OpencodeLoginView {
    const view = this.opencode().snapshot(loginId)
    if (view === undefined) throw new RemoteError('gateway/bad-request', 'OpenCode login no longer exists', {})
    return view
  }

  /** @param loginId - approved login id. @param orgID - optional billed workspace. @returns the persisted login result. */
  @Remote
  async selectOpencode(loginId: string, orgID?: string): Promise<OpencodeLoginView> {
    return this.opencode().select(loginId, orgID)
  }

  /** @param loginId - active login id. @returns its terminal progress. */
  @Remote
  cancelOpencode(loginId: string): OpencodeLoginView {
    const view = this.opencode().cancel(loginId)
    if (view === undefined) throw new RemoteError('gateway/bad-request', 'OpenCode login no longer exists', {})
    return view
  }

  /** @returns a pending Claude login and its approval link. */
  @Remote
  startClaude(): ClaudeLoginView { return this.claude().start() }

  /** @param loginId - pending login id. @param pasted - browser approval code. @returns the persisted login result. */
  @Remote
  async submitClaude(loginId: string, pasted: string): Promise<ClaudeLoginView> {
    return this.claude().submit(loginId, pasted)
  }

  /** @param loginId - active login id. @returns its terminal progress. */
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
