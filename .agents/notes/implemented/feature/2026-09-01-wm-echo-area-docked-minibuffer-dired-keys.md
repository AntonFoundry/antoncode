# Agent Note: Echo area, docked minibuffer, and keyboard dired
English | [中文](2026-09-01-wm-echo-area-docked-minibuffer-dired-keys.zh.md)


Status: implemented

## Problem

The window manager had no persistent status surface: the armed chord and command feedback were either invisible or floated in popups, and the minibuffer overlayed the tree instead of living at the frame's bottom edge like Emacs's echo area. The dired files buffer had click navigation but its keys only worked after an explicit click into the listing (the container never held DOM focus when its window gained WM focus by chord), C-p/C-n did nothing, and the selection could scroll out of view. Deployed without the host's browse capability, `C-x d` failed entirely: `host.listDirectory` refuses when the composed directory picker serves the `native` OS-dialog face.

## Decision

- `StatusLine.tsx` is the frame's persistent last row (in flow, under the tree): the armed chord echo (`C-x-`), a transient message (self-expiring after 4 s via WmFrame's `notify`), or the focused buffer as the resting face; the right side carries the buffer name and window count. Command feedback lands there (`Split below/right`, `Closed window`, `The last window stands`, `Killed <buffer>`, `Wrote *scratch*`, `Layout reset`, `Undo`/`Redo`, `Layout dumped to *scratch*`, `Quit`).
- The minibuffer docks in the frame's flow directly above the echo area: opening a prompt grows the frame's tail (the tree shrinks) instead of floating over it; the echo strip stays visible beneath it.
- The which-key popup keeps only the completion list — the chord echo lives in the echo area.
- `FilesBuffer` takes an `active` prop (the pane's WM focus): when its window becomes the focused leaf the listing container takes the DOM focus, so keys land without a click. `C-p`/`C-n` join `↑`/`↓`/`n`/`p` for selection movement, and the selected row scrolls into view (`scrollIntoView`, nearest).
- The app profile overlay pins the directory picker to `@deepseek-ai/dsh-host-directory-picker-browse` (the composition's documented overlay pin), because dired's listing rides `host.listDirectory`, which the native OS-dialog face refuses. Trade-off: workspace folder pickers use the in-web listing instead of the OS dialog.
- The listing wire widened: `DirectoryEntry` carries `isDirectory`/`size`/`mtimeMs`/`mode`, and `list` takes `{ includeFiles }` — the folder chooser keeps its directories-only default, while dired always asks for the full level and renders kind/perms/size/date columns (`dired.ts` formats; Enter on a file hands it to the host's `openPath`). `C-x C-f` seeds the listing at the focused session's cwd (the workspace directory), `C-x d` at home.

## Alternatives considered

**Keep the floating minibuffer and add a separate status row above it.** Rejected: two stacked bottom surfaces re-create the echo/minibuffer split Emacs merged; the echo area and the minibuffer are one surface that expands.

**Route dired keys through the global chord listener with a dired mode flag.** Rejected: the global listener is the chord parser's home, not per-buffer keymaps; the listing container holding DOM focus keeps key ownership local and the text-field guard untouched.

**Serve `listDirectory` from the native picker face.** Rejected: a native dialog cannot enumerate a listing; the browse capability is the listing seam by design.

## Consequences

- The frame always ends in a one-line echo area; prompts expand upward from it, Emacs-style.
- A dired window driven by chords (C-x d, C-x b, C-x o) is keyboard-complete from the moment it is focused: arrows, C-p/C-n, Enter, `^`, `g`, `d`, `s`, `q`, Alt+arrows.
- Requires the host composition to pin the browse picker; a composition serving only `native` keeps dired listing dead (the RPC refuses loudly by design).
