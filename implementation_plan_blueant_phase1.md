# Blueant Phase 1 — Spotlight-like Popup Ask-Loop + `blueant` Agent Preset

Status: plan only (verified facts as of this read; no source modified, no builds, nothing restarted).
Repo root: `/Users/pankajdoharey/Development/Projects/ML/antoncode/deepseek-harness`.
Hard constraints: never restart the harness (`node` on 127.0.0.1:3080, live session), never run `dist/install-anton.sh`, build the candidate bundle only (`dist/Anton.next.app`), installation is user-timed.

---

## Part A — Verified current-state facts

### A1. Menubar app — `apps/anton-bridge/macos/AntonApp.swift` (275 lines)

- `@main struct AntonMain` (L3–10): creates `NSApplication`, sets `delegate = AntonApp()`, `app.run()`. File is compiled with `-parse-as-library`.
- `final class AntonApp: NSObject, NSApplicationDelegate, NSMenuDelegate` (L12).
  - State: `private enum HarnessState { running, transitioning, stopped }`; `bridge: Process?`, `statusItem: NSStatusItem?`, `startItem/stopItem/restartItem: NSMenuItem?`, `pollTimer: Timer?`, `consecutivePollFailures: Int`.
  - `bridgeURL = URL(string: "http://127.0.0.1:3742")!` (L33).
- `applicationDidFinishLaunching` (L36–41): `NSApp.setActivationPolicy(.accessory)` → `installMenu()` → `launchBridge()` → `beginStatusPolling()`. `applicationWillTerminate` invalidates the timer and terminates the bridge.
- `installMenu()` (L43–70): `NSStatusBar.system.statusItem(withLength: .squareLength)`; `NSMenu` with `menu.delegate = self; menu.autoenablesItems = false`; items: `Open Anton ⌘o`, `Start Harness ⌘s` (target self), `Stop Harness` (no key), `Restart ⌘r`, separator, `Quit Anton ⌘q`. Status button uses `wantsLayer` + `cornerRadius 8`. Ends with `updatePresentation()`.
- `launchBridge()` (L72–106): spawns `Resources/bin/anton-bridge` with env `ANTON_DSH_ROOT`, `ANTON_CONTEXT_ROOT`, `ANTON_CONTEXT_PLUGIN_ROOT`, `ANTON_DSH_HOME` (`~/Library/Application Support/Anton/dsh`), `ANTON_BRIDGE_CONFIG`, `ANTON_NODE_BINARY`, `ANTON_CONTEXT_AUTO_START=true`; stdout/stderr appended to `bridge.log`.
- `restartAnton()` (L124–141): detached `/bin/sh -c "sleep 2; open <bundle>"` relauncher, then `NSApp.terminate`.
- `requestHarness(_:successState:openAfterSuccess:)` (L143–165): POST `bridge/api/harness/<action>` via `URLSession.shared.dataTask`.
- `beginStatusPolling()` / `refreshHarnessState()` (L176–207): GET `bridge/api/status` every 2 s; decodes `BridgeStatus{harness:{running:Bool}}`; 3 consecutive failures ⇒ `.stopped` (one failure never flips state).
- `antonMarkImage()` — hand-drawn NSImage template glyph; `updatePresentation()` tints the button green/orange/clear by state; `menuWillOpen` re-polls; `showError` uses `NSAlert.runModal`.
- Code style: single file, no external deps, four-space indent, `//` doc comments above non-obvious logic, all actions `@objc private func`, weak-self URLSession closures dispatched to main.
- Info.plist beside it: `dev.antoncode.anton`, `LSUIElement`, `NSAllowsLocalNetworking`. **No window/hotkey/panel code exists today.**

### A2. Build — `scripts/build-anton-macos.ts` (167 lines)

