/**
 * Monospace font preference owner. Unlike {@link ThemeRuntime} the runtime
 * applies its selection itself: the two CSS custom properties it writes are
 * typography facts owned by this feature, not theme tokens routed through
 * ui-layout's presenter. Durable state lives in the same `ui-theme` settings
 * namespace as the theme preference.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import {
  DEFAULT_MONO_FONT, DEFAULT_MONO_SIZE, MONO_SIZE_RANGE, isMonoFont, monoFontStack,
  type ThemeSettings,
} from '../theme-settings.ts'

/** Immutable font state published on every change. */
export interface FontSnapshot {
  /** Curated monospace family id. */
  monoFont: string
  /** Monospace size in px. */
  monoSize: number
  /** Monotonic change counter. */
  revision: number
}

/** Font selection fields applied to the document root. */
export interface FontSelection {
  /** Curated family id. */
  monoFont: string
  /** Size in px. */
  monoSize: number
}

/**
 * Write the selection's CSS custom properties onto the document root.
 * No-op outside a browser (node e2e booting the client tree).
 * @param selection - family id and size to apply.
 */
export function applyFontVars(selection: FontSelection): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement.style
  root.setProperty('--ds-font-family-code', monoFontStack(selection.monoFont))
  root.setProperty('--dsw-font-size-code', `${selection.monoSize}px`)
}

/**
 * Live monospace preference. Reads go through {@link getFont}; user writes
 * only through {@link setMonoFont}/{@link setMonoSize}; continuous sync
 * through the `font/change` event.
 */
export class FontRuntime {
  private readonly ctx: Context
  private readonly host: SettingsScope<ThemeSettings>
  private selection: FontSelection
  private revision = 0
  private snapshot: FontSnapshot

  /**
   * @param ctx - owning context (`font/change` emits on it; the scope
   * listener is released through ctx.effect on dispose).
   * @param host - durable settings scope shared with ThemeRuntime.
   */
  constructor(ctx: Context, host: SettingsScope<ThemeSettings>) {
    this.ctx = ctx
    this.host = host
    this.selection = { monoFont: DEFAULT_MONO_FONT, monoSize: DEFAULT_MONO_SIZE }
    this.snapshot = this.buildSnapshot()
    applyFontVars(this.selection)
    ctx.effect(() => host.subscribe(() => { this.adopt() }), 'ui-theme: font scope adoption')
    this.adopt()
  }

  /**
   * Read the current immutable font snapshot.
   * @returns the current snapshot (stable reference until the next change).
   */
  getFont(): FontSnapshot {
    return this.snapshot
  }

  /**
   * Switch the monospace family — the only family write entry.
   * @param id - a curated family id; unknown ids throw.
   */
  setMonoFont(id: string): void {
    if (!isMonoFont(id)) throw new Error(`mono font "${id}" is not curated`)
    if (id === this.selection.monoFont) return
    this.selection = { ...this.selection, monoFont: id }
    void this.host.set('monoFont', id)
    this.publish()
  }

  /**
   * Switch the monospace size — the only size write entry.
   * @param size - size in px inside {@link MONO_SIZE_RANGE}; out-of-range throws.
   */
  setMonoSize(size: number): void {
    if (size < MONO_SIZE_RANGE.min || size > MONO_SIZE_RANGE.max) {
      throw new Error(`mono size ${size} outside [${MONO_SIZE_RANGE.min}, ${MONO_SIZE_RANGE.max}]`)
    }
    if (size === this.selection.monoSize) return
    this.selection = { ...this.selection, monoSize: size }
    void this.host.set('monoSize', size)
    this.publish()
  }

  /** Adopt the scope's accepted durable selection without writing it back. */
  private adopt(): void {
    const section = this.host.getSnapshot().value
    if (section === undefined) return
    const next: FontSelection = { monoFont: section.monoFont, monoSize: section.monoSize }
    if (this.selection.monoFont === next.monoFont && this.selection.monoSize === next.monoSize) return
    this.selection = next
    this.publish()
  }

  private publish(): void {
    this.revision += 1
    this.snapshot = this.buildSnapshot()
    applyFontVars(this.selection)
    this.ctx.emit('font/change', this.snapshot)
  }

  private buildSnapshot(): FontSnapshot {
    return { ...this.selection, revision: this.revision }
  }
}
