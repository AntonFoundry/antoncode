/**
 * Efficiency-discipline preference row registered into the General section
 * item slot: title + description left, plugin-list-style switch right.
 * Registered by this package — the feature owns its own settings surface.
 */
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { createEfficiencyRowStore } from './settings-store.ts'
import css from './EfficiencyRow.module.css'

/** Injected business face: the preference write. */
export interface EfficiencyRowInjected {
  /** Persist the new switch value. */
  setEnabled: (enabled: boolean) => void
}

/** Full component props: runtime share + store share + locale seat + injected face. */
export type EfficiencyRowComponentProps =
  PropsRuntime<'settings.general.item'> & PropsStore<ReturnType<typeof createEfficiencyRowStore>>
  & PropsLocale<'settings.efficiency'> & EfficiencyRowInjected

/**
 * Render the efficiency row.
 * @param props - composed slot props.
 * @returns the row element tree.
 */
export function EfficiencyRow({ t, setEnabled, useStore }: EfficiencyRowComponentProps) {
  const enabled = useStore(s => s.enabled)
  return (
    <div className={css.group}>
      <div className={css.copy}>
        <div className={css.title}>{t('efficiency.title')}</div>
        <div className={css.description}>{t('efficiency.description')}</div>
      </div>
      <button
        className={css.toggle}
        type="button"
        role="switch"
        aria-checked={enabled}
        data-checked={enabled ? 'true' : 'false'}
        aria-label={t('efficiency.title')}
        onClick={() => { setEnabled(!enabled) }}
      >
        <span className={css.toggleThumb} />
      </button>
    </div>
  )
}
