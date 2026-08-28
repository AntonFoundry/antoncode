import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import type { PluginInventorySnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconChevronDownOutline14,
  IconSearchOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PluginInventoryLocaleKey } from './locales.ts'
import css from './PluginInventorySettingsTab.module.css'

/** Registration-side Remote face used by the section. */
export interface PluginInventorySettingsTabInjected {
  /** Read a current Host inventory snapshot. */
  list: () => Promise<PluginInventorySnapshot>
  /** Toggle a plugin's enabled state. */
  toggle: (entryId: string, enabled: boolean) => Promise<void>
  /** Merge scalar config values into a plugin entry and reload it. */
  configure: (entryId: string, patch: Record<string, string | number | boolean | null>) => Promise<void>
}

type PluginInventoryEntry = PluginInventorySnapshot['entries'][number]
type PluginFiberPhase = PluginInventoryEntry['fiberPhase']

/** Full component props assembled by the Settings slot renderer. */
export type PluginInventorySettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginInventory'>
  & InjectFace<PluginInventorySettingsTabInjected>

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: PluginInventorySnapshot }

const PHASE_KEYS = {
  pending: 'pending',
  loading: 'loadingPhase',
  active: 'active',
  failed: 'failed',
  unloading: 'unloading',
} satisfies Record<Exclude<PluginFiberPhase, null>, PluginInventoryLocaleKey>

/** Localized accessible label for one root Fiber phase. */
function phaseLabel(
  phase: PluginFiberPhase,
  t: PluginInventorySettingsTabProps['t'],
): string {
  return phase === null ? t('unobserved') : t(PHASE_KEYS[phase])
}

/** Compact a module specifier without guessing whether its Loader id was generated. */
function moduleShortName(moduleName: string): string {
  const unscoped = moduleName.startsWith('@') ? moduleName.slice(moduleName.indexOf('/') + 1) : moduleName
  return unscoped
    .replace(/^cordis:/, '')
    .replace(/^cordis-plugin-/, '')
    .replace(/^dsh-(?:host-|client-)?/, '')
}

/** Whether an inventory row matches the local catalog query. */
function matches(entry: PluginInventoryEntry, normalizedQuery: string): boolean {
  if (normalizedQuery.length === 0) return true
  return [entry.moduleName, entry.entryId]
    .some(value => value.toLocaleLowerCase().includes(normalizedQuery))
}

/** Config keys the inventory details render as editable connection fields. */
const EDITABLE_CONFIG_FIELDS = ['endpoint', 'apiKey'] as const

type ConfigSaveState = 'idle' | 'saving' | 'saved' | 'error'

