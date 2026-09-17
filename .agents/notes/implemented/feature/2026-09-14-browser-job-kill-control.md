# Agent Note: Browser kill control for background jobs

Status: implemented

English

## Problem

The session-header job card could only watch background jobs die. The model-facing `job_kill` tool reaches `JobRegistry.kill()`, and the `session/jobs` mux frames keep every browser mirror current, but the apiproxy had no client-callable kill method — so a human seeing a stray `sleep 300` row could neither stop it nor even ask the host to. The only kill authority lived on the model side of the glass.

## Decision

One unary method copied from the sibling template, and the smallest UI that reaches it:

- **Contract** (`dsh-host-apiproxy/api`): `JobsApi.kill(request: RpcRequest<{ jobId: JobId }>): Promise<RpcResponse<{ killed: 'requested' | 'already-finished' }>>` in a new `jobs` domain — `RpcMethodMap` row, `ApiProxy` field, payload-direct `IApiClient.jobs.kill`, request/value zod schemas, and both dispatch tables. Two error codes join `RpcErrorDetailsMap` and the error schema: `job-not-found` (settled jobs leave the store) and `jobs-unavailable` (no registry composed; the term-domain precedent).
- **Handler**: the browser is not a registry caller, so the handler kills an unowned job under the callerless fence and resolves an owned job's owner among the live sessions' agents. The fence throws before any mutation (unknown id, foreign owner), so probing callers is side-effect-free; a throw in every attempt collapses to `job-not-found`. The connection fixture and the two in-package carrier fixtures gain `jobs` rows the same way `term` did.
- **Object layer**: `ISessions.killJob`/`SessionManager.killJob` wraps the raw wire call, beside `interruptSession`/`cancelSession`. Fire-and-return: the row settles through the next `session/jobs` change push, never through this result.
- **UI** (`ui-jobs`): the register call gains an inject face carrying one `killJob` callback over `ctx.sessions`; components stay pure-props. The card header grows a stop button beside the list toggle while any job is live (stop-all), and each `running` row grows a per-row stop — `stopping` rows show none, since the cancel signal is already admitted. A row's button disables while its request is in flight; a failure surfaces as the button's tooltip (`stop.failed`) and keeps the button retryable. No new chrome beyond the two buttons; approval-free, matching every sibling unary method.

## Testing

Handler-level: `api-proxy-jobs` kills an owned job by owner resolution, kills an unowned job callerless, answers `already-finished` for a settled job, and rejects unknown ids and registry-less compositions. Component-level: header stop appears only with live jobs and kills each; per-row stop carries the right id; a `stopping` row has no button; in-flight requests disable the button; failures land in the tooltip and re-enable retry. The `background-job-list` web e2e now drives settlement through the row's stop button itself — UI → `jobs.kill` → registry kill → change push — and its `running` golden pins the button inside the listitem.

## Alternatives considered

**A generic `jobs.list` + kill pair.** The read side already exists and is strictly better in the browser: the mux push arrives unprompted and carries the whole set, so a pollable list would add a second source of truth for one fact.

**Reusing `session.cancel`.** Different registry, different authority shape — `sessions.cancel` stops an agent's turn; jobs are process handles the session object layer never sees. A domain method keeps the two seams honest.

**Kill-by-session in the payload.** Deriving the owner in the handler from the job id keeps the wire minimal and lets the same endpoint serve both owned and unowned rows without the client ever learning about caller fences.

## Consequences

A human can now stop any job the card already shows, with the same authority the card's data ride uses. The model-side and browser-side kill paths are symmetric and neither can do more than the other. Registry fences remain: the browser cannot name a job outside its visible set and cannot kill under a wrong owner — the handler resolves owners, not the client.
