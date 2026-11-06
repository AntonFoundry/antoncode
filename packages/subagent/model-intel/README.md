---
description: "Research model strengths periodically and choose credential-backed child routes for automatic delegation."
kind: "package-reference"
---

# @deepseek-ai/dsh-model-intel

English

## Summary

Choose a credential-backed child model automatically using a periodically researched strength datasheet. Research refreshes use public leaderboard material and one LLM call; failed refreshes preserve the previous datasheet. The saved research timestamp survives restarts, and route resolution falls back to parent inheritance when no eligible entry exists.

## Table of Contents

- [Understand the implementation](#understand-the-implementation)
- [Configuration (`model-intel:` settings section)](#configuration-model-intel-settings-section)
- [Auto routing](#auto-routing)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Understand the implementation

A weekly-researched model-strength datasheet plus the `auto` child-model resolver. The scheduler composes the deployment's existing pieces: a persisted `fetchedAt` marker in the datasheet gives restart-surviving cron semantics (missed intervals run once on the next boot), and a cheap effect-owned interval checks staleness. Each pass is guarded against concurrency and logged; the previous datasheet is kept verbatim on failure.

## Configuration (`model-intel:` settings section)

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Mount the scheduler and the resolver. |
| `researchIntervalHours` | `168` | Hours between research passes (one week). |
| `checkIntervalMinutes` | `30` | Cadence of the cheap staleness check. |
| `researchRoute` | `''` | `provider/model` the distiller runs on; empty = first credentialed configured provider. |

## Auto routing

`subagent-child-model.defaultModel: auto` (or a per-session `auto`) asks this service. Datasheet entries are scored against the delegation's task text (keyword axes: reasoning / coding / agentic / speed, dominant axis weighted 2x); **providers whose credential does not resolve are skipped** — a keyless provider is never chosen. If no eligible entry exists, the caller falls back to parent-model inheritance.

## Model Experience

### Research and child-route selection

#### What the model sees

The research model receives one user-role message beginning `You compile a model-strength datasheet for this deployment's model-chooser from the public leaderboard material below.` It requests JSON `entries` with strength scores and includes up to 40,000 source characters. Ordinary Session models receive no added prompt; `auto` changes the delegated child's provider/model selection.

#### Token effect

Each research pass makes web requests and one LLM call with reasoning off and a 512–4,000-token reply budget derived from prompt length. Resolving a route makes no LLM call; selected child runs incur their route's normal costs.

#### KV Cache effect

Research calls are stateless and have no retained Session history. Route selection can change which provider handles a child; the resolver itself does not alter that child's prompt prefix.

## Known Limitations and Deferred Work

- The datasheet is only as good as the free public leaderboards the pass fetches; there is no paid-benchmark ingestion, and models the material does not mention are simply absent (they are then never auto-chosen until a later pass covers them).
- Credential verdicts cache for three hours; a key added mid-window is picked up on the next check rather than instantly.
- The research distiller trusts the fetched material's scores as-is; there is no cross-source verification or confidence weighting yet.

### Dev Note

- See the module JSDoc for the owning contract and its rationale.
