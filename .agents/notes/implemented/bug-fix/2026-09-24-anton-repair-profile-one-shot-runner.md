# Agent Note: Anton repair uses the bundled one-shot runner

Status: implemented

English

## Problem

Anton launches the repair profile as a single CLI task. A profile that only mounts the demo agent spine cannot consume that task or produce the completion exit code the bridge watches. An unavailable bundle also prevents profile composition before any model request.

## Decision

The bridge owns the `repair` profile manifest and writes the base plus headless bundle list when the stored manifest differs. The headless runner creates the Agent, reads the saved default model, completes the task, and returns a success-sensitive process exit code. The bridge marks repair `done` only for exit code zero; Anton leaves recovery mode only after that state.

The macOS build boot smoke composes the generated repair profile from the staged app using its bundled Node runtime. It requires the `headless-runner` entry, so an unavailable bundle or absent one-shot runner rejects the candidate before installation.

A keyless CLI snapshot runs the repair bundle list with paged tools through `tool_search`, `todo_write`, and `bash`, then checks the persisted session and final answer.

## Alternatives considered

**Add the demo spine as a CLI dependency.** That makes the package resolvable but still leaves the repair task without a one-shot entry point or completion signal.

**Reuse the Web profile for repair.** A broken Web plugin is the reason recovery may be active, so repair needs a composition independent of the Web bundle.

## Consequences

The repair profile uses the same saved default model as other headless tasks and does not start a second Web server. Because Anton owns this internal profile, startup replaces edits to its generated manifest; the separate profile patch remains available for local configuration.
