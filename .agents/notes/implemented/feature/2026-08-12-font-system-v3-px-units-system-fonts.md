# Agent Note: Font system v3 — uniform px units, installed system families, overlay zoom coverage

Status: implemented

## Problem

User feedback on the sectioned font panel: units were inconsistent (Interface/Chat in percent, Code/Terminal in px), the Interface family menu offered only five curated fonts instead of the system's fonts, and coverage was inconsistent — menus and dialogs portaled to `document.body` sat outside ui-layout's `.frame`, so they ignored the interface zoom.

## Decision

**One unit everywhere: px.** Each section exposes its base text size in px and zoom becomes the implementation, not the user-facing unit. `uiSize` (12–20, default 14 = shipped UI base) replaced `uiScale`, `chatSize` (12–22, default 16 = the markdown base) replaced `chatScale`. The runtime computes `--dsh-zoom-ui = uiSize / 14` and keeps `--dsh-zoom-chat` as the chat/ui ratio so zoom still multiplies out of nested sections; the boot bootstrap computes the same ratios pre-paint. Ranges and bases live in `theme-settings.ts` (`UI_SIZE_RANGE`, `CHAT_SIZE_RANGE`, `UI_ZOOM_BASE`, `CHAT_ZOOM_BASE`) so tests and UI share one source.

**All installed fonts, enumerated by the host.** WKWebView cannot enumerate fonts from script, so the host half parses the files: `system-fonts.ts` scans `/System/Library/Fonts` (+ Supplemental), `/Library/Fonts`, and `~/Library/Fonts`, and reads each TTF/OTF/TTC `name` table with two ranged reads per font (directory window + name table), keeping activation cost at ~150 ms instead of reading whole CJK collections. Interface stores any family name; the boot bootstrap embeds the sorted list as `documentElement.dataset.uiFonts` (JSON) and the Font panel's Interface menu renders it with a filter field. Mono stays curated — a code face must ship real bold/italic cuts, which an arbitrary family does not.

Parsing facts that cost real debugging time, encoded as tests in `system-fonts.spec.ts`: a `name` record is `platform, encoding, language, nameID, length, offset` (length before offset); in a TrueType collection the member table-directory offsets are **absolute file offsets**, not member-relative (OpenType spec) — getting this wrong parses garbage, not a failure; Apple system fonts often ship only Macintosh-platform names (platform 1), whose non-Roman encodings cannot be decoded as latin1, so Mac records count only for Mac Roman and every font contributes one primary name (English Windows → other Unicode → Mac Roman), deduplicated across the scan. Dot-prefixed families are Apple's private fonts and stay out of the list.

**Overlay coverage.** Portaled overlays mount under `document.body`, outside `.frame`'s interface zoom. `Menu.portal` and `Modal` roots now carry `zoom: var(--dsh-zoom-ui, 1)` themselves; the anchor rect is already measured post-zoom, so positioning is unaffected. Tool cards (Diff/Read/Search/Web) already consumed the mono/markdown tokens, so no block-level fixes were needed.

## Consequences

- Settings schema keys changed (`uiScale`/`chatScale` → `uiSize`/`chatSize`); pre-release stance, no migration.
- The family list is enumerated once per activation: fonts installed while the app runs appear after restart (documented in the package README).
- Families managed by the system font-asset pipeline rather than files in the standard directories (PingFang SC on current macOS builds) are not listed; the shipped UI fallback stack still carries them, so CJK rendering is unaffected.
- `ui-theme`'s package tsconfig now admits `types: ["node"]` for the host-half enumeration module; the client bundle is unaffected (only `src/index.ts` imports it).

## Alternatives considered

**Keep percentage units for Interface/Chat and pixel units elsewhere.** Rejected: the settings exposed inconsistent units despite all sections controlling a text size. Pixel values provide one user-facing unit while preserving nested zoom compensation.

**Enumerate font families in WKWebView.** Unavailable through browser scripting. The Host reads installed font name tables; mono families remain curated because arbitrary families need not provide code-appropriate weight and italic cuts.
