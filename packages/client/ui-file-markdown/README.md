---
description: "Inline markdown file viewing in the GUI, including loading and failure behavior."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-file-markdown

English

## Summary

Read Markdown files inside the GUI with the same tables, math, code highlighting, and diagram rendering used in chat. Read failures appear in the file pane, and capped reads display a truncation note. Opening a document does not add its contents to a model request.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

## Use this package

Open a supported file through the window manager. The Web composition supplies this viewer; removing it leaves the frame's plain-text fallback for its file type.

-----

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Web inline markdown viewer: the `markdown` key of ui-layout's `file.view` keyed slot. When the window manager opens a `.md`/`.markdown` file buffer (ido find-file Enter, dired Enter — the `openPath` opener routes them inline), the frame dispatches the `file.view` slot with `entryKey: 'markdown'` and this package's `MarkdownFileView` renders the body: the file text fetched once per path through the owner's read face, rendered by the shared `MarkdownText` engine (`@deepseek-ai/dsh-client-ui-primitives`) — the same renderer assistant output uses, so GFM, tables, math, code highlighting, and diagram fences behave exactly as in chat. There is deliberately no second markdown pipeline here.

A read failure renders the error message in place of the body; a read truncated at the host's 512 KiB cap renders its head with a note. An unclaimed `file.view` key falls back to the frame's built-in plain-text viewer, so removing this composition row degrades `.md` files to raw text instead of breaking the surface.

The companion packages own the other viewer keys: `ui-file-image` (`image`) and `ui-file-video` (`video`); the extension→key map lives in ui-layout's `file-view.ts`, and the key→package coupling lives in the web-app bundle's composition rows.

</details>

-----

## Model Experience

### GUI file viewing

#### What the model sees

No file content or viewer state enters model context. The `file.view` contribution only renders a file the user opened; it registers no model tool or prompt section.

#### Token effect

None; this package adds no model-input tokens.

#### KV Cache effect

None; browser presentation does not change provider requests or their reusable prefixes.

## Known Limitations and Deferred Work

- **Read-face cap only** — files render from the 512 KiB text head the host read face returns; larger documents show a truncation note rather than a lazy tail, because the file-view owner share deliberately exposes no range reads.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
