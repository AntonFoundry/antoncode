/**
 * Models settings section: the provider rows joined from the configurable
 * directory, settings namespaces, and credential states, with one editor
 * card at a time. Rows retain the account-first order supplied by the store
 * and show each provider's logo and branded name. Their accessible solid
 * configured or missing dots report confirmed API-key, subscription-login, or
 * stored OAuth-session state. Each row carries a switch that hides or shows
 * the provider's models in the session model catalog (`session-controller`
 * `disabledProviders`); OAuth routes (OpenCode, Claude) add login, re-login,
 * and log-out actions, and a shipped row with stored credentials offers their
 * confirmed removal. A whole-section provider without a
 * configured key renders as its open setup card instead of a row, but only in
 * the first-run posture — no provider on the page can serve requests yet — and
 * only until the user closes that card. The add flow is one card behind one
 * button: a mode switch chooses between adopting a dormant directory provider
 * (the catalog select over the provider editor) and declaring a custom model
 * API (the create form). A panel mounts the first time its mode is shown and
 * stays mounted, hidden, while the card is open and its mode stays offered,
 * so switching modes discards neither draft and an unvisited mode costs
 * nothing; the switch holds still while either panel has a write or an
 * endpoint interrogation in flight, since a switch underneath one would
 * orphan the answer. Each card kind owns its own open state, so closing one
 * never discards a draft in another. Every
 * mutation writes through the wire, while a provider removal first requires
 * confirmation; the page re-renders from pushed invalidations or the
 * post-apply reload.
 */