- Output: `const appRoot = resolve(harnessRoot, outputArgument ?? 'dist/Anton.next.app')` (L16). Never in-place: side-by-side candidate.
- Build-step order (main body, L137+): `rmSync(appRoot)` → mkdir `Resources/bin`, `MacOS` →
  1. `run(['bun','build','--compile','--outfile', join(resources,'bin','anton-bridge'), 'src/index.ts'], bridgeRoot)`
  2. `bundledNode(...)` — downloads/checksums node v22.19.0
  3. copy `macos/Info.plist`; `appIcon()` via sips/iconutil
  4. **L129: `run(['swiftc', '-parse-as-library', '-framework', 'Cocoa', join(bridgeRoot, 'macos', 'AntonApp.swift'), '-o', join(macOS, 'Anton')])`** ← new `.swift` files are appended as additional input arguments here.
  5. `syncDirectory(harnessRoot → Resources/deepseek-harness)` excluding `/dist`, `packages/*/*/src`, `apps/*/src`, `*.ts`, `*.tsx`, `*.map`; **this means the profile must resolve `@deepseek-ai/dsh-persona` from its built `lib/` only** (`packages/preset/persona/lib/index.js` exists and is built ✓).
  6. `syncDirectory(contextRoot → Resources/c0ntext)` (excludes plugin `src/`), writes the compose include stub, asserts `c0ntext/deepseek-harness-plugin/package.json` exists, `assertLibOnlyHarnessBundle()` (rejects any first-party `.ts` in apps/packages trees and requires `lib/index.js` + `lib/client.js` of the plugin).
  7. Three ad-hoc `codesign --force --sign -` runs (bridge binary, node, app root).
- Runner: `pnpm run anton:build:macos`. `dist/install-anton.sh` is the (forbidden) installer.

### A3. Bridge — `apps/anton-bridge/src/index.ts` (659 lines)

- Ports: `bridgePort = ANTON_BRIDGE_PORT ?? 3742`, `harnessPort = ANTON_HARNESS_PORT ?? 3080` (L5–6). `harnessUrl = http://127.0.0.1:3080`, mux relay targets `ws://127.0.0.1:3080` (L17–18).
- `dshHome = process.env.ANTON_DSH_HOME ?? join(homedir(), '.anton', 'dsh')` (L110). In the packaged app the env wins ⇒ **`~/Library/Application Support/Anton/dsh`**.
- `ensureBundledContextProfile()` (L205–244), called from `startHarness()` (L314) before each spawn:
  ```ts
  const profileDir = join(dshHome, 'profiles', profile)          // profile = 'web'
  const manifestPath = join(profileDir, 'package.json')
  const patchPath    = join(profileDir, 'cordis.patch.yml')
  const pluginLink   = join(profileDir, 'node_modules', '@c0ntext', 'dsh-c0ntext')
  mkdirSync(dirname(pluginLink), { recursive: true })
  if (!existsSync(manifestPath)) writeFileSync(manifestPath, JSON.stringify({
    name: `anton-profile-${profile}`, private: true,
    dependencies: { '@c0ntext/dsh-c0ntext': `file:${bundledContextPluginRoot}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@c0ntext/dsh-c0ntext'] } },
  }, null, 2))
  if (!existsSync(patchPath))    writeFileSync(patchPath, patchBody(toolsMode))   // ANTON_TOOLS_MODE ?? 'paged'
  // remove existing junction, then:
  symlinkSync(bundledContextPluginRoot, pluginLink, 'junction')
  ```
  **Writes are guarded by `existsSync` — an existing profile is never rewritten.** The live profile already exists with extra deps (`@deepseek-ai/dsh-web-search-browser`, `dsh-blender`) — a blueant `ensure*` must ADD to this layout without clobbering.
- `patchBody(toolsMode)` (L156–203): the `- id: c0ntext-context` row config in YAML — `endpoint`, `endpointEnv`, `apiKeyEnv: ANTON_CONTEXT_API_KEY`, `projectId: c0ntext`, `tokenBudget: 1200`, `requestedZones: [...]`, `mirrorSession: true`, `maxSurfaceRatio: 0.80`, `evictorEnabled: true`, `searchToolEnabled: true`, plus a `compaction-basic` row.
- `resolveContextApiKey()` (L113–141): reads flat `ANTON_CONTEXT_API_KEY:` line from `<dshHome>/.credentials.yaml`; never logged.
- Harness spawn (`startHarness`, L285–333): `ensureBundledContextProfile()` then `Bun.spawn([nodeBinary, harnessEntry, '--profile', 'web', '--port', '3080'], { cwd: harnessRoot, env: { ...process.env, ANTON_CONTEXT_ENDPOINT, ANTON_CONTEXT_API_KEY, DSH_HOME: dshHome } })`.
- Proxy `proxyHarness()` (L489–523): every non-`/bridge` path → same path on the harness; deletes `host`/`connection`; **`if (headers.has('origin')) headers.set('origin', harnessUrl)`**; rewrites `referer` path onto `harnessUrl`. So a direct call to `http://127.0.0.1:3742/api/...` with **no Origin header** passes `sameOrigin()` trivially; a browser-style call must send `Origin: http://127.0.0.1:3742` (or `http://antoncode.localhost:3742`) which is rewritten.
- WebSockets: `/api/events.mux` and `/api/events.host` are upgraded and **downlink-only** (`relayDownlink`, L524–545; client messages are closed with 1008). Upstream connect sends `origin: harnessUrl`.
- Endpoints: GET `/bridge/api/status`; POST `/bridge/api/harness/{start,stop,restart}`, `/bridge/api/context/{start,config}`. CSRF fence: `sameOrigin` (L443–446), `loopbackControlAllowed` (origin-less loopback, L449–456). `idleTimeout: 255` on both HTTP and WS.

