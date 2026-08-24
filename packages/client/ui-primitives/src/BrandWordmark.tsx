// Anton brand wordmark: the Anton mark tile (apps/web/public/anton-mark.png)
// plus the "Anton" name. Ink rides currentColor; the tile is rounded so its
// black plate reads as an app-icon chip in both themes.

import type { IconProps } from './icons/props.ts'

/**
 * Render the full brand wordmark.
 * @param props.size - height in px of the text line (default 24); the mark
 * tile renders at twice that so it reads as an app-icon chip beside the name.
 * @param props.className - extra class for layout placement.
 * @returns the wordmark (aria-hidden decorative brand art).
 */
export function BrandWordmark({ size = 24, className }: IconProps) {
  const mark = size * 2
  return (
    <span
      className={className}
      aria-hidden="true"
      style={{ display: 'inline-flex', alignItems: 'center', gap: size * 0.42 }}
    >
      <img
        src="/anton-mark.png"
        width={mark}
        height={mark}
        alt=""
        style={{ display: 'block', borderRadius: mark * 0.26 }}
      />
      <span style={{ color: 'currentColor', fontSize: size * 0.72, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1 }}>
        Anton
      </span>
    </span>
  )
}
