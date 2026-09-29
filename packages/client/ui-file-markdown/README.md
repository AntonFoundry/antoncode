# @deepseek-ai/dsh-client-ui-file-markdown

Web inline markdown viewer: the `markdown` key of ui-layout's `file.view` keyed slot. When the window manager opens a `.md`/`.markdown` file buffer (ido find-file Enter, dired Enter — the `openPath` opener routes them inline), the frame dispatches the `file.view` slot with `entryKey: 'markdown'` and this package's `MarkdownFileView` renders the body: the file text fetched once per path through the owner's read face, rendered by the shared `MarkdownText` engine (`@deepseek-ai/dsh-client-ui-primitives`) — the same renderer assistant output uses, so GFM, tables, math, code highlighting, and diagram fences behave exactly as in chat. There is deliberately no second markdown pipeline here.

A read failure renders the error message in place of the body; a read truncated at the host's 512 KiB cap renders its head with a note. An unclaimed `file.view` key falls back to the frame's built-in plain-text viewer, so removing this composition row degrades `.md` files to raw text instead of breaking the surface.

The companion packages own the other viewer keys: `ui-file-image` (`image`) and `ui-file-video` (`video`); the extension→key map lives in ui-layout's `file-view.ts`, and the key→package coupling lives in the web-app bundle's composition rows.

## Model Experience

None: the viewer is presentation-only over files the user opened in the GUI. It reads no session state, registers no tool, and adds nothing to any model request.

#### KV Cache effect

None — no model-visible surface.

## Known Limitations and Deferred Work

- **Read-face cap only** — files render from the 512 KiB text head the host read face returns; larger documents show a truncation note rather than a lazy tail, because the file-view owner share deliberately exposes no range reads.