import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, IconPlusOutlineRegular, Modal, ProviderLogo, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { LlmNativeAuth, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls this package's SlotMap merge (the two Models child slots).
import type {} from './slot-contract.ts'
import { CustomProviderCard } from './CustomProviderCard.tsx'
import { OpencodeLoginDialog } from './OpencodeLoginDialog.tsx'
import { ClaudeLoginDialog } from './ClaudeLoginDialog.tsx'
import {
  deriveKeyRef, disabledProvidersOf, MODEL_CATALOG_NAMESPACE, protocolChoices, providerUsable, reasoningLevelChoices,
} from './store.ts'
import type { ModelsSettingsStore, ProviderRow } from './store.ts'
import type { ModelsOperations } from './operations.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import { ProviderEditor, type ProviderEditorProps } from './ProviderEditor.tsx'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Injected dependencies of {@link ModelsSection} (slot `inject`). */
export interface ModelsSectionInjected {
  /** The page store (loaded on mount, refreshed on pushed invalidations). */
  controller: ModelsSettingsStore
  hooks: {
    /** Page snapshot bound by the UI renderer as useSnapshot. */
    snapshot: ModelsSettingsStore['store']
  }
  /** The Host operations the section and its cards invoke. */
  operations: ModelsOperations
  /** Settings schema and immutable path callbacks. */
  schema: SettingsSchemaOperations
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/**
 * The two ways the add card gains a provider: adopt a directory row the
 * adapter already knows, or declare a route it does not.
 */
type AddMode = 'catalog' | 'custom'

/** The child slots this section declares and dispatches (see ./slot-contract.ts). */
type ModelsChildSlots = 'settings.models.provider-card' | 'settings.models.footer'

/** The child-slot dispatch function the renderer binds for the section. */
type ModelsRenderSlot = PropsRenderSlots<ModelsChildSlots>['renderSlot']

/**
 * Props delivered by the slot outlet: the inject face spread flat (the
 * renderer erases the share boundary at the render call) plus the child-slot
 * dispatch seat. The seat is required: the renderer binds it at the render
 * call itself — unlike the inject face it is never absent at runtime — and a
 * direct render that forgets it fails to compile instead of mounting nothing.
 */
export type ModelsSectionProps = Partial<InjectFace<ModelsSectionInjected>> & PropsRenderSlots<ModelsChildSlots>

type ModelsSectionFace = InjectFace<ModelsSectionInjected>

/** Provider identity shared by row actions and confirmation copy. */
export interface ProviderIdentity {
  /** Stable provider route id. */
  provider: string
  /** Human-facing provider name. */
  displayName: string
}

const PROVIDER_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic Claude',
  'kimi-coding': 'Kimi Coding',
  nvidia: 'NVIDIA',
  'qwen-token-plan': 'Qwen Token Plan',
  'qwen-token-plan-individual': 'Qwen Token Plan Individual',
  zai: 'Z.ai',
}

/** Apply established branding when a provider uses its route id as its display name. */
export function providerDisplayName(provider: string, displayName: string): string {
  return provider === displayName ? PROVIDER_DISPLAY_NAMES[provider] ?? displayName : displayName
}

/** One existing row or dormant directory entry addressed by an editor action. */
interface EditorTarget extends ProviderIdentity {
  settingsNs: string
  settingsPath: readonly string[]
  /** Writable credential identified under this page's conventional reference. */
  credentialRef?: string
  /** The adapter reports this route as one it does not ship (see {@link ProviderEditorProps.declared}). */
  declared?: boolean
  /** The route's catalog endpoint (see {@link ProviderEditorProps.defaultBaseURL}). */
  defaultBaseURL?: string
  /** Environment used to construct an endpoint (see {@link ProviderEditorProps.baseURLEnv}). */
  baseURLEnv?: readonly string[]
  /** The route's native authentication (see {@link ProviderEditorProps.nativeAuth}). */
  nativeAuth?: LlmNativeAuth
}

/** A dormant directory row the add card can adopt, with its registered namespace. */
interface AddableRow {
  row: ProviderRow
  namespace: SettingsNamespaceView
}

/** The catalog draft the add card shows: its editor target and the namespace that takes the write. */
interface CatalogDraft {
  target: EditorTarget
  namespace: SettingsNamespaceView
}

/** Settings namespaces whose routes authenticate through a stored OAuth session. */
const OAUTH_SETTINGS_NS: Readonly<Record<string, 'opencode' | 'claude'>> = {
  'llm-opencode': 'opencode',
  'llm-claude': 'claude',
}

/**
 * Whether the Host serves the login flow of an OAuth route's namespace.
 * @param operations - the page's Host operations.
 * @param settingsNs - the route's settings namespace.
 * @returns whether the row offers login controls.
 */
function loginServed(operations: ModelsOperations, settingsNs: string): boolean {
  const route = OAUTH_SETTINGS_NS[settingsNs]
  if (route === undefined) return false
  return (route === 'claude' ? operations.claudeLogin : operations.opencodeLogin) !== undefined
}

/**
 * Remove a shipped route's stored credentials (API key and/or OAuth
 * session) without touching its settings profile, which the deployment
 * owns. Shipped routes have nothing settings-side to delete — that is what
 * distinguishes this from {@link removeProviderProfile} — so the row stays
 * listed and only its secrets go away.
 * @param operations - the page's Host operations.
 * @param controller - the page store reloaded after the removal lands.
 * @param refs - credential references to unset, in order.
 * @returns the failure message, or undefined once the removal landed.
 */
export async function removeRouteCredentials(
  operations: ModelsOperations,
  controller: ModelsSettingsStore,
  refs: readonly string[],
): Promise<string | undefined> {
  for (const ref of refs) {
    const failure = await operations.removeCredential(ref)
    if (failure !== undefined) return failure
  }
  await controller.load()
  return undefined
}

/** Values that vary around the shared provider-editor rendering. */
interface ProviderEditorRenderProps extends Pick<
  ProviderEditorProps,
  'namespace' | 'schema' | 'operations' | 't' | 'readOnly' | 'onClose'
> {
  target: EditorTarget
  row: ProviderRow
}

/** Render an editor for either the setup posture or an expanded provider row. */
function renderProviderEditor({ target, row, ...props }: ProviderEditorRenderProps): ReactNode {
  return (
    <ProviderEditor
      provider={target.provider}
      displayName={target.displayName}
      settingsPath={target.settingsPath}
      {...target.declared === true ? { declared: true } : {}}
      {...target.defaultBaseURL === undefined ? {} : { defaultBaseURL: target.defaultBaseURL }}
      {...target.baseURLEnv === undefined ? {} : { baseURLEnv: target.baseURLEnv }}
      {...target.nativeAuth === undefined ? {} : { nativeAuth: target.nativeAuth }}
      {...row.credential === undefined ? {} : { credential: row.credential }}
      {...row.credentialChecks === undefined ? {} : { credentialChecks: row.credentialChecks }}
      {...props}
    />
  )
}

/**
 * Remove one user-added provider and its page-managed credential. Credential
 * removal comes first so a second-step failure leaves the provider row visible
 * and the whole operation safely retryable; both unsets are idempotent.
 * The settings removal names the profile rather than rebuilding its whole
 * namespace from a partial view.
 * @param operations - the page's Host operations.
 * @param controller - the page store to refresh.
 * @param target - the provider's settings address and optional managed credential.
 * @returns the failure message, or undefined once the write and reload landed.
 */
export async function removeProviderProfile(
  operations: ModelsOperations,
  controller: ModelsSettingsStore,
  target: { settingsNs: string; settingsPath: readonly string[]; credentialRef?: string },
): Promise<string | undefined> {
  if (target.credentialRef !== undefined) {
    const credential = await operations.removeCredential(target.credentialRef)
    if (credential !== undefined) return credential
  }
  const written = await operations.writeSettings(
    target.settingsNs,
    [{ op: 'unset', path: [...target.settingsPath] }],
    undefined,
  )
  if (written.kind !== 'written') return written.message
  await controller.load()
  return undefined
}

/**
 * Set one provider's catalog visibility: membership in the gateway's
 * `session-controller` `disabledProviders` list. The write carries the described
 * revision so a concurrent edit elsewhere refuses instead of clobbering; the
 * snapshot is read at call time, so two quick toggles compose rather than
 * overwrite each other's list.
 * @param operations - the page's Host operations.
 * @param schema - settings schema operations.
 * @param controller - the page store to refresh.
 * @param provider - the provider route id to enable or disable.
 * @param enabled - whether the provider's models should appear in the catalog.
 * @returns the failure message, or undefined once the write and reload landed.
 */
export async function setProviderEnabled(
  operations: ModelsOperations,
  schema: SettingsSchemaOperations,
  controller: ModelsSettingsStore,
  provider: string,
  enabled: boolean,
): Promise<string | undefined> {
  const catalog = controller.store.getSnapshot().namespaces.get(MODEL_CATALOG_NAMESPACE)
  const current = [...disabledProvidersOf(catalog, schema)]
  const next = enabled
    ? current.filter(id => id !== provider)
    : current.includes(provider) ? current : [...current, provider]
  const written = await operations.writeSettings(
    MODEL_CATALOG_NAMESPACE,
    [{ op: 'set', path: ['disabledProviders'], value: next }],
    catalog?.revision,
  )
  if (written.kind !== 'written') return written.message
  await controller.load()
  return undefined
}

/**
 * Whether a whole-section provider still needs its first key: an unconfigured
 * credential opens the setup card instead of showing a row. This is the
 * first-run posture alone — a user who can already reach some provider gets an
 * ordinary row with the missing-key dot, since nothing here is blocking them.
 * @param row - the joined provider row.
 * @param anyUsable - whether any joined row can already serve requests.
 * @returns whether to render the setup card.
 */
export function needsSetup(row: ProviderRow, anyUsable: boolean): boolean {
  if (anyUsable || row.entry.provider === 'deepseek-account') return false
  if (row.entry.settingsPath.length > 0) return false
  return row.credential?.configured !== true
}

/**
 * The provider-card seat's credential fact: the reference this page would use
 * for the row — the profile's `apiKeyEnv`, or the page's derived
 * `<ROUTE>_API_KEY` while the profile names none — confirmed configured. The
 * derived half is what keeps the seat consistent with the editor on the
 * add-provider draft, whose dormant row names no reference yet.
 */
function keyConfiguredOf(row: ProviderRow): boolean {
  return row.apiKeyEnv !== undefined
    ? row.credential?.configured === true
    : row.derivedCredential?.configured === true
}

function targetOf(row: ProviderRow): EditorTarget {
  const managedRef = deriveKeyRef(row.entry.provider)
  const credentialRef = row.apiKeyEnv === managedRef
    && row.credential?.configured === true
    && row.credential.writable
    ? managedRef
    : undefined
  return {
    provider: row.entry.provider,
    displayName: providerDisplayName(row.entry.provider, row.entry.displayName),
    settingsNs: row.entry.settingsNs,
    settingsPath: row.entry.settingsPath,
    ...credentialRef === undefined ? {} : { credentialRef },
    // Only declared routes may expose route-owned fields.
    ...row.entry.declared === true ? { declared: true } : {},
    ...row.entry.defaultBaseURL === undefined ? {} : { defaultBaseURL: row.entry.defaultBaseURL },
    ...row.entry.baseURLEnv === undefined ? {} : { baseURLEnv: row.entry.baseURLEnv },
    ...row.entry.nativeAuth === undefined ? {} : { nativeAuth: row.entry.nativeAuth },
  }
}

/** Stable visible and accessible identity for one provider target. */
export function providerTargetLabel(target: ProviderIdentity): string {
  return target.provider === target.displayName
    ? target.provider
    : `${target.displayName} (${target.provider})`
}

/** Replace the one provider placeholder in localized destructive-action copy. */
export function providerCopy(template: string, target: ProviderIdentity): string {
  return template.replace('{provider}', () => providerTargetLabel(target))
}

/**
 * Render the Models section content column.
 * @param props - slot-delivered injected dependencies.
 * @returns the section, or null while the shell has not injected yet.
 */
export function ModelsSection(props: ModelsSectionProps): ReactNode {
  const { controller, useSnapshot, operations, schema, t, renderSlot } = props
  if (
    controller === undefined || useSnapshot === undefined || operations === undefined
    || schema === undefined || t === undefined
  ) return null
  return <Loaded injected={{ controller, useSnapshot, operations, schema, t }} renderSlot={renderSlot} />
}

function Loaded({ injected, renderSlot }: { injected: ModelsSectionFace; renderSlot: ModelsRenderSlot }): ReactNode {
  const { controller, operations, schema, t } = injected
  const snapshot = injected.useSnapshot(value => value)
  const state = { ...snapshot, rows: snapshot.rows.map(row => row.entry.provider === 'deepseek-account'
    ? { ...row, entry: { ...row.entry, displayName: t('deepSeekAccount') } } : row) }
  /** A new or failed surface waits for a current snapshot; background refreshes preserve its drafts. */
  const [hasReadySnapshot, setHasReadySnapshot] = useState(state.status === 'ready')
  if (state.status === 'ready' && !hasReadySnapshot) setHasReadySnapshot(true)
  if (state.status === 'error' && hasReadySnapshot) setHasReadySnapshot(false)
  const [editing, setEditing] = useState<EditorTarget | undefined>(undefined)
  const [addOpen, setAddOpen] = useState(false)
  const [addMode, setAddMode] = useState<AddMode>('catalog')
  /** The modes shown since the add card opened; each keeps its panel mounted. */
  const [visited, setVisited] = useState<ReadonlySet<AddMode>>(() => new Set())
  /** Whether each add panel has a write or an interrogation in flight. */
  const [catalogBusy, setCatalogBusy] = useState(false)
  const [customBusy, setCustomBusy] = useState(false)
  /** Base of the add card's tab and panel ids. */
  const addId = useId()
  const [deleteTarget, setDeleteTarget] = useState<EditorTarget | undefined>(undefined)
  const [loginTarget, setLoginTarget] = useState<EditorTarget | undefined>(undefined)
  const [resetTarget, setResetTarget] = useState<(ProviderIdentity & { refs: readonly string[] }) | undefined>(undefined)
  const [resetting, setResetting] = useState(false)
  const [resetFailure, setResetFailure] = useState<string | undefined>(undefined)
  const [deleting, setDeleting] = useState(false)
  const [deleteFailure, setDeleteFailure] = useState<string | undefined>(undefined)
  const [savedTarget, setSavedTarget] = useState<ProviderIdentity | undefined>(undefined)
  const [toggling, setToggling] = useState<ReadonlySet<string>>(() => new Set())
  const [toggleFailure, setToggleFailure] = useState<string | undefined>(undefined)
  const [dismissedSetup, setDismissedSetup] = useState<ReadonlySet<string>>(() => new Set())

  const announceSaved = (target: ProviderIdentity): void => {
    // Announced only once the refreshed directory is in the snapshot the
    // notice reads its name from: an apply can rename the route, and the
    // target captured when the card opened still carries the old name.
    void controller.load().then(() => { setSavedTarget(target) })
  }

  /** Flip one provider's catalog visibility through the gateway namespace. */
  const toggleProvider = (target: EditorTarget): void => {
    const provider = target.provider
    setToggleFailure(undefined)
    setToggling(previous => new Set([...previous, provider]))
    void setProviderEnabled(operations, schema, controller, provider, !controller.store.getSnapshot().rows
      .find(row => row.entry.provider === provider)?.enabled)
      .then((failure) => {
        if (failure !== undefined) setToggleFailure(providerCopy(t('toggleFailed'), target))
      })
      .finally(() => {
        setToggling((previous) => {
          const next = new Set(previous)
          next.delete(provider)
          return next
        })
      })
  }

  /**
   * Close the add card whole. The catalog target is forgotten with it, since
   * `editing` doubles as the row editor's target once the card is closed and a
   * refresh could otherwise open the row of a provider the draft never saved.
   * The busy flags reset here because a panel that closes itself on success
   * unmounts before it can report idle.
   */
  const closeAdd = (): void => {
    setEditing(undefined)
    setAddOpen(false)
    setCatalogBusy(false)
    setCustomBusy(false)
  }

  const closeEditor = (changed: boolean, target: ProviderIdentity): void => {
    closeAdd()
    if (changed) announceSaved(target)
  }

  /**
   * Close a setup card, which owns none of the state above: the row-editor
   * and add cards each own one of those, so clearing them here would discard
   * a draft the user opened beside this card. Dismissal is this card's own —
   * the provider falls back to an ordinary row for the rest of the session,
   * and reopens through Edit.
   */
  const closeSetup = (changed: boolean, target: ProviderIdentity): void => {
    setDismissedSetup(previous => new Set([...previous, target.provider]))
    if (changed) announceSaved(target)
  }

  const closeLogin = (changed: boolean): void => {
    setLoginTarget(undefined)
    if (changed) void controller.load()
  }

  const closeReset = (): void => {
    if (resetting) return
    setResetTarget(undefined)
    setResetFailure(undefined)
  }

  const confirmReset = (): void => {
    if (resetTarget === undefined || resetting) return
    setResetting(true)
    setResetFailure(undefined)
    void removeRouteCredentials(operations, controller, resetTarget.refs)
      .then((failure) => {
        if (failure !== undefined) {
          setResetFailure(failure)
          return
        }
        setResetTarget(undefined)
      })
      .finally(() => { setResetting(false) })
  }

  /** Stored credentials a shipped row can drop: API key and/or OAuth session. */
  const resettableRefs = (row: ProviderRow): readonly string[] => [
    ...(row.credential?.configured === true && row.apiKeyEnv !== undefined ? [row.apiKeyEnv] : []),
    ...(row.oauthSession?.configured === true && row.oauthRef !== undefined ? [row.oauthRef] : []),
  ]
  const logoutSession = (target: ProviderIdentity, ref: string): void => {
    setToggleFailure(undefined)
    void operations.removeCredential(ref).then((failure) => {
      if (failure !== undefined) {
        setToggleFailure(providerCopy(t('logoutFailed'), target))
        return
      }
      void controller.load()
    })
  }

  /** Row label reopening the login dialog of an already configured OAuth route. */
  const reloginCopy = (target: EditorTarget): string =>
    target.settingsNs === 'llm-claude' ? t('claudeLoginRelogin') : t('opencodeLoginRelogin')

  const closeDelete = (): void => {
    if (deleting) return
    setDeleteTarget(undefined)
    setDeleteFailure(undefined)
  }

  const confirmDelete = (): void => {
    /* v8 ignore next -- the action only renders with a target and is disabled while a deletion is pending */
    if (deleteTarget === undefined || deleting) return
    setDeleting(true)
    setDeleteFailure(undefined)
    void removeProviderProfile(operations, controller, deleteTarget)
      .then((failure) => {
        if (failure !== undefined) {
          setDeleteFailure(failure)
          return
        }
        setDeleteTarget(undefined)
      })
      .finally(() => { setDeleting(false) })
  }

  if (state.status === 'idle') void controller.load()
  if (state.status === 'error') {
    /* v8 ignore next -- an error status always carries text; the fallback satisfies the nullable type */
    const errorText = state.error ?? ''
    return (
      <div className={styles['section']}>
        <p className={styles['error']}>{`${t('loadFailed')}: ${errorText}`}</p>
        <button type="button" className={styles['secondaryButton']} onClick={() => { void controller.load() }}>
          {t('retry')}
        </button>
      </div>
    )
  }
  if (!hasReadySnapshot && state.status !== 'ready') {
    return (
      <div className={styles['section']}>
        <h2 className={styles['title']}>{t('title')}</h2>
        <p className={styles['intro']}>{t('intro')}</p>
      </div>
    )
  }

  // The saved provider as the directory currently names it. The route id is
  // what the apply cannot change, so it is what the notice is keyed by; a row
  // the same apply removed keeps the captured identity, since nothing newer
  // exists to name it with.
  const savedRow = savedTarget === undefined
    ? undefined
    : state.rows.find(row => row.entry.provider === savedTarget.provider)
  const savedIdentity = savedRow === undefined
    ? savedTarget
    : {
      provider: savedRow.entry.provider,
      displayName: providerDisplayName(savedRow.entry.provider, savedRow.entry.displayName),
    }

  // One fact decides both first-run postures on this page and the onboarding
  // step: whether the user already has a provider to talk to.
  const anyUsable = state.rows.some(providerUsable)
  const configured = state.rows.filter(row => row.configured)
  const configurable = state.rows.filter(row => state.namespaces.has(row.entry.settingsNs))
  const addable: AddableRow[] = state.rows.flatMap((row) => {
    const namespace = state.namespaces.get(row.entry.settingsNs)
    return namespace === undefined || row.configured ? [] : [{ row, namespace }]
  })
  // Hand-declared routes live in the pi-ai namespace, which is also the only
  // one whose schema names the protocols one may speak; without it mounted
  // there is nothing to declare and the mode is not offered.
  const piAi = state.namespaces.get('llm-pi-ai')
  const protocols = protocolChoices(piAi, schema)
  const reasoningLevels = reasoningLevelChoices(piAi, schema)
  // Each mode is offered while its namespace is mounted and enabled while it
  // has something to offer; the card shows the chosen mode where both are
  // offered, else the only one there is. A mode's panel is mounted while it is
  // the shown mode or has been shown since the card opened — derived, so a
  // refresh that changes which modes are offered can never leave the card
  // without a panel.
  const catalogOffered = configurable.length > 0
  const catalogEnabled = addable.length > 0
  const customOffered = piAi !== undefined
  const customEnabled = protocols.length > 0
  const bothOffered = catalogOffered && customOffered
  const mode: AddMode = bothOffered ? addMode : customOffered ? 'custom' : 'catalog'
  const mounted = (candidate: AddMode): boolean => mode === candidate || visited.has(candidate)
  const switchLocked = catalogBusy || customBusy
  // The catalog draft: the row the user chose, kept through a refresh that
  // adopts or withdraws it elsewhere so a typed key is never discarded, for as
  // long as its namespace can still take the write; else the first row still
  // addable, since the mode can be entered by a refresh as well as by the
  // switch and the button only picks a target when it opens the card.
  const draft = ((): CatalogDraft | undefined => {
    if (!addOpen || !catalogOffered) return undefined
    const kept = editing === undefined ? undefined : state.namespaces.get(editing.settingsNs)
    if (editing !== undefined && kept !== undefined) return { target: editing, namespace: kept }
    const first = addable[0]
    return first === undefined ? undefined : { target: targetOf(first.row), namespace: first.namespace }
  })()
  // The draft's directory row, for the card extension seat. A refresh can drop
  // the row mid-draft (the route was adopted or withdrawn elsewhere); the
  // draft card stays while the seat simply has no row to dispatch.
  const addRow = draft === undefined
    ? undefined
    : state.rows.find(row => row.entry.provider === draft.target.provider)

  return (
    <div className={styles['section']}>
      <h2 className={styles['title']}>{t('title')}</h2>
      <p className={styles['intro']}>{t('intro')}</p>
      {!state.writable && state.status === 'ready' ? <p className={styles['notice']}>{t('readOnly')}</p> : null}
      {savedIdentity === undefined
        ? null
        : (
          <p className={styles['savedNotice']} role="status" aria-live="polite">
            {providerCopy(t('savedProvider'), savedIdentity)}
          </p>
        )}
      <ul className={styles['rows']}>
        {configured.map((row) => {
          const target = targetOf(row)
          const namespace = state.namespaces.get(target.settingsNs)
          /* v8 ignore next -- the join marks a row configured only when its namespace resolved */
          if (namespace === undefined) return null
          const error = row.entry.error === undefined
            ? null
            : <p role="alert" className={styles['error']}>{row.entry.error}</p>
          if (needsSetup(row, anyUsable) && !dismissedSetup.has(row.entry.provider)) {
            // First-run posture: the provider exists but has no key — the
            // setup card IS its presence on the page, until the user closes it.
            return (
              <li key={row.entry.provider} className={styles['setupCard']}>
                {error}
                {renderProviderEditor({
                  target,
                  row,
                  namespace,
                  schema,
                  operations,
                  t,
                  readOnly: !state.writable,
                  onClose: (changed) => { closeSetup(changed, target) },
                })}
                {renderSlot(
                  'settings.models.provider-card',
                  { provider: row.entry, configured: row.configured, keyConfigured: keyConfiguredOf(row) },
                  { entryKey: row.entry.settingsNs },
                )}
              </li>
            )
          }
          const open = !addOpen && editing?.provider === row.entry.provider
          const credentialConfigured = row.credential?.configured === true
          const credentialMissing = !credentialConfigured
            && row.apiKeyEnv !== undefined
            && row.credential?.configured === false
          const subscriptionConfigured = row.entry.authConfigured === true
          const subscriptionMissing = row.entry.authConfigured === false
          const isAntigravity = row.entry.settingsNs === 'llm-antigravity'
          // A stored OAuth session lights the row exactly like a stored key:
          // without it a logged-in workspace still reads red on its key dot.
          const oauthConfigured = row.oauthSession?.configured === true
          const statusConfigured = credentialConfigured || subscriptionConfigured || oauthConfigured
          const statusMissing = credentialMissing || subscriptionMissing
          const statusLabel = subscriptionConfigured
            ? (isAntigravity ? t('antigravitySubscriptionConfigured') : t('subscriptionConfigured'))
            : subscriptionMissing
              ? (isAntigravity ? t('antigravitySubscriptionMissing') : t('subscriptionMissing'))
              : credentialConfigured
                ? t('credentialConfigured')
                : oauthConfigured
                  ? t('oauthSessionActive')
                  : t('credentialMissing')
          return (
            <li key={row.entry.provider} className={styles['rowCard']}>
              <div className={styles['rowHead']}>
                <span className={styles['rowIdentity']}>
                  <ProviderLogo provider={target.provider} name={target.displayName} size={24} />
                  <span
                    className={`${styles['rowName']} ${row.enabled ? '' : styles['rowNameDisabled']}`}
                  >{target.displayName}</span>
                  {/* Only the adapter can tell a hand-declared route from a
                      shipped one it also has a stored profile for, so the tag
                      follows its answer and stays off when it gives none. */}
                  {row.entry.declared === true
                    ? <span className={styles['rowTag']}>{t('customTag')}</span>
                    : null}
                  {/* The store keeps the account row only while the account lists models. */}
                  {row.entry.provider === 'deepseek-account'
                    ? (
                      <span className={styles['accountStatus']}>
                        <span className={`${styles['credentialDot']} ${styles['credentialDotConfigured']}`} aria-hidden="true" />
                        {t('accountSignedIn')}
                      </span>
                    )
                    : null}
                  {statusConfigured
                    ? (
                      <span
                        className={`${styles['credentialDot']} ${styles['credentialDotConfigured']}`}
                        role="img"
                        aria-label={statusLabel}
                        title={statusLabel}
                      />
                    )
                    : statusMissing
                      ? (
                        <span
                          className={`${styles['credentialDot']} ${styles['credentialDotMissing']}`}
                          role="img"
                          aria-label={statusLabel}
                          title={statusLabel}
                        />
                      )
                      : null}
                </span>
                <span className={styles['rowActions']}>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={row.enabled}
                    aria-label={providerCopy(row.enabled ? t('disableProvider') : t('enableProvider'), target)}
                    title={providerCopy(row.enabled ? t('disableProvider') : t('enableProvider'), target)}
                    disabled={!state.writable || toggling.has(row.entry.provider)}
                    className={styles['providerSwitch']}
                    onClick={() => { toggleProvider(target) }}
                  >
                    <span className={styles['providerSwitchKnob']} />
                  </button>
                  {!loginServed(operations, target.settingsNs)
                    ? null
                    : row.oauthSession?.configured === true
                      ? (
                        <>
                          {/* A stored session can still be unusable (expired or
                              revoked refresh token), and the login dialog owns the
                              paste-back flow, so the row keeps a direct way back
                              into it instead of forcing a log out first. */}
                          <button
                            type="button"
                            className={styles['secondaryButton']}
                            aria-label={providerCopy(reloginCopy(target), target)}
                            disabled={!state.writable}
                            onClick={() => {
                              setSavedTarget(undefined)
                              setLoginTarget(target)
                            }}
                          >
                            {reloginCopy(target)}
                          </button>
                          <button
                            type="button"
                            className={styles['secondaryButton']}
                            aria-label={providerCopy(t('logout'), target)}
                            disabled={!state.writable}
                            onClick={() => {
                              if (row.oauthRef !== undefined) logoutSession(target, row.oauthRef)
                            }}
                          >
                            {t('logout')}
                          </button>
                        </>
                      )
                      : (
                        <button
                          type="button"
                          className={styles['secondaryButton']}
                          aria-label={providerCopy(
                            target.settingsNs === 'llm-claude' ? t('claudeLogin') : t('opencodeLogin'),
                            target,
                          )}
                          disabled={!state.writable}
                          onClick={() => {
                            setSavedTarget(undefined)
                            setLoginTarget(target)
                          }}
                        >
                          {target.settingsNs === 'llm-claude' ? t('claudeLogin') : t('opencodeLogin')}
                        </button>
                      )}
                  {/* The account catalog comes from the account listing; its model overrides live in cordis.patch.yml. */}
                  {row.entry.provider === 'deepseek-account'
                    ? null
                    : (
                      <button
                        type="button"
                        className={styles['secondaryButton']}
                        aria-label={providerCopy(t('editProvider'), target)}
                        disabled={!open && state.status !== 'ready'}
                        onClick={() => {
                          if (!open && controller.store.getSnapshot().status !== 'ready') return
                          setSavedTarget(undefined)
                          // One card at a time: the add card closes with whatever
                          // it held, since closing either card would otherwise
                          // discard the other's draft.
                          setAddOpen(false)
                          setEditing(open ? undefined : target)
                        }}
                      >
                        {t('edit')}
                      </button>
                    )}
                  {row.removable
                    ? (
                      <button
                        type="button"
                        className={styles['dangerButton']}
                        aria-label={providerCopy(t('removeProvider'), target)}
                        disabled={!state.writable || state.status !== 'ready'}
                        onClick={() => {
                          if (controller.store.getSnapshot().status !== 'ready') return
                          setSavedTarget(undefined)
                          setDeleteFailure(undefined)
                          setDeleteTarget(target)
                        }}
                      >
                        {t('remove')}
                      </button>
                    )
                    : resettableRefs(row).length > 0
                      ? (
                        <button
                          type="button"
                          className={styles['dangerButton']}
                          aria-label={providerCopy(t('resetCredentials'), target)}
                          disabled={!state.writable}
                          onClick={() => {
                            setSavedTarget(undefined)
                            setResetFailure(undefined)
                            setResetTarget({
                              provider: target.provider,
                              displayName: target.displayName,
                              refs: resettableRefs(row),
                            })
                          }}
                        >
                          {t('remove')}
                        </button>
                      )
                      : null}
                </span>
              </div>
              {error}
              {renderSlot(
                'settings.models.provider-card',
                { provider: row.entry, configured: row.configured, keyConfigured: keyConfiguredOf(row) },
                { entryKey: row.entry.settingsNs },
              )}
              {open
                ? renderProviderEditor({
                  target,
                  row,
                  namespace,
                  schema,
                  operations,
                  t,
                  readOnly: !state.writable,
                  onClose: (changed) => { closeEditor(changed, target) },
                })
                : null}
            </li>
          )
        })}
      </ul>
      {toggleFailure === undefined
        ? null
        : <p className={styles['error']} role="alert">{toggleFailure}</p>}
      <div className={styles['addBlock']}>
        {addOpen
          ? (
            <div className={styles['addCard']}>
              <div className={styles['addModes']}>
                {bothOffered
                  ? (
                    <SegmentedControl
                      id={addId}
                      label={t('addMode')}
                      value={mode}
                      disabled={switchLocked}
                      options={[
                        {
                          value: 'catalog',
                          label: t('addCatalog'),
                          disabled: !catalogEnabled,
                          ...catalogEnabled ? {} : { title: t('addCatalogExhausted') },
                        },
                        {
                          value: 'custom',
                          label: t('addCustom'),
                          disabled: !customEnabled,
                          ...customEnabled ? {} : { title: t('addCustomUnavailable') },
                        },
                      ]}
                      onChange={(next) => {
                        setAddMode(next)
                        setVisited(previous => new Set([...previous, next]))
                      }}
                    />
                  )
                  : (
                    // One mode alone has no switch to name it, so the card
                    // carries the mode as its title instead.
                    <div className={styles['editorHeader']}>
                      <span className={styles['editorTitle']}>{t(mode === 'catalog' ? 'addCatalog' : 'addCustom')}</span>
                    </div>
                  )}
                <p className={styles['advancedHint']}>
                  {t(mode === 'catalog' ? 'addCatalogHint' : 'addCustomHint')}
                </p>
              </div>
              {mounted('catalog') && draft !== undefined
                ? (
                  <div
                    id={`${addId}-catalog-panel`}
                    {...bothOffered ? { role: 'tabpanel', 'aria-labelledby': `${addId}-catalog` } : {}}
                    hidden={mode !== 'catalog'}
                    className={styles['addPanel']}
                  >
                    <div className={styles['field']}>
                      <span className={styles['fieldLabel']}>{t('provider')}</span>
                      <select
                        className={`${styles['input']} ${styles['selectInput']}`}
                        value={draft.target.provider}
                        aria-label={t('provider')}
                        disabled={catalogBusy}
                        onChange={(event) => {
                          const picked = addable.find(candidate => candidate.row.entry.provider === event.target.value)
                          /* v8 ignore next -- the select only lists addable rows */
                          if (picked === undefined) return
                          setEditing(targetOf(picked.row))
                        }}
                      >
                        {addable.map(({ row }) => (
                          <option key={row.entry.provider} value={row.entry.provider}>
                            {providerDisplayName(row.entry.provider, row.entry.displayName)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <ProviderEditor
                      key={draft.target.provider}
                      provider={draft.target.provider}
                      displayName={draft.target.displayName}
                      hideTitle
                      namespace={draft.namespace}
                      schema={schema}
                      settingsPath={draft.target.settingsPath}
                      operations={operations}
                      {...draft.target.defaultBaseURL === undefined ? {} : { defaultBaseURL: draft.target.defaultBaseURL }}
                      {...draft.target.baseURLEnv === undefined ? {} : { baseURLEnv: draft.target.baseURLEnv }}
                      {...draft.target.nativeAuth === undefined ? {} : { nativeAuth: draft.target.nativeAuth }}
                      {...addRow?.credentialChecks === undefined ? {} : { credentialChecks: addRow.credentialChecks }}
                      t={t}
                      readOnly={!state.writable}
                      onClose={(changed) => { closeEditor(changed, draft.target) }}
                      onBusyChange={setCatalogBusy}
                    />
                    {addRow === undefined
                      ? null
                      : renderSlot(
                        'settings.models.provider-card',
                        { provider: addRow.entry, configured: addRow.configured, keyConfigured: keyConfiguredOf(addRow) },
                        { entryKey: addRow.entry.settingsNs },
                      )}
                  </div>
                )
                : null}
              {mounted('custom') && piAi !== undefined
                ? (
                  <div
                    id={`${addId}-custom-panel`}
                    {...bothOffered ? { role: 'tabpanel', 'aria-labelledby': `${addId}-custom` } : {}}
                    hidden={mode !== 'custom'}
                    className={styles['addPanel']}
                  >
                    <CustomProviderCard
                      taken={state.rows.map(row => row.entry.provider)}
                      protocols={protocols}
                      reasoningLevels={reasoningLevels}
                      revision={piAi.revision}
                      operations={operations}
                      t={t}
                      readOnly={!state.writable}
                      onClose={(changed) => {
                        closeAdd()
                        if (changed) void controller.load()
                      }}
                      onBusyChange={setCustomBusy}
                    />
                  </div>
                )
                : null}
            </div>
          )
          : catalogOffered || customOffered
            ? (
              // One entry for both ways to gain a provider; the card behind it
              // splits them. Full width, so it lines up with the rows above.
              <div className={styles['addActions']}>
                <button
                  type="button"
                  className={styles['addButton']}
                  disabled={!state.writable || state.status !== 'ready' || (!catalogEnabled && !customEnabled)}
                  onClick={() => {
                    if (controller.store.getSnapshot().status !== 'ready') return
                    const first = addable[0]
                    const initial: AddMode = catalogEnabled ? 'catalog' : 'custom'
                    setSavedTarget(undefined)
                    setEditing(first === undefined ? undefined : targetOf(first.row))
                    setAddMode(initial)
                    setVisited(new Set([initial]))
                    setAddOpen(true)
                  }}
                >
                  <IconPlusOutlineRegular size={14} />
                  {t('add')}
                </button>
              </div>
            )
            : null}
      </div>
      {renderSlot('settings.models.footer', {})}
      {loginTarget === undefined
        ? null
        : OAUTH_SETTINGS_NS[loginTarget.settingsNs] === 'claude' && operations.claudeLogin !== undefined
          ? (
            <ClaudeLoginDialog
              operations={operations}
              login={operations.claudeLogin}
              t={t}
              readOnly={!state.writable}
              onClose={closeLogin}
            />
          )
          : OAUTH_SETTINGS_NS[loginTarget.settingsNs] === 'opencode' && operations.opencodeLogin !== undefined
            ? (
              <OpencodeLoginDialog
                operations={operations}
                login={operations.opencodeLogin}
                t={t}
                readOnly={!state.writable}
                onClose={closeLogin}
              />
            )
            : null}
      {resetTarget === undefined
        ? null
        : (
          <Modal
            open
            onClose={closeReset}
            title={providerCopy(t('resetCredentialsTitle'), resetTarget)}
            closeLabel={t('close')}
            description={providerCopy(t('resetCredentialsDescription'), resetTarget)}
            footer={(
              <>
                <Button variant="outline" autoFocus disabled={resetting} onClick={closeReset}>
                  {t('cancel')}
                </Button>
                <Button
                  variant="outline"
                  className={styles['deleteConfirm']}
                  disabled={resetting}
                  onClick={confirmReset}
                >
                  {resetting ? t('resettingCredentials') : t('resetCredentialsConfirm')}
                </Button>
              </>
            )}
          >
            {resetFailure === undefined ? null : <p className={styles['error']}>{resetFailure}</p>}
          </Modal>
        )}
      <Modal
        open={deleteTarget !== undefined}
        onClose={closeDelete}
        title={deleteTarget === undefined ? '' : providerCopy(t('deleteTitle'), deleteTarget)}
        closeLabel={t('close')}
        description={deleteTarget === undefined
          ? ''
          : providerCopy(
            deleteTarget.credentialRef === undefined
              ? t('deleteDescription')
              : t('deleteDescriptionWithCredential'),
            deleteTarget,
          )}
        className={styles['deleteDialog'] as string}
        footer={(
          <>
            <Button variant="outline" data-modal-autofocus disabled={deleting} onClick={closeDelete}>
              {t('cancel')}
            </Button>
            <Button
              variant="outline"
              className={styles['deleteConfirm']}
              disabled={deleting}
              onClick={confirmDelete}
            >
              {deleteTarget === undefined
                ? ''
                : providerCopy(deleting ? t('deleting') : t('deleteConfirm'), deleteTarget)}
            </Button>
          </>
        )}
      >
        {deleteFailure === undefined ? null : <p className={styles['error']}>{deleteFailure}</p>}
      </Modal>
    </div>
  )
}
