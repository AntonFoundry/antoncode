import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { C0ntextCardFace } from './c0ntext-card-controller.ts'
import type {} from './slot-contract.ts'

export type C0ntextCardProps = PropsRuntime<'settings.plugin.item'> & PropsLocale<'settings.plugins'> & InjectFace<C0ntextCardFace>

export function C0ntextCard(props: C0ntextCardProps) {
  const state = props.useC0ntextCard(snapshot => snapshot)
  const { t } = props
  return <PluginCard t={t} titleKey="contextTitle" descriptionKey="contextDescription" state={state} onSave={props.save} onDiscard={props.discard}>
    <ValueField id="plugin-config-context-endpoint" label={t('contextEndpoint')} hint={t('contextEndpointHint')} overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('invalidNumber')} disabled={!state.writable} {...state.endpoint} onEdit={text => props.edit('endpoint', text)} onReset={() => props.resetField('endpoint')} />
    <ValueField id="plugin-config-context-api-key" label={t('contextApiKey')} hint={t('contextApiKeyHint')} overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('invalidNumber')} disabled={!state.writable} placeholder="ctx_…" {...state.apiKey} onEdit={text => props.edit('apiKey', text)} onReset={() => props.resetField('apiKey')} />
    <ValueField id="plugin-config-context-project" label={t('contextProjectId')} hint={t('contextProjectIdHint')} overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('invalidNumber')} disabled={!state.writable} {...state.projectId} onEdit={text => props.edit('projectId', text)} onReset={() => props.resetField('projectId')} />
    <ValueField id="plugin-config-context-ratio" label={t('contextMaxSurfaceRatio')} hint={t('contextMaxSurfaceRatioHint')} overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('invalidNumber')} numeric disabled={!state.writable} {...state.maxSurfaceRatio} onEdit={text => props.edit('maxSurfaceRatio', text)} onReset={() => props.resetField('maxSurfaceRatio')} />
    <ValueField id="plugin-config-context-window" label={t('contextWindowTokens')} hint={t('contextWindowTokensHint')} overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('invalidNumber')} numeric disabled={!state.writable} {...state.windowTokens} onEdit={text => props.edit('windowTokens', text)} onReset={() => props.resetField('windowTokens')} />
    <ValueField id="plugin-config-context-evictor" label={t('contextEvictorEnabled')} hint={t('contextEvictorEnabledHint')} overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('invalidNumber')} disabled={!state.writable} {...state.evictorEnabled} onEdit={text => props.edit('evictorEnabled', text)} onReset={() => props.resetField('evictorEnabled')} />
  </PluginCard>
}