### A4. Harness API contract (what Swift must speak)

Unary transport (`packages/host/apiproxy/src/fetch/handler.ts` L1–5, L196–210; `rpc.schema.ts` L100–112, L87–92):
- `POST /api/<method>` with JSON body `{ "type": "client-request", "rpcId": "<string>", "method": "<method>", "payload": { ... } }`.
- Response: `{ "type": "server-response", "rpcId": "...", "result": { "ok": true, "value": {...} } }` or `{ result: { ok: false, error: { code, message } } }`. HTTP status is carrier-only (200 for business errors). Client-side default timeout `DEFAULT_TIMEOUT_MS` (`fetch/client.ts` L256) ⇒ **prompt is admission-only; the answer arrives on the mux stream**.

Methods (rpc-map `packages/host/apiproxy/src/api/rpc-map.ts`):
- `session.create` — payload `{ workspaceId?, cwd?, sessionId?, agentPreset? }` (workspaceId XOR cwd, `sessions.schema.ts` L101–110); value `{ sessionId, agentPreset? }` (L112–116).
- `session.prompt` — payload `{ sessionId, mode: 'queue'|'steer', content: [{type:'text',text} | {type:'image',mediaType,data,name?}], clientTimeZone? }` (L299–305); value `{ accepted: true, command? }` (L307–315).
- `session.cancel` — payload `{ sessionId }` (L348–350).
- `agentPreset.list` — payload `{}`; value `{ presets: [{ id, trust: 'system'|'user', isDefault, name?, description?, broken? }], authorable, hasDocument }` (`agent-presets.schema.ts` L13–31).
- `workspace.create` — **exists**: payload `{ path: string }` (`workspace.schema.ts` L35–43), value `{ workspace, created }`. So a dedicated Blueant workspace is possible via path.

Mux frames (`packages/host/apiproxy/src/api/events.schema.ts` L51–76, `muxFrameSchema`): the WS at `GET /api/events.mux` (`packages/client/connection/src/api-path.ts`: `MUX_EVENTS_PATH = '/api/events.mux'`) delivers JSON of shape `{ type: 'session/event', sessionId, event, view? }` among others:
- `session/subscribed { sessionId, lastSeq }` — subscribe ack (Swift must wait for this before trusting silence).
- `session/event { sessionId, event: { type, seq, time, data } }` (`sessions.schema.ts` L41–49: `type: string, seq: int, time: number, data: unknown`).
- `stream/error { error }`; also `approval/*`, `question/*`, `session/queue`, `session/jobs`, `session/projection` frames.

Assistant text deltas — the exact JSON paths Swift parses:
```
frame.type == "session/event"
frame.sessionId == <our sessionId>
frame.event.type == "assistant/chunk"        // raw stream chunk (core/session/src/types.ts L272–274)
frame.event.data.chunk.type == "text-delta"  // StreamChunk union (packages/llm/llm/src/types.ts L320–332)
frame.event.data.chunk.text                  // append to the answer buffer
```
Other useful chunk types: `reasoning-delta` (same `.text`), `block-end` (`data.chunk.block`), `finish` (`reason`), `usage`. A completed step's message also arrives as `event.type == "assistant/message"` with `data.message` — usable as a repair/authoritative snapshot. `turn/end` (`data.reason`) is the natural "answer complete" signal.

