---
description: "Shell layout for the Web GUI: the window-manager frame that tiles the sidebar, Conversation, details, and buffer panes, the panel service, and theme presentation; for users and maintainers of the window chrome."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-layout

English

## Summary

This package provides the Web GUI's window-manager frame (WmFrame), which tiles the sidebar, the Conversation, the right panel, and file, terminal, scratch, and settings buffers as panes of one window tree, and the `ctx.layout` panel control. It keeps upstream's slot vocabulary (`sidebar`, `main`, `rightbar`, `shell.bottom`, `shell.overlay`, `shell.leading`), so upstream occupants register unchanged and render inside panes. The theme presenter owns color scheme, alias tokens, the theme's `--shiki-*` syntax hues, font sizes, font lists, the active theme id, and document metadata. The window tree persists in `localStorage` (`dsh.layout.wm`).

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Desktop Mod+B toggles the left sidebar through the same layout action used by its controls. The shortcut command is unavailable behind modal dialogs and yields to terminal input.

The root slot renders one window tree. Each leaf is a pane showing one buffer: the `sidebar` occupant, a chat pane, the details pane, or a file, terminal, scratch, webcam, or settings buffer. Splits divide space by weight; the sidebar and details panes keep pixel widths. Emacs-style key chords split, close, move, and switch panes, and the brand row carries the sidebar toggle and the chat/agent mode switch. Narrow viewports drop the sidebar pane and restore it on widening.

Global panels occupy the root-scoped `main` keyed slot; `conversation` is the reserved key for the Conversation. Every chat pane renders the selected `main` entry. `ctx.layout.selectPanel(id)` selects a registered panel, and `null` selects the Conversation without changing the current Session. The Plugins page contributes one of the shipped global panels. The `rightbar` occupant's surface is a buffer like any other: it stays mounted in one host for the frame's lifetime, parked in a hidden element inside the frame while no window shows it, and whichever window shows its buffer adopts that host and sizes the surface to the window, wherever the user placed it. No window reserves space for it. The surface expanding (`openRightbar`) shows its buffer in a window, the surface collapsing (`closeRightbar`) quits that window, and a window showing the buffer asks the surface to expand; closing or moving the window stays the user's. A later explicit Sidebar navigation reveals its buffer again even if the surface was already expanded; it reuses and focuses a window already showing that buffer rather than duplicating it, including a window inside an inactive nested tab group. Passive presentation reports do not reopen a manually closed window.

The agent board addresses prompt and stop actions to each pane's Session, independently of the selected conversation. Prompt acceptance clears only the submitted draft; rejection keeps the draft and displays the action's failure beside that pane. Temporary Session references remain owned until command settlement and release on failure or acquisition cancellation. Model labels read the Session's next or last-used model projection without opening cold conversation history.

Closing a terminal view preserves its PTY while another view still shows that terminal. The final view close or a global buffer kill waits for the Host disposal receipt before changing the window tree or buffer registry. A refused disposal keeps the existing view and reports the failure; concurrent close requests share one pending disposal.

The single root-scoped `shell.bottom` slot spans the full width below the window tree. Its occupant controls its own height and visibility; the panes shrink by that height, and empty content reserves no space. Main-panel navigation preserves the bottom component, while `shell.overlay` covers the whole frame. The default composition leaves this slot empty.

<a id="window-chrome-seat"></a>
### Window-chrome seat

The frame declares the root-scoped `shell.leading` seat, which ui-sidebar occupies with its reopen and New Session controls, but does not render it: the brand row owns the sidebar toggle at that position. On macOS desktop (`html[data-platform='darwin']`, set only by the desktop preload) the frame publishes `--dsh-frame-top-clearance` (48px) on the root element; entry pages in the main panel pad their top by it. The frame declares no darwin drag of its own: every chrome row marks itself `data-window-drag`, ui-web base.css turns that mark into the one darwin drag rule, and the row's own box is therefore the window's draggable geometry. The frame's remaining drag rule is the Windows caption row, which belongs to that platform.

Windows Electron's `data-windows-titlebar` marker reserves the caption height above the window tree as a drag band. Ordinary Web documents do not receive the marker; macOS retains its separate layout.

The root publishes `--dsh-frame-top-clearance` for the reserved strip (48px on macOS, the caption height on Windows), and `--dsh-frame-overlay-top` adds 20px for dialogs and menus. Native fullscreen reduces the overlay inset to 20px; dialogs retain their own 24px minimum. `--dsh-frame-chrome-top` excludes the Windows caption from modal mask painting and becomes zero in fullscreen. The full-viewport modal layer still blocks background clicks. Plain browser documents publish none of these values.

