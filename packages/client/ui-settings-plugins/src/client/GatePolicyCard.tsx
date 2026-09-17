/**
 * The gate-policy card: the todo-plan gate toggle and the tools it gates
 * while no plan exists. The Host guard reads the section live, so a save
 * applies on the next tool call.
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { GatePolicyCardFace } from './gate-policy-card-controller.ts'
import type {} from './slot-contract.ts'

/** Props the renderer binds for the gate-policy card. */
export type GatePolicyCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<GatePolicyCardFace>

/**
 * Render the gate-policy card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function GatePolicyCard(props: GatePolicyCardProps) {
  const { t } = props
  const state = props.useGatePolicyCard(snapshot => snapshot)
  const disabled = !state.writable
  return (
    <PluginCard
      t={t}
      titleKey="gatePolicyTitle"
      descriptionKey="gatePolicyDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <ValueField
        id="plugin-config-gate-policy-enabled"
        label={t('gatePolicyEnabled')}
        hint={t('gatePolicyEnabledHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        disabled={disabled}
        {...state.enabled}
        onEdit={(text) => { props.edit('enabled', text) }}
        onReset={() => { props.resetField('enabled') }}
      />
      <ValueField
        id="plugin-config-gate-policy-tools"
        label={t('gatePolicyTools')}
        hint={t('gatePolicyToolsHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        disabled={disabled}
        {...state.tools}
        onEdit={(text) => { props.edit('tools', text) }}
        onReset={() => { props.resetField('tools') }}
      />
    </PluginCard>
  )
}
