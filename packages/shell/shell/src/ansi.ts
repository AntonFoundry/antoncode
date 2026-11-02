/**
 * ANSI escape removal for model-facing shell output. Color-preserving
 * executors keep SGR bytes in the captured output for terminal
 * presentation; this module is the projection that keeps the model-facing
 * text clean, shared by `dsh-tool-bash` (and later its pwsh twin).
 * @module @deepseek-ai/dsh-shell/ansi
 */

import ansiRegex from 'ansi-regex'

/** Shared compiled matcher (ansi-regex's pattern is stateless and reusable). */
const ANSI = ansiRegex()

/** DCS payloads through their string terminator (ansi-regex stops at the two-byte ESC P). */
const DCS_PAYLOAD = /\x1bP[\s\S]*?\x1b\\/g

/** OSC sequences that reached BEL or ST. */
const OSC_COMPLETE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

/** An OSC that never reached BEL/ST before the capture ended. */
const OSC_TAIL = /\x1b\][^\x07\x1b]*$/

/** A CSI that never reached its final byte before the capture ended. */
const CSI_TAIL = /\x1b\[[0-9;:<=>?]*$/

/**
 * Remove ANSI escape sequences — CSI (SGR colors, cursor movement), OSC
 * (titles, hyperlinks), DCS, and two-byte ESC sequences — from captured
 * output. Plain text passes through untouched; an unterminated trailing
 * escape is dropped with everything after it (the capture was cut mid-write),
 * which is why the complete-sequence and tail passes run before the generic
 * matcher: ansi-regex's OSC branch accepts a partial sequence and would
 * leave the cut text behind.
 * @param text - captured shell output that may contain ANSI escapes.
 * @returns the same text without escape sequences.
 */
export function stripAnsi(text: string): string {
  return text
    .replace(DCS_PAYLOAD, '')
    .replace(OSC_COMPLETE, '')
    .replace(OSC_TAIL, '')
    .replace(CSI_TAIL, '')
    .replace(ANSI, '')
    .replace(/\x1b\\/g, '')
}
