// Anton brand wordmark: the header mark tile (apps/web/public/anton-header.png,
// derived from apps/anton-bridge/macos/AppIcon.png) plus the "Anton" name.
// Ink rides currentColor; the tile is rounded so the mark's plate reads as an
// app-icon chip in both themes. The in-chat mark (FishLogo, /anton-mark.png)
// is a separate asset and stays on the previous art.

import type { IconProps } from './icons/props.ts'

/** Display options for the official brand wordmark. */
export interface BrandWordmarkProps extends IconProps {
  /** Whether to include the leading mark tile; defaults to true. */
  includeMark?: boolean | undefined
}

/**
 * Render the full brand wordmark.
 * @param props.size - height in px of the text line (default 24); the mark
 * tile renders at twice that so it reads as an app-icon chip beside the name.
 * @param props.className - extra class for layout placement.
 * @param props.includeMark - whether to include the leading mark tile.
 * @returns the wordmark (aria-hidden decorative brand art).
 */
export function BrandWordmark({ size = 24, className, includeMark = true }: BrandWordmarkProps) {
  const mark = size * 2
  return (
    <span
      className={className}
      aria-hidden="true"
      style={{ display: 'inline-flex', alignItems: 'center', gap: size * 0.42 }}
    >
      {includeMark && (
        <img
          src="/anton-header.png"
          width={mark}
          height={mark}
          alt=""
          style={{ display: 'block', borderRadius: mark * 0.26 }}
        />
      )}
      <span style={{ color: 'currentColor', fontSize: size * 0.72, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1 }}>
        Anton
      </span>
    </span>
  )
}
