/** Delegation-limit fields inside the shared Subagent settings card. */

import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SubagentLimitsCardFace, SubagentLimitsCardState } from './subagent-limits-card-controller.ts'
import css from './SubagentLimitsFields.module.css'

/** Plain state and edit callbacks supplied by the owning card. */
export type SubagentLimitsFieldsProps = PropsLocale<'settings.subagent'>
  & Pick<SubagentLimitsCardFace, 'edit' | 'resetField'>
  & { state: SubagentLimitsCardState }

function sliderValue(text: string, minimum: number): number {
  const value = Number(text)
  return Number.isSafeInteger(value) && value >= minimum ? value : minimum
}

/**
 * Render the depth and capacity fields with their original validation and reset behavior.
 * @param props - Locale, staged fields, and edit callbacks.
 * @returns Two responsive fields and their application rules.
 */
export function SubagentLimitsFields(props: SubagentLimitsFieldsProps) {
  const { t, state } = props
  return (
    <>
      <div className={css.limits}>
        <div className={css.limit}>
          <SettingsValueField id="plugin-config-subagent-depth" label={t('subagentMaxDepth')}
            help={{ label: t('subagentDepthHelpLabel'), content: (
              <>
                <p>{t('subagentDepthHelp')}</p>
                <table className={css.depthTable} aria-label={t('subagentDepthHelpLabel')}>
                  <tbody>
                    <tr>
                      <th scope="row">{0}</th>
                      <td>{t('subagentDepthZero')}</td>
                    </tr>
                    <tr>
                      <th scope="row">{1}</th>
                      <td>{t('subagentDepthOne')}</td>
                    </tr>
                  </tbody>
                </table>
                <p>{t('subagentDepthOverride')}</p>
              </>
            ) }} overriddenLabel={t('overridden')}
            resetLabel={t('reset')} invalidLabel={t('subagentDepthInvalid')}
            numeric disabled={!state.writable || state.saving} {...state.maxDepth}
            onEdit={(text) => { props.edit('maxDepth', text) }} onReset={() => { props.resetField('maxDepth') }} />
          <input className={css.slider} type="range" min={0}
            max={Math.max(10, sliderValue(state.maxDepth.text, 0))} step={1}
            value={sliderValue(state.maxDepth.text, 0)}
            aria-label={t('subagentMaxDepth')}
            disabled={!state.writable || state.saving}
            onChange={(event) => { props.edit('maxDepth', event.currentTarget.value) }} />
        </div>
        <div className={css.limit}>
          <SettingsValueField id="plugin-config-subagent-capacity" label={t('subagentMaxActive')}
            help={{ label: t('subagentCapacityHelpLabel'), content: <p>{t('subagentCapacityHelp')}</p> }} overriddenLabel={t('overridden')}
            resetLabel={t('reset')} invalidLabel={t('subagentCapacityInvalid')}
            numeric disabled={!state.writable || state.saving} {...state.maxActiveSubagents}
            onEdit={(text) => { props.edit('maxActiveSubagents', text) }} onReset={() => { props.resetField('maxActiveSubagents') }} />
          <input className={css.slider} type="range" min={1}
            max={Math.max(32, sliderValue(state.maxActiveSubagents.text, 1))} step={1}
            value={sliderValue(state.maxActiveSubagents.text, 1)}
            aria-label={t('subagentMaxActive')}
            disabled={!state.writable || state.saving}
            onChange={(event) => { props.edit('maxActiveSubagents', event.currentTarget.value) }} />
        </div>
      </div>
    </>
  )
}
