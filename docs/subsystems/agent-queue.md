# Agent queues

Durable workspace queues and cross-workspace direct mail do not wake a model or append inbox input. The [package README](../../packages/interaction/agent-queue/README.md) owns authorization, durability, bounds, and failure behavior.

## Workspace publications

`PublishRequest` chooses an explicit recipient set or the subscriptions active at publication. `ReadPage` retains the acknowledgement cursor; `QueueListener` receives advisory post-commit notices, so consumers replay reads after subscribing to close races.

### `PublishRequest`

Source: [`packages/interaction/agent-queue/src/index.ts`](../../packages/interaction/agent-queue/src/index.ts).

```ts type-equiv
/** Addressed text for one durable workspace publication. */
interface PublishRequest {
  /** Optional workspace guard; when supplied it must equal the caller's workspace. */
  readonly workspaceId?: WorkspaceId
  /** Workspace topic: include only the subscriptions present at durable publication. */
  readonly workspaceWide?: boolean
  /** Durable session addresses within the sender's workspace. */
  readonly recipients?: readonly SessionId[]
  readonly body: string
}
```

### `ReadPage`

Source: [`packages/interaction/agent-queue/src/index.ts`](../../packages/interaction/agent-queue/src/index.ts).

```ts type-equiv
/** Retained addressed messages and the unchanged durable acknowledgement cursor. */
interface ReadPage {
  readonly messages: readonly QueueMessage[]
  readonly cursor: number
  readonly hasMore: boolean
}
```

### `QueueNotice`

Source: [`packages/interaction/agent-queue/src/index.ts`](../../packages/interaction/agent-queue/src/index.ts).

```ts type-equiv
/** Advisory post-commit notification; read the queue to obtain message contents. */
interface QueueNotice {
  readonly workspaceId: WorkspaceId
  readonly seq: number
}
```

### `QueueListener`

Source: [`packages/interaction/agent-queue/src/index.ts`](../../packages/interaction/agent-queue/src/index.ts).

```ts type-equiv
/** A subscriber callback is advisory; replay with read() after registering to close races. */
type QueueListener = (notice: QueueNotice) => void
```

## Cross-workspace direct mail

Direct discovery pages expose live authorized peers. Direct-inbox positions and peer-page tokens are distinct from workspace-queue cursors. Messages retain their addressed workspace and session identities at send time.

### `DirectSendRequest`

Source: [`packages/interaction/agent-queue/src/direct.ts`](../../packages/interaction/agent-queue/src/direct.ts).

```ts type-equiv
/** One direct send: addressees are durable session ids in OTHER registered workspaces. */
interface DirectSendRequest {
  readonly recipients: readonly SessionId[]
  readonly body: string
}
```

### `DirectInboxPage`

Source: [`packages/interaction/agent-queue/src/direct.ts`](../../packages/interaction/agent-queue/src/direct.ts).

```ts type-equiv
/**
 * Bounded direct-inbox page. `inboxCursor` is deliberately not named `cursor`:
 * it is the caller's position in the cross-workspace direct ledger and has
 * nothing to do with the per-workspace `cursor` of `agentQueue.read`.
 */
interface DirectInboxPage {
  readonly messages: readonly DirectMessage[]
  readonly inboxCursor: number
  readonly hasMore: boolean
}
```

### `DirectPeer`

Source: [`packages/interaction/agent-queue/src/direct.ts`](../../packages/interaction/agent-queue/src/direct.ts).

```ts type-equiv
/**
 * One discoverable peer: a live Agent whose own lineage authorizes a registered
 * workspace. `transport` names the service that actually reaches it, so a
 * caller never sends a local message through the cross-workspace ledger.
 */
interface DirectPeer {
  readonly sessionId: SessionId
  readonly workspaceId: WorkspaceId
  readonly transport: 'direct' | 'workspace-queue'
}
```

### `DirectIdentity`

Source: [`packages/interaction/agent-queue/src/direct.ts`](../../packages/interaction/agent-queue/src/direct.ts).

