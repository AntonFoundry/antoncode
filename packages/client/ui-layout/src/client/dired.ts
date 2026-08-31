/**
 * Dired-lite pure helpers: sorting, filtering, and path ancestry for the
 * files buffer (compos's dired.scm behavior, client side). The wire
 * (`host.listDirectory` via the workspaces face) carries
 * `{name, path, hidden}` rows plus a crumbs ancestry chain; size/mtime are
 * optional extensions the sort falls back from when absent.
 */

/** One listing row (the wire shape plus optional stat extensions). */
export interface DiredEntry {
  /** Base name shown in the row. */
  name: string
  /** Absolute host path — navigation never joins path segments itself. */
  path: string
  /** Hidden by the host platform's convention (dot-prefixed on POSIX). */
  hidden: boolean
  /** Optional stat extension: byte size. */
  size?: number
  /** Optional stat extension: modification time (epoch ms). */
  modified?: number
}

/** Sort keys, cycled by the `s` key: name → size → modified. */
export type DiredSort = 'name' | 'size' | 'modified'

/**
 * The next sort key in the cycle.
 * @param sort - current key.
 * @returns name → size → modified → name.
 */
export function nextDiredSort(sort: DiredSort): DiredSort {
  return sort === 'name' ? 'size' : sort === 'size' ? 'modified' : 'name'
}

/**
 * Sort one listing: directories first (compos groups enterable rows ahead),
 * then by the active key; `reverse` flips the key order within each group.
 * Directories-first holds in both directions (the group split is not
 * reversed). The wire carries no dir flag today, so every row is treated as
 * enterable — the group split is future-proofing for a stat extension.
 * Missing sort values sort last within their group.
 * @param entries - the listing rows.
 * @param sort - active sort key.
 * @param reverse - reverse the key comparison.
 * @returns a new sorted array (input untouched).
 */
export function sortDired(entries: readonly DiredEntry[], sort: DiredSort, reverse: boolean): DiredEntry[] {
  const key = (e: DiredEntry): string | number => {
    switch (sort) {
      case 'name': return e.name.toLowerCase()
      case 'size': return e.size ?? Number.NaN
      case 'modified': return e.modified ?? Number.NaN
    }
  }
  const missingLast = (a: number, b: number): number => {
    const aNaN = Number.isNaN(a)
    const bNaN = Number.isNaN(b)
    if (aNaN || bNaN) return aNaN && bNaN ? 0 : aNaN ? 1 : -1
    return a - b
  }
  const sorted = [...entries].sort((a, b) => {
    const ka = key(a)
    const kb = key(b)
    const cmp = typeof ka === 'string' && typeof kb === 'string'
      ? ka.localeCompare(kb)
      : missingLast(ka as number, kb as number)
    return reverse ? -cmp : cmp
  })
  return sorted
}

/**
 * Apply the dotfiles toggle (`d` key): hidden rows drop out unless shown.
 * @param entries - the listing rows.
 * @param showDotfiles - whether hidden rows are visible.
 * @returns the visible rows (input untouched when everything shows).
 */
export function filterDired(entries: readonly DiredEntry[], showDotfiles: boolean): DiredEntry[] {
  return showDotfiles ? [...entries] : entries.filter(e => !e.hidden)
}

/**
 * The parent directory of an absolute POSIX-style path (pure fallback; the
 * live buffer prefers the listing's crumbs chain, which carries the host's
 * own ancestry).
 * @param path - absolute directory path.
 * @returns the parent path, or undefined at the filesystem root.
 */
export function parentOf(path: string): string | undefined {
  if (path === '' || path === '/') return undefined
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const cut = trimmed.lastIndexOf('/')
  if (cut <= 0) return cut === 0 ? '/' : undefined
  return trimmed.slice(0, cut)
}

/** Dired navigation history: the visited levels plus the cursor into them. */
export interface DiredHistory {
  /** The visited directory paths in visit order (undefined = the host home). */
  readonly levels: readonly (string | undefined)[]
  /** The cursor: levels[index] is the directory on screen. */
  readonly index: number
}

/** The fresh history: one level (the starting directory). */
export function freshDiredHistory(path: string | undefined): DiredHistory {
  return { levels: [path], index: 0 }
}

/**
 * Record one navigation: the forward stack drops (Emacs dired does not
 * branch histories), the target appends, the cursor moves onto it.
 * Re-navigating to the level already on screen returns the same history.
 * @param history - the current history.
 * @param path - the target directory (undefined = the host home).
 * @returns the new history (input untouched).
 */
export function pushDiredLevel(history: DiredHistory, path: string | undefined): DiredHistory {
  if (history.levels[history.index] === path) return history
  return { levels: [...history.levels.slice(0, history.index + 1), path], index: history.index + 1 }
}

/**
 * Step one level back.
 * @param history - the current history.
 * @returns the history at the previous level, or null when none exists.
 */
export function diredBack(history: DiredHistory): DiredHistory | null {
  if (history.index === 0) return null
  return { levels: history.levels, index: history.index - 1 }
}

/**
 * Step one level forward.
 * @param history - the current history.
 * @returns the history at the next level, or null when none exists.
 */
export function diredForward(history: DiredHistory): DiredHistory | null {
  if (history.index >= history.levels.length - 1) return null
  return { levels: history.levels, index: history.index + 1 }
}
