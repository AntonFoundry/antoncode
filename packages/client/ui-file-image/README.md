# @deepseek-ai/dsh-client-ui-file-image

Web inline image viewer: the `image` key of ui-layout's `file.view` keyed slot. When the window manager opens a browser-renderable image buffer (png/jpg/jpeg/gif/webp/svg/bmp/ico/avif — the extension→key map lives in ui-layout's `file-view.ts`), the frame dispatches the `file.view` slot with `entryKey: 'image'` and this package's `ImageFileView` renders it: an `<img>` whose src is the trust-fenced `/api/host/media` streaming URL the owner share's `mediaUrl` builds. The browser fetches and decodes the bytes, so the viewer holds none; SVG renders as an `<img>`, where the browser sandbox never runs the file's embedded scripts (no innerHTML path exists).

A load failure keeps the pane usable: an inline note with a Retry (re-mounts the `<img>`, so a cached error re-requests) and an "Open with default app" escape hatch riding the owner's `openWithOs` face. An unclaimed `file.view` key falls back to the frame's built-in plain-text viewer, so removing this composition row degrades images to the fallback instead of breaking the surface.

The companion packages own the other viewer keys: `ui-file-markdown` (`markdown`) and `ui-file-video` (`video`); the key→package coupling lives in the web-app bundle's composition rows.

## Model Experience

None: the viewer is presentation-only over files the user opened in the GUI. It reads no session state, registers no tool, and adds nothing to any model request.

#### KV Cache effect

None — no model-visible surface.

## Known Limitations and Deferred Work

- **Browser-decodable formats only** — tiff and other formats the decoders reject land here only if `file-view.ts` routes them; they deliberately stay on the OS-open list, and a routed-but-undecodable file shows the failure note.
