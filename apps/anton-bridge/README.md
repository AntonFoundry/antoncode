# Anton Bridge

Anton Bridge is the first local-runtime layer for Anton. It is a small Bun
daemon that starts and supervises a DeepSeek Harness Web process, confirms the
health of the configured memory service, and presents Harness at a stable local
URL.

It intentionally does **not** replace DeepSeek Harness or the memory service.
The memory plugin remains enabled in the DeepSeek Harness `web` profile, while
this bridge owns local lifecycle and is the future home for the tray app,
browser extension pairing, permissions, and durable agents.

The memory plugin is endpoint-neutral. Its profile has a safe local default,
but Anton Bridge supplies `ANTON_CONTEXT_ENDPOINT` to Harness at launch. That
lets one Harness installation target any approved service endpoint now and the
same configuration seam can later target a hosted endpoint. The service itself
is a separate product: this codebase ships only the client plugin and never
references the service's implementation.

## Run locally

Prerequisites:

- Bun 1.3 or newer.
- This DeepSeek Harness checkout.
- The memory plugin beside the checkout at `../c0ntext/deepseek-harness-plugin`
  (or set `ANTON_CONTEXT_PLUGIN_ROOT`).
- The harness built to `lib/` — the bridge launches the built CLI
  (`apps/cli/lib/bin.js`), not the TypeScript source: `npm run build:lib:host`
  (the bridge falls back to `src/bin.ts` only when you set
  `ANTON_HARNESS_ENTRY`/`ANTON_HARNESS_LOADER=tsx/esm` yourself).

```sh
cd /Users/pankajdoharey/Development/Projects/ML/antoncode/deepseek-harness
pnpm run anton:dev
```

Open these URLs:

- `http://antoncode.localhost:3742/` — DeepSeek Harness, proxied by the bridge.
- `http://antoncode.localhost:3742/bridge` — local bridge lifecycle controls.
- `http://antoncode.localhost:3742/bridge/api/status` — machine-readable status.

Use the **c0ntext endpoint** field on the control page to select a local
worker URL. The selected URL is saved at `~/.anton/bridge.json` (unless
`ANTON_BRIDGE_CONFIG` is set) and Bridge restarts the Harness process it owns
so every new turn uses the selected engine. An explicit
`ANTON_CONTEXT_ENDPOINT` environment variable takes precedence, which is
useful for development and deployment automation.

`.localhost` resolves to the loopback interface in modern browsers; no hosts
file change is needed. The explicit `:3742` avoids privileged-port and port
conflict concerns during development.

DNS cannot map a hostname to a non-standard TCP port. If port 80 is available
on the machine, start the bridge with `ANTON_BRIDGE_PORT=80 bun run start` and
use the clean `http://antoncode.localhost/` URL. The future installer can make
that the preferred configuration after checking for port conflicts; it must
retain the explicit-port fallback because another local application may already
own port 80.

`Ctrl-C` stops the bridge and, if the bridge launched it, stops Harness as
well. If Harness was already running before the bridge started, the bridge will
reuse it and deliberately refuses to kill a process it does not own.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTON_BRIDGE_PORT` | `3742` | Loopback port for Anton Bridge. |
| `ANTON_HARNESS_PORT` | `3080` | DeepSeek Harness Web port. |
| `ANTON_DSH_PROFILE` | `web` | DeepSeek Harness profile with c0ntext enabled. |
| `ANTON_DSH_ROOT` | this checkout | Harness source checkout. |
| `ANTON_HARNESS_ENTRY` | built CLI (`apps/cli/lib/bin.js`) | Override the bundled/installed Harness CLI entrypoint. |
| `ANTON_HARNESS_LOADER` | *(empty — built JavaScript)* | Node import loader for a TypeScript Harness entrypoint; set `tsx/esm` when running from source, leave empty for built JavaScript. |
| `ANTON_NODE_BINARY` | `node` | Node executable used to launch Harness. |
| `ANTON_CONTEXT_ENDPOINT` | `http://127.0.0.1:8090` | Memory-service health endpoint. |
| `ANTON_CONTEXT_PLUGIN_ROOT` | sibling checkout or bundled plugin | Memory-plugin package linked into the Harness profile. |
| `ANTON_BRIDGE_CONFIG` | `~/.anton/bridge.json` | Persistent Bridge preferences, including the memory-service endpoint. |
| `ANTON_AUTO_START` | `true` | Set to `false` to start Harness only from the control page. |

## Build a local executable

```sh
pnpm run anton:build
./dist/anton-bridge
```

For a compiled executable, set `ANTON_DSH_ROOT` explicitly. The executable is
the daemon payload that a future signed macOS app, Windows installer, or Linux
package will install and supervise.

## macOS app bundle

Build a local, Apple-silicon/native-architecture Anton menu-bar app with:

```sh
pnpm run anton:build:macos
open dist/Anton.app
```

The bundle contains the compiled Bridge, a Node runtime, the built local
DeepSeek Harness runtime, and the memory-service client plugin. On first
launch it creates an app-owned Harness profile at
`~/Library/Application Support/Anton/dsh`, with the bundled plugin enabled.
Harness sessions in this app are therefore isolated from an existing
developer `~/.dsh` installation.

The app is ad-hoc signed for local development only; it is **not** notarized or
ready for public distribution. It reaches the memory service at the configured
endpoint (`ANTON_CONTEXT_ENDPOINT` or the control-page field) and ships no
service implementation of its own.

## Security boundary

The bridge listens only on `127.0.0.1`. Its start/stop endpoints are under
`/bridge/api` and reject cross-origin browser requests. This is local
development plumbing, not the final remote-control protocol: the browser
extension and hosted `antoncode.dev` flow will add device pairing, scoped
workspace capabilities, request signing, and user approvals.