/** Render the read-only current Loader inventory. */
export function PluginInventorySettingsTab({ list, toggle, configure, t }: PluginInventorySettingsTabProps): ReactNode {
  const catalogId = useId()
  const [request, setRequest] = useState(0)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<PluginInventoryEntry['entryId'] | null>(null)
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [toggling, setToggling] = useState<Set<PluginInventoryEntry['entryId']>>(new Set())
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({})
  const [saveState, setSaveState] = useState<ConfigSaveState>('idle')

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => list()).then(
      (snapshot) => { if (current) setState({ status: 'ready', snapshot }) },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [list, request])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredEntries = useMemo(
    () => state.status === 'ready'
      ? state.snapshot.entries.filter(entry => matches(entry, normalizedQuery))
      : [],
    [normalizedQuery, state],
  )

  useEffect(() => {
    if (expanded !== null && !filteredEntries.some(entry => entry.entryId === expanded)) {
      setExpanded(null)
    }
  }, [expanded, filteredEntries])

  const retry = (): void => {
    setState({ status: 'loading' })
    setRequest(value => value + 1)
  }

  /** Editable config keys this entry exposes. */
  const editableKeys = (entry: PluginInventoryEntry): readonly string[] => {
    const config = entry.config
    return config === undefined ? [] : EDITABLE_CONFIG_FIELDS.filter(key => key in config)
  }

  /** Current editor value: the draft when touched, otherwise the live config. */
  const draftValue = (entry: PluginInventoryEntry, key: string): string => {
    const draft = drafts[entry.entryId]
    if (draft !== undefined && key in draft) return draft[key] ?? ''
    const current = entry.config?.[key]
    return typeof current === 'string' ? current : current === undefined || current === null ? '' : String(current)
  }

  const setDraftValue = (entryId: string, key: string, value: string): void => {
    setDrafts(current => ({ ...current, [entryId]: { ...current[entryId], [key]: value } }))
    setSaveState('idle')
  }

  const saveConfig = async (entry: PluginInventoryEntry): Promise<void> => {
    const draft = drafts[entry.entryId] ?? {}
    const patch: Record<string, string> = {}
    for (const key of editableKeys(entry)) {
      patch[key] = draft[key] ?? draftValue(entry, key)
    }
    setSaveState('saving')
    try {
      await configure(entry.entryId, patch)
      setSaveState('saved')
      setRequest(value => value + 1)
    } catch {
      setSaveState('error')
    }
  }

  const handleToggle = async (entry: PluginInventoryEntry): Promise<void> => {
    const newEnabled = !entry.enabled
    setToggling(prev => new Set(prev).add(entry.entryId))
    // Optimistic UI update: flip switch immediately for native responsiveness
    setState((current) => {
      if (current.status !== 'ready') return current
      return {
        ...current,
        snapshot: {
          ...current.snapshot,
          entries: current.snapshot.entries.map(e =>
            e.entryId === entry.entryId ? { ...e, enabled: newEnabled } : e,
          ),
        },
      }
    })
    try {
      await toggle(entry.entryId, newEnabled)
    } catch (err) {
      console.error('Failed to toggle plugin', entry.entryId, err)
      // Rollback to original state on failure
      setState((current) => {
        if (current.status !== 'ready') return current
        return {
          ...current,
          snapshot: {
            ...current.snapshot,
            entries: current.snapshot.entries.map(e =>
              e.entryId === entry.entryId ? { ...e, enabled: !newEnabled } : e,
            ),
          },
        }
      })
    } finally {
      setToggling((prev) => {
        const next = new Set(prev)
        next.delete(entry.entryId)
        return next
      })
    }
  }

  return (
    <div className={css.section} aria-busy={state.status === 'loading'}>
      {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('error')}</p>
          <button type="button" onClick={retry}>{t('retry')}</button>
        </div>
      ) : null}
      {state.status === 'ready' ? (
        <div className={css.catalog}>
          <label className={css.search}>
            <IconSearchOutline16 aria-hidden="true" />
            <span className={css.visuallyHidden}>{t('search')}</span>
            <input
              type="search"
              value={query}
              placeholder={t('search')}
              aria-label={t('search')}
              onChange={(event) => { setQuery(event.currentTarget.value) }}
            />
          </label>
          <div className={css.catalogHeading}>
            <h3>{t('catalog')}</h3>
            <span data-plugin-count={filteredEntries.length}>{filteredEntries.length}</span>
          </div>
          {state.snapshot.entries.length === 0 ? <p className={css.status}>{t('empty')}</p> : null}
          {state.snapshot.entries.length > 0 && filteredEntries.length === 0
            ? <p className={css.status}>{t('emptySearch')}</p>
            : null}
          {filteredEntries.length > 0 ? (
            <ul className={css.cards}>
              {filteredEntries.map((entry) => {
                const status = phaseLabel(entry.fiberPhase, t)
                const title = moduleShortName(entry.moduleName)
                const open = expanded === entry.entryId
                const detailId = `${catalogId}-details-${encodeURIComponent(entry.entryId)}`
                return (
                  <li
                    className={css.card}
                    key={entry.entryId}
                    data-plugin-entry={entry.entryId}
                    data-open={open ? 'true' : undefined}
                  >
                    <div className={css.cardRow}>
                      <button
                        className={css.cardContent}
                        type="button"
                        aria-expanded={open}
                        aria-controls={detailId}
                        aria-label={entry.enabled ? `${title}, ${status}, ${t('enabledTag')}` : `${title}, ${t('disabledTag')}`}
                        onClick={() => {
                          setSaveState('idle')
                          setExpanded(current => current === entry.entryId ? null : entry.entryId)
                        }}
                      >
                        <strong className={css.cardTitle} title={entry.moduleName}>{title}</strong>
                        <span className={css.cardTrailing}>
                          {entry.enabled ? (
                            <span
                              className={css.statusDot}
                              data-phase={entry.fiberPhase ?? 'unobserved'}
                              role="img"
                              aria-label={status}
                              title={status}
                            />
                          ) : null}
                          <span
                            className={css.configTag}
                            data-enabled={entry.enabled ? 'true' : undefined}
                          >
                            {entry.enabled ? t('enabledTag') : t('disabledTag')}
                          </span>
                          <IconChevronDownOutline14 className={css.chevron} size={12} aria-hidden="true" />
                        </span>
                      </button>
                      <button
                        className={css.toggle}
                        type="button"
                        role="switch"
                        aria-checked={entry.enabled}
                        data-checked={entry.enabled ? 'true' : 'false'}
                        aria-label={entry.isProtected ? `${title} (Core plugin - protected)` : entry.enabled ? `Disable ${title}` : `Enable ${title}`}
                        title={entry.isProtected ? 'Core plugin - protected' : undefined}
                        disabled={entry.isProtected || toggling.has(entry.entryId)}
                        onClick={(event) => {
                          event.stopPropagation()
                          event.preventDefault()
                          if (!entry.isProtected) {
                            void handleToggle(entry)
                          }
                        }}
                      >
                        <span className={css.toggleThumb} />
                      </button>
                    </div>
                    {open ? (
                      <div className={css.cardDetails} id={detailId}>
                        <code className={css.entryValue} data-loader-entry>{entry.entryId}</code>
                        {editableKeys(entry).length > 0 ? (
                          <form
                            className={css.configForm}
                            onSubmit={(event) => {
                              event.preventDefault()
                              void saveConfig(entry)
                            }}
                          >
                            <span className={css.configFormTitle}>{t('configuration')}</span>
                            {editableKeys(entry).map(key => (
                              <label key={key} className={css.configField}>
                                <span>{key === 'endpoint' ? t('apiUrlLabel') : t('apiKeyLabel')}</span>
                                <input
                                  type={key === 'apiKey' ? 'password' : 'url'}
                                  value={draftValue(entry, key)}
                                  placeholder={key === 'endpoint' ? 'http://127.0.0.1:8090' : 'ctx_…'}
                                  spellCheck={false}
                                  autoComplete="off"
                                  onChange={(event) => { setDraftValue(entry.entryId, key, event.currentTarget.value) }}
                                />
                              </label>
                            ))}
                            <div className={css.configActions}>
                              <button type="submit" disabled={saveState === 'saving'}>
                                {saveState === 'saving' ? t('saving') : t('save')}
                              </button>
                              {saveState === 'saved' ? <span className={css.configSaved}>{t('saved')}</span> : null}
                              {saveState === 'error' ? <span className={css.configError} role="alert">{t('configError')}</span> : null}
                            </div>
                          </form>
                        ) : null}
                        <dl className={css.details}>
                          <div>
                            <dt>{t('configuration')}</dt>
                            <dd>{entry.enabled ? t('enabledTag') : t('disabledTag')}</dd>
                          </div>
                          {entry.enabled ? (
                            <div>
                              <dt>{t('cordis')}</dt>
                              <dd>{status}</dd>
                            </div>
                          ) : null}
                        </dl>
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
