import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { booleanField, CardForm, numberField, textField, type CardActions, type CardFieldState, type CardShell } from './card-form.ts'

export const CONTEXT_NS = 'c0ntext-context'

export interface C0ntextSettings {
  endpoint?: string
  apiKey?: string
  projectId?: string
  maxSurfaceRatio?: number
  windowTokens?: number
  evictorEnabled?: boolean
  retrieveMode?: 'fast' | 'full'
  dreamProvider?: string
  dreamModel?: string
  dreamIdleHours?: number
  /** Replacement text for the `c0ntext:memory` prompt section; empty = built-in. */
  memoryContractOverride?: string
  /** Replacement text for the `c0ntext:paging` prompt section; empty = built-in. */
  pagingReminderOverride?: string
  /** Replacement text for the `c0ntext:code-map` prompt section; empty = built-in. */
  codeMapGuidanceOverride?: string
}

export interface C0ntextCardState extends CardShell {
  endpoint: CardFieldState
  apiKey: CardFieldState
  projectId: CardFieldState
  maxSurfaceRatio: CardFieldState
  windowTokens: CardFieldState
  evictorEnabled: CardFieldState
  retrieveMode: CardFieldState
  dreamProvider: CardFieldState
  dreamModel: CardFieldState
  dreamIdleHours: CardFieldState
  memoryContractOverride: CardFieldState
  pagingReminderOverride: CardFieldState
  codeMapGuidanceOverride: CardFieldState
}

export interface C0ntextCardFace extends CardActions {
  hooks: { c0ntextCard: SnapshotStore<C0ntextCardState> }
  dreamCatalog: () => Promise<DreamRouteOption[]>
}

/** One selectable dream route from the deployment catalog (`provider/model`). */
export interface DreamRouteOption { id: string; label: string }

export class C0ntextCardController {
  private readonly form: CardForm<C0ntextSettings>
  private readonly store: SnapshotStore<C0ntextCardState>
  private readonly dreamCatalog: () => Promise<DreamRouteOption[]>

  constructor(scope: SettingsScope<C0ntextSettings>, dreamCatalog?: () => Promise<DreamRouteOption[]>) {
    this.dreamCatalog = dreamCatalog ?? (() => Promise.resolve([]))
    this.form = new CardForm(scope, [
      textField('endpoint'), textField('apiKey'), textField('projectId'), numberField('maxSurfaceRatio'),
      numberField('windowTokens'), booleanField('evictorEnabled'),
      textField('retrieveMode'),
      textField('dreamProvider'), textField('dreamModel'), numberField('dreamIdleHours'),
      // Prompt-section overrides: prose long enough to want textareas, but the
      // same staged-text contract — an empty draft clears the stored override,
      // which is exactly "use the built-in text" again.
      textField('memoryContractOverride'), textField('pagingReminderOverride'), textField('codeMapGuidanceOverride'),
    ])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): C0ntextCardState {
    return {
      ...this.form.shell(),
      endpoint: this.form.field('endpoint'),
      apiKey: this.form.field('apiKey'),
      projectId: this.form.field('projectId'),
      maxSurfaceRatio: this.form.field('maxSurfaceRatio'),
      windowTokens: this.form.field('windowTokens'),
      evictorEnabled: this.form.field('evictorEnabled'),
      retrieveMode: this.form.field('retrieveMode'),
      dreamProvider: this.form.field('dreamProvider'),
      dreamModel: this.form.field('dreamModel'),
      dreamIdleHours: this.form.field('dreamIdleHours'),
      memoryContractOverride: this.form.field('memoryContractOverride'),
      pagingReminderOverride: this.form.field('pagingReminderOverride'),
      codeMapGuidanceOverride: this.form.field('codeMapGuidanceOverride'),
    }
  }

  inject(): C0ntextCardFace {
    return {
      hooks: { c0ntextCard: this.store },
      dreamCatalog: () => this.dreamCatalog?.() ?? Promise.resolve([]),
      ...this.form.actions(),
    }
  }
}
