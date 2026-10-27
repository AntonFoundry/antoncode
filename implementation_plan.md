# Subagent Resilience + Minimal-Prompt Preset

## Part A — Minimal-prompt preset (COMPLETE, mounted)

Created `blueant-lean` (copy of `blueant`, untouched source preset) at
`~/.dsh/.agent-presets/blueant-lean/`. **Mount-validated: `mounted OK`.**

Four levers, all verified against source:

1. **`tool-presentation: mode paged`** — only `tool_search` + pinned + granted tools are wired.
2. **`plugins/minimal-prompt.js`** — a scope-filtered `system-prompt/assemble` listener rewrites
   `tools:paged-only` and `tools:catalog`. It must be the waterfall, not `systemPrompt.section()`:
   `presentAs('paged')` registers those names into the preset's OWN layer, where a duplicate
   registration throws instead of shadowing.
3. **`plugins/skill-search.js`** — `skill_search` replaces the static `<available_skills>` catalog.
   The catalog is suppressed for free under paging: `tool-skill` emits it only when
   `ctx.tools.get('skill', agent)` is its own definition, and an ungranted `skill` reads as absent.
   `catalogDescriptionMaxLength: 3` is the belt-and-braces cap if it ever materializes.
4. **Host `tools.pinned`** in `profiles/web/cordis.patch.yml` — the 21-tool spine.
   All 21 names verified present in the live catalog (`skill_search` comes from the preset itself).

**Measured:** 82 live tools, 72,663 chars of schemas (~18,166 tokens). Pinned spine = 28,009 chars
(~7,002 tokens). **Saved ≈ 44,654 chars ≈ 11,164 tokens per request**, before the ~130-entry skill
catalog and the 200-line tool catalog also disappear.

## Part B — Subagent resilience (COMPLETE)

### Root cause found: delegation was 100% broken

Every subagent failed instantly with `NO_ADAPTER: no adapter registered for provider "opengateway/deepseek"`.

Settings carry `subagent-child-model.defaultModel: opengateway/deepseek/deepseek-v4.1-flash-ultrafast`,
and `splitModelRoute` (`packages/subagent/tool-subagent/src/index.ts:138`) split on the **last**
slash:

```ts
const slash = route.lastIndexOf('/')
return { provider: route.slice(0, slash), model: route.slice(slash + 1) }
```

Yielding `provider: "opengateway/deepseek"`, `model: "deepseek-v4.1-flash-ultrafast"`. The registered
adapter is provider `opengateway` with model id `deepseek/deepseek-v4.1-flash-ultrafast` — a model id
that **contains a slash**, which the last-slash split cannot express.

### Fixes deployed (all verified in running app):

1. **`splitModelRoute` resolves against provider registry** — prefers longest registered provider
   prefix leaving non-empty model id; falls back to last-slash split. Unit test added.

2. **Durable outcome projection** — `subagentOutcomeProjectionDefinition` folds each child's own
   turn structure into `{ stopReason, error, seq }` so a master (or human) can read why a child
   stopped without resuming it. Uses `foldConsumedWork` logic (turn/start, step/start, turn/end)
   rather than a single ending event.

3. **Extended served status** — `running | idle | failed | completed` with `stopReason` and
   `stopReasonDetail`, through `subagents.schema.js`, apiproxy projection, and
   `ui-subagent` StateDot/locale. Failed children now render **red** (error dot), not green.

4. **Cold model switching** — `selectModel` now ACCEPTS a non-live child, recording the route in
   `pendingModelOverrides` so the next `coldResume` activates it. The child that most needs a new
   model is the one that just died on the old route — previously unsupported.

### Commits:
- `e1025eb8b7` — fix(subagent): resolve slash-bearing model ids against the provider registry
- `9f0210fbfc` — feat(subagent): durable outcome, honest status, and cold model switching

### Tests: 1086 passing across `packages/subagent`, `packages/host/apiproxy`, `packages/client/ui-subagent`.
