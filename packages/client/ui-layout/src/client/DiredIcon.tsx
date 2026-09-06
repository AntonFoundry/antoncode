/**
 * Dired row icons: small outline glyphs in the primitives' 16px style
 * (stroke, currentColor) — the web answer to lsd's Nerd Font icons, colored
 * by theme tokens so they follow the loaded palette (lsd's LS_COLORS idea,
 * expressed through the design system instead of terminal colors).
 */
import type { DiredIconKind } from './dired.ts'
import css from './DiredIcon.module.css'

/** Icon props: the classified kind. */
export function DiredIcon({ kind }: { kind: DiredIconKind }) {
  return (
    <svg
      width={14}
      height={14}
      viewBox='0 0 16 16'
      fill='none'
      xmlns='http://www.w3.org/2000/svg'
      className={`${css.icon} ${css[kind]}`}
      aria-hidden
    >
      {kind === 'folder' ? (
        <path
          d='M1.5 4.5C1.5 3.67 2.17 3 3 3h3l1.5 1.5H13c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5H3c-.83 0-1.5-.67-1.5-1.5v-7Z'
          stroke='currentColor'
          strokeWidth='1.2'
          strokeLinejoin='round'
        />
      ) : kind === 'code' ? (
        <>
          <path d='M5.5 5.5 3 8l2.5 2.5M10.5 5.5 13 8l-2.5 2.5' stroke='currentColor' strokeWidth='1.2' strokeLinecap='round' strokeLinejoin='round' />
          <path d='M9 3.5 7 12.5' stroke='currentColor' strokeWidth='1.2' strokeLinecap='round' />
        </>
      ) : kind === 'image' ? (
        <>
          <rect x='2.5' y='2.5' width='11' height='11' rx='1.5' stroke='currentColor' strokeWidth='1.2' />
          <circle cx='6' cy='6' r='1.2' fill='currentColor' />
          <path d='M3 11.5 6.5 8l3 3 1.5-1.5 2 2' stroke='currentColor' strokeWidth='1.2' strokeLinejoin='round' />
        </>
      ) : kind === 'archive' ? (
        <>
          <rect x='3' y='2.5' width='10' height='11' rx='1.5' stroke='currentColor' strokeWidth='1.2' />
          <path d='M8 3v2M8 6v2M8 9v1.5' stroke='currentColor' strokeWidth='1.2' strokeLinecap='round' />
        </>
      ) : kind === 'config' ? (
        <>
          <circle cx='8' cy='8' r='2.2' stroke='currentColor' strokeWidth='1.2' />
          <path d='M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6 11 5M5 11l-1.4 1.4' stroke='currentColor' strokeWidth='1.1' strokeLinecap='round' />
        </>
      ) : kind === 'doc' ? (
        <>
          <path d='M4 2.5h5L12.5 6v7c0 .55-.45 1-1 1h-7c-.55 0-1-.45-1-1v-9.5c0-.55.45-1 1-1Z' stroke='currentColor' strokeWidth='1.2' strokeLinejoin='round' />
          <path d='M5.5 8h5M5.5 10.5h5' stroke='currentColor' strokeWidth='1.1' strokeLinecap='round' />
        </>
      ) : (
        <path
          d='M4 2.5h5L12.5 6v7c0 .55-.45 1-1 1h-7c-.55 0-1-.45-1-1v-9.5c0-.55.45-1 1-1Z M9.5 2.5V6h3'
          stroke='currentColor'
          strokeWidth='1.2'
          strokeLinejoin='round'
        />
      )}
    </svg>
  )
}