```ts type-equiv
/**
 * The caller's own cross-workspace address, direct-inbox position, unread
 * depth, and ONE keyset page of the live peers it may address.
 * `hasMorePeers` reports that live peers remain beyond this page, and
 * `nextPeerCursor` — present exactly when `hasMorePeers` is true — resumes the
 * walk strictly after the last peer returned.
 */
interface DirectIdentity {
  readonly sessionId: SessionId
  readonly workspaceId: WorkspaceId
  readonly inboxCursor: number
  readonly unread: number
  readonly peers: readonly DirectPeer[]
  readonly hasMorePeers: boolean
  readonly nextPeerCursor?: string
}
```

### `DirectAddressOptions`

Source: [`packages/interaction/agent-queue/src/direct.ts`](../../packages/interaction/agent-queue/src/direct.ts).

```ts type-equiv
/** Optional peer-page controls of one `address` call. */
interface DirectAddressOptions {
  /** Opaque `nextPeerCursor` of a previous page; the walk resumes after it. */
  readonly peerCursor?: string
  /** Peers per page, 1–{@link MAX_DIRECT_PEER_PAGE}. */
  readonly peerLimit?: number
}
```

### `QueueMessage`

Source: [`packages/interaction/agent-queue/src/spec.ts`](../../packages/interaction/agent-queue/src/spec.ts).

```ts type-equiv
/** Durable workspace message with recipients frozen at publication. */
type QueueMessage = z.infer<typeof queueMessage>
```

### `DirectMessage`

Source: [`packages/interaction/agent-queue/src/direct-spec.ts`](../../packages/interaction/agent-queue/src/direct-spec.ts).

```ts type-equiv
/** One canonical direct message in the cross-workspace mailbox. */
type DirectMessage = z.infer<typeof directMessage>
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxagentdirectqueue--agentdirectqueue"></a>

### `ctx.agentDirectQueue` — `AgentDirectQueue`

Host-owned durable direct mailbox. Every write serializes on one chain and lands as a single global-record write, so a message, its recipient index entries, and its cursors commit together or not at all.

```ts cordis-catalog
/**
 * Report the caller's own address, unread depth, and the live peers it may
 * address in every registered workspace, one keyset page at a time.
 * @param agent - Exact live calling Agent.
 * @param options - Optional peer resumption cursor and page size.
 * @returns the caller's address, cursor, unread count, and one peer page.
 */
async address(agent: Agent, options: DirectAddressOptions = {}): Promise<DirectIdentity>

/**
 * Send one direct message to session addresses in OTHER registered
 * workspaces. This ledger carries cross-workspace mail only: a recipient in
 * the sender's own workspace is rejected and belongs to `agentQueue.publish`,
 * whose v1 domain keeps every local direct message and topic.
 * @param agent - Exact live sending Agent.
 * @param request - Addressees and body.
 * @returns the committed canonical message.
 */
async send(agent: Agent, request: DirectSendRequest): Promise<DirectMessage>

/**
 * Read cross-workspace direct mail addressed to the caller, from its
 * acknowledged direct-inbox position by default. An explicit lower cursor
 * replays only still-retained messages and acknowledges nothing.
 * @param agent - Exact live reading Agent.
 * @param options - Optional explicit cursor and page limit (1–100, default 50).
 * @returns a bounded page plus the caller's durable `inboxCursor`.
 */
async inbox(agent: Agent, options: { cursor?: number; limit?: number } = {}): Promise<DirectInboxPage>

/**
 * Advance the cursor of the caller's own `(session, current workspace)`
 * address, monotonically and never past the committed ledger head or the mail
 * it can currently read. It touches no other address and no v1 workspace cursor.
 * @param agent - Exact live acknowledging Agent.
 * @param throughSeq - Last processed sequence.
 * @returns the durable cursor after the acknowledgement.
 */
async ackInbox(agent: Agent, throughSeq: number): Promise<number>
```

Types: [Agent](core.md)

Source: [`packages/interaction/agent-queue/src/direct.ts`](../../packages/interaction/agent-queue/src/direct.ts)

<a id="ctxagentqueue--agentqueue"></a>

### `ctx.agentQueue` — `AgentQueue`

Host-owned durable queue; publishing never sends agent inbox input or wakes a model.

```ts cordis-catalog
/**
 * Discover the caller's durable session address and authorized workspace peers.
 * @param agent - Exact live caller whose header and lineage establish workspace membership.
 * @returns Caller address and deduplicated durable workspace members and eligible live children.
 * @throws Error when the caller is not live or cannot authorize a registered workspace.
 */
