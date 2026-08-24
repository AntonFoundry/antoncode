// Anton mark (apps/web/public/anton-mark.png): the binary-face head tile.
// Used standalone in the collapsed sidebar rail (24px) and the welcome hero
// (34px). Rounded corners keep the black plate reading as an app-icon chip.

import type { IconProps } from './icons/props.ts'

/**
 * Render the Anton mark.
 * @param props.size - edge length in px (default 24).
 * @param props.className - extra class for layout placement.
 * @returns the mark image (aria-hidden; pair with the wordmark for accessibility).
 */
export function FishLogo({ size = 24, className }: IconProps) {
  return (
    <img
      src="/anton-mark.png"
      width={size}
      height={size}
      className={className}
      alt=""
      aria-hidden="true"
      style={{ display: 'block', borderRadius: size * 0.28 }}
    />
  )
}
