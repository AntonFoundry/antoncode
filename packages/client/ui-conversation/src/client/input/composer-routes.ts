/**
 * Per-view composer routing. The resident composer belongs to the session,
 * not to the active view: a view that owns its own send semantics (Agent Mail)
 * registers here, and the input sink dispatches to it while that view is
 * selected instead of prompting the chat session.
 */
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { InputSubmitMode } from '../contract/composer-submission.ts'
import type { DraftAttachmentId } from './contract.ts'

/** One submission routed away from the chat session. */
export interface ComposerRouteRequest {
  /** Session whose resident composer produced the submission. */
  readonly sessionId: SessionId
  /** Trimmed draft text. */
  readonly text: string
  /** Browser-owned image drafts; routes that cannot carry images reject them. */
  readonly imageIds: readonly DraftAttachmentId[]
  /** Delivery mode resolved by the keyboard policy. */
  readonly mode: InputSubmitMode
}

/** Send semantics owned by one conversation view. */
export interface ComposerRoute {
  /**
   * Deliver one submission for the active view.
   * @param request - text, session, images, and delivery mode.
   * @returns completion; rejection restores the draft and surfaces a notice.
   */
  submit(request: ComposerRouteRequest): Promise<void>
}

/** Registry of the active view id plus its route handler. */
export class ComposerRoutes {
  private readonly routes = new Map<string, ComposerRoute>()

  /**
   * @param readActiveView - resolves the persisted active view id for a session.
   */
  constructor(private readonly readActiveView: (sessionId: SessionId) => string | null) {}

  /**
   * Register one view's send semantics.
   * @param viewId - `conversation.view` entry id.
   * @param route - submission handler.
   * @returns disposer removing the route.
   */
  register(viewId: string, route: ComposerRoute): () => void {
    if (this.routes.has(viewId)) throw new Error(`conversation composer route "${viewId}" is already registered`)
    this.routes.set(viewId, route)
    return () => {
      if (this.routes.get(viewId) === route) this.routes.delete(viewId)
    }
  }

  /**
   * Active view id for a session; null keeps the stable chat fallback.
   * @param sessionId - session whose persisted view selection is read.
   * @returns the selected view id, or null.
   */
  activeView(sessionId: SessionId): string | null {
    return this.readActiveView(sessionId)
  }

  /**
   * Route handler for the active view, when one is registered.
   * @param sessionId - session whose composer submitted.
   * @returns the handler, or undefined for the chat path.
   */
  activeRoute(sessionId: SessionId): ComposerRoute | undefined {
    const viewId = this.readActiveView(sessionId)
    return viewId === null ? undefined : this.routes.get(viewId)
  }
}