### A5. Persona row — `packages/preset/persona/` (`@deepseek-ai/dsh-persona`)

- Package name `@deepseek-ai/dsh-persona`, main `lib/index.js` (built ✓).
- Plugin `name = 'persona'`, `inject = ['systemPrompt']` (`src/index.ts` L33–38).
- Config (`src/index.ts` L40–58): `text: string` (required, supports `{{model}}`/`{{cwd}}` interpolation), `complete?: boolean` (default false — makes this the ONLY system-prompt section), `includeRuntimeContext?: boolean` (default true; false calls `ctx.systemPrompt.suppressRuntimeContext()`).
- Mounts only inside an agent scope (preset) — a global mount collides with the registry's own persona registration and fails loud.

### A6. Preset format — discovered under `packages/preset/agent-presets/`

- `README.md` (read in full) is the authority: a preset is **a directory holding one `agent.cordis.yml`** (a top-level YAML LIST of named plugin rows: `- id: <rowId>` + `name: <package-or-path>` + `config:` + optional `disabled: true`). Optional sibling **`preset.yml`** carries display metadata only: `{ name, description }`.
- Fixture example (`tests/fixtures/system/standard/agent.cordis.yml`):
  ```yaml
  - id: alpha
    name: ../../plugins/contribute.js
    config:
      tool: alpha
  - id: alpha-extra
    name: ../../plugins/contribute.js
    disabled: true
    config: { tool: alpha-extra }
  ```
- **Row resolution**: "A row's package name resolves from the host composition, not from the preset directory" (README §"How a preset's rows resolve"). A user-home preset cannot reach `@deepseek-ai/dsh-*` via the node_modules walk ⇒ the package must be resolvable from the HOST base — i.e. **junction-symlink `@deepseek-ai/dsh-persona` into `<dshHome>/profiles/web/node_modules/`**, exactly as the bridge already does for `@c0ntext/dsh-c0ntext`. A **relative** path (`./plugins/restrict.js`) resolves from the preset dir, so the preset can ship its own tiny plugin files.
- **Tool restriction**: `ToolRuntime.restrict(filter)` (`packages/core/tools/src/index.ts` L1300–1328) takes `{ allow?: string[], deny?: string[] }`, requires a scoped (agent) context — exactly what a preset row's `apply(ctx)` has. There is no YAML-only restrict row, so Blueant ships a ~15-line relative plugin that calls `ctx.tools.restrict({ allow: [...] })`.
- Roster config: `packages/bundle/web-app/cordis.patch.yml` L421–435 inserts `agent-presets` (`@deepseek-ai/dsh-agent-presets`) with `default: standard`; the shipped root sits beside the app config; **`<dshHome>/.agent-presets` is appended as a `user` root by default (`includeUserRoot: true`)**.
- **Discovery is unmemoized** (README §Service): "`list()` and `resolve()` re-read the roots on every call, so a preset authored while the process runs is visible immediately." ⇒ the RUNNING harness picks up `$DSH_HOME/.agent-presets/blueant/` with no restart. Broken presets are listed with a `broken` reason rather than hidden; ids must match `[a-z0-9][a-z0-9-]*`.

### A7. c0ntext plugin config (`/Users/pankajdoharey/Development/Projects/ML/antoncode/c0ntext/deepseek-harness-plugin/src/index.ts`)

Config fields (L116–258, zod defaults L236–258):
- `retrieveMode: 'fast' | 'full'` (default `'full'`), env `ANTON_CONTEXT_RETRIEVE_MODE` (L303–308).
- `tokenBudget?: number`; `retrieveSoftTimeoutMs` (default 8000), `retrieveSoftTimeoutMsFast` (default 2500, used in fast mode), `retrieveHardTimeoutMs` (default 60000) with env overrides `ANTON_CONTEXT_RETRIEVE_SOFT_TIMEOUT_MS[_FAST|_HARD]`.
- `searchToolEnabled: boolean` (default true); `scoutEnabled: boolean` (default **false** — the exact scout-disable field name; also `scoutProvider`/`scoutModel`, empty string disables).
- Tools registered by the plugin (L2146–2227): `c0ntext_search`, `c0ntext_remember`, `c0ntext_dream`, `c0ntext_rehydrate`, `recipe_search`, `recipe_put`. Web search tool name is `web_search` (`@deepseek-ai/dsh-tool-web`, base patch L450–469).
- Live example of a c0ntext row config: bridge `patchBody()` (A3) and the on-disk `<dshHome>/profiles/web/cordis.patch.yml`.

