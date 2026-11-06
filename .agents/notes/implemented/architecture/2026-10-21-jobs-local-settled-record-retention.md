# Agent Note: Jobs-local settled-record retention

Status: implemented

English

## Problem

`LocalJobRegistry` kept every terminal job record — including its retained output — for the registry's whole life. The only removal paths were owner-agent disposal and service teardown, so a long-lived agent that starts many background jobs accumulated terminal history without bound. This was the one unbounded in-memory structure in the jobs seam.

## Decision

`settledRetentionPerOwner` (a positive safe integer, schema-defaulted to `128`) caps terminal records per exact-owner bucket and in the shared unowned bucket, mirroring `maxConcurrentJobsPerOwner`'s ownership shape. Settlement past the cap drops the oldest-finished records and announces the removals through the same change notification `disposeOwned` uses. The just-settled record is the newest terminal record, so eviction never removes the outcome that triggered the pass.

## Alternatives considered

**One global cap across all owners.** A single spammy owner would evict another owner's unread outcomes; per-bucket retention keeps owners independent, matching the existing concurrency cap.

**Evict only records marked `reported`.** `reported` means a waiter resolved at settlement, not that every observer has read the row — outcomes already reach `onJobDone` listeners during settlement — so the flag adds a state distinction without a stronger safety property.

**TTL-based expiry.** Time-based eviction makes the visible record set depend on wall-clock timing and bounds nothing under bursts that land inside any TTL. A count bound is deterministic and testable.

## Consequences

Memory is bounded at roughly `retention × per-record output limit` per bucket. A `job_status` poll naming a record evicted before it was read observes the same "unknown job" it already observes for never-seen ids; default `128` is generous against the per-owner concurrency cap of `10`. The key is schema-defaulted, so existing compositions change nothing.

## Testing

`packages/jobs/jobs-local/tests/jobs.spec.ts` covers eviction past the cap (oldest dropped, just-settled kept, removal announced through the visible set) and the under-cap no-op.
