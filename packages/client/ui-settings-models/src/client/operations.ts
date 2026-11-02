/**
 * The Host reads and writes the Models cards perform, as callbacks built in the
 * plugin body. Cards receive these instead of a context: the outcomes name what
 * a card renders — a stored view, a stale revision, a refusal message — so the
 * failure codes and Remote namespaces stay in the apply world.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {
  LlmDiscoveredModel, LlmModelDiscoveryRequest,
  SettingsNamespaceView, SettingsPathOpView,
} from '@deepseek-ai/dsh-api-remotes/client'

/** What one namespace write answered. */
export type SettingsWriteOutcome =
  /** Committed; the view carries the stored user subtree and the new revision. */
  | { readonly kind: 'written'; readonly view: SettingsNamespaceView }
  /**
   * The stored revision moved after the card read it, so the draft is stale.
   * The message stays for callers that report the Host diagnostic as it is.
   */
  | { readonly kind: 'conflict'; readonly message: string }
  /** Any other refusal, with the Host's own diagnostic. */
  | { readonly kind: 'refused'; readonly message: string }

/** What one endpoint interrogation answered. */
export type ModelDiscoveryOutcome =
  /** The candidates the provider disclosed, in its own order. */
  | { readonly kind: 'found'; readonly models: readonly LlmDiscoveredModel[] }
  /** The interrogation was refused, with the Host's own diagnostic. */
  | { readonly kind: 'refused'; readonly message: string }

/** What one credential describe answered. */
export type CredentialStateOutcome =
  /** The reference's redacted state. */
  | { readonly kind: 'described'; readonly configured: boolean }
  /** The describe was refused, with the Host's own diagnostic. */
  | { readonly kind: 'refused'; readonly message: string }

/** What one provider-login step answered. */
export type LoginStepOutcome<L> =
  /** The Host's login snapshot after the step. */
  | { readonly kind: 'login'; readonly login: L }
  /** The step was refused, with the Host's own diagnostic. */
  | { readonly kind: 'refused'; readonly message: string }

/** One workspace an OpenCode account may bind the login to. */
export interface OpencodeLoginOrg {
  readonly id: string
  readonly name: string
}

/**
 * Host snapshot of one OpenCode Zen device-flow login. It carries progress and
 * outcome only; token material stays on the Host.
 */
export interface OpencodeLoginView {
  readonly loginId: string
  readonly status: 'pending' | 'awaiting-org' | 'done' | 'denied' | 'expired' | 'cancelled'
  /** Code the user enters at {@link verificationUri}, while pending. */
  readonly userCode?: string
  readonly verificationUri?: string
  /** Workspaces offered once the account approved, while awaiting a pick. */
  readonly orgs?: readonly OpencodeLoginOrg[]
  /** Host diagnostic for a denied, expired, or cancelled login. */
  readonly error?: string
}

/** Host operations of the OpenCode Zen device-flow login (`dsh opencode-login` in the page). */
export interface OpencodeLoginOperations {
  /**
   * Begin one device-flow login.
   * @returns the pending login with its user code and verification link.
   */
  start(): Promise<LoginStepOutcome<OpencodeLoginView>>
  /**
   * Poll one login.
   * @param loginId - login returned by {@link start}.
   * @returns the login's current snapshot.
   */
  status(loginId: string): Promise<LoginStepOutcome<OpencodeLoginView>>
  /**
   * Finish one login awaiting a workspace pick and persist its session.
   * @param loginId - login awaiting a pick.
   * @param orgID - picked workspace, or undefined to skip binding one.
   * @returns the settled login.
   */
  select(loginId: string, orgID: string | undefined): Promise<LoginStepOutcome<OpencodeLoginView>>
  /**
   * Abandon one login (idempotent).
   * @param loginId - login to cancel.
   * @returns the terminal snapshot.
   */
  cancel(loginId: string): Promise<LoginStepOutcome<OpencodeLoginView>>
}

/**
 * Host snapshot of one Claude subscription paste-back login. It carries
 * progress and outcome only; token material stays on the Host.
 */
export interface ClaudeLoginView {
  readonly loginId: string
  readonly status: 'pending' | 'done' | 'failed' | 'cancelled'
  /** Browser approval link, while pending. */
  readonly verificationUri?: string
  /** Host diagnostic for a failed or cancelled login. */
  readonly error?: string
}

/** Host operations of the Claude subscription login (`dsh claude-login` in the page). */
export interface ClaudeLoginOperations {
  /**
   * Begin one paste-back login.
   * @returns the pending login with its approval link.
   */
  start(): Promise<LoginStepOutcome<ClaudeLoginView>>
  /**
   * Redeem the code the browser showed and persist the session.
   * @param loginId - login returned by {@link start}.
   * @param pasted - the pasted code, as the user entered it.
   * @returns the settled login; `done` once the session is stored.
   */
  submit(loginId: string, pasted: string): Promise<LoginStepOutcome<ClaudeLoginView>>
  /**
   * Abandon one login (idempotent).
   * @param loginId - login to cancel.
   * @returns the terminal snapshot.
   */
  cancel(loginId: string): Promise<LoginStepOutcome<ClaudeLoginView>>
}

