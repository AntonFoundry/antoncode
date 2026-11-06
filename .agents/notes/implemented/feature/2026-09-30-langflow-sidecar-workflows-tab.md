# Agent Note: LangFlow replaces the custom Workflows canvas

Status: implemented

## Problem

The Workflows tab hosted a hand-rolled canvas (`flowbuilder.tsx` + `graph.ts` over the `flow.*` wire domain): a home-grown node editor with click-to-connect ports, no pan/zoom, and a custom run engine. The user's verdict across several sessions was unambiguous — the custom builder should not exist; the tab should host a real workflow product, specifically LangFlow (github.com/langflow-ai/langflow). LangFlow is a full-stack Python application (FastAPI + React Flow frontend + SQLite), not an npm-embeddable library, so "use LangFlow" cannot mean an import; the honest integration is running the real product locally and embedding its UI.

Builds on the flowbuilder series (domain vocabulary, storage service, run engine, `flow.*` wire, model-facing tools): all of that stays mounted and untouched — only the tab's surface pivots.

## Decision

**Host side — one new package, `packages/flowbuilder/langflow-sidecar` (`ctx.langflow`).** A function plugin (`name`/`inject: ['subprocess']`/`Config`/`apply`, per the loader postmortem's no-default-export rule) that publishes a `LangflowSidecar` controller and owns teardown as a plugin effect. `start()` spawns `[command, 'langflow', 'run', '--host', '127.0.0.1', '--port', port]` through `ctx.subprocess` (credential-scrubbed env, collected stdout/stderr tails), then polls `GET /health` until any HTTP response arrives — an answered server can render the UI, so readiness is intentionally any-status. `start()` is single-flight and resolves at readiness or into a structured `error` status (launcher missing, early exit with the last stderr lines, readiness timeout — the first `uvx` run downloads hundreds of MB, so the default `readyTimeoutMs` is 600 s). Config is `command` (default `uvx`), `port` (default 7860), `workdir` (**required, no default** — a `cwd()` fallback would scatter LangFlow's database wherever the process starts; the base layer passes `dshHomePath('langflow')` so flows survive restarts), and `readyTimeoutMs`. Mounted in `packages/bundle/base/cordis.patch.yml` — host plane, one sidecar per process, beside `flowbuilder-service`.

**Wire — `langflow.status|start|stop` in apiproxy, mirroring `flow.*` exactly:** contract (`api/langflow.ts`, typed over the sidecar's `LangflowStatus` — already wire-plain), zod schemas, rpc-map rows, `UNARY_ROUTES` rows, the `IApiClient.langflow` surface, a client-safe `LangflowStatusView` projection beside the existing wire-record exports, `createApiProxy` impl rows, and `ApiProxyService` field/assignment/`inject` additions (the service now waits on `langflow`, so the sidecar is a hard dependency of the gateway — same treatment as `flowBuilder`). The connection's browser fixture grew the three routes and a dispatch-switch case row each, and the fixture browser boots with the sidecar stopped.

**Client — the tab pivots to `LangflowView`.** The canvas files and their spec are deleted (recoverable from git history; the `@xyflow/react` dep that a previous session staged for canvas modernization is dropped uncommitted — no package in the tree references it). The new component is a pure props-driven embed: a control bar (state pill, Start/Stop, open-in-new-window while serving) above a full-tab iframe. Mount snapshots `langflow.status`; Start flips the pill to "starting…" optimistically — the RPC resolves only at readiness — and mounts the iframe on the resolved running URL; Stop tears the child down; `error` statuses render sidecar reason text (stderr tail included) in the error strip. The `dagflow` tab id, its label, and the `flowbuilder` locale namespace survive unchanged; the dictionary shrank to the embed's ten keys.

## Alternatives considered

**Port LangFlow's component library onto our own canvas.** Rejected twice by the user: it rebuilds a product to avoid running one, and the canvas was the complaint.

**iframe without a sidecar service (user starts `langflow run` themselves).** Rejected: the embed could not show a truthful starting/error state, and teardown would not be owned by the plugin lifecycle.

**Bridge chat to LangFlow's REST API now.** Deferred: LangFlow's API can create and run flows programmatically, but nothing consumes that yet — the `flow.*` domain and tools stay for a later bridge rather than being deleted with the canvas.

## Consequences

The Workflows tab embeds a separately running Python application instead of maintaining a custom canvas. The plugin owns process readiness and teardown; first startup may download substantial dependencies. Existing workflow definitions and tools remain independent of the embedded product until a consumer requires a REST bridge.
