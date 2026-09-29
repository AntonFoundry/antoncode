# Agent Note: Inline file viewers and the find-file open routing fix

Status: implemented

## Problem

C-x C-f (the ido find-file prompt) answered Enter on a plain file by landing the full dired window at the file's directory, so opening a file took two Enters and never opened the file itself. From dired, markdown opened as raw text in the plain-text file buffer, and images and videos left the app entirely (the opener face handed them to the OS default application). The user asked for file-first routing, plus inline markdown, image, and video viewers as separate plugins.

Partially builds on the dired-keys note (2026-09-01): dired's keyboard surface, the browse-picker composition pin, and the `DirectoryEntry` wire widening stand unchanged — only what Enter on a plain file *does* (ido prompt side) and where the opener's face routes media changed here.

## Decision

The routing contract collapses to one opener: `IdoFind` gains an `onOpenFile` outcome and WmFrame wires it to the same `openPath` face dired's open action uses. Enter on a file opens the file; Enter on a directory still descends; C-j and C-x d still open dired. The face's inline/OS split moved into ui-layout's `file-view.ts` (`opensInline`): only the binary hand-off families (pdf, archives, fonts, audio, tiff, wasm, sqlite) leave the app; everything else opens an inline `buffer:file:<path>` buffer.

Viewer choice is a keyed slot. ui-layout declares `file.view` (`kind: 'keyed'`, `scope: 'root'`, mirroring `tool.call.toolview`) and LeafPane dispatches `renderSlot('file.view', owner, { entryKey: viewerKeyFor(path), fallback: FileViewer })`. `viewerKeyFor` is the pure extension→key map owned by ui-layout; the plain-text `FileViewer` stays the built-in fallback for the `text` key and for any key with no registrant, so removing a viewer row degrades extensions to text instead of breaking the surface. Each shipped viewer is its own client package registering exactly one key: `ui-file-markdown` (`markdown`, rendering through the shared `MarkdownText` engine — no second markdown pipeline), `ui-file-image` (`image`, an `<img>` over the streaming endpoint; SVG stays sandboxed as an image element), and `ui-file-video` (`video`).

Binary media rides one new trust-fenced download channel: `GET|HEAD /api/host/media` in the api-proxy fetch carrier beside the `session.export` precedent — the carrier's prefix-wide `/api` authority fence applies, the handler checks the browse capability, types content by extension, slices single HTTP ranges (200/206/416 with `Accept-Ranges`/`Content-Range`), and streams from disk with abort-destroy. `remux=1` stream-copies a video file to fragmented MP4 through ffmpeg (501 when the binary is absent) for containers the browser cannot play natively; the video viewer flips to it once after a native playback error, then gives up into a failure note with retry and an OS-open escape hatch.

## Alternatives considered

**Give each viewer a whole buffer kind.** Rejected: the registry, titles, and kill/cycle logic would grow per-kind branches for what is one concept — a file shown through a renderer; the keyed slot keeps that dispatch in one place.

**Base64 file-content RPC for images.** Rejected: it multiplies browser-held bytes, caps sizes, and duplicates what a range-capable streaming endpoint already gives; images and video share the endpoint.

**Transcode unsupported codecs with ffmpeg.** Deferred: stream-copy remux is instant and fixes the common container mismatch (h264-in-MKV/MOV); transcoding HEVC or ProRes needs long-running host jobs with progress and cancellation, and no current consumer needs it — the failure note names the OS player.

**Fix the routing inside IdoFind by calling the viewer directly.** Rejected: two opener code paths would drift; the frame already owns the opener face, so the prompt just reports the file.

## Consequences

Unknown extensions still open inline as text (the pre-existing contract); a genuinely binary unknown renders mojibake in the fallback until `file-view.ts` grows the family. The remuxed stream is not seekable (fragmented MP4 over a live pipe) — only the native path seeks. The endpoint serves any regular file the browse capability can read, which is exactly the set dired can already list and the text viewer can already read; no new file authority was introduced. `Anton.previous.app` rollback restores the old routing wholesale (both the client bundles and the api-proxy ship in the app bundle).
