# Agent Note: Agent Mail uses the resident composer

Status: implemented

## Problem

Agent Mail rendered its own composer at the bottom of a Discord-shaped feed, so the
session had two message boxes and the one in the mail view exposed long session ids
through a recipient dropdown. Typing `@` did nothing useful. Inter-agent
`send_message` traffic was visible only as tool calls in the sender's transcript,
not as conversation in Agent Mail. The channel rail and message feed also shared the
session scrollport, so scrolling either side moved both.

## Decision

`ui-conversation` owns a `ComposerRoutes` registry keyed by `conversation.view` id.
The resident input sink reads the session's persisted active view and, when that view
registered a route, dispatches the submission there instead of prompting the chat
session. Failure restores the draft and surfaces the route's error through the normal
composer notice. Chat keeps the unmodified prompt path.

Agent Mail registers the `agent-mail` route. It removes its internal form; the
view only selects the channel and feeds it. Channel state lives in a per-session
browser store shared by the view and the route. A local message with no mention is
the workspace broadcast; mentions address specific peers; the direct channel
requires a mention.

The `@` source suggests `Display Name#hex6` tokens, computed from the existing
deterministic name generator. The session id remains the durable address but never
appears in the draft. Sends also land in a short-lived browser outbox so the sender
sees its own message; the durable queue only returns mail addressed to the reader.

The view marks its root with `data-conversation-composer-overlay`, the existing
conversation contract for a view that owns its scrollers. The rail and feed are
independent overflow containers, and the feed reserves bottom clearance for the
resident composer. `send_message` tool calls from the active session are projected
into the same feed as sender → recipient rows, so a relay and the recipient's report
read as one thread.

## Alternatives considered

- **Keep the internal composer and style it like the main one.** Rejected: two
  input machines with different draft, image, and IME behavior is the duplication
  the reporter flagged.
- **Route by listening for the standard composer's Enter event.** Rejected: the
  chat submission would still race the mail send; the input sink is the one
  adjudicated boundary.
- **Expose session ids in mention candidates.** Rejected: the reporter's point is
  that humans cannot type them; the name plus tag already disambiguates agents.
- **Publish every `send_message` into the workspace queue.** Rejected: recipients
  would see the same text twice, once as the follow-up turn and once in the queue
  digest.

## Consequences

- A view that registers no composer route keeps today's chat behavior exactly.
- Agent Mail cannot send image attachments; the route rejects them and restores the
  draft.
- Mentions resolve against the authorized peer snapshot, so a peer that appears
  later becomes addressable after the next inbox refresh.
- `send_message` projection is scoped to the active session's transcript; a relay
  between two other agents is visible through the recipient's report, not as a
  separate child-to-child row.
