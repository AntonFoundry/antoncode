---
description: "Inline image file viewing in the GUI, including loading and failure behavior."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-file-image

English

## Summary

Open image files inside the GUI, with loading feedback, retry, and an option to open the file in its default application. The browser decodes supported formats, and SVG files display as images rather than executable markup. Unsupported files remain available through the default application.

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

Web inline image viewer: the `image` key of ui-layout's `file.view` keyed slot. When the window manager opens a browser-renderable image buffer (png/jpg/jpeg/gif/webp/svg/bmp/ico/avif — the extension→key map lives in ui-layout's `file-view.ts`), the frame dispatches the `file.view` slot with `entryKey: 'image'` and this package's `ImageFileView` renders it: an `<img>` whose src is the trust-fenced `/api/host/media` streaming URL the owner share's `mediaUrl` builds. The browser fetches and decodes the bytes, so the viewer holds none; SVG renders as an `<img>`, where the browser sandbox never runs the file's embedded scripts (no innerHTML path exists).

A load failure keeps the pane usable: an inline note with a Retry (re-mounts the `<img>`, so a cached error re-requests) and an "Open with default app" escape hatch riding the owner's `openWithOs` face. An unclaimed `file.view` key falls back to the frame's built-in plain-text viewer, so removing this composition row degrades images to the fallback instead of breaking the surface.

The companion packages own the other viewer keys: `ui-file-markdown` (`markdown`) and `ui-file-video` (`video`); the key→package coupling lives in the web-app bundle's composition rows.

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

- **Browser-decodable formats only** — tiff and other formats the decoders reject land here only if `file-view.ts` routes them; they deliberately stay on the OS-open list, and a routed-but-undecodable file shows the failure note.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