async identities(agent: Agent): Promise<{ workspaceId: WorkspaceId; sessionId: SessionId; sessionIds: readonly SessionId[] }>

/**
 * Durably opt into future workspace broadcasts while preserving the acknowledgement cursor.
 * Direct messages need no topic subscription. Notifications are advisory; read after
 * listener installation to close races. Listener failures do not reject delivery.
 * @param agent - Exact live caller authorized for the workspace.
 * @param workspaceId - Optional guard that must equal the caller's workspace.
 * @param listener - Optional callback for addressed committed messages, including retained unread mail.
 * @param signal - Removes the live listener on abort; durable opt-in remains in place.
 * @returns Disposer for the live listener only; use unsubscribe to remove durable opt-in.
 * @throws Error on invalid membership, a mismatched workspace, or cancellation. Cancellation
 * after the durable write can reject while leaving broadcast opt-in enabled.
 */
async subscribe(agent: Agent, workspaceId?: WorkspaceId, listener?: QueueListener, signal?: AbortSignal): Promise<() => void>

/**
 * Remove broadcast opt-in and live listeners without resetting the durable cursor.
 * @param agent - Exact live caller authorized for the workspace.
 * @param workspaceId - Optional guard that must equal the caller's workspace.
 * @returns True when opt-in was removed, or false when the session was not subscribed.
 * @throws Error on invalid membership, a mismatched workspace, or addressed unread messages.
 */
async unsubscribe(agent: Agent, workspaceId?: WorkspaceId): Promise<boolean>

/**
 * Commit one message to direct targets and the current eligible broadcast subscribers.
 * Publication never injects inbox input or wakes an agent. Notifications follow commit.
 * @param agent - Exact live sender authorized for the workspace, rechecked before writing.
 * @param request - Nonempty bounded body and direct recipients, broadcast opt-in, or both.
 * @returns Durably committed message with a per-workspace sequence and frozen recipients.
 * @throws Error on invalid membership, mismatched workspace, or no eligible recipients;
 * RangeError on recipient, backlog, or sequence limits. Invalid bodies fail schema
 * validation. Storage failures reject; failed provisional-cursor rollback is reported
 * as an AggregateError.
 */
async publish(agent: Agent, request: PublishRequest): Promise<QueueMessage>

/**
 * Read addressed messages without acknowledging them; replay is limited to retained mail.
 * @param agent - Exact live caller authorized for the workspace.
 * @param options - Workspace guard, exclusive cursor or after alias, and limit (1–100,
 * default 50). Omitting both positions reads after the durable acknowledgement cursor.
 * @returns Bounded addressed messages, the unchanged acknowledgement cursor, and remaining-page flag.
 * @throws Error on invalid membership, mismatched workspace, disagreeing cursor aliases,
 * or an absent delivery account; RangeError on an invalid position or limit.
 */
async read( agent: Agent, options: { workspaceId?: WorkspaceId; cursor?: number; after?: number; limit?: number } = {}, ): Promise<ReadPage>

/**
 * Durably advance only the caller's acknowledgement cursor, never beyond committed stream head.
 * @param agent - Exact live caller authorized for the workspace.
 * @param workspaceId - Guard that must equal the caller's workspace.
 * @param throughSeq - Nonnegative safe stream sequence through which messages are acknowledged.
 * @returns Monotonic committed cursor; an earlier position leaves the cursor unchanged.
 * @throws Error on invalid membership, mismatched workspace, or absent delivery account;
 * RangeError on an invalid position or a position beyond the committed head.
 */
async ack(agent: Agent, workspaceId: WorkspaceId, throughSeq: number): Promise<number>
```

Types: [Agent](core.md) · [SessionId](core.md) · [WorkspaceId](workspace.md)

Source: [`packages/interaction/agent-queue/src/index.ts`](../../packages/interaction/agent-queue/src/index.ts)
<!-- END GENERATED cordis-surface -->
