# Make subagent delegation the default in the Blueant system prompt

## Problem

The agent only delegates when the user explicitly asks. The guidance that does exist
(`tool-subagent`'s standing prompt section, order 116.5, rendered once per delegation
tool) is buried among the tool-description prose, phrased as `Delegation is the DEFAULT
for decomposable work`, and says nothing about the model route. In the live session the
model reads two near-identical paragraphs mid-prompt and still does the work inline.

## Findings (how the prompt is built)

- `packages/core/system-prompt` is the registry; plugins contribute ordered sections via
  `ctx.systemPrompt.section({ name, order, text })`, which returns a disposer.
- Order bands: `deployment:persona` = 0, plan-mode = 50/52, tool rules 98–115,
  `tool:subagent` = 116.5, tool catalog = 151.
- `packages/subagent/tool-subagent` renders the delegation section only when its
  tool is registered, at order 116.5 — inside the tool-documentation band.
- The Blueant agent preset (`${DSH_HOME}/.agent-presets/blueant/`) already ships local
  plugin rows (`plugins/notify.js`, `plugins/chrome.js`), so a preset can contribute its
  own prompt section without touching any package.
- The subagent model is already user-configured and needs no new selection UI:
  settings namespace `subagent-child-model` = `{ defaultModel: codex/gpt-6-luna,
  defaultEffort: medium }`. `resolveChildModelRoute` applies it whenever a delegation
  omits `model`, falling back to `{ model: 'auto' }`.

## Plan

1. Load `editing-cordis-compositions` before editing the composition.
2. Add `plugins/delegation.js` to the Blueant preset: a prompt-section row that
   registers a short, imperative delegation policy at order 5 — immediately after the
   persona, above every tool section.
3. Row content: decompose before acting; fan out ≥2 independent pieces in one message;
   always delegate codebase exploration; never pass `model`/`reasoningEffort` because
   the configured swarm default applies; summarise results, never transcripts.
4. Add the row to `blueant/agent.cordis.yml`.
5. Verify the file parses and the row resolves (node syntax check + composition check).
6. Report that a new conversation picks it up; no app rebuild is required for a preset
   change.

## Non-goals

- No change to `packages/subagent` section text in this pass (it would need a full
  `pnpm run anton:build:macos` to reach the running app).
- No new model-selection surface; the existing `subagent-child-model` setting is reused.