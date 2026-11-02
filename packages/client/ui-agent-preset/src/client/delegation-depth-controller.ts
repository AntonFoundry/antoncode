/**
 * The delegation-depth control: how many levels a subagent may delegate to
 * another subagent, backed by `@deepseek-ai/dsh-tool-subagent`'s
 * `subagent-depth-limit` settings section.
 *
 * Namespace spelled here rather than imported: a client package must not
 * depend on a Host package. The section is installed only when the
 * deployment's configured `maxDepth` is numeric (never for
 * `'provider-managed'`), so `available: false` is this card's only signal —
 * it renders nothing rather than a control with nothing to act on.
 *
 * One field, staged like every other settings card in this deployment: a
 * drag stages a draft, and only Save turns it into a document mutation.
 */

import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** Namespace of the operator-tunable recursion cap. */
export const SUBAGENT_DEPTH_NS = 'subagent-depth-limit'

/** The section this card edits. */
interface DepthSettings {
  /** Operator override of the configured `maxDepth`, absent when none is stored. */
  maxDepth?: number
}

/** What the delegation-depth card renders. */
export interface DelegationDepthState {
  /** False while the namespace is not served to this client (e.g. `'provider-managed'`). */
  available: boolean
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** The deployment's configured default, when the composition layer carries one. */
  deploymentDefault: number | undefined
  /** The effective value this card shows: the staged draft, the stored override, or the deployment default. */
  value: number
  /** Whether a stored override currently exists, staged or not (drives the "Overridden" badge and Reset control). */
  overridden: boolean
  /** Whether a staged draft is waiting to be saved or discarded. */
  pendingEdit: boolean
  /** Whether a save is in flight. */
  saving: boolean
  /** Whether the last save did not land. */
  failed: boolean
}

/** The slider's fallback range ceiling when the deployment default does not exceed it. */
const DEFAULT_MAX = 10

/** Registration-side face for the delegation-depth card. */
export interface DelegationDepthFace {
  hooks: {
    /** Card snapshot bound by the renderer as useDelegationDepth. */
    delegationDepth: SnapshotStore<DelegationDepthState>
  }
  /** The slider's maximum, widened past {@link DEFAULT_MAX} by the deployment default. */
  max: () => number
  /** Stage a new draft value; writes nothing until {@link save}. */
  stage: (value: number) => void
  /** Write the staged draft as the stored override. */
  save: () => Promise<void>
  /** Drop a staged draft without writing anything. */
  discard: () => void
  /** Clear the staged draft and the stored override, reverting to the deployment default. */
  reset: () => Promise<void>
}

/** Bridges the `subagent-depth-limit` scope onto the delegation-depth card. */
export class DelegationDepthController {
  private readonly store: SnapshotStore<DelegationDepthState>
  private staged: number | undefined
  private saving = false
  private failed = false

  /**
   * @param scope - the bound settings scope for the `subagent-depth-limit` namespace.
   */
  constructor(private readonly scope: SettingsScope<DepthSettings>) {
    this.store = createSnapshotStore(this.projection())
    scope.subscribe(() => { this.publish() })
  }

  private publish(): void {
    this.store.set(this.projection())
  }

  private projection(): DelegationDepthState {
    const snapshot = this.scope.getSnapshot()
    const base = snapshot.base as DepthSettings | undefined
    const stored = (snapshot.value as DepthSettings | undefined)?.maxDepth
    const deploymentDefault = base?.maxDepth
    const effective = stored ?? deploymentDefault ?? 3
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      deploymentDefault,
      value: this.staged ?? effective,
      overridden: this.staged !== undefined || stored !== undefined,
      pendingEdit: this.staged !== undefined,
      saving: this.saving,
      failed: this.failed,
    }
  }

  /**
   * Build the slice of the owning `AgentPresetSection`'s inject face this
   * control contributes: its `hooks.delegationDepth` entry (auto-bound by the
   * renderer as `useDelegationDepth`) plus its flat actions, spread into the
   * section's own face rather than registered as a separate slot — the card
   * is a plain presentational sub-component, not its own entry.
   */
  inject(): DelegationDepthFace {
    return {
      hooks: { delegationDepth: this.store },
      max: () => Math.max(DEFAULT_MAX, this.projection().deploymentDefault ?? 0),
      stage: (value) => {
        this.staged = value
        this.failed = false
        this.publish()
      },
      save: () => this.save(),
      discard: () => {
        if (this.staged === undefined && !this.failed) return
        this.staged = undefined
        this.failed = false
        this.publish()
      },
      reset: () => this.reset(),
    }
  }

  private async save(): Promise<void> {
    if (this.staged === undefined || this.saving) return
    this.saving = true
    this.failed = false
    this.publish()
    try {
      await this.scope.set('maxDepth', this.staged)
      this.staged = undefined
      this.failed = false
    } catch {
      this.failed = true
    }
    this.saving = false
    this.publish()
  }

  private async reset(): Promise<void> {
    if (this.saving || !this.projection().overridden) return
    this.saving = true
    this.failed = false
    this.publish()
    try {
      await this.scope.unset('maxDepth')
      this.staged = undefined
      this.failed = false
    } catch {
      this.failed = true
    }
    this.saving = false
    this.publish()
  }
}
