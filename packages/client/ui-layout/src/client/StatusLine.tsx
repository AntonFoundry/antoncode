/**
 * The echo area: the frame's persistent bottom strip (Emacs echo-area
 * placement — the frame's last row, under the tree; the minibuffer expands
 * the frame directly above it when a prompt is active). One line at rest,
 * showing in priority order: the armed chord echo, a transient message
 * (WmFrame's notify, self-expiring), or the focused window's buffer as the
 * resting face; the right side carries the buffer name and window count.
 * Pure presentational: every fact arrives through props.
 */
import css from './StatusLine.module.css'

/** Echo-area props: chord echo, transient message, and the resting face. */
export interface StatusLineProps {
  /** The armed chord prefix (C-x / C-c), echoed while it waits. */
  prefix: 'x' | 'c' | undefined
  /** A transient message (self-expiring in WmFrame); beats the resting face. */
  message: string | undefined
  /** The focused window's buffer title (the resting face). */
  bufferTitle: string
  /** How many windows the frame currently shows. */
  windowCount: number
}

/**
 * Render the echo-area strip.
 * @param props - prefix, message, buffer title, window count.
 * @returns the strip element.
 */
export function StatusLine({ prefix, message, bufferTitle, windowCount }: StatusLineProps) {
  const prefixEcho = prefix === 'x' ? 'C-x-' : prefix === 'c' ? 'C-c-' : undefined
  const text = prefixEcho ?? message ?? `(${bufferTitle})`
  return (
    <div className={css.echo} data-echo>
      <span className={css.echoText} data-armed={prefixEcho !== undefined || undefined}>{text}</span>
      <span className={css.echoMeta}>
        {bufferTitle} · {windowCount} {windowCount === 1 ? 'window' : 'windows'}
      </span>
    </div>
  )
}
