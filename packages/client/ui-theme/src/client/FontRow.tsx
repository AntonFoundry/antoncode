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
  CHAT_SIZE_RANGE, MONO_FONTS, MONO_SIZE_RANGE, TERM_SIZE_RANGE, UI_SIZE_RANGE,
  SYSTEM_UI_STACK, monoFontStack, uiFamilyStack,
} from '../theme-settings.ts'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { createFontRowStore } from './font-store.ts'
import css from './FontRow.module.css'

/** Injected business face: the preference writes (t rides the standard locale seat). */
export interface FontRowInjected {
  /** Installed system font families for the interface menu. */
  uiFonts: readonly string[]
  /** Switch the UI family (any installed family name, or 'system'). */
  setUiFamily: (family: string) => void
  /** Switch the interface base size in px. */
  setUiSize: (size: number) => void
  /** Switch the chat base size in px. */
  setChatSize: (size: number) => void
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
  onStep: (next: number) => void
}

/** One labeled stepper (− value +) clamped to its range. Values are px. */
function Stepper({ label, value, min, max, onStep }: StepperProps) {
  return (
    <div className={css.stepper} role="group" aria-label={label}>
      <button
        type="button" className={css.stepButton} disabled={value <= min}
        onClick={() => { onStep(value - 1) }}
      >
        −
      </button>
      <span className={css.sizeValue}>{`${value}px`}</span>
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
  /** Menu label shown when the selected value has no curated option row. */
  selectedLabel: string
  /** Optional filter input shown above the list (for long system menus). */
  filterable?: boolean
  onSelect: (id: string) => void
}

/** Family pill opening a menu whose rows preview in their own family. */
function FamilyMenu({ options, selected, selectedLabel, filterable = false, onSelect }: FamilyMenuProps) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const active = options.find(font => font.id === selected)
  const needle = filter.trim().toLowerCase()
  const visible = needle === ''
    ? options
    : options.filter(font => font.label.toLowerCase().includes(needle))
  return (
    <Menu
      open={open}
      onClose={() => {
        setOpen(false)
        setFilter('')
      }}
      items={visible.map(font => ({
        id: font.id,
        label: <span style={{ fontFamily: font.stack }}>{font.label}</span>,
      }))}
      {...(filterable
        ? {
          header: (
            <input
              className={css.filter}
              placeholder={tFilter}
              value={filter}
              onChange={(e) => { setFilter(e.target.value) }}
              onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false) }}
            />
          ),
        }
        : {})}
      selectedId={selected}
      onSelect={(id) => {
        onSelect(id)
        setOpen(false)
        setFilter('')
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
          {active?.label ?? selectedLabel}
          <IconChevronDownOutline14 className={css.chevron} />
        </button>
      )}
    />
  )
}

/** Filter placeholder is a fixed product string (the row owns no seat for it). */
const tFilter = 'Filter…'

/**
 * Render the Font panel.
 * @param props - composed slot props.
 * @returns the panel element tree.
 */
export function FontRow({
  t, uiFonts, setUiFamily, setUiSize, setChatSize, setMonoFont, setMonoSize, setTermSize, useStore,
}: FontRowComponentProps) {
  const uiFamily = useStore(s => s.uiFamily)
  const uiSize = useStore(s => s.uiSize)
  const chatSize = useStore(s => s.chatSize)
  const monoFont = useStore(s => s.monoFont)
  const monoSize = useStore(s => s.monoSize)
  const termSize = useStore(s => s.termSize)
  const uiOptions = [
    { id: 'system', label: t('font.system'), stack: SYSTEM_UI_STACK },
    ...uiFonts.map(family => ({ id: family, label: family, stack: uiFamilyStack(family) })),
  ]

  return (
    <div className={css.panel}>
      <div className={css.title}>{t('font.title')}</div>

      <div className={css.section}>
        <div className={css.sectionText}>
          <div className={css.sectionLabel}>{t('font.interface')}</div>
          <div className={css.preview} style={{ fontFamily: uiFamilyStack(uiFamily) }}>
            {t('font.previewUi')}
          </div>
        </div>
        <div className={css.controls}>
          <FamilyMenu
            options={uiOptions} selected={uiFamily}
            selectedLabel={uiFamily} filterable
            onSelect={setUiFamily}
          />
          <Stepper
            label={t('font.size')} value={uiSize}
            min={UI_SIZE_RANGE.min} max={UI_SIZE_RANGE.max} onStep={setUiSize}
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
            label={t('font.size')} value={chatSize}
            min={CHAT_SIZE_RANGE.min} max={CHAT_SIZE_RANGE.max} onStep={setChatSize}
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
          <FamilyMenu
            options={MONO_FONTS} selected={monoFont} selectedLabel={monoFont}
            onSelect={setMonoFont}
          />
          <Stepper
            label={t('font.size')} value={monoSize}
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
            label={t('font.size')} value={termSize}
            min={TERM_SIZE_RANGE.min} max={TERM_SIZE_RANGE.max} onStep={setTermSize}
          />
        </div>
      </div>
    </div>
  )
}
