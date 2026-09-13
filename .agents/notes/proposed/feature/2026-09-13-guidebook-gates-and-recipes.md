# Guidebook, gates, and recipes — agent knowledge system

Status: proposed. Class: feature. This note records the decision to build an
agent knowledge system with five pieces (verdicts, gates, global recipe
store, promotion pipeline, dream-cycle consolidation) plus a tier-3 upstream
recipe repository, and the design invariants the implementation must keep.

## Problem

Agents re-derive procedure every session. Public-tool knowledge lives in
model weights and must not be encoded in prompts. What needs infrastructure
is: policy verdicts ("full suite before push") chosen by the deployment
owner; discipline — a model mid-task optimizes for completing the request
and never asks what must be true before a dangerous action; and compounding
— procedures that succeeded once should be findable cross-repo by later
sessions.

## The pieces

1. **Verdicts** — a few one-line laws in the workspace `AGENT.md` the
   session always loads. Content, not code; ships first so gates have
   something to enforce.
2. **Gates** — middleware on the tool-execution path. Trigger patterns
   (`git push`, deploy, delete, force-flags) cause a denial whose text is
   the question: "what must be true before this proceeds?", plus verdicts
   retrieved from the recipe store. The model answers in-transcript and
   retries. A gate never approves; it can only block until the checks are
   stated. Verified gates that execute the check themselves are a later
   refinement reserved for test-before-push.
3. **Global recipe store** — c0ntext gains a global scope (cross-repo,
   cross-session) and a `recipe` entity: `{intent, procedure, contract,
   provenance, status}`. Queried by intent at decision time; only a
   one-line reminder that the store exists is always loaded.
4. **Promotion pipeline** — watches run records; when a run using a
   procedure completes successfully, it deterministically drafts a recipe
   record with provenance (`promoted_from_run` / `url` / `authored`).
5. **Dream-cycle consolidation** — the dream cycle dedupes drafts, merges
   variants (keeping the variant with more successful runs), demotes
   recipes contradicted by later failures, and commits survivors as
   long-term guidebook entries.
6. **Tier-3 upstream repo** — a plain public git repository of scrubbed,
   parameterized, cross-project-surviving recipes. Fetch pulls into a
   read-only upstream scope queried after the local tier; contribution runs
   the scrubbing pass and renders a PR.

Phase 2 shipped as `packages/guard/gate-policy`: configured rules register
monotonic tool guards; a matching call is denied with the rule's checklist
as the tool-result text. The in-denial verdict retrieval (piece 2's store
lookup) and pieces 3–6 are not yet built.

## Invariants

- Recipes live as store records, not files: agent-facing, cross-repo by
  construction, retrieved by meaning through the store's projections.
- Private APIs become typed tool surfaces, not prose descriptions.
- Drafting is deterministic; only consolidation is model-assisted (the
  analysis/improve split: the evidence under a proposal is not
  model-produced).
- Usage accounting distinguishes reported from estimated; an unmeasured
  number is never presented as measured.
- Gate triggers are cheap and deterministic; the tuning budget goes to
  firing on dangerous actions without nagging.

## What was given up

File-based workflow cards (the px0 pattern) — rejected because the
consumer is agents, not people; records give cross-repo scope, semantic
retrieval, bitemporal provenance, and demotion natively. The escape hatch
for a load-bearing recipe is promotion of its text into `AGENT.md`.

## Required verification

- Gates: a keyless snapshot showing a `git push` tool call denied with the
  checklist in the tool result, and the unmodified retry after checks (the
  package's real-composition suite covers the decision path; the snapshot
  pass is still owed).
- Store: recipe CRUD/query against the global scope; retrieval by intent
  without the name.
- Pipeline: a successful run produces a drafted record with provenance;
  a failed re-run flags the recipe.
- Dream extension: duplicate drafts merge; a contradicted recipe demotes.
