---
description: "langflow-sidecar package."
kind: "package-reference"
---

# @deepseek-ai/dsh-langflow-sidecar

## Summary

English

## Table of Contents

- [Understand the implementation](#understand-the-implementation)
- [Dev Note](#dev-note)

## Understand the implementation

English

LangFlow sidecar service: spawns a local [LangFlow](https://github.com/langflow-ai/langflow) server (`langflow run` through the configured launcher), polls it to readiness, and exposes it to the Workflows tab embed. Published as `ctx.langflow`; the `langflow.*` wire domain in `dsh-host-apiproxy` is the browser's only consumer.

## Configuration

| key | meaning |
| --- | --- |
| `command` | Launcher executable; default `uvx` resolves `langflow` on demand through the uv cache. |
| `port` | Loopback port LangFlow serves on; default `7860`. |
| `workdir` | Child working directory; LangFlow stores its database and logs here. Required, no default — assemblies state it (the base layer uses `dshHomePath('langflow')`). |
| `readyTimeoutMs` | How long `start()` polls `/health` before declaring a startup failure; default 600 000 (a first `uvx` run downloads the LangFlow environment). |

## Model Experience

### Durable workflow state

#### What the model sees

Nothing directly. The sidecar registers no tools and injects no prompts; the model reaches it only if a future consumer bridges chat to LangFlow's own API. The browser reaches it through the `langflow.status` / `langflow.start` / `langflow.stop` RPC routes.

#### Token effect

Zero. No text from this package enters any model request.

#### KV Cache effect

Independent: sidecar state never touches request prefixes.

## Known Limitations and Deferred Work

- **Composition coverage is operational** — spawning a real LangFlow child in CI is not viable (multi-minute first download), so unit tests stub the subprocess runtime and the real composition (base-layer mount, app boot smoke, GUI embed) is verified at the app level.
- **Health is any-HTTP-response** — readiness counts any answered HTTP request as up; a LangFlow deployment whose UI is broken while `/health` answers would still report `running`.
- **No multi-instance support** — one sidecar per process at a fixed configured port; a port already taken by another process surfaces as a startup error rather than port rotation.

## Dev Note

- See the module JSDoc for the owning contract and its rationale.