### A8. Running deployment (live facts)

- Bridge PID **68721** listening on 127.0.0.1:3742; `ps eww` env (values not printed beyond these two keys): `ANTON_DSH_ROOT=.../dist/Anton.app/Contents/Resources/deepseek-harness`, `ANTON_DSH_HOME=/Users/pankajdoharey/Library/Application Support/Anton/dsh`.
- `<dshHome>` contains `profiles/web/` (package.json + cordis.patch.yml + `node_modules/@c0ntext/dsh-c0ntext` junction) but **no `.agent-presets/` directory yet** — creating it is what makes `blueant` discoverable.

---

## Part B — Step-by-step implementation plan

### Step 1 — Swift popup surface (new files in `apps/anton-bridge/macos/`, appended to swiftc at `scripts/build-anton-macos.ts:129`)

1.1 **`BlueantPanel.swift`** — `NSPanel` subclass / factory:
- `NSPanel(styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)`, `level = .floating`, `isReleasedWhenClosed = false`, `hidesOnDeactivate = true`, `collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]`.
- Content: `NSVisualEffectView` material `.hudWindow`, dark; a one-line entry field with `>` prompt; a scrolling answer `NSTextView` (plain attributed text, no markdown dependency for MVP); footer keybar label `⏎ ask · ⌘N new thread · ⌘C copy answer · Esc close`.
- Position under the status item / cursor; persist frame in `UserDefaults` (`blueant.panel.frame`) and restore.
- Esc: cancel-in-progress then `orderOut(nil)`; idempotent `toggle()`; key equivalents handled by a local `NSEvent` monitor or panel `keyDown`.

1.2 **`HotkeyCenter.swift`** — Carbon `RegisterEventHotKey` for **⇧⌥Space** with constants at the top of the file:
```swift
enum BlueantHotkey {
  static let keyCode: UInt32 = 49          // kVK_Space
  static let modifiers: UInt32 = (1 << 17) | (1 << 19)  // shiftKey | optionKey
}
```
Idempotent toggle; on registration failure `NSLog` and continue (menubar still works). No conflict with existing `⌘O/S/R/Q` menu equivalents.

1.3 **`HarnessClient.swift`** — `URLSession`-based, delegate-callback style (no deps):
- `getStatus()` → GET `http://127.0.0.1:3742/bridge/api/status`.
- `ensureHarness()` → if status down, POST `/bridge/api/harness/start` and poll until running (panel shows "waking Anton…").
- Unary RPC helper: `POST http://127.0.0.1:3742/api/<method>` with body `{"type":"client-request","rpcId":<uuid>,"method":m,"payload":p}`; parse `result.ok` / `result.value` (A4). **Send no `Origin` header** (loopback control is allowed origin-less; a present origin must match exactly, A3).
- `createSession()` → `session.create` with `{ cwd: <blueant workspace dir>, agentPreset: "blueant" }` (workspaceId XOR cwd — use `cwd` for MVP; optional Step 6 upgrades to `workspace.create {path}`).
- `prompt(sessionId, text)` → `session.prompt` `{ sessionId, mode: "queue", content: [{type:"text", text: contextBlock + text}] }` — admission only.
- `cancel(sessionId)` → `session.cancel` `{ sessionId }`.
- Streaming: `URLSessionWebSocketTask` to `ws://127.0.0.1:3742/api/events.mux`; receive loop parsing each text message defensively:
  ```swift
  guard obj["type"] == "session/event", obj["sessionId"] == sessionId,
        let ev = obj["event"], ev["type"] == "assistant/chunk",
        let chunk = ev["data"]["chunk"], chunk["type"] == "text-delta",
        let t = chunk["text"] else { return }
  ```
  Append `text` to the answer buffer on the main queue; treat `event.type == "turn/end"` as completion; `stream/error` → show error. Parse every level with `as?` chains (never force-cast), ignore unknown frames (`session/projection`, `session/queue`, … arrive constantly).
