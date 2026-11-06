# Agent Note: Desktop notifications from the agent

Status: implemented

English

## Problem

An agent that finishes a long task has no way to reach a user who is working in another app. The chat surface only helps when it is on screen, and the agent cannot open one.

## Decision

- **Bounded inbox in the bridge.** `apps/anton-bridge/src/index.ts` keeps an in-memory queue (20 entries, oldest dropped) behind three loopback routes: `POST /bridge/api/notify` (`{title?, body}`, accepted only from origin-less loopback callers), `GET /bridge/api/notify/pending`, and `POST /bridge/api/notify/ack {ids}`. The body is required and capped at 2000 characters; the title is optional, capped at 200, and defaults to `Anton`.
- **Delivery rides the existing poll.** The Mac app already polls `/bridge/api/status` every two seconds; the same timer pulls `/pending`, claims ids on the main queue, acks every id it saw, and presents each new one through `UNUserNotificationCenter`. Ids are claimed before delivery and acked again on a later cycle, so overlapping polls cannot show a banner twice.
- **Authorization is lazy and the denial is silent.** The first delivery requests `[.alert, .sound]`; the macOS prompt is the approve-once gate. A denied grant drops the banner without failing anything — the bridge already returned `queued`, and a tool error would only cause retries.
- **Foreground presentation needs a delegate.** Anton is an accessory app; a `UNUserNotificationCenterDelegate` returning `[.banner, .sound]` is what keeps banners visible while the app is frontmost.
- **The tool is mounted in the main profile.** `notify` (body required, title optional) lives in `apps/anton-bridge/src/desktop-tools.ts`, which the bridge copies into the web profile and mounts with a managed patch row. There is no separate persona or allow-list.
- **Not durable.** A notification describes something happening now; replaying yesterday's queue on launch would be noise.

## Alternatives considered

- **Push from the bridge over a socket or native channel.** The bridge (Bun) has no channel into the app (Swift), and the app already polls. A new port or entitlement would buy at most two seconds of latency.
- **A durable queue in the bridge.** Surviving a bridge restart would replay stale nudges and needs retention policy no one asked for.
- **A separate approval panel for notifications.** The delivery itself needs no consent beyond the one macOS authorization dialog; a second gate would only teach users to click through.

## Consequences

Delivery latency is at most one poll interval. A denied or dismissed banner is not retried. Twenty entries is the whole backlog, so a chatty agent degrades to dropping its oldest message rather than flooding Notification Center. The tool returns `Notification queued.` regardless of whether the user later grants permission.
