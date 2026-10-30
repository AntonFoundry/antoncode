# Agent Note: Extract measured hot paths behind native providers instead of porting the harness

Status: proposed

English

## Problem

The harness is 288k lines of first-party TypeScript/TSX under `packages/**/src` and
`apps/*/src` (plus 280k lines of tests) across 60+ plugin packages, a Cordis plugin
runtime, a Typert type/RPC generator, two SDKs, and a browser client. It is slow in
places — session resume on a long transcript, per-token streaming work, markdown
rendering of long answers, some tool fan-out — and the obvious reading of "rewrite
in Go or Swift" is applied to the whole tree.

That reading misidentifies the bottleneck. An agent turn is dominated by model
latency and network I/O (seconds to minutes per turn), then by tool round-trips
(subprocess spawn, filesystem, LSP, browser CDP, HTTP fetches). Local CPU is a
minority of wall-clock time, and the parts that are CPU-bound are small and
isolated. Meanwhile a whole-language port would discard the property that makes
this product extensible: everything is a plugin, loaded from `cordis.yml`,
contributed through `ctx.effect()`, type-generated, HMR-reloadable, and packaged as
npm workspaces. None of that survives a Go or Swift core without rebuilding the
plugin model, the loader, the type graph, and both SDKs.

The repository already contains substantial native code on the paths that needed
it: SQLite through Node's `node:sqlite`, file search through the packaged ripgrep
binary, syntax highlighting through Shiki's WASM grammars, the Linux sandbox
through a C Landlock addon, the macOS app in Swift, and the bridge as a compiled
Bun binary. Node starts the built CLI in 70–80 ms on this machine. The remaining
cost is concentrated in specific algorithms and render loops, not in the language.

## Proposal

Keep the harness in TypeScript. Move work to a native language only where a
profile names it, and put it behind an existing capability seam so the plugin
model, RPC, tests, and packaging stay intact.

1. **Measure before choosing a language.** Add a per-turn breakdown (model
   request/stream, each tool call, session append, projection rebuild, client
   render) and capture it on (a) a 10k-event session resume, (b) a long streaming
   answer, (c) a tool-heavy turn (search + bash + edit). Record Node CPU profiles
   (`node --cpu-prof`) and a browser Performance trace for the same turn. A
   rewrite proposal without this baseline is rejected by construction.
2. **Swift stays in the app and grows there.** The Mac app already owns the
   bridge lifecycle, notifications, and consent UI. Native desktop services that
   benefit from Apple frameworks belong in that process or a small Swift helper:
   FSEvents workspace indexing, Keychain, local speech, Metal-backed embeddings or
   inference. They reach the harness through the existing tool/service surface,
   not by replacing it.
3. **Go is the candidate for two sidecars, if measurement justifies them.**
   - A **tool runner** behind the `subprocess`/`shell` Service Definition:
     process-tree supervision, PTY, parallel file walking, sandbox orchestration,
     and high-concurrency fan-out. The seam already exists; a provider can be a
     process speaking JSON-RPC over stdio, which the SDK already speaks.
   - A **headless gateway/runner** for multi-session or remote deployments, where
     Go's HTTP/SSE concurrency and single-binary distribution are the point. That
     is a new deployment shape, not a port.
4. **Client rendering moves within the browser, not to Go/Swift.** If long
   answers jank, the fix is a parser/highlight/diff worker (or a WASM module),
   incremental rendering keyed by block, and virtualization — not a native app
   rewrite. Shiki and Mermaid already dominate that budget; measure them first.
5. **No full port.** A Go/Swift harness loses the plugin loader, the Cordis
   service/effect semantics, the Typert type graph, npm workspace distribution,
   and the TS/Python SDK parity, for a gain that model latency will erase.

## Candidates, ranked by expected return

| Surface | Current | Native fit | Expected gain | Verdict |
|---|---|---|---|---|
| macOS desktop services (indexing, Keychain, speech, Metal) | Swift app + TS bridge | Swift (already) | High UX, low risk | Do incrementally in the app |
| Long-answer rendering (markdown, highlight, mermaid, diff) | micromark + Shiki + Mermaid in the render path | Browser worker / WASM (Rust best) | High jank reduction | Measure first; worker before native |
| Session projection rebuild on resume | TS fold over JSONL/SQLite events | Go sidecar or compiled WASM | Medium on very long sessions | Profile a 10k-event resume |
| Tool fan-out, process supervision, PTY | Node child_process, Bun | Go sidecar | Medium at high concurrency | Only if the profile shows it |
| File search / glob | ripgrep binary | already native | — | No work |
| SQLite persistence | `node:sqlite` (C) | already native | — | No work |
| Token counting | heuristic estimator (no tokenizer) | Go tokenizer | Low unless exact counts are required | Product decision, not speed |
| Agent loop, LLM adapters, tool schemas, prompt assembly, settings | TS | — | None: I/O and JSON | Keep |
| Plugin loader, Typert, HMR, client bundle system | TS | — | Lost entirely | Keep |

## Acceptance criteria

- A committed baseline table of per-phase timings and CPU profiles for the three
  scenarios above, taken on the same machine.
- Any extracted component beats the TypeScript path by a stated margin (target:
  ≥2× on the measured phase, not on total turn time) and keeps the owning Service
  Definition's contract, cancellation, and error codes unchanged.
- The native component ships as an optional provider selected by configuration;
  the TypeScript provider remains the default until the native one passes the same
  package tests plus the seam's integration tests.
- Packaging covers macOS arm64/x64, Linux, and Windows with signing/notarization
  for the app bundle, and the boot smoke still passes without the native provider.
- No plugin-authored code loses a capability: anything that ran in-process keeps an
  in-process path.

## Alternatives considered

- **Port the whole harness to Go.** 288k lines plus tests, a dynamic plugin
  runtime with loader semantics, a generated type graph, and two SDKs; most of the
  runtime is waiting on the model. The rewrite would take quarters, freeze the
  product, and cost the ecosystem. Rejected.
- **Port the whole harness to Swift.** Same scope, plus it excludes Linux and
  Windows for the harness itself; Swift is the right language for the app, not for
  a cross-platform plugin host. Rejected.
- **Rewrite only the UI in Swift/AppKit.** The UI is the web app served locally;
  a native client means maintaining two clients and losing plugin-contributed
  views, which is the same plugin argument one layer up. Rejected.
- **Move everything to Bun (already partly true for the bridge).** A runtime swap
  is cheap to try and worth a benchmark, but it does not change the asymptotic
  costs above. Compatible with this proposal.
- **Adopt a Go/Rust agent framework wholesale.** Discards the harness's session
  log, compaction, presets, permissions, and plugin surface; that is a different
  product. Rejected.

## Risks

- A native sidecar adds a second toolchain to CI, release signing, and crash
  surface; an IPC failure must degrade to the TypeScript provider, never to a dead
  session.
- Profiles taken on one machine (Apple silicon, warm cache) can mislead; the
  baseline must state hardware, session size, and model route.
- The biggest perceived-speed win may be UI work (incremental rendering, streaming
  markdown) that never touches Go or Swift; prioritizing the language question
  first would spend effort in the wrong place.
