/**
 * The gate-policy card's staged form over the `gate-policy` settings
 * namespace: the todo-plan gate toggle and the tools it gates while no plan
 * exists. The Host guard reads the section live, so a save applies on the
 * next tool call without re-composing.
 */

import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import { booleanField, CardForm } from './card-form.ts'
import type { CardActions, CardFieldState, CardShell } from './card-form.ts'

/** The settings namespace this card edits. */
export const GATE_POLICY_NS = 'gate-policy'

/** The section shape the card edits (flat: the todo-plan gate). */
export interface GatePolicySettings {
  enabled: boolean
  tools: string[]
}

/** The stored-to-draft conversion for the comma-separated tools list. */
const toolsField = {
  field: 'tools',
  format: (value: unknown): string => Array.isArray(value) ? value.join(', ') : '',
  parse: (text: string) => ({ kind: 'set' as const, value: text.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0) }),
}

/** One gate-policy card control's state. */
export interface GatePolicyCardState extends CardShell {
  enabled: CardFieldState
  tools: CardFieldState
  /** Whether the gate is on (the effective stored value). */
  enabledOn: boolean
  /** The effective gated-tools list. */
  toolsList: string[]
}

/** Card face the slot registration injects. */
export interface GatePolicyCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useGatePolicyCard. */
    gatePolicyCard: import('@deepseek-ai/dsh-client-runtime/client').SnapshotStore<GatePolicyCardState>
  }
}

/**
 * Bridges the `gate-policy` settings scope onto the card.
 * @param scope - the bound settings scope for the `gate-policy` namespace.
 */
export class GatePolicyCardController {
  private readonly form: CardForm<GatePolicySettings>
  private readonly store: import('@deepseek-ai/dsh-client-runtime/client').SnapshotStore<GatePolicyCardState>

  /**
   * @param scope - the bound settings scope for the `gate-policy` namespace.
   */
  constructor(scope: SettingsScope<GatePolicySettings>) {
    this.form = new CardForm(
      scope,
      [booleanField('enabled'), toolsField],
    )
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): GatePolicyCardState {
    const enabled = this.form.field('enabled')
    const tools = this.form.field('tools')
    return {
      ...this.form.shell(),
      enabled,
      tools,
      enabledOn: enabled.text === 'true',
      toolsList: tools.text.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0),
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): GatePolicyCardFace {
    return { hooks: { gatePolicyCard: this.store }, ...this.form.actions() }
  }
}
