/**
 * Font preference panel registered into the General section item slot: four
 * labeled sections — Interface (UI family + zoom), Chat (zoom), Code (mono
 * family + size), Terminal (size) — each with a live preview. Registered by
 * this package — the theme feature owns its settings surface. Selection
 * follows the persisted preference and applies live through the font service.
 */
import { useState } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  MONO_FONTS, MONO_SIZE_RANGE, SCALE_RANGE, TERM_SIZE_RANGE, UI_FONTS,
  monoFontStack, uiFontStack,
} from '../theme-settings.ts'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { createFontRowStore } from './font-store.ts'
import css from './FontRow.module.css'

/** Injected business face: the preference writes (t rides the standard locale seat). */
export interface FontRowInjected {
  /** Switch the UI family (a curated id). */
  setUiFamily: (id: string) => void
  /** Switch the interface zoom percent. */
  setUiScale: (scale: number) => void
  /** Switch the chat zoom percent. */
  setChatScale: (scale: number) => void
  /** Switch the monospace family (a curated id). */
  setMonoFont: (id: string) => void
  /** Switch the monospace size (px inside the accepted range). */
  setMonoSize: (size: number) => void
  /** Switch the terminal size (px inside the accepted range). */
  setTermSize: (size: number) => void
}

/** Full component props: runtime share + store share + locale seat + injected face. */
export type FontRowComponentProps =
  PropsRuntime<'settings.general.item'> & PropsStore<ReturnType<typeof createFontRowStore>>
  & PropsLocale<'settings.theme'> & FontRowInjected

interface StepperProps {
  label: string
  value: number
  min: number
  max: number
  /** Value unit shown after the number (empty for percent, which shows %). */
  unit: '%' | ''
  onStep: (next: number) => void
}

/** One labeled stepper (− value +) clamped to its range. */
function Stepper({ label, value, min, max, unit, onStep }: StepperProps) {
  return (
    <div className={css.stepper} role="group" aria-label={label}>
      <button
        type="button" className={css.stepButton} disabled={value <= min}
        onClick={() => { onStep(value - 1) }}
      >
        −
      </button>
      <span className={css.sizeValue}>{`${value}${unit}`}</span>
      <button
        type="button" className={css.stepButton} disabled={value >= max}
        onClick={() => { onStep(value + 1) }}
      >
        +
      </button>
    </div>
  )
}

interface FamilyMenuProps {
  options: readonly { id: string; label: string; stack: string }[]
  selected: string
  onSelect: (id: string) => void
}

/** Family pill opening a menu whose rows preview in their own family. */
function FamilyMenu({ options, selected, onSelect }: FamilyMenuProps) {
  const [open, setOpen] = useState(false)
  const active = options.find(font => font.id === selected)
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={options.map(font => ({
        id: font.id,
        label: <span style={{ fontFamily: font.stack }}>{font.label}</span>,
      }))}
      selectedId={selected}
      onSelect={(id) => {
        onSelect(id)
        setOpen(false)
      }}
      align="end"
      portal
      anchor={(
        <button
          type="button" className={css.selector}
          style={{ fontFamily: active?.stack }}
          aria-haspopup="menu" aria-expanded={open}
          onClick={() => { setOpen(v => !v) }}
        >
          {active?.label ?? selected}
          <IconChevronDownOutline14 className={css.chevron} />
        </button>
      )}
    />
  )
}

/**
 * Render the Font panel.
 * @param props - composed slot props.
 * @returns the panel element tree.
 */
export function FontRow({
  t, setUiFamily, setUiScale, setChatScale, setMonoFont, setMonoSize, setTermSize, useStore,
}: FontRowComponentProps) {
  const uiFamily = useStore(s => s.uiFamily)
  const uiScale = useStore(s => s.uiScale)
  const chatScale = useStore(s => s.chatScale)
  const monoFont = useStore(s => s.monoFont)
  const monoSize = useStore(s => s.monoSize)
  const termSize = useStore(s => s.termSize)

  return (
    <div className={css.panel}>
      <div className={css.title}>{t('font.title')}</div>

      <div className={css.section}>
        <div className={css.sectionText}>
          <div className={css.sectionLabel}>{t('font.interface')}</div>
          <div className={css.preview} style={{ fontFamily: uiFontStack(uiFamily) }}>
            {t('font.previewUi')}
          </div>
        </div>
        <div className={css.controls}>
          <FamilyMenu options={UI_FONTS} selected={uiFamily} onSelect={setUiFamily} />
          <Stepper
            label={t('font.scale')} value={uiScale} unit="%"
            min={SCALE_RANGE.min} max={SCALE_RANGE.max} onStep={setUiScale}
          />
        </div>
      </div>

      <div className={css.section}>
        <div className={css.sectionText}>
          <div className={css.sectionLabel}>{t('font.chat')}</div>
          <div className={css.preview}>{t('font.previewChat')}</div>
        </div>
        <div className={css.controls}>
          <Stepper
            label={t('font.scale')} value={chatScale} unit="%"
            min={SCALE_RANGE.min} max={SCALE_RANGE.max} onStep={setChatScale}
          />
        </div>
      </div>

      <div className={css.section}>
        <div className={css.sectionText}>
          <div className={css.sectionLabel}>{t('font.code')}</div>
          <div
            className={css.preview}
            style={{ fontFamily: monoFontStack(monoFont), fontSize: `${monoSize}px` }}
          >
            {'fn main() { println!("ok") }'}
          </div>
        </div>
        <div className={css.controls}>
          <FamilyMenu options={MONO_FONTS} selected={monoFont} onSelect={setMonoFont} />
          <Stepper
            label={t('font.size')} value={monoSize} unit=""
            min={MONO_SIZE_RANGE.min} max={MONO_SIZE_RANGE.max} onStep={setMonoSize}
          />
        </div>
      </div>

      <div className={css.section}>
        <div className={css.sectionText}>
          <div className={css.sectionLabel}>{t('font.terminal')}</div>
          <div
            className={css.preview}
            style={{ fontFamily: monoFontStack(monoFont), fontSize: `${termSize}px` }}
          >
            {'$ cargo build --release'}
          </div>
        </div>
        <div className={css.controls}>
          <Stepper
            label={t('font.size')} value={termSize} unit=""
            min={TERM_SIZE_RANGE.min} max={TERM_SIZE_RANGE.max} onStep={setTermSize}
          />
        </div>
      </div>
    </div>
  )
}
