---
description: "Interactive terminal buffers in the GUI and their lifecycle and resource limits."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-terminal

English

## Summary

Use an interactive shell inside a terminal buffer, with keyboard input, pane resizing, retained output, and an exit notice. Each buffer attaches to its own Host PTY session or starts a new one. Terminal font preferences update mounted views, while palette colors are sampled when the view opens.

## Table of Contents

- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Terminal shell plugin: an [xterm.js](https://xtermjs.org/) view occupying the window manager's `terminal.view` slot — one interactive PTY session per terminal buffer, opened with `C-x t` / `M-x term`. Decision record: the [interactive PTY terminal buffers Agent Note](../../../.agents/notes/implemented/feature/2026-09-05-interactive-pty-terminal-buffers.md).

The view owns one xterm lifecycle per buffer: it waits for web fonts and a stable pane grid (two consecutive fits agreeing at ≥20 columns), spawns the shell at that grid over the `guiTerminal` Remote namespace, then polls the host's retained output tail on a 60 ms cadence against a client-owned cursor. Keystrokes pass through `guiTerminal.input`; container resizes propagate only when the grid actually changes, because every `SIGWINCH` makes bash's readline redraw its (multi-line) prompt and redraws garble the scrollback. Unmounting stops the view's polling and removes its broadcast membership; after the shell exits the poll stops and the view writes one exit notice.

Colors resolve from the loaded theme's alias tokens at view mount — `load-theme` before opening a terminal tints it accordingly. The essential upstream `xterm.css` rules are ported into `TerminalView.module.css`; the keyboard-capture textarea is functionally required and visually parked.

The `/client` exports are the plugin body (`apply`/`inject`) plus the component prop contract type only; the view component stays package-internal behind the slot registration. The plugin reads the generated `guiTerminal` Remote. Font selection changes reach mounted terminals through the `font/change` event and a shared viewing-state store.

</details>

-----

## Model Experience

### User terminal view

#### What the model sees

No terminal input or screen output enters model context. The `terminal.view` contribution is a direct user-to-shell interface, separate from the agent terminal tools.

#### Token effect

None; this package adds no model-input tokens.

#### KV Cache effect

None; browser presentation does not change provider requests or their reusable prefixes.

## Known Limitations and Deferred Work

- **No durable PTY sessions** — host session ids are memory-only. If an existing id is unavailable when the view attaches, the view spawns a fresh shell rather than recovering the old process.
- **Theme changes mid-session require a fresh terminal** — colors are sampled once at mount; xterm's theme is not re-applied on `theme/change` yet.
- **bash multi-line prompt redraws garble on window resize** — inherent to readline + a 3-line `PS1` (kitty behaves the same); the client bounds it by never sending a `SIGWINCH` without a real dimension change.
- **Output transport uses cursor polling** — reads run on a 60 ms interval rather than an output stream subscription.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
