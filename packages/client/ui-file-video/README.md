# @deepseek-ai/dsh-client-ui-file-video

Web inline video viewer: the `video` key of ui-layout's `file.view` keyed slot. When the window manager opens a video buffer (mp4/m4v/webm/mov/mkv/avi — the extension→key map lives in ui-layout's `file-view.ts`), the frame dispatches the `file.view` slot with `entryKey: 'video'` and this package's `VideoFileView` renders a `<video controls>` streaming from the trust-fenced `/api/host/media` endpoint URL the owner share's `mediaUrl` builds, with HTTP Range seeking served by the endpoint.

Playback degrades in two steps. A native playback error flips the source once to the endpoint's ffmpeg stream-copy remux (`&remux=1` — fragmented-MP4 stream copy, which recovers container mismatches such as h264-in-MKV/MOV instantly; the host answers 501 when ffmpeg is absent and the viewer falls through). A second error renders the failure note with a Retry and an "Open with default app" escape hatch riding the owner's `openWithOs` face — a codec no installed browser decodes (HEVC commonly) needs a real player regardless of container. The remuxed stream is not seekable (no Range on a live transcode); it is a fallback, not the default path.

The companion packages own the other viewer keys: `ui-file-markdown` (`markdown`) and `ui-file-image` (`image`); the key→package coupling lives in the web-app bundle's composition rows.

## Model Experience

None: the viewer is presentation-only over files the user opened in the GUI. It reads no session state, registers no tool, and adds nothing to any model request.

#### KV Cache effect

None — no model-visible surface.

## Known Limitations and Deferred Work

- **Remux is stream-copy only** — a video whose codec the browser cannot decode (HEVC, ProRes) still fails after the remux; transcoding would need long-running host jobs and is deferred until a real consumer needs it.
- **Remuxed playback is not seekable** — the fragmented-MP4 fallback streams from zero with no Range support; only the native path seeks.
