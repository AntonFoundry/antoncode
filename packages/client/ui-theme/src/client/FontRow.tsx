/**
 * Font preference row registered into the General section item slot: title +
 * monospace family menu + size stepper. Registered by this package — the
 * theme feature owns its settings surface. Selection follows the persisted
 * preference and applies live through the font service.
 */
import { useState } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { MONO_FONTS, MONO_SIZE_RANGE, monoFontStack } from '../theme-settings.ts'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { createFontRowStore } from './font-store.ts'
import css from './FontRow.module.css'

/** Injected business face: the preference writes (t rides the standard locale seat). */
export interface FontRowInjected {
  /** Switch the monospace family (a curated id). */
  setMonoFont: (id: string) => void
  /** Switch the monospace size (px inside the accepted range). */
  setMonoSize: (size: number) => void
}

/** Full component props: runtime share + store share + locale seat + injected face. */
export type FontRowComponentProps =
  PropsRuntime<'settings.general.item'> & PropsStore<ReturnType<typeof createFontRowStore>>
  & PropsLocale<'settings.theme'> & FontRowInjected

/**
 * Render the Font row.
 * @param props - composed slot props.
 * @returns the row element tree.
 */
export function FontRow({ t, setMonoFont, setMonoSize, useStore }: FontRowComponentProps) {
  const monoFont = useStore(s => s.monoFont)
  const monoSize = useStore(s => s.monoSize)
  const [open, setOpen] = useState(false)
  const activeLabel = MONO_FONTS.find(font => font.id === monoFont)?.label ?? monoFont

  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('font.title')}</div>
        <div className={css.preview} style={{ fontFamily: monoFontStack(monoFont), fontSize: `${monoSize}px` }}>
          {'fn main() { println!("ok") }'}
        </div>
      </div>
      <div className={css.controls}>
        <Menu
          open={open}
          onClose={() => { setOpen(false) }}
          items={MONO_FONTS.map(font => ({
            id: font.id,
            label: <span style={{ fontFamily: font.stack }}>{font.label}</span>,
          }))}
          selectedId={monoFont}
          onSelect={(id) => {
            setMonoFont(id)
            setOpen(false)
          }}
          align="end"
          portal
          anchor={(
            <button
              type="button"
              className={css.selector}
              style={{ fontFamily: monoFontStack(monoFont) }}
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={() => { setOpen(v => !v) }}
            >
              {activeLabel}
              <IconChevronDownOutline14 className={css.chevron} />
            </button>
          )}
        />
        <div className={css.stepper} role="group" aria-label={t('font.size')}>
          <button
            type="button"
            className={css.stepButton}
            disabled={monoSize <= MONO_SIZE_RANGE.min}
            onClick={() => { setMonoSize(monoSize - 1) }}
          >
            −
          </button>
          <span className={css.sizeValue}>{monoSize}</span>
          <button
            type="button"
            className={css.stepButton}
            disabled={monoSize >= MONO_SIZE_RANGE.max}
            onClick={() => { setMonoSize(monoSize + 1) }}
          >
            +
          </button>
        </div>
      </div>
    </div>
  )
}
