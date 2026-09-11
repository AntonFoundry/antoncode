/**
 * The subagent-model card's staged form over the `subagent-child-model`
 * settings namespace — the swarm default: which model delegated children
 * run when a delegation does not name its own. One route, global for the
 * deployment; blank inherits the parent session's model.
 */

import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { CardForm, textField, type CardActions, type CardFieldState, type CardShell } from './card-form.ts'

/**
 * Namespace of the subagent child-model default. Spelled here rather than
 * imported: a client package must not depend on a Host package.
 */
export const SUBAGENT_MODEL_NS = 'subagent-child-model'

/** The swarm-default field this card edits. */
export interface SubagentModelSettings {
  /** Route children inherit when their delegation names none. */
  defaultModel?: string
}

/** One selectable model route: `provider/model` id plus a display label. */
export interface SubagentModelOption {
  /** The route written into the section (`provider/model`). */
  id: string
  /** Display label (`provider · model`). */
  label: string
}

/** What the subagent-model card renders. */
export interface SubagentModelCardState extends CardShell {
  /** The global child-model route. */
  defaultModel: CardFieldState
}

/** The registration-side face the subagent-model card's slot entry injects. */
export interface SubagentModelCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useSubagentModelCard. */
    subagentModelCard: SnapshotStore<SubagentModelCardState>
  }
  /** Load the selectable model routes from the deployment's catalog. */
  modelOptions: () => Promise<readonly SubagentModelOption[]>
}

/** Bridges the `subagent-child-model` scope onto the card. */
export class SubagentModelCardController {
  private readonly form: CardForm<SubagentModelSettings>
  private readonly store: SnapshotStore<SubagentModelCardState>

  /**
   * @param scope - the bound settings scope for the `subagent-child-model` namespace.
   * @param fetchCatalog - load the deployment's selectable model routes.
   */
  constructor(
    scope: SettingsScope<SubagentModelSettings>,
    private readonly fetchCatalog: () => Promise<readonly SubagentModelOption[]>,
  ) {
    this.form = new CardForm(scope, [textField('defaultModel')])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): SubagentModelCardState {
    return {
      ...this.form.shell(),
      defaultModel: this.form.field('defaultModel'),
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot, its form actions, and the catalog loader.
   */
  inject(): SubagentModelCardFace {
    return {
      hooks: { subagentModelCard: this.store },
      modelOptions: () => this.fetchCatalog(),
      ...this.form.actions(),
    }
  }
}
