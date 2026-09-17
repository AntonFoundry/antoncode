# Agent Note: ZAI model catalog refreshes from models.dev at startup

Status: implemented

## Problem

The `zai` route's picker list was the installed pi-ai catalog, which only changes when
`@earendil-works/pi-ai` is bumped. A provider's newest model ids — the case that
motivated this note: `glm-5.3-flash` shipped on Z.AI's coding gateway months before a
catalog update reached an installable dependency — were invisible until a release train
the harness does not control delivered them. The existing `liveModelDiscovery` flag
asked the gateway's own listing, but it was opt-in and unusable before a credential was
stored.

## Decision

Plugin startup now populates the `zai` route by default from models.dev
(`https://models.dev/api.json`, entry `zai-coding-plan`) — the same catalog source
OpenCode serves its pickers from — through `fetchModelsDevLiveModels`
(`src/models-dev.ts`). Source precedence is: explicit `models:` configuration (refresh
skipped entirely), then `liveModelDiscovery: true` asking the endpoint's own listing,
then the default models.dev read, then the endpoint listing as fallback when the
models.dev fetch fails, then the bundled catalog with a warning. The refresh re-runs on
settings changes and is retried lazily by model-list reads while it has not yet
succeeded (`adapter.listModels` awaits it).

A catalog payload may carry `reasoningEfforts` and `input` modalities for ids the
installed catalog has never heard of; the live-model conversion forwards them so an
unseen model still dispatches thinking and accepts the images its catalog entry
declares (`ZAI_REASONING_EFFORTS`, the spellings the bundled glm-5.2 entry declares).
Ids the installed catalog also ships keep their installed configuration; payload
capacities override installed ones.

## Alternatives rejected

- **Bumping pi-ai** keeps freshness hostage to another project's release cadence and
  still cannot cover plan-specific entries such as `zhipuai-coding-plan`.
- **Serving zai through `llm-models-dev`** would fork route ownership: that plugin
  declares its own routes and free-tier predicate, while the zai route belongs to
  pi-ai's provider materialization.
- **Defaulting to the gateway listing** requires a credential before first paint of the
  picker and burns an authenticated request per startup for data a public catalog
  already publishes.

## Known limitations

An endpoint whose `/models` listing disagrees with models.dev wins only when explicitly
selected with `liveModelDiscovery`. Models absent from both sources and from the
bundled catalog still require hand-declared configuration.
