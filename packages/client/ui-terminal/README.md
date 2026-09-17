# @deepseek-ai/dsh-client-ui-terminal

English

Terminal shell plugin: an [xterm.js](https://xtermjs.org/) view occupying the window manager's `terminal.view` slot — one interactive PTY session per terminal buffer, opened with `C-x t` / `M-x term`. Decision record: the [interactive PTY terminal buffers Agent Note](../../../.agents/notes/implemented/feature/2026-09-05-interactive-pty-terminal-buffers.md).

The view owns one xterm lifecycle per buffer: it waits for web fonts and a stable pane grid (two consecutive fits agreeing at ≥20 columns), spawns the shell at that grid over the `term` RPC domain, then polls the host's retained output tail on a 60 ms cadence against a client-owned cursor. Keystrokes pass straight through `term.input`; container resizes propagate only when the grid actually changes, because every `SIGWINCH` makes bash's readline redraw its (multi-line) prompt and redraws garble the scrollback. Closing the buffer disposes the session; after the shell exits the poll stops and the view writes one exit notice.

Colors resolve from the loaded theme's alias tokens at view mount — `load-theme` before opening a terminal tints it accordingly. The essential upstream `xterm.css` rules are ported into `TerminalView.module.css`; the keyboard-capture textarea is functionally required and visually parked.

The `/client` exports are the plugin body (`apply`/`inject`) plus the component prop contract type only; the view component stays package-internal behind the slot registration. The plugin reads the typed `IApiClient` through `ctx.get('connection')` (the model-selection service's established pattern) — no generated remote namespace yet.

## Model Experience

None, as the terminal is a direct user↔shell surface; nothing here reaches a model request. The shell is the user's login bash (`bash -l`, real env, `~/.bash_profile`/`~/.bashrc` sourced) — deliberately *not* the sanitized, OSC-133-marked shell the agent's own terminal tools use.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No reattach across app restarts** — PTY session ids are host-memory only; a restart orphans the buffer into a dead session (the view writes its exit notice on the next poll).
- **Theme changes mid-session require a fresh terminal** — colors are sampled once at mount; xterm's theme is not re-applied on `theme/change` yet.
- **bash multi-line prompt redraws garble on window resize** — inherent to readline + a 3-line `PS1` (kitty behaves the same); the client bounds it by never sending a `SIGWINCH` without a real dimension change.
- **Output transport is a 60 ms cursor poll, not a stream** — indistinguishable interactively; graduates to a mux stream later without contract changes if latency ever matters.
