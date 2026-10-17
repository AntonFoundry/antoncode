/**
 * The delegation-depth card: a slider over the recursion cap a subagent may
 * delegate through. A plain presentational sub-component rendered inline by
 * `AgentPresetSection` — not its own slot entry — so it receives the state
 * and actions its owner threads down, like the section's copy dialog.
 * Renders nothing while the namespace is unavailable — a `'provider-managed'`
 * cap, or no `tool-subagent` plugin at all, leaves nothing for this control
 * to act on.
 */

import type { DelegationDepthState } from './delegation-depth-controller.ts'
import type { AgentPresetSettingsKey } from './locales.ts'
import css from './DelegationDepthCard.module.css'

/** Props the owner (`AgentPresetSection`) threads into this card. */
export interface DelegationDepthCardProps {
  /** Active Web locale lookup. */
  t: (key: AgentPresetSettingsKey, params?: Record<string, string | number>) => string
  /** The card's current snapshot. */
  state: DelegationDepthState
  /** The slider's maximum, widened past the fallback ceiling by the deployment default. */
  max: number
  /** Stage a new draft value; writes nothing until {@link save}. */
  stage: (value: number) => void
  /** Write the staged draft as the stored override. */
  save: () => void
  /** Drop a staged draft without writing anything. */
  discard: () => void
  /** Clear the staged draft and the stored override, reverting to the deployment default. */
  reset: () => void
}

/**
 * Render the delegation-depth card, or nothing when unavailable.
 * @param props - locale copy, the card's snapshot, and its actions.
 * @returns the card, or null.
 */
export function DelegationDepthCard({ t, state, max, stage, save, discard, reset }: DelegationDepthCardProps) {
  if (!state.available) return null
  const disabled = !state.writable || state.saving

  return (
    <div className={css.card}>
      <div className={css.head}>
        <div className={css.headText}>
          <span className={css.name}>{t('depthTitle')}</span>
          <span className={css.description}>{t('depthDescription')}</span>
        </div>
        {state.overridden
          ? (
            <span className={css.badges}>
              <span className={css.badge}>{t('depthOverridden')}</span>
              <button type="button" className={css.reset} disabled={disabled} onClick={reset}>
                {t('depthReset')}
              </button>
            </span>
          )
          : null}
      </div>
      <label className={css.field} htmlFor="agent-preset-delegation-depth">
        <span className={css.fieldLabel}>{t('depthLabel')}</span>
        <div className={css.sliderRow}>
          <input
            id="agent-preset-delegation-depth"
            type="range"
            className={css.slider}
            min={0}
            max={max}
            step={1}
            value={state.value}
            disabled={disabled}
            onChange={(event) => { stage(Number(event.target.value)) }}
          />
          <span className={css.valueReadout}>{state.value}</span>
        </div>
        <p className={css.hint}>{t('depthHint')}</p>
        {state.deploymentDefault === undefined
          ? null
          : <p className={css.hint}>{t('depthDeploymentDefault', { value: state.deploymentDefault })}</p>}
      </label>
      <div className={css.footer}>
        {state.failed ? <p className={css.failed} role="status">{t('depthSaveFailed')}</p> : null}
        <button type="button" className={css.discard} disabled={!state.pendingEdit || state.saving} onClick={discard}>
          {t('depthDiscard')}
        </button>
        <button type="button" className={css.save} disabled={!state.pendingEdit || state.saving} onClick={save}>
          {t(state.saving ? 'depthSaving' : 'depthSave')}
        </button>
      </div>
    </div>
  )
}
