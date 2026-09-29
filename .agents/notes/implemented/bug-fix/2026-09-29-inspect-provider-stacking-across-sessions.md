# Agent Note: Host inspect providers stack equal manifests instead of failing the second session

Status: implemented

## Problem

`@deepseek-ai/dsh-tool-cordis` is a per-session preset row whose `apply()` registers first-party Host inspect providers (`Service`, `Event`, `Builtin`, `Tool`) into the process-global `cordisInspect` registry. The registry rejected any second registration of a live id, so at most one live session on any tool-cordis preset could exist per harness process: after a restart, the first session to mount claimed the ids and every later session on `cordis`, `standard`, `code`, or a derived preset failed its preset mount — `Host Cordis inspect provider "Service" is already registered` — which surfaces to the user as a session that cannot start a turn or reach any model.

The mounting session owns no provider state: every provider `query` receives the requesting agent at call time, so the registrations are shareless and safe to overlap. The 2026-09-27 model-catalog note already recorded the intended semantics ("registrations from overlapping preset generations may share a provider id only when their validated manifests match; the newest active handler serves queries, and disposing it restores the prior handler"), but that behavior had never landed in `CordisInspectRegistryService`.

## Decision

`CordisInspectRegistryService.register()` now keeps a handler stack per live provider id. A validated manifest equal to the newest live manifest stacks: the newest handler serves `list`/`query` results, and its disposer removes only that handler, restoring the prior one while claims remain and removing the id at zero. A different manifest under a live id still throws, now naming the collision a conflicting manifest held by a live session or package. Manifest comparison treats JSON object key order as insignificant while preserving array and method order.

## Alternatives considered

Moving the provider registrations to the host composition would remove the per-session registration entirely, but the providers are owned and shipped by the `tool-cordis` package and preset opt-in is per session; a host row would also change what deployments must compose. Silently overwriting or silently ignoring duplicates loses a generation when the newer owner unmounts, and the idempotent-disposer contract of `ctx.effect` needs each registration to release exactly its own claim.

## Consequences

Two or more concurrent sessions on tool-cordis presets mount independently, and a session exiting no longer breaks the others' inspect tools. A genuine version conflict (same id, different manifest) still fails the mount loudly. The two pre-existing `runner.spec.ts` failures on this tree are unrelated to this change and fail on the clean tree as well.