/**
 * Render a rejected Host call as the dialog's failure text.
 * @param error - the rejection reason.
 * @returns its message, or its string form for a non-Error reason.
 */
export function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The Host operations the Models page and its cards invoke. */
export interface ModelsOperations {
  /**
   * Store one credential literal under its reference.
   * @param ref - credential reference name.
   * @param value - the literal to store.
   * @returns the refusal message, or undefined once stored.
   */
  storeCredential(ref: string, value: string): Promise<string | undefined>
  /**
   * Remove one credential reference (idempotent).
   * @param ref - credential reference name.
   * @returns the refusal message, or undefined once removed.
   */
  removeCredential(ref: string): Promise<string | undefined>
  /**
   * Describe one credential reference without reading its value.
   * @param ref - credential reference name.
   * @returns whether a value is stored, or the refusal.
   */
  describeCredential(ref: string): Promise<CredentialStateOutcome>
  /**
   * OpenCode Zen login, present only when the Host serves its login namespace;
   * the page offers no login control without it.
   */
  readonly opencodeLogin?: OpencodeLoginOperations
  /**
   * Claude subscription login, present only when the Host serves its login
   * namespace; the page offers no login control without it.
   */
  readonly claudeLogin?: ClaudeLoginOperations
  /**
   * Apply path operations to one settings namespace.
   * @param ns - settings namespace identity.
   * @param ops - ordered path operations against the stored section, as the
   * wire takes them (the Remote signature owns the array).
   * @param expectedRevision - revision the draft was opened at, or undefined to write unfenced.
   * @returns the write outcome the card renders from.
   */
  writeSettings(
    ns: string,
    ops: SettingsPathOpView[],
    expectedRevision: number | undefined,
  ): Promise<SettingsWriteOutcome>
  /**
   * Ask a provider endpoint what models it serves.
   * @param settingsNs - namespace whose adapter family answers.
   * @param request - endpoint facts as the form currently shows them.
   * @returns the candidates, or the refusal.
   */
  discoverModels(settingsNs: string, request: LlmModelDiscoveryRequest): Promise<ModelDiscoveryOutcome>
}

/**
 * Bind the page's Host operations to the plugin's own Remote namespaces.
 * @param ctx - the page plugin's context, which declares `remote.credentials`,
 * `remote.llm`, and `remote.settings` in its own `inject`.
 * @returns the callbacks the section and its cards are injected with.
 */
export function createModelsOperations(ctx: ClientContext): ModelsOperations {
  return {
    storeCredential: async (ref, value) => {
      const response = await ctx.remote.credentials.set(ref, value)
      return response.ok ? undefined : response.error.message
    },
    removeCredential: async (ref) => {
      const response = await ctx.remote.credentials.unset(ref)
      return response.ok ? undefined : response.error.message
    },
    describeCredential: async (ref) => {
      const response = await ctx.remote.credentials.describe([ref])
      return response.ok
        ? { kind: 'described', configured: response.value[ref]?.configured === true }
        : { kind: 'refused', message: response.error.message }
    },
    opencodeLogin: {
      start: async () => {
        const response = await ctx.remote.oauth.startOpencode()
        return response.ok ? { kind: 'login', login: response.value } : { kind: 'refused', message: response.error.message }
      },
      status: async (loginId) => {
        const response = await ctx.remote.oauth.statusOpencode(loginId)
        return response.ok ? { kind: 'login', login: response.value } : { kind: 'refused', message: response.error.message }
      },
      select: async (loginId, orgID) => {
        const response = await ctx.remote.oauth.selectOpencode(loginId, orgID)
        return response.ok ? { kind: 'login', login: response.value } : { kind: 'refused', message: response.error.message }
      },
      cancel: async (loginId) => {
        const response = await ctx.remote.oauth.cancelOpencode(loginId)
        return response.ok ? { kind: 'login', login: response.value } : { kind: 'refused', message: response.error.message }
      },
    },
    claudeLogin: {
      start: async () => {
        const response = await ctx.remote.oauth.startClaude()
        return response.ok ? { kind: 'login', login: response.value } : { kind: 'refused', message: response.error.message }
      },
      submit: async (loginId, pasted) => {
        const response = await ctx.remote.oauth.submitClaude(loginId, pasted)
        return response.ok ? { kind: 'login', login: response.value } : { kind: 'refused', message: response.error.message }
      },
      cancel: async (loginId) => {
        const response = await ctx.remote.oauth.cancelClaude(loginId)
        return response.ok ? { kind: 'login', login: response.value } : { kind: 'refused', message: response.error.message }
      },
    },
    writeSettings: async (ns, ops, expectedRevision) => {
      const response = await ctx.remote.settings.mutate(ns, ops, expectedRevision)
      if (response.ok) return { kind: 'written', view: response.value }
      const { code, message } = response.error
      return code === 'settings/conflict' ? { kind: 'conflict', message } : { kind: 'refused', message }
    },
    discoverModels: async (settingsNs, request) => {
      const response = await ctx.remote.llm.discoverModels(settingsNs, request)
      return response.ok
        ? { kind: 'found', models: response.value }
        : { kind: 'refused', message: response.error.message }
    },
  }
}