### Theme presentation

The presenter consumes resolved theme snapshots and projects them onto the document: `html { color-scheme }` for native UA chrome, `body[data-ds-dark-theme]` from the active color scheme, `body[data-ds-theme]` carrying the active theme id for theme-scoped sheets, the theme's alias tokens, `--dsh-content-font-size`, `--dsh-code-font-size`, `--dsh-terminal-font-size`, and each non-empty `--dsh-font-family-<role>` list as inline variables on body, and one owned `<meta name="theme-color">` whose content follows the computed body background. Disposing the presenter removes its metadata node with its other global writes.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`selectPanel(id)` checks the live `main` registry before changing selection; an absent key throws and leaves the current panel intact. `beginNavigation()` returns an abort signal for an asynchronous UI navigation. A later call, a valid panel selection (including repeated selection), or layout disposal aborts that signal without cancelling underlying Session creation. Consumers check the signal before committing navigation or moving drafts.

One registration declares the frame slots and binds `ctx.layout` methods `selectPanel`, `toggleSidebar`, `openRightbar(track, fullscreen)`, `closeRightbar`, `revealRightbar()`, and the settings-window controls used by the Settings shell; `IWmLayout` adds details and inline-file pane controls. The layout store holds `panelInfo` selection, pane width preferences, and the right panel's presentation report; a separate store holds the persisted window tree. `ctx.layout.panelInfo` and the standard `usePanelInfo` hook share the same selection source; each chat pane subscribes to the panel id alone. The `rightbar` owner supplies actual `width`, `viewportWidth`, and normal-presentation eligibility `canShow`; insufficient room causes a deterministic close, never automatic reopening on widening. Fullscreen hides the width handle without releasing a track the occupant retains. AppFrame keeps the column containers mounted. The right column's root controller renders `rightbar.session` through `SessionProvider` only while the Conversation is selected; its unmount report releases the track. The independent title component uses the selected Session title only while the Conversation is visible, with the build-configured product title or localized `common.brand.localBuild` as its fallback; locale revisions update that fallback. The theme presenter is a second effect: pure DOM writes from resolved snapshots — initial state through the getter once, then event-driven only, with no React path. It applies palette, font-size, font-list, and token variables before measuring the rendered background as the single color authority. Fullscreen presentation suppresses grid and handle transitions; its occupant reports the new columns only after covering the frame. Fullscreen exit keeps transitions suppressed while the frame installs its destination geometry: close removes the right track, and restore retains it. Subsequent normal geometry actions restore ordinary transitions.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the layout surface is not enough. They move from the frame to the columns it renders and the theme it presents.

- [ui-sidebar](../ui-sidebar/README.md) — occupies the `sidebar` column and its seats.
- [ui-conversation](../ui-conversation/README.md) — occupies the `main` key `conversation`.
- [ui-sidebar-right](../ui-sidebar-right/README.md) — occupies the `rightbar` column with one docking surface per session.
- [ui-theme](../ui-theme/README.md) — the theme seam whose resolved snapshots the presenter consumes.
- [Web client architecture](../../../docs/subsystems/web-client.md) — how browser plugin rows load and register slots.

-----

<a id="model-experience"></a>
## Model Experience

None, as the layout shell manages browser viewing state; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current layout behavior.

- **Per-pane Session pinning is not wired** — every chat pane renders the current Session. A pane pinned to another Session needs a retained `SessionReference` per pane rendered through `SessionProvider`, as ui-sidebar-right retains its Session views.
- **The agent board cannot interrupt or prompt a Session** — the 0.2 sessions controller has no such operations yet; those actions fail with a named error, and pane tails and model labels stay empty.
- **`shell.leading` is declared but not rendered** — the brand row owns the sidebar toggle, so ui-sidebar's leading controls register without mounting.
- **Quitting the right panel's window leaves its surface expanded** — the surface keeps its own expanded record, so tools reaching it while no window shows it do not reopen a window until it reports a fresh expansion.
- **The frame's stylesheets keep their own corner radii** — they are recorded as package-owned exceptions to the shared radius scale.
- **Window layout persists per workspace, panel geometry does not** — the split tree, buffers, and focused leaf reload from the wm snapshot; sidebar-width defaults and closed-details state reset per load.
- **No scroll anchoring during squeeze reflow** — layout changes may move the reader's viewport.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
