# @deepseek-ai/dsh-client-ui-layout

English

Shell plugin: the Emacs-style window-manager frame (`WmFrame`) plus the `ctx.layout` panel-geometry service; it registers into the runtime-owned `root` slot and declares the `sidebar`, `conversation`, and `details` windows as buffers of a persistent split tree (rows/columns with weights, optional tabbed containers). The buffer registry is persisted per workspace (`dsh.*` localStorage keys through the wm store) alongside the focused leaf; the shipped layout is sidebar | chat with Context closed until opened. Every buffer operation is a pure function in `wm.ts` (`splitLeaf`, `swapBuffer`, `killBuffer`, `focusDirection`, `normalizeTree`, …) and the frame's Ctrl-X chord layer (`keymap.ts`) drives them: `C-x b` opens the minibuffer switcher over the buffer roster plus every workspace session, `C-x 2/3` split the focused window, `C-x 0/1` close and single-window, arrows cycle and move focus. A closed sidebar retains a 56px control rail while details closes to zero width. The package also seats the theme presenter: it consumes resolved `ctx.theme` snapshots and projects them onto the document (`html { color-scheme }` for native UA chrome, `body[data-ds-dark-theme]` from the active color scheme, the theme's alias tokens as inline variables on body, and one owned `<meta name="theme-color">` whose content follows the computed body background). Measuring after palette and token application keeps the rendered background as the single color authority; disposing the presenter removes its metadata node with its other global writes.

Chat sessions are per-window session buffers (see [the Agent Note](../../.agents/notes/implemented/feature/2026-09-21-per-window-session-buffers.md)): a `session` buffer with a defined `sessionId` pins its window to that session through the slot renderer's `scopeSessionId` pinning, `undefined` follows the global current session, `C-x b` switches any window to any workspace session, and a sidebar click re-binds only the focused chat window. Splits clone the anchor's session buffer into a new registry entry, and the frame contributes the pane facts through the conversation owner share: `layoutSpan` (`single`/`multi`, driving pane-scoped drop targets), `scopeSessionId`, and the leaf-bound `rebindPane` a pinned pane's composer uses to re-pin instead of moving the global selection. The sidebar owner share contains only `collapsed` and `width`; registrants obtain business data from standard hooks and actions from their own inject faces.

The `/client` exports are the plugin body (`apply`/`inject`), `LayoutController` + `ILayout`, and the owner-share interfaces (`SidebarOwnerProps`, `ConvOwnerProps`, `DetailsOwnerProps`). The frame, window tree, wm operations, keymap, and stores remain package-internal (same-package tests import them directly).

## Model Experience

None, as the layout shell manages browser viewing state; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Window layout persists per workspace, panel geometry does not** — the split tree, buffers, and focused leaf reload from the wm snapshot; sidebar-width defaults and closed-details state reset per load.
- **Concession-chain auto-close derives a zero width without touching the preferred width** — the panel restores itself when the window widens; consumers must not read the stored details width as the rendered truth.
- **No scroll anchoring during squeeze reflow** — layout changes may move the reader's viewport.
