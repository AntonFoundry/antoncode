import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SelectField, ValueField } from './fields.tsx'
import { useEffect, useState } from 'react'
import { PluginCard } from './PluginCard.tsx'
import modeCss from './C0ntextCard.module.css'
import type { C0ntextCardFace } from './c0ntext-card-controller.ts'
import type {} from './slot-contract.ts'

export type C0ntextCardProps = PropsRuntime<'settings.plugin.item'> & PropsLocale<'settings.plugins'> & InjectFace<C0ntextCardFace>

export function C0ntextCard(props: C0ntextCardProps) {
  const state = props.useC0ntextCard(snapshot => snapshot)
  const { t } = props
  const [dreamRoutes, setDreamRoutes] = useState<readonly { id: string; label: string }[]>([])
  useEffect(() => {
    void props.dreamCatalog().then(setDreamRoutes).catch(() => setDreamRoutes([]))
  }, [props.dreamCatalog])
  const isLocal = state.dreamProvider.text === 'local'
  const [localModels, setLocalModels] = useState<readonly { id: string; label: string }[]>([])
  useEffect(() => {
    if (!isLocal) return
    let cancelled = false
    fetch('http://127.0.0.1:8090/dream/local-models')
      .then(response => response.json())
      .then((payload) => {
        if (cancelled) return
        const models = Array.isArray(payload.models) ? payload.models : []
        // Embedding models cannot hold a conversation — dreaming needs chat.
        const chatModels = models.filter((id: string) => !/embed/i.test(id))
        setLocalModels(chatModels.map((id: string) => ({ id, label: id })))
      })
      .catch(() => { if (!cancelled) setLocalModels([]) })
    return () => { cancelled = true }
  }, [isLocal])
  const tierOptions = [
    { id: 'auto', label: 'Auto — free route first, then current model' },
    { id: 'local', label: 'Local — LM Studio / on-device (private)' },
    { id: 'current', label: 'Current chat model' },
  ]
  return <PluginCard t={t} titleKey="contextTitle" descriptionKey="contextDescription" state={state} onSave={props.save} onDiscard={props.discard}>
    <ValueField id="plugin-config-context-endpoint" label={t('contextEndpoint')} hint={t('contextEndpointHint')} overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('invalidNumber')} disabled={!state.writable} {...state.endpoint} onEdit={text => props.edit('endpoint', text)} onReset={() => props.resetField('endpoint')} />
    <ValueField id="plugin-config-context-api-key" label={t('contextApiKey')} hint={t('contextApiKeyHint')} overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('invalidNumber')} disabled={!state.writable} placeholder="ctx_…" {...state.apiKey} onEdit={text => props.edit('apiKey', text)} onReset={() => props.resetField('apiKey')} />
    <ValueField id="plugin-config-context-project" label={t('contextProjectId')} hint={t('contextProjectIdHint')} overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('invalidNumber')} disabled={!state.writable} {...state.projectId} onEdit={text => props.edit('projectId', text)} onReset={() => props.resetField('projectId')} />
    <ValueField id="plugin-config-context-ratio" label={t('contextMaxSurfaceRatio')} hint={t('contextMaxSurfaceRatioHint')} overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('invalidNumber')} numeric disabled={!state.writable} {...state.maxSurfaceRatio} onEdit={text => props.edit('maxSurfaceRatio', text)} onReset={() => props.resetField('maxSurfaceRatio')} />
    <ValueField id="plugin-config-context-window" label={t('contextWindowTokens')} hint={t('contextWindowTokensHint')} overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('invalidNumber')} numeric disabled={!state.writable} {...state.windowTokens} onEdit={text => props.edit('windowTokens', text)} onReset={() => props.resetField('windowTokens')} />
    <ValueField id="plugin-config-context-evictor" label={t('contextEvictorEnabled')} hint={t('contextEvictorEnabledHint')} overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('invalidNumber')} disabled={!state.writable} {...state.evictorEnabled} onEdit={text => props.edit('evictorEnabled', text)} onReset={() => props.resetField('evictorEnabled')} />
    <div className={modeCss.field}>
      <div className={modeCss.head}>
        <span className={modeCss.label} id="plugin-config-context-retrieval-mode-label">{t('contextRetrievalMode')}</span>
        {state.retrieveMode.overridden ? (
          <span className={modeCss.badges}>
            <span className={modeCss.badge}>{t('overridden')}</span>
            <button className={modeCss.reset} type="button" disabled={!state.writable} onClick={() => props.resetField('retrieveMode')}>{t('reset')}</button>
          </span>
        ) : null}
      </div>
      <div className={modeCss.choices} role="group" aria-labelledby="plugin-config-context-retrieval-mode-label">
        {(['fast', 'full'] as const).map(mode => (
          <button
            key={mode}
            className={modeCss.choice}
            type="button"
            aria-pressed={(state.retrieveMode.text || 'fast') === mode}
            disabled={!state.writable}
            onClick={() => { props.edit('retrieveMode', mode) }}
          >
            {mode === 'fast' ? 'Fast' : 'Full'}
          </button>
        ))}
      </div>
      <p className={modeCss.hint}>{t('contextRetrievalModeHint')}</p>
    </div>
    <SelectField id="plugin-config-context-dream-provider" label="Dream model" hint="Who processes offline dream cycles: the tiers, or any configured provider/model route from this deployment." overriddenLabel={t('overridden')} resetLabel={t('reset')} disabled={!state.writable} invalid={false} invalidLabel={t('invalidNumber')} value={state.dreamProvider.text} overridden={state.dreamProvider.overridden} options={[...tierOptions, ...dreamRoutes]} onEdit={text => props.edit('dreamProvider', text)} onReset={() => props.resetField('dreamProvider')} />
    {isLocal && localModels.length > 0 ? (
      <SelectField id="plugin-config-context-dream-model" label="Local dream model" hint="Models currently served by your on-device endpoint (LM Studio / Ollama)." overriddenLabel={t('overridden')} resetLabel={t('reset')} disabled={!state.writable} invalid={false} invalidLabel={t('invalidNumber')} value={state.dreamModel.text} overridden={state.dreamModel.overridden} options={localModels} onEdit={text => props.edit('dreamModel', text)} onReset={() => props.resetField('dreamModel')} />
    ) : isLocal ? (
      <ValueField id="plugin-config-context-dream-model" label="Local dream model id" hint="Model id loaded in your local endpoint (LM Studio / Ollama). Shown as a list once the endpoint answers." overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('invalidNumber')} disabled={!state.writable} {...state.dreamModel} onEdit={text => props.edit('dreamModel', text)} onReset={() => props.resetField('dreamModel')} />
    ) : null}
    <ValueField id="plugin-config-context-dream-idle" label="Dream idle threshold (hours)" hint="Harness idle time before the engine may dream on its own. Synced to the engine on the next dream run." overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('invalidNumber')} numeric disabled={!state.writable} {...state.dreamIdleHours} onEdit={text => props.edit('dreamIdleHours', text)} onReset={() => props.resetField('dreamIdleHours')} />
    <ValueField id="plugin-config-context-memory-override" label={t('contextMemoryOverride')} hint={t('contextMemoryOverrideHint')} overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('invalidNumber')} multiline rows={7} disabled={!state.writable} {...state.memoryContractOverride} onEdit={text => props.edit('memoryContractOverride', text)} onReset={() => props.resetField('memoryContractOverride')} />
    <ValueField id="plugin-config-context-paging-override" label={t('contextPagingOverride')} hint={t('contextPagingOverrideHint')} overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('invalidNumber')} multiline rows={5} disabled={!state.writable} {...state.pagingReminderOverride} onEdit={text => props.edit('pagingReminderOverride', text)} onReset={() => props.resetField('pagingReminderOverride')} />
    <ValueField id="plugin-config-context-codemap-override" label={t('contextCodeMapOverride')} hint={t('contextCodeMapOverrideHint')} overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('invalidNumber')} multiline rows={5} disabled={!state.writable} {...state.codeMapGuidanceOverride} onEdit={text => props.edit('codeMapGuidanceOverride', text)} onReset={() => props.resetField('codeMapGuidanceOverride')} />
  </PluginCard>
}
