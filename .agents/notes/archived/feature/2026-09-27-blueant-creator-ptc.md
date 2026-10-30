# Agent Note: Blueant combines Creator and PTC capabilities

Status: implemented
Archived: 2026-10-30

English

## Problem

An allow-list does not mount tools. Blueant named `bash` without mounting its plugin, while the Web host deliberately leaves shell, file, and todo tools to agent presets. Maintaining a separate roster also omitted Creator capabilities and suppressed runtime context through a complete desktop-only persona.

## Decision

The bridge generates Blueant from the bundled Creator composition and the PTC presentation row. Creator remains the owner of the tool plugins, isolated groups, configurations, and composition-authoring skill. Blueant changes the persona identity, copies the skill directory, selects `both` presentation, and adds desktop Chrome tools and notifications. Direct calls and `run_code` share the harness dispatcher and session policy. No restrictive Blueant roster or duplicate approval system is installed.

The bridge owns the generated composition. The first replacement backs up the old file; custom presets must be separate copies. Missing Creator or PTC sources fail initialization instead of silently generating fewer capabilities. The [single approval policy](../bug-fix/2026-09-27-blueant-single-approval-policy.md) still owns command authorization; this decision supersedes its targeted allow-list migration.

## Alternatives considered

Enumerating Creator’s tool names in an allow-list cannot supply absent plugin registrations and drifts as Creator evolves. Copying only selected tool rows loses isolated service groups and their configuration. PTC-only presentation hides direct calls; `both` supplies the requested PTC capability while retaining direct tool access.

## Consequences

Blueant can code, manage todo trees, delegate work, inspect its runtime, and compose tool calls through TypeScript. Prompt size increases because both direct schemas and the SDK are supplied. Capability access does not change sandbox or approval settings. Regression checks compare all Creator rows, mount the generated preset in the real Web composition, and execute a todo update through the code runtime without a model API call.
