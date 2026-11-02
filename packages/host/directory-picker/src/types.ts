/**
 * Client-safe type surface of the directory-picking seam: what one browse level
 * looks like to a caller. Types only — no runtime code, and nothing here reaches
 * a Host-only symbol, so a Client compilation face reads exactly the signatures
 * the Host emits.
 *
 * @module @deepseek-ai/dsh-host-directory-picker/types
 */

/** One directory row: a listing child or a breadcrumb ancestor. */
export interface DirectoryEntry {
  /** Base name shown in a browser row (a root crumb carries its full path). */
  name: string
  /** Absolute host path — clients never join path segments themselves. */
  path: string
  /** Hidden by the host platform's convention (dot-prefixed on POSIX); the client owns whether to show it. */
  hidden: boolean
  /** Row kind: an enterable directory (the browser descends) versus a plain file row (only `includeFiles` listings carry these). */
  isDirectory: boolean
  /** Content size in bytes; absent where the backend cannot report it. */
  size?: number
  /** Last modification in Unix milliseconds; absent where the backend cannot report it. */
  mtimeMs?: number
  /** POSIX mode bits (type nibble included, e.g. `0o100644`); absent on platforms without modes. */
  mode?: number
}

/** One directory level plus its ancestry, as a browse backend reports it. */
export interface DirectoryListing {
  /** Absolute path of the listed directory. */
  path: string
  /** The host account's home directory (breadcrumb "Home" rooting). */
  home: string
  /**
   * Ancestor chain from the filesystem root to the listed directory
   * inclusive; every crumb is a jump target (crumb `hidden` is always false).
   */
  crumbs: DirectoryEntry[]
  /** Direct child directories (plus plain files when the call set `includeFiles`), name-sorted; symlinks follow to their targets. */
  entries: DirectoryEntry[]
  /**
   * True when the backend cut `entries` at its complete-result bound: the
   * level has more child directories than reported, and the missing rows are
   * the name-sorted tail (hidden rows count toward the bound).
   */
  truncated: boolean
}
