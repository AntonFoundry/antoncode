# Agent Note: Pinned tools — always-wired schemas in Paged Mode

Status: implemented

English

## Problem

Paged Mode pages the entire registry behind a name-and-summary catalog plus the `tool_search` grant loop. That is all-or-nothing per agent: every tool costs one `tool_search` round-trip before it is callable, including the small set a deployment knows its model will need on every turn. For those always-on tools the round-trip is pure latency with no token savings — their schemas are already needed regardless — while the long tail genuinely benefits from paging. The paging contract needed a deployment-level "always granted" subset that keeps the catalog for the long tail without forcing a search round-trip for the common tools.

## Decision

`dsh-tools` gains a `pinned?: string[]` config, defaulting to `[]`. Under `paged`, a pinned name is unioned into the scope's granted-name set, so it is wired with its full schema from the first turn and directly callable with no `tool_search` round-trip. Pinned names are also excluded from the `tools:catalog` section and from the `tool_search` candidate list — an already-wired tool re-listed in the catalog is noise. `native`, `code`, and `both` ignore the field.

The single seam is `grantedNames(scope)`: `view()` (visibility), `collapses()` (the direct-call gate), `schemas()`, `wireSchemas()`, and `grantTools()` all already flow through it, so pinning needs no other gating change — pinned tools become visible and callable by construction. `PAGED_ONLY_INSTRUCTION` stays unchanged: it already says "already-granted tools", and pinned tools are effectively pre-granted.

Pinning grants visibility, not authority. A scoped restriction still removes a pinned tool from the wire set (restrictions filter the pre-paging capability surface, and `view()` only keeps granted names that survive that filter), and a pinned name that resolves to no registered tool is ignored. The pinned set is fixed at construction, unlike the per-scope granted sets that widen over a session.

## Alternatives considered

- **Per-agent or per-preset pinned sets** (`presentAs(mode, { pinned })`) — rejected: deployment-wide is the first-order need. A preset that wants a standing always-on tool can already express it through a paged scope plus a grant, and adding a `presentAs` overload would split the concept before a consumer asks for it.
- **Auto-selecting the pinned set from usage** — rejected: explicit config only. Deriving "always-on" from usage would be a heuristic the harness must explain, and it would make the wire set non-deterministic across sessions — the opposite of the prefix-cache stability paging exists to preserve.
- **A separate pinned layer instead of unioning into `grantedNames`** — rejected: `grantedNames` is already the single point every paged consumer reads. A parallel set would risk the visibility gate (`view`) and the direct-call gate (`collapses`) drifting apart, the exact duplication the existing single-seam design avoids.

## Consequences

Pinned tools are wired from turn 1 and never cost a `tool_search` round-trip, while the long tail stays paged. The catalog and the `tool_search` candidate list shrink by the pinned names, so a pinned tool is no longer discoverable by search — acceptable because it is already present in the wire set. The behavior is pinned by the `pinned set` describe block in `paged-mode.spec.ts`: full schema on the first turn, direct execution without a grant, absence from the catalog section and candidate list, union with dynamic grants without duplicates, restriction still hides a pinned tool, and `native`/`code`/`both` are unaffected.

The field stays out of shipped defaults (`[]`), so an existing paged deployment is unchanged until it opts in.
