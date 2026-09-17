# Agent Note: Layout modes, code-mode terminal grid, and multi-cursor broadcast

Status: implemented

English | [中文](2026-09-06-layout-modes-code-grid-multi-cursor.zh.md)

## Problem

The frame had exactly one composition (sidebar + conversation + details), so running several agents side-by-side — one terminal per agent, the BridgeMind/Codex layout — was impossible. Panel visibility (context toggle) and the brand-row toggles were hardcoded in WmFrame's brand row rather than reachable by plugins, and there was no way to type the same command into multiple terminals at once.

## Decision

- **Layout modes** (`agent` | `code` | `chat`) live in the layout store, persisted at `dsh.layout.mode`. Modes are *views over the tree*, not tree mutations: `agent` renders the tree unchanged, `chat` renders the first conversation leaf fullscreen (the tree is untouched, so returning to agent mode restores every window), and `code` renders every `terminal` buffer as a card in a wrapping grid (`auto-fit, minmax(480px, 1fr)`), hiding the context toggle. `M-x code-mode` / `chat-mode` / `agent-mode` plus a segmented control centered in the brand row switch modes.
- **Multi-cursor broadcast**: ui-terminal declares a broadcast store (broadcast flag + mounted-session set). The apply creates the single instance and shares it two ways — the inject `hooks` compartment (`hooks: { broadcast }` → components get `useBroadcast`) and the inject face (`broadcastActions`). `M-x multi-cursor` raises the `ui-terminal:toggle-broadcast` event from the WM; the apply listens and flips the same instance. Each terminal carries a ⧉ overlay toggle; with broadcast on, keystrokes typed into any terminal write into every joined session.
- **Top bar slots**: `shell.topbar.left` / `shell.topbar.right` are declared brand-row child slots, rendered left of / right of the centered switcher. The layout registers notification + account placeholder buttons into the right slot; ui-jobs/identity should replace them with real occupants.

## Alternatives considered

**Mutate the window tree per mode (close/open leaves).** Rejected: modes-as-views keep the tree — and every persisted geometry — untouched; the sidebar/details/split layout reappears exactly as it was.

**Wire multi-cursor through a generated remote namespace or M-x-only.** Rejected: the broadcast state is pure client viewing state; a store declared at the register is the sanctioned channel, and the WM→plugin toggle rides the same DOM-event seam c0ntext already uses (`c0ntext:open-map`).

**Put the broadcast instance in the register's `store:` factory.** Rejected after implementation: the framework instantiates its own instance from the factory, so an apply-created instance would be a second one — two sources of truth. The hooks compartment carries the single apply-created instance instead.

## Consequences

- `C-x t` twice in code mode gives the two-window agent layout; broadcast (M-x multi-cursor or ⧉) mirrors keystrokes into both.
- The brand row is plugin-extensible: `shell.topbar.left/right` occupants appear around the centered switcher. The sidebar and context toggles remain layout-owned brand controls (they toggle layout-owned state); re-homing them to their owning plugins is deferred.
- Terminal colors and broadcast state are per-view-mount; broadcast resets on reload (no persistence — it is session intent).

## Update (same day): expand↔restore, per-workspace arrangements, mode semantics

The reference layout drove three refinements. **Expand is a toggle**: entering stashes the current tree component-side and the pane's button becomes Restore, returning the exact pre-expand orientation (`M-x restore-layout`). **The window tree is a workspace fact**: an active-workspace change stashes the outgoing snapshot at `dsh.layout.wm:<workspaceId>` and loads the incoming one — each workspace keeps its own splits and per-leaf buffers (first visit keeps the persisted default; mid-workspace edits persist on switch). **Mode semantics**: Chat is the default mode (the normal per-workspace layout); Agent is a tiled multi-session launcher (every session of the active workspace as a card that opens into the frame's conversation windows); Code stays the terminal grid with a `+ Terminal` spawn toolbar. True N-conversation tiling requires per-card session contexts — a framework seam that does not exist yet; the launcher grid is the honest first cut. Also: three CSS token names that do not exist (`bg-raised`, `bg-sunken`, `border-subtle`) were replaced with real ones across the mode/broadcast rules, and the broadcast toggle glyph became an inline SVG.
