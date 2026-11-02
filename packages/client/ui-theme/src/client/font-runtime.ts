/**
 * Sectioned font preference owner: interface family/zoom, chat zoom,
 * monospace family/size, and terminal size. Unlike {@link ThemeRuntime} the
 * runtime applies its selection itself: the CSS custom properties it writes
 * are typography facts owned by this feature, not theme tokens routed
 * through ui-layout's presenter. Durable state lives in the same `ui-theme`
 * settings namespace as the theme preference.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  CHAT_SIZE_RANGE, CHAT_ZOOM_BASE, DEFAULT_CHAT_SIZE, DEFAULT_MONO_FONT,
  DEFAULT_MONO_SIZE, DEFAULT_TERM_SIZE, DEFAULT_UI_FAMILY, DEFAULT_UI_SIZE,
  MONO_SIZE_RANGE, TERM_SIZE_RANGE, UI_SIZE_RANGE, UI_ZOOM_BASE,
  isMonoFont, monoFontStack, uiFamilyStack, type ThemeSettings,
} from '../theme-settings.ts'

/** Full font selection applied as document-root custom properties. */
export interface FontSelection {
  /** UI family name, or 'system' (`--dsw-font-family`). */
  uiFamily: string
  /** Interface base text size in px, 12–20 (drives `--dsh-zoom-ui`). */
  uiSize: number
  /** Chat-pane base text size in px, 12–22 (drives `--dsh-zoom-chat`). */
  chatSize: number
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
  uiFamily: DEFAULT_UI_FAMILY, uiSize: DEFAULT_UI_SIZE, chatSize: DEFAULT_CHAT_SIZE,
  monoFont: DEFAULT_MONO_FONT, monoSize: DEFAULT_MONO_SIZE, termSize: DEFAULT_TERM_SIZE,
})

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
  root.setProperty('--dsw-font-family', uiFamilyStack(selection.uiFamily))
  // Zoom is the implementation of the px sizes: each section's zoom is its
  // size over the section's shipped base; the chat pane consumes the
  // chat/ui ratio so zoom multiplies back out to the requested chat size.
  const uiZoom = selection.uiSize / UI_ZOOM_BASE
  root.setProperty('--dsh-zoom-ui', String(uiZoom))
  root.setProperty('--dsh-zoom-chat', String(selection.chatSize / CHAT_ZOOM_BASE / uiZoom))
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
  private readonly host: ConfigForm<ThemeSettings>
  private selection: FontSelection
  private revision = 0
  private snapshot: FontSnapshot

  /**
   * @param ctx - owning context (`font/change` emits on it; the scope
   * listener is released through ctx.effect on dispose).
   * @param host - durable settings scope shared with ThemeRuntime.
   */
  constructor(ctx: Context, host: ConfigForm<ThemeSettings>) {
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

  /** Switch the UI family; any non-empty family name is accepted. */
  setUiFamily(family: string): void { this.writeId('uiFamily', family) }

  /** Switch the interface base size in px; non-integer or out-of-range throws. */
  setUiSize(size: number): void {
    if (!Number.isInteger(size) || size < UI_SIZE_RANGE.min || size > UI_SIZE_RANGE.max) {
      throw new Error(`ui size ${size} outside [${UI_SIZE_RANGE.min}, ${UI_SIZE_RANGE.max}]`)
    }
    this.writeNumber('uiSize', size)
  }

  /** Switch the chat base size in px; non-integer or out-of-range throws. */
  setChatSize(size: number): void {
    if (!Number.isInteger(size) || size < CHAT_SIZE_RANGE.min || size > CHAT_SIZE_RANGE.max) {
      throw new Error(`chat size ${size} outside [${CHAT_SIZE_RANGE.min}, ${CHAT_SIZE_RANGE.max}]`)
    }
    this.writeNumber('chatSize', size)
  }

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
      uiFamily: section.uiFamily, uiSize: section.uiSize, chatSize: section.chatSize,
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

  private writeNumber(field: 'uiSize' | 'chatSize' | 'monoSize' | 'termSize', value: number): void {
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
  return left.uiFamily === right.uiFamily && left.uiSize === right.uiSize
    && left.chatSize === right.chatSize && left.monoFont === right.monoFont
    && left.monoSize === right.monoSize && left.termSize === right.termSize
}
