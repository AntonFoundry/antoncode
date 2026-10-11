# Agent Note: The agent identifies itself as running inside Anton Code

Status: implemented

English

## Problem

The fork ships as Anton (`dev.antoncode.anton`), but every model-visible identity string still named the upstream project: the `harness:identity` opener said "You are an AI agent powered by DeepSeek Harness.", the deployment persona tail said "…, running on the DeepSeek Harness.", the Web orientation line said "…through the DeepSeek Harness Web GUI…", and the source-checkout line said "The DeepSeek Harness implementation checkout is at…". Asked what it is, the agent answered that it runs on DeepSeek Harness — the upstream harness name, not the product the user is running.

## Decision

All four identity surfaces name the product Anton Code; their structure, order, and the rest of their text are unchanged.

- Identity opener: "You are an AI agent powered by Anton Code." — `dsh-system-prompt` fixed section, order −100 (`packages/core/system-prompt/src/index.ts`).
- Deployment persona tail: "…, running inside Anton Code." — the `cordis` agent preset persona (`apps/cli/config/agent-presets/cordis/agent.cordis.yml`). The bridge's Blueant generator (`apps/anton-bridge/src/blueant-preset.ts`) replaces only the sentence head, so the tail flows through unchanged, and the managed preset at `<dshHome>/.agent-presets/blueant/agent.cordis.yml` rewrites itself on the next harness start whenever its content differs.
- Web orientation line and `DSH_WEB_URL` description: "Anton Code Web GUI" (`packages/bundle/web-app/src/index.ts`).
- Source-checkout line: "The Anton Code implementation checkout is at … Use this checkout only to inspect or extend Anton Code itself." (`packages/boot/app-boot/src/index.ts`).

The Blueant persona name and the model attribution (`{{model}}`) are unchanged: the agent says who powers it, who it is, and where it runs.

## Alternatives considered

**Rename inside the Blueant generator instead of the base persona.** The harness attribution belongs to the deployment persona, which every preset derivation — including plain `dsh` sessions — reads; patching only the bridge would leave every non-Blueant session identifying as DeepSeek Harness.

**Rebrand every "DeepSeek Harness"/DSH mention.** Package scopes (`@deepseek-ai/*`), the `dsh` CLI, docs, AGENTS.md, and `DSH_*` identifiers are not identity claims the model repeats about itself; renaming them is a repository-wide rebrand with separate review. Only the four model-visible identity strings changed.

**Edit the generated preset on disk.** `<dshHome>/.agent-presets/blueant/agent.cordis.yml` is bridge-managed and regenerated on content change; a hand edit would survive only until the next regeneration diverged. The base persona and the generator own the text.

## Consequences

- Fresh sessions say "running inside Anton Code" with the Blueant persona and the routed model attribution intact.
- Verbatim-pinning specs, READMEs, and keyless replay snapshots were updated in the same change: `dsh-system-prompt`, `dsh-app-boot`, `dsh-bundle-web-app`, agent-loop, agent-spine-demo, and anton-bridge specs, the ACP and headless replay fixtures, and the apps/web round-trip snapshots.
- The rename reaches a running install only through a bundle rebuild and harness restart (`anton:build:macos`, then a harness restart); the build's boot smoke gates a broken composition before install.
- Upstream merges touching these strings conflict on the renamed lines; resolve toward the fork's name unless the merge intentionally reverts the rebrand.
