/**
 * The gate-policy card: the todo-plan gate toggle and the gated-tools chip
 * cloud with an add-tool dropdown. Writes stage through the shared CardForm
 * (the section stores `enabled` as 'true'/'false' and `tools` as an array),
 * and the Host guard reads the section live, so a save applies on the next
 * tool call.
 */

import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { PluginCard } from './PluginCard.tsx'
import type { GatePolicyCardFace } from './gate-policy-card-controller.ts'
import type {} from './slot-contract.ts'
import css from './GatePolicyCard.module.css'

/** Props the renderer binds for the gate-policy card. */
export type GatePolicyCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<GatePolicyCardFace>

/** Curated candidates for the add-tool dropdown; custom names stay addable. */
const TOOL_CANDIDATES = [
  'bash', 'read', 'edit', 'write', 'multiedit', 'glob', 'grep',
  'web_search', 'web_fetch', 'todo_write', 'skill', 'subagent',
] as const

/**
 * Render the gate-policy card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function GatePolicyCard(props: GatePolicyCardProps) {
  const { t } = props
  const state = props.useGatePolicyCard(snapshot => snapshot)
  const disabled = !state.writable
  // The staged field state carries the effective text ('true'/'false', the
  // comma-joined tools) — the single source the toggle and chips render from.
  const [draft, setDraft] = useState<{ enabled?: string; tools?: string[] }>({})

  const enabledText = draft.enabled ?? state.enabled.text
  const enabledOn = enabledText === 'true'
  const toolsList = draft.tools ?? state.tools.text.split(',').map(entry => entry.trim()).filter(Boolean)

  const setEnabled = (next: boolean): void => {
    const text = next ? 'true' : 'false'
    setDraft(current => ({ ...current, enabled: text }))
    props.edit('enabled', text)
  }

  const setTools = (next: string[]): void => {
    const joined = next.join(', ')
    setDraft(current => ({ ...current, tools: next }))
    props.edit('tools', joined)
  }

  const available = TOOL_CANDIDATES.filter(candidate => !toolsList.includes(candidate))

  return (
    <PluginCard
      t={t}
      titleKey="gatePolicyTitle"
      descriptionKey="gatePolicyDescription"
      state={state}
      onSave={props.save}
      onDiscard={() => { setDraft({}); props.discard() }}
    >
      <div className={css.switchRow}>
        <span className={css.switchLabel}>
          <span className={css.switchLabelStrong}>{t('gatePolicyEnabled')}</span>
          <span className={css.switchLabelHint}>{t('gatePolicyEnabledHint')}</span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={enabledOn}
          aria-label={t('gatePolicyEnabled')}
          disabled={disabled}
          className={css.switch}
          onClick={() => { setEnabled(!enabledOn) }}
        >
          <span className={css.switchKnob} />
        </button>
      </div>
      <div className={css.chipRow}>
        {toolsList.map(tool => (
          <span key={tool} className={css.chip}>
            {tool}
            <button
              type="button"
              className={css.chipRemove}
              aria-label={`remove ${tool}`}
              disabled={disabled}
              onClick={() => { setTools(toolsList.filter(entry => entry !== tool)) }}
            >
              ×
            </button>
          </span>
        ))}
        {toolsList.length === 0 && <span className={css.switchLabelHint}>{t('gatePolicyToolsEmpty')}</span>}
      </div>
      <div className={css.addRow}>
        <select
          className={css.addSelect}
          aria-label={t('gatePolicyAddTool')}
          value=""
          disabled={disabled}
          onChange={(event) => {
            const picked = event.target.value
            if (picked !== '') setTools([...toolsList, picked])
            event.target.value = ''
          }}
        >
          <option value="">{t('gatePolicyAddTool')}</option>
          {available.map(candidate => (
            <option key={candidate} value={candidate}>{candidate}</option>
          ))}
        </select>
      </div>
    </PluginCard>
  )
}
