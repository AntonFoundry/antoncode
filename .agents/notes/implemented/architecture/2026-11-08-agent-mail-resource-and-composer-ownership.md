# Agent Note: Agent Mail separates live mailbox resources from composer choices

Status: implemented

## Problem

Cross-workspace discovery and replies need live authorization data, while recipient choices must survive view remounts and remain available to the resident composer. Component subscriptions and module-global channel state give those values different lifetimes and can submit a selection captured before a Session moved or lost eligibility. Reusing workspace broadcast subscription for UI updates also changes durable delivery membership merely by opening mail.

The [resident-composer decision](../feature/2026-10-30-agent-mail-resident-composer.md) continues to own input routing and independent scrollers; this decision replaces its channel-only selection with registered recipient state. The [delivery-settlement decision](../bug-fix/2026-10-30-agent-mail-delivery-settlement.md) keeps queue commitment separate from refresh. Live observation preserves that distinction without another durable inbox or a best-effort copy into Session history.

## Decision

Agent Mail uses the existing local and direct queues. Each queue provides read-only post-commit observation independently of broadcast subscription and acknowledgement. The owner-only Remote watch emits bounded generation-local invalidation revisions, not message bodies. Workspace and Agent lifecycle changes trigger eligibility re-evaluation. The Host checks the invoking principal and current address; browser discovery grants no permission.

The registered `agentmail` resource owns watch setup, paginated refresh, reconnect generations, cancellation, and publication. It installs observation before the initial query and coalesces invalidations while a read is pending. The Gateway remains the sole cached mailbox and temporary outgoing-row owner. Its stable aggregate source lets a committed receipt become visible without waiting for another watch event. Authority failures clear sensitive values before an error frame; unrelated declared Remote failures can preserve the last authorized value. Unexpected exceptions remain defects rather than being disguised as access errors.

The composer has one declared Session-scoped store containing channel, browsed workspace, and selected recipient tuples only. The renderer owns store instances. The view reads framework hooks and mutates declared actions; apply-world composer commands use `getStoreSnapshot` against the current Session binding and the same registered handle. Production business code never creates a parallel store instance. This bridge supplies command-time state without exporting a module singleton or passing a hand-made hook into the component.

The picker uses current authorized live peers and permitted Session/workspace titles, falling back to identifiers. Direct recipients may span workspaces but use one direct transaction. Selecting an incompatible transport requires replacement rather than an implicit split across ledgers. Submission revalidates Session/workspace/transport tuples and rejects conflicting mentions. Reply selects the exact current sender and focuses the resident composer without changing draft text; it neither publishes mail nor creates reply metadata.

## Alternatives considered

**Use queue subscription as UI observation.** Rejected: local subscription opts a Session into durable workspace broadcasts. Observation must not create accounts, acknowledge, or wake recipients.

**Poll or subscribe inside components.** Rejected: that duplicates the resource framework's lifetime and reconnect ownership, hides stale generations, and makes teardown depend on presentation structure.

**Keep global channel helpers or create a command-only store.** Rejected: globals leak interaction state across plugin lifetimes, and a second store disconnects the composer from the rendered selection. The declared handle and current framework binding provide one Session state owner.

**Mirror every send into a new durable Sent store.** Rejected: queue commitment and a separate write are not atomic. The current scope preserves canonical queue and Session owners without promising permanent history, idempotent ambiguous-send retries, or persisted threads.

## Consequences

Custom Client integrations migrate removed channel helpers and Gateway component props as described in the [upgrade guide](../../../../docs/upgrade-guide/v0.2.2-alpha.2/cross-workspace-agent-mail/guide.md). Matching Host watch descriptors and generated APIs are required; manual polling is not a fallback. The Client resource and queue observers add process-local notification/lifecycle data, not durable Session fields or queue schema changes.

Opening, refreshing, selecting, and replying do not advance processing cursors or wake recipients. Offline direct authorization, archived-recipient policy, durable Sent retention, persisted reply relations, and read/responded status remain outside this capability. Local queue APIs retain their existing durable-member behavior; the picker does not turn that into an offline cross-workspace delivery promise.
