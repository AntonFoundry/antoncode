/**
 * The subagent-model card: the swarm default — which model delegated
 * children run when a delegation does not name its own. One route, chosen
 * from the deployment's catalog; blank inherits the parent session's model.
 */

import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SelectField, ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { SubagentModelCardFace, SubagentModelOption } from './subagent-model-card-controller.ts'
import type {} from './slot-contract.ts'

/** Props the renderer binds for the subagent-model card. */
export type SubagentModelCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<SubagentModelCardFace>

/** Select value for the custom-route branch of the dropdown. */
const CUSTOM = '__custom'

/** The inherit choice: no section override; children use the parent's model. */
const INHERIT = ''

/**
 * Render the subagent-model card.
 * @param props - locale copy, the card snapshot, its form actions, and the
 *   catalog loader.
 * @returns the card.
 */
export function SubagentModelCard(props: SubagentModelCardProps) {
  const { t } = props
  const state = props.useSubagentModelCard(snapshot => snapshot)
  const disabled = !state.writable

  // The catalog loads once per mount; a deployment whose providers change is
  // covered by reopening settings, which remounts the card.
  const [options, setOptions] = useState<readonly SubagentModelOption[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let live = true
    props.modelOptions()
      .then((routes) => { if (live) setOptions(routes) })
      .catch(() => { if (live) setOptions([]) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
    // The loader is a stable apply-closure callback; it is not a subscription.
  }, [props.modelOptions])

  // The custom-route branch shows whenever the staged value is not a catalog
  // row — so a typed route stays editable and a stale catalog row stays honest.
  const known = options.some(option => option.id === state.defaultModel.text)
  const [forceCustom, setForceCustom] = useState(false)
  const showCustom = forceCustom || (state.defaultModel.text !== '' && !known)

  const fieldProps = {
    id: 'plugin-config-subagent-model-default',
    label: t('subagentModelDefault'),
    overridden: state.defaultModel.overridden,
    overriddenLabel: t('overridden'),
    resetLabel: t('reset'),
    invalid: state.defaultModel.invalid,
    invalidLabel: t('invalidNumber'),
    disabled,
    onReset: () => {
      setForceCustom(false)
      props.edit('defaultModel', INHERIT)
    },
  }

  return (
    <PluginCard
      t={t}
      titleKey="subagentModelTitle"
      descriptionKey="subagentModelDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      {showCustom
        ? (
          <ValueField
            {...fieldProps}
            hint={t('subagentModelDefaultHint')}
            text={state.defaultModel.text}
            onEdit={(text) => { props.edit('defaultModel', text) }}
          />
        )
        : (
          <SelectField
            {...fieldProps}
            hint={loading ? t('subagentModelLoading') : t('subagentModelDefaultHint')}
            value={state.defaultModel.text}
            options={[
              { id: INHERIT, label: t('subagentModelInherit') },
              ...options,
              { id: CUSTOM, label: t('subagentModelCustom') },
            ]}
            onEdit={(value) => {
              if (value === CUSTOM) { setForceCustom(true); return }
              props.edit('defaultModel', value)
            }}
          />
        )}
    </PluginCard>
  )
}