- Session hygiene: one rolling session per calendar day; store `sessionId` + date in `UserDefaults` (`blueant.session.<yyyy-MM-dd>`); lazily create on first ask. ⌘N clears today's stored id so the next ask creates a fresh session.

1.4 **Desktop context v0** (zero-permission), prepended inside the prompt text as a short block:
- `NSWorkspace.shared.frontmostApplication` → app localizedName + bundleIdentifier (no permission).
- Browser URL: `NSAppleScript(source: 'tell app "<frontmost browser>" to get URL of active tab of front window')` **only if** automation consent already exists; on first error set a session flag and never try again this launch (no prompt storm). No screenshots, no accessibility.

1.5 **`AntonApp.swift` edits** (minimal, same style):
- Add a `Blueant ⌘B`-less item ("Open Blueant") above "Open Anton" → `blueantPanel.toggle()`; instantiate `BlueantPanel` + `HotkeyCenter` in `applicationDidFinishLaunching`, dispose hotkey in `applicationWillTerminate`. Keep everything else untouched.

### Step 2 — blueant preset via the bridge (`apps/anton-bridge/src/index.ts`)

2.1 Add `ensureBlueantPreset()` next to `ensureBundledContextProfile()` (call it from the same `startHarness()` path, right after `ensureBundledContextProfile()`), writing:
- `<dshHome>/.agent-presets/blueant/agent.cordis.yml`:
  ```yaml
  - id: persona
    name: '@deepseek-ai/dsh-persona'
    config:
      text: >-
        You are Blueant, the user's personal desktop agent. You are direct,
        context-aware, and terse. You answer from what you actually read and
        say so; you cite the memory or source you used. You are not a coding
        assistant: you answer questions and do small tasks about the user's
        day and machine. Default to one short paragraph; ask at most one
        clarifying question only when the ask is genuinely ambiguous.
      complete: true
      includeRuntimeContext: false
  - id: restrict-tools
    name: ./plugins/restrict-tools.js
    config:
      allow: [c0ntext_search, c0ntext_remember, recipe_search, web_search]
  ```
  (`recipe_put` and every file/bash/anton-lifecycle tool stay out of `allow`.)
- `<dshHome>/.agent-presets/blueant/preset.yml`: `name: Blueant` + `description: Personal desktop ask-loop agent (popup).`
- `<dshHome>/.agent-presets/blueant/plugins/restrict-tools.js` — plain-JS Cordis row:
  ```js
  export const name = 'blueant-restrict-tools'
  export function apply(ctx, config) {
    ctx.effect(() => ctx.tools.restrict({ allow: config.allow }), 'blueant.restrict')
  }
  ```
