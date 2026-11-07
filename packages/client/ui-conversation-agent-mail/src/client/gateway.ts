/** One addressed mail item projected for browser display. */
export interface AgentMailMessage {
  seq: number
  from: string
  workspaceId: string
  body: string
  at: number
}

/** A committed queue send, independent of whether its browser refresh succeeded. */
export interface AgentMailSendOutcome {
  readonly receipt: { readonly seq: number }
  readonly refreshError?: string
}

/** Browser-instance outgoing mail; durable history remains owned by the Host queues and Session logs. */
export interface AgentMailSentEntry {
  readonly key: string
  readonly seq: number
  readonly channel: 'local' | 'direct'
  readonly workspaceId: string
  readonly from: string
  readonly to: readonly string[]
  readonly body: string
  readonly at: number
}

/** Browser-facing Agent Mail operations and local presentation state. */
export interface AgentMailGateway {
  /**
   * Read local presentation authorization without opening a Remote mailbox.
   * @param sessionId - Session whose browser state is requested.
   * @returns Current authorization state and discovered address and workspace, when available.
   */
  authorization(sessionId: string): {
    state: 'unpaired' | 'authorized' | 'revoked'
    address?: string
    workspaceId?: string
  }
  /**
   * Observe local authorization snapshot updates across Sessions.
   * @param listener - Callback invoked when a mailbox snapshot is published.
   * @returns Disposer for this listener.
   */
  subscribeAuthorization(listener: () => void): () => void
  /**
   * Open the owner-only Remote mailbox and load peers and both inboxes.
   * @param sessionId - Session whose mailbox should be opened.
   * @throws Error on Remote or pagination failure; local state returns to unpaired.
   */
  authorize(sessionId: string): Promise<void>
  /**
   * Read cached mailbox contents without fetching or acknowledging mail.
   * @param sessionId - Session whose browser inbox snapshot is requested.
   * @returns Local and direct message lists with their separate acknowledgement cursors.
   */
  inbox(sessionId: string): {
    local: { messages: readonly AgentMailMessage[]; cursor: number }
    direct: { messages: readonly AgentMailMessage[]; cursor: number }
    readonly sent: readonly AgentMailSentEntry[]
    readonly refreshError?: string
  }
  /**
   * Observe browser mailbox snapshot updates across Sessions.
   * @param listener - Callback invoked when a mailbox snapshot is published.
   * @returns Disposer for this listener.
   */
  subscribeInbox(listener: () => void): () => void
  /**
   * Read the peer roster cached by the latest successful refresh.
   * @param sessionId - Session whose discoverable peers are requested.
   * @returns Authorized live peers observed during the completed paginated discovery.
   */
  peers(sessionId: string): readonly { sessionId: string; workspaceId: string }[]
  /**
   * Fetch all peer and inbox pages, then publish one browser snapshot.
   * @param sessionId - Locally authorized Session whose mailbox should be refreshed.
   * @throws Error on missing local authorization, Remote failure, or non-advancing pagination.
   */
  refresh(sessionId: string): Promise<void>
  /**
   * Clear local mailbox presentation state without changing durable delivery or Host permissions.
   * @param sessionId - Locally authorized Session to mark revoked in this browser.
   * @throws Error when the Session is not locally authorized.
   */
  revoke(sessionId: string): Promise<void>
  /**
   * Commit workspace-local mail and refresh the browser mailbox.
   * @param input - Authorized Session and workspace, direct recipients, body, and broadcast selection.
   * @returns committed receipt, with a refresh warning when the retained browser inbox is stale.
   * @throws Error on authorization or publication failure; a committed send never rejects because refresh failed.
   */
  sendLocal(input: {
    sessionId: string
    workspaceId: string
    recipients: readonly string[]
    body: string
    workspaceWide: boolean
  }): Promise<AgentMailSendOutcome>
  /**
   * Commit mail atomically to live peers in other workspaces and refresh the browser mailbox.
   * @param input - Authorized sender Session and workspace, recipient Sessions, and body.
   * @returns committed receipt, with a refresh warning when the retained browser inbox is stale.
   * @throws Error on authorization or publication failure; a committed send never rejects because refresh failed.
   */
  sendDirect(input: { sessionId: string; workspaceId: string; recipients: readonly string[]; body: string }): Promise<AgentMailSendOutcome>
  /**
   * Durably advance the selected mailbox cursor and refresh its browser snapshot.
   * @param input - Authorized Session and workspace, mailbox channel, and highest processed sequence.
   * @throws Error on authorization, acknowledgement, or refresh failure; a refresh failure does not undo the cursor.
   */
  acknowledge(input: {
    sessionId: string
    workspaceId: string
    channel: 'local' | 'direct'
    throughSeq: number
  }): Promise<void>
}
