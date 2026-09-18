# @deepseek-ai/dsh-model-intel

A weekly-researched model-strength datasheet plus the `auto` child-model resolver. The scheduler composes the deployment's existing pieces: a persisted `fetchedAt` marker in the datasheet gives restart-surviving cron semantics (missed intervals run once on the next boot), and a cheap effect-owned interval checks staleness. Each pass is guarded against concurrency and logged; the previous datasheet is kept verbatim on failure.

## Model Experience

- **Model visibility:** none directly. The datasheet changes which route a delegated child runs on (`subagent` calls whose settings route is `auto`); the choice is logged in the child's own session like any route.
- **Tokens:** one research pass per interval costs one bounded LLM call (reply budget proportional to the fetched material, reasoning off) plus web fetches through the `web` seam. Resolver calls cost nothing. Auto-selected children run on their chosen route's own token economics.
- **KV cache:** no session of its own; the research call is un-attributed and stateless.

## Configuration (`model-intel:` settings section)

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Mount the scheduler and the resolver. |
| `researchIntervalHours` | `168` | Hours between research passes (one week). |
| `checkIntervalMinutes` | `30` | Cadence of the cheap staleness check. |
| `researchRoute` | `''` | `provider/model` the distiller runs on; empty = first credentialed configured provider. |

## Auto routing

`subagent-child-model.defaultModel: auto` (or a per-session `auto`) asks this service. Datasheet entries are scored against the delegation's task text (keyword axes: reasoning / coding / agentic / speed, dominant axis weighted 2x); **providers whose credential does not resolve are skipped** — a keyless provider is never chosen. No eligible entry falls back to parent-model inheritance.

## Known Limitations and Deferred Work

- The datasheet is only as good as the free public leaderboards the pass fetches; there is no paid-benchmark ingestion, and models the material does not mention are simply absent (they are then never auto-chosen until a later pass covers them).
- Credential verdicts cache for three hours; a key added mid-window is picked up on the next check rather than instantly.
- The research distiller trusts the fetched material's scores as-is; there is no cross-source verification or confidence weighting yet.