- c0ntext row tuning for the preset: extend the yml with
  ```yaml
  - id: c0ntext-context
    config:
      retrieveMode: fast
      tokenBudget: 600
      searchToolEnabled: true
      scoutEnabled: false
  ```
  (Preset rows can restate/override deployment rows by id in the preset layer; verify at runtime in Step 4 — if the preset-layer row config does not merge, fall back to setting the row in the profile's `cordis.patch.yml` guarded the same way `ensureBundledContextProfile` guards writes, or accept deployment-layer values for MVP and record the deviation.)
- Guard every write with `existsSync` (mirror `ensureBundledContextProfile`) so reruns are no-ops and the running deployment is never clobbered.

2.2 In the SAME function (or a sibling `ensureBlueantProfileLink()`), junction-symlink the persona package into the profile:
```ts
const personaLink = join(dshHome, 'profiles', profile, 'node_modules', '@deepseek-ai', 'dsh-persona')
mkdirSync(dirname(personaLink), { recursive: true })
// same unlink-if-symlink dance as pluginLink, then:
symlinkSync(resolve(harnessRoot, 'packages', 'preset', 'persona'), personaLink, 'junction')
```
(Same mechanism as `@c0ntext/dsh-c0ntext`; the packaged tree carries `packages/preset/persona/lib` built, satisfying `assertLibOnlyHarnessBundle`.)

2.3 **Land it NOW without restarting anything**: the bridge is already running, so run the authoring functions in isolation, e.g. a throwaway script:
```bash
cd apps/anton-bridge && ANTON_DSH_HOME="$HOME/Library/Application Support/Anton/dsh" \
  ANTON_DSH_ROOT="$PWD/../.." bun run -e 'await import("./src/index.ts")' # or extract ensure* into an exported module and call it
```
(Preferred: factor `ensureBundledContextProfile`/`ensureBlueantPreset` into an exported `profile.ts` module imported by `index.ts` — same behavior, testable in isolation. Pure refactor, no behavior change.)

### Step 3 — Build (candidate only)

- `pnpm run anton:build:macos` → produces `dist/Anton.next.app`; swiftc line becomes
  `swiftc -parse-as-library -framework Cocoa AntonApp.swift BlueantPanel.swift HotkeyCenter.swift HarnessClient.swift -o MacOS/Anton`.
- Typecheck alone: `swiftc -parse-as-library -typecheck` on all four files.
- Bridge typecheck/build: `bun build ./src/index.ts --outfile /dev/null` (or the repo's tsc) must stay clean.
- Do NOT run `dist/install-anton.sh`; do NOT restart the app or the harness.

### Step 4 — Verification (no restarts)

1. `GET http://127.0.0.1:3742/api/agentPreset.list` (curl, no Origin header) → expect `presets` to contain `{ id: "blueant", trust: "user", ... }` with no `broken` field (unmemoized discovery ⇒ visible immediately, A6).
2. `POST /api/session.create` `{"type":"client-request","rpcId":"1","method":"session.create","payload":{"cwd":"...","agentPreset":"blueant"}}` → `result.value.sessionId`; `session.prompt` `{mode:"queue",content:[{type:"text",text:"ping"}]}` → `accepted: true`.
3. Open a local WS client to `ws://127.0.0.1:3742/api/events.mux`, filter frames by that sessionId, confirm at least one `session/event` with `event.type == "assistant/chunk"` and `data.chunk.type == "text-delta"`, then `POST /api/session.cancel` and confirm no stream continues. **Do not leave test sessions streaming.**
4. Record the exact observed frame JSON (field names) in the phase report so Phase 3 (voice) reuses the parser.

### Step 5 — Risks / open items

- Preset-layer `c0ntext-context` row override semantics (restating an id in a preset) must be verified live in Step 4.2; fallback documented in 2.1.
- `session.prompt`'s client default timeout is irrelevant for the panel (admission-only), but the bridge HTTP `idleTimeout: 255` and the WS relay are downlink-only — the Swift client must never send WS messages.
- The candidate bundle's bridge binary embeds the new `ensureBlueantPreset`, but the RUNNING bridge is the old one: Step 2.3's isolated invocation is what makes the preset appear today; after the user installs `Anton.next.app`, the same function runs on every harness start.
- Hotkey ⇧⌥Space may collide with user shortcuts (e.g. input-source switching); constants are isolated in `BlueantHotkey` for trivial change.
- The `web_search` tool availability depends on `@deepseek-ai/dsh-web-search-browser` being in the live profile (it is, A8); if the preset `allow` names an unregistered tool, `tools.restrict` throws for unknown names — final `allow` list must be intersection-checked against `tool` registrations during verification.

### Deliverables checklist
- New: `apps/anton-bridge/macos/{BlueantPanel,HotkeyCenter,HarnessClient}.swift`
- Modified: `apps/anton-bridge/macos/AntonApp.swift` (Blueant menu item + lifecycle wiring)
- Modified: `scripts/build-anton-macos.ts` L129 (append the three new swift files)
- Modified: `apps/anton-bridge/src/index.ts` (+ optional `src/profile.ts` extraction): `ensureBlueantPreset()` + persona junction
- Created at runtime (user-trust data, not source): `<dshHome>/.agent-presets/blueant/{agent.cordis.yml,preset.yml,plugins/restrict-tools.js}`, profile `node_modules/@deepseek-ai/dsh-persona` junction
- Build artifact: `dist/Anton.next.app` (candidate, NOT installed)
