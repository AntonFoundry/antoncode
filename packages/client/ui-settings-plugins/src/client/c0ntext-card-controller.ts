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
  dreamProvider?: string
  dreamModel?: string
  dreamIdleHours?: number
}

export interface C0ntextCardState extends CardShell {
  endpoint: CardFieldState
  apiKey: CardFieldState
  projectId: CardFieldState
  maxSurfaceRatio: CardFieldState
  windowTokens: CardFieldState
  evictorEnabled: CardFieldState
  dreamProvider: CardFieldState
  dreamModel: CardFieldState
  dreamIdleHours: CardFieldState
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
      textField('dreamProvider'), textField('dreamModel'), numberField('dreamIdleHours'),
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
      dreamProvider: this.form.field('dreamProvider'),
      dreamModel: this.form.field('dreamModel'),
      dreamIdleHours: this.form.field('dreamIdleHours'),
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
