---
description: "Inline video file viewing in the GUI, including loading and failure behavior."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-file-video

English

## Summary

Play video files inside the GUI with native playback and seeking where the browser supports the source. A playback error offers an audio-remux fallback, and silent playback can use the same fallback manually. Retry and the default application remain available when inline playback fails.

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

Web inline video viewer: the `video` key of ui-layout's `file.view` keyed slot. When the window manager opens a video buffer (mp4/m4v/webm/mov/mkv/avi — the extension→key map lives in ui-layout's `file-view.ts`), the frame dispatches the `file.view` slot with `entryKey: 'video'` and this package's `VideoFileView` renders a `<video controls>` streaming from the trust-fenced `/api/host/media` endpoint URL the owner share's `mediaUrl` builds, with HTTP Range seeking served by the endpoint.

Playback degrades in two steps. A native playback error flips the source once to the endpoint's ffmpeg remux (`&remux=1` — fragmented MP4 with the video track stream-copied and the audio track transcoded to AAC, which recovers container mismatches (h264-in-MKV/MOV) and silent-audio cases (AC-3/DTS tracks Chromium drops) alike; the host answers 501 when ffmpeg is absent and the viewer falls through). Because a stream whose video decodes but whose audio does not plays silently and fires no error event, the native stage also shows a "No sound? Play via remux" affordance — the manual rescue for exactly that case. A second error renders the failure note with a Retry and an "Open with default app" escape hatch riding the owner's `openWithOs` face — a codec no installed browser decodes (ProRes commonly) needs a real player regardless of container. The remuxed stream is not seekable (no Range on a live transcode); it is a fallback, not the default path.

The companion packages own the other viewer keys: `ui-file-markdown` (`markdown`) and `ui-file-image` (`image`); the key→package coupling lives in the web-app bundle's composition rows.

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

- **Remux transcodes audio only** — video stays stream-copied, so a video codec the browser cannot decode at all (ProRes) still fails after the remux; full video transcoding needs long-running host jobs with progress and cancellation and is deferred until a real consumer needs it.
- **Remuxed playback is not seekable** — the fragmented-MP4 fallback streams from zero with no Range support; only the native path seeks.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
