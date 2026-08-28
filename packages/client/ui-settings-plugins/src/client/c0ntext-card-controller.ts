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
}

export interface C0ntextCardState extends CardShell {
  endpoint: CardFieldState
  apiKey: CardFieldState
  projectId: CardFieldState
  maxSurfaceRatio: CardFieldState
  windowTokens: CardFieldState
  evictorEnabled: CardFieldState
}

export interface C0ntextCardFace extends CardActions {
  hooks: { c0ntextCard: SnapshotStore<C0ntextCardState> }
}

export class C0ntextCardController {
  private readonly form: CardForm<C0ntextSettings>
  private readonly store: SnapshotStore<C0ntextCardState>

  constructor(scope: SettingsScope<C0ntextSettings>) {
    this.form = new CardForm(scope, [
      textField('endpoint'), textField('apiKey'), textField('projectId'), numberField('maxSurfaceRatio'),
      numberField('windowTokens'), booleanField('evictorEnabled'),
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
    }
  }

  inject(): C0ntextCardFace { return { hooks: { c0ntextCard: this.store }, ...this.form.actions() } }
}
