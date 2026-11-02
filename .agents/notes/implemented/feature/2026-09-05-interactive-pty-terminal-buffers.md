# Agent Note: Interactive PTY terminal buffers (`term` domain + ui-terminal)

Status: implemented

## Problem

The harness GUI had no terminal surface: every shell interaction went through the agent's own tool lane (pull-based, sanitized env, controlled `PS1`), so the user could not run their *own* interactive login shell — aliases, `~/.bash_profile`, `lsd` icons, vim/htop — inside the app. The WM also had no buffer kind a terminal could live in, and the slot system had no seat for an xterm view.

## Decision

- **New wire domain `term`** (`packages/host/apiproxy`): `spawn`/`read`/`input`/`resize`/`dispose` over node-pty (the same `node-pty@1.2.0-beta.15` the subprocess seam ships). `spawn` runs `/bin/bash -l` with the user's real env and `TERM=xterm-256color`, so `~/.bash_profile`/`~/.bashrc` are sourced and full ANSI/24-bit color works. Output transport is **unary polling with a client-owned cursor**: the host retains a 400 KB tail per session and `read({ since })` returns the bytes past the cursor plus the next offset — no mux/stream frame was added for a first-class terminal. Errors use the closed `RpcErrorDetailsMap` codes (`term-unavailable`, `term-no-session`, `term-spawn-failed`, …).
- **New client plugin `packages/client/ui-terminal`**: hosts `@xterm/xterm` + `@xterm/addon-fit`, registers the WM's `terminal.view` slot (declared in ui-layout's `SlotMap` with `owner: { sessionId?: string | undefined }`). Terminal colors resolve from the loaded theme's alias tokens at mount.
- **WM integration** (ui-layout): a `terminal` buffer kind and the `C-x t` / `M-x term` command. The buffer is created **without a session id**; the view spawns the PTY itself once the pane grid is settled, so the shell is born at the true pane size.
- **Startup stability sequence** (the fix behind the "chevron garble" reports): the view waits for `document.fonts.ready`, then polls fits until two consecutive fits agree at ≥20 columns, and only then spawns. Every fit change otherwise would fire `SIGWINCH`; bash's readline cannot redraw a multi-line `PS1` without overprinting the scrollback (user-visible as interleaved `>>>>` runs at the top). A dimension-change guard keeps later layout settles silent; only real pane/window resizes propagate.
- **Focus follows the WM**: when a terminal pane becomes the focused leaf, LeafPane focuses xterm's `.xterm-helper-textarea`, so `C-x o`/`C-x t` put the cursor in the terminal without a click. The essential upstream `xterm.css` rules (helper-textarea parked at `opacity: 0`, `.xterm` focus/cursor/selection, viewport scroll) are ported into `TerminalView.module.css` — the package never loads upstream CSS.
- Exit is written once (`[process exited — close the window or C-x t for a new shell]`) and the poll stops; closing the window disposes the PTY.

## Alternatives considered

**Reuse the agent-oriented `ctx.terminals` capability.** Rejected: it is owner-scoped (Agent), line-oriented, and deliberately sanitizes env/`PS1` with OSC 133 readiness markers — the opposite of an interactive login shell.

**Add a typert-generated remote namespace for `term`.** Rejected for now: the generated-contribution machinery is heavy for five methods; the plugin reaches the typed `IApiClient` through `ctx.get('connection')` (the model-selection service's established cast). Revisit when a second consumer needs the namespace.

**Stream PTY output over a new mux frame.** Rejected for now: a 60 ms cursor poll over a retained host tail is indistinguishable for interactive use and keeps the transport unary; the domain can graduate to a stream later without contract changes.

**Write the exit notice on every read.** Rejected (bug it caused): the host keeps reporting `exited: true` after death, so the marker looped. The notice is written once and the poll stops.

## Consequences

- `C-x t` opens a login shell in a split window; buffers clone across windows like every other kind; `C-x 0` disposes the PTY.
- Colors follow `load-theme` at view mount; theme changes mid-session require a fresh terminal (accepted first-cut limitation).
- The host keeps one node-pty process per open terminal; sessions die with the app process (no reattach across restarts — session ids are not durable).
- The `dsh.client`/bundle registration for `@deepseek-ai/dsh-client-ui-terminal` follows the standard three surfaces (aggregate reference, patch row, web-app dependency).
