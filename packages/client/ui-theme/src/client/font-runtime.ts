/**
 * Sectioned font preference owner: interface family/zoom, chat zoom,
 * monospace family/size, and terminal size. Unlike {@link ThemeRuntime} the
 * runtime applies its selection itself: the CSS custom properties it writes
 * are typography facts owned by this feature, not theme tokens routed
 * through ui-layout's presenter. Durable state lives in the same `ui-theme`
 * settings namespace as the theme preference.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import {
  DEFAULT_MONO_FONT, DEFAULT_MONO_SIZE, DEFAULT_SCALE, DEFAULT_TERM_SIZE,
  DEFAULT_UI_FAMILY, MONO_SIZE_RANGE, SCALE_RANGE, TERM_SIZE_RANGE,
  isMonoFont, monoFontStack, uiFontStack, type ThemeSettings,
} from '../theme-settings.ts'

/** Full font selection applied as document-root custom properties. */
export interface FontSelection {
  /** Curated UI family id (`--dsw-font-family`). */
  uiFamily: string
  /** Interface zoom percent, 80–140 (`--dsh-zoom-ui`). */
  uiScale: number
  /** Chat pane zoom percent, 80–140 (compensated `--dsh-zoom-chat` ratio). */
  chatScale: number
  /** Curated monospace family id (`--ds-font-family-code`). */
  monoFont: string
  /** Monospace size in px, 10–24 (`--dsw-font-size-code`). */
  monoSize: number
  /** Terminal size in px, 10–24 (`--dsh-font-size-term`, xterm re-fits). */
  termSize: number
}

/** Immutable font state published on every change. */
export interface FontSnapshot extends FontSelection {
  /** Monotonic change counter. */
  revision: number
}

/** Default selection when the settings document has no override. */
export const DEFAULT_SELECTION: FontSelection = Object.freeze({
  uiFamily: DEFAULT_UI_FAMILY, uiScale: DEFAULT_SCALE, chatScale: DEFAULT_SCALE,
  monoFont: DEFAULT_MONO_FONT, monoSize: DEFAULT_MONO_SIZE, termSize: DEFAULT_TERM_SIZE,
})

/** Normalize a zoom percent to a unitless CSS factor. */
function zoomFactor(percent: number): string {
  return String(percent / 100)
}

/**
 * Write the selection's CSS custom properties onto the document root. The
 * chat pane consumes chat/ui because zoom multiplies through the frame's
 * interface zoom; the runtime publishes the compensated ratio.
 * No-op outside a browser (node e2e booting the client tree).
 * @param selection - section selection to apply.
 */
export function applyFontVars(selection: FontSelection): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement.style
  root.setProperty('--dsw-font-family', uiFontStack(selection.uiFamily))
  root.setProperty('--dsh-zoom-ui', zoomFactor(selection.uiScale))
  root.setProperty('--dsh-zoom-chat', String(selection.chatScale / selection.uiScale))
  root.setProperty('--ds-font-family-code', monoFontStack(selection.monoFont))
  root.setProperty('--dsw-font-size-code', `${selection.monoSize}px`)
  root.setProperty('--dsh-font-size-term', `${selection.termSize}px`)
}

/**
 * Live sectioned font preference. Reads go through {@link getFont}; user
 * writes only through the `set*` methods; continuous sync through the
 * `font/change` event.
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
    this.selection = { ...DEFAULT_SELECTION }
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

  /** Switch the UI family; unknown ids throw. */
  setUiFamily(id: string): void { this.writeId('uiFamily', id) }

  /** Switch the interface zoom percent; non-integer or out-of-range throws. */
  setUiScale(scale: number): void { this.writeScale('uiScale', scale) }

  /** Switch the chat zoom percent; non-integer or out-of-range throws. */
  setChatScale(scale: number): void { this.writeScale('chatScale', scale) }

  /** Switch the monospace family; unknown ids throw. */
  setMonoFont(id: string): void {
    if (!isMonoFont(id)) throw new Error(`mono font "${id}" is not curated`)
    this.writeId('monoFont', id)
  }

  /** Switch the monospace size in px; out-of-range throws. */
  setMonoSize(size: number): void {
    if (size < MONO_SIZE_RANGE.min || size > MONO_SIZE_RANGE.max) {
      throw new Error(`mono size ${size} outside [${MONO_SIZE_RANGE.min}, ${MONO_SIZE_RANGE.max}]`)
    }
    this.writeNumber('monoSize', size)
  }

  /** Switch the terminal size in px; out-of-range throws. */
  setTermSize(size: number): void {
    if (size < TERM_SIZE_RANGE.min || size > TERM_SIZE_RANGE.max) {
      throw new Error(`term size ${size} outside [${TERM_SIZE_RANGE.min}, ${TERM_SIZE_RANGE.max}]`)
    }
    this.writeNumber('termSize', size)
  }

  /** Adopt the scope's accepted durable selection without writing it back. */
  private adopt(): void {
    const section = this.host.getSnapshot().value
    if (section === undefined) return
    const next: FontSelection = {
      uiFamily: section.uiFamily, uiScale: section.uiScale, chatScale: section.chatScale,
      monoFont: section.monoFont, monoSize: section.monoSize, termSize: section.termSize,
    }
    if (sameSelection(this.selection, next)) return
    this.selection = next
    this.publish()
  }

  private writeId(field: 'uiFamily' | 'monoFont', id: string): void {
    if (this.selection[field] === id) return
    this.selection = { ...this.selection, [field]: id }
    void this.host.set(field, id)
    this.publish()
  }

  private writeScale(field: 'uiScale' | 'chatScale', scale: number): void {
    if (!Number.isInteger(scale) || scale < SCALE_RANGE.min || scale > SCALE_RANGE.max) {
      throw new Error(`scale ${scale} outside [${SCALE_RANGE.min}, ${SCALE_RANGE.max}]`)
    }
    this.writeNumber(field, scale)
  }

  private writeNumber(field: 'uiScale' | 'chatScale' | 'monoSize' | 'termSize', value: number): void {
    if (this.selection[field] === value) return
    this.selection = { ...this.selection, [field]: value }
    void this.host.set(field, value)
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

/** Field-by-field selection equality (revision excluded). */
function sameSelection(left: FontSelection, right: FontSelection): boolean {
  return left.uiFamily === right.uiFamily && left.uiScale === right.uiScale
    && left.chatScale === right.chatScale && left.monoFont === right.monoFont
    && left.monoSize === right.monoSize && left.termSize === right.termSize
}
