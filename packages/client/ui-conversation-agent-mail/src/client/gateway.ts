/** One addressed mail item projected for browser display. */
export interface AgentMailMessage {
  seq: number
  from: string
  workspaceId: string
  body: string
  at: number
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
   * @throws Error on authorization, publication, or refresh failure; a refresh failure does not undo a send.
   */
  sendLocal(input: {
    sessionId: string
    workspaceId: string
    recipients: readonly string[]
    body: string
    workspaceWide: boolean
  }): Promise<void>
  /**
   * Commit mail to one live peer in another workspace and refresh the browser mailbox.
   * @param input - Authorized sender Session and workspace, recipient Session, and body.
   * @throws Error on authorization, publication, or refresh failure; a refresh failure does not undo a send.
   */
  sendDirect(input: { sessionId: string; workspaceId: string; recipient: string; body: string }): Promise<void>
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
