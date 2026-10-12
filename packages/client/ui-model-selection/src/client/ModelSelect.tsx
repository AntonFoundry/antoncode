/**
 * ModelSelect: the composer's named model seat (`conversation.input.model`).
 * The trigger opens the provider-grouped model list directly — effort is not
 * a menu row anymore. It moved to the sibling effort pill: a colored button
 * showing the effective effort level (hue ladders with the level — neutral
 * at off/provider default, cool→hot up to max), whose hover slider offers
 * exactly the levels the model declares. The pill renders only for a model
 * with reasoning metadata. Data and submission ride the SAME per-session
 * ModelDirectory as the /model popup; exact-model reasoning metadata and the
 * selected effort come from the Host rather than a client-owned vocabulary.
 * A rejected selection announces through the shared transient Toast anchored
 * to the composer card; the menu strip with Retry remains the catalog-load
 * surface.
 */
import {
  useEffect, useId, useMemo, useRef, useState, useSyncExternalStore,
  type KeyboardEvent, type FocusEvent,
} from 'react'
import clsx from 'clsx'
import type { ModelReasoningEffort, ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconCheckOutline16, IconChevronDownOutline14,
  IconWarningOutline16, ProviderLogo, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelSelectInjected } from './slots.ts'
import css from './ModelSelect.module.css'

/** One dynamic effort stop; undefined means preserve the provider default. */
interface EffortChoice {
  key: string
  effort: string | undefined
  label: string
  description?: string
}

/** Pill hue class per declared effort id; unknown or absent ids stay neutral. */
const EFFORT_LEVEL: Record<string, string> = {
  low: 'levelLow',
  medium: 'levelMedium',
  high: 'levelHigh',
  max: 'levelMax',
}

/**
 * Render the composer model seat: the model trigger, and — for a model with
 * reasoning metadata — the effort pill with its hover slider.
 * @param props - owner share (locked) + injected face (shared directory
 * store/verbs) + the standard locale seat.
 * @returns the seat element.
 */
export function ModelSelect(
  { locked, available, directory, load, select, t }:
  ModelSelectInjected & { locked: boolean } & PropsLocale<'model'>,
) {
  const state = useSyncExternalStore(
    fn => directory.subscribe(fn),
    () => directory.getSnapshot(),
  )
  const [open, setOpen] = useState(false)
  // Hover reveals the slider; a click pins it so pointer-off and touch
  // users keep it open until an outside click dismisses it.
  const [sliderPinned, setSliderPinned] = useState(false)
  const [modelSearch, setModelSearch] = useState('')
  // The in-menu error strip serves catalog loads (its Retry re-runs the
  // load); a rejected SELECTION announces through the transient toast
  // instead, so the strip renders only while the latest failure-capable
  // action was a load.
  const lastActionRef = useRef<'load' | 'select'>('load')
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const groupsRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const id = useId()

  const choices = useMemo(() => state.groups.flatMap(group =>
    group.models.map(model => ({
      group,
      model,
      selection: {
        provider: group.id,
        model: model.id,
        ...model.reasoning?.defaultEffort === undefined
          ? {}
          : { reasoningEffort: model.reasoning.defaultEffort },
      } satisfies ModelSelection,
    }))), [state.groups])
  const search = modelSearch.trim().toLocaleLowerCase()
  const filteredGroups = state.groups.map(group => ({
    group,
    models: group.models.filter(model => search === '' || [
      group.name, group.id, model.name, model.id, model.description ?? '',
    ].some(value => value.toLocaleLowerCase().includes(search))),
  })).filter(({ models }) => models.length > 0)
  const visibleModels = filteredGroups.reduce((count, { models }) => count + models.length, 0)
  const selectedIndex = state.current === null
    ? -1
    : choices.findIndex(c => c.selection.provider === state.current?.provider && c.selection.model === state.current.model)
  const currentChoice = choices[selectedIndex]
  const reasoning = currentChoice?.model.reasoning
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
  const effortLabel = reasoning === undefined
    ? undefined
    : effectiveEffort === undefined
      ? t('effort.providerDefault')
      : reasoning.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort
  const effortChoices = useMemo<readonly EffortChoice[]>(() => reasoning === undefined
    ? []
    : [
      ...reasoning.defaultEffort === undefined
        ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }]
        : [],
      ...reasoning.efforts.map((effort: ModelReasoningEffort) => ({
        key: `effort:${effort.id}`,
        effort: effort.id,
        label: effort.name,
        ...effort.description === undefined ? {} : { description: effort.description },
      })),
    ], [reasoning, t])
  // The slider's thumb position: the active stop, clamped so an effort the
  // list somehow lacks degrades to the first stop rather than an out-of-range
  // value.
  const activeEffortIndex = Math.max(0, effortChoices.findIndex(level => level.effort === effectiveEffort))
  const busy = state.status === 'selecting'

  const reload = (): void => {
    lastActionRef.current = 'load'
    load()
  }

  // Load the directory when the composer mounts so opening the picker only
  // displays the cached host result; Retry remains the explicit refresh path.
  useEffect(() => {
    if (available) {
      lastActionRef.current = 'load'
      load()
    }
  }, [available, load])

  useEffect(() => {
    if (!open && !sliderPinned) return
    const closeOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
        setSliderPinned(false)
      }
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open, sliderPinned])

  useEffect(() => {
    if (!open) return
    searchRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    if (modelSearch.trim() === '') {
      groupsRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')
        ?.scrollIntoView({ block: 'nearest' })
    }
  }, [open, modelSearch, state.current?.provider, state.current?.model, state.groups])

  if (!available) return null

  const show = (): void => {
    setModelSearch('')
    setOpen(true)
  }

  const close = (restoreFocus = false): void => {
    setOpen(false)
    setModelSearch('')
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const moveFocus = (offset: number): void => {
    const items = itemRefs.current.filter(item => item !== null)
    if (items.length === 0) return
    const active = items.findIndex(item => item === document.activeElement)
    const next = active < 0 ? (offset > 0 ? 0 : items.length - 1) : (active + offset + items.length) % items.length
    items[next]?.focus()
  }

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && (open || sliderPinned)) {
      event.preventDefault()
      setSliderPinned(false)
      close(true)
    }
    if (!open) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget)) return
    close()
  }

  const settleSelection = (accepted: boolean): void => {
    if (accepted) {
      if (rootRef.current !== null && open) close(true)
      return
    }
    const message = directory.getSnapshot().error
    if (message !== null) {
      toastSeq.current += 1
      setToast({ seq: toastSeq.current, text: t('error.action', { message }) })
    }
  }

  const choose = (selection: ModelSelection): void => {
    if (state.current?.provider === selection.provider && state.current.model === selection.model) {
      close(true)
      return
    }
    lastActionRef.current = 'select'
    void select(selection).then(settleSelection)
  }

  const chooseEffort = (effort: string | undefined): void => {
    if (state.current === null || effectiveEffort === effort) return
    const selection: ModelSelection = {
      provider: state.current.provider,
      model: state.current.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    }
    lastActionRef.current = 'select'
    void select(selection).then(settleSelection)
  }

  const modelLabel = currentChoice?.model.name ?? t('trigger.fallback')
  itemRefs.current = []
  let itemIndex = 0
  const itemRef = () => {
    const at = itemIndex++
    return (node: HTMLButtonElement | null) => { itemRefs.current[at] = node }
  }

  return (
    <div ref={rootRef} className={css.root} onKeyDown={onRootKeyDown} onBlur={onBlur}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-label={currentChoice === undefined ? t('trigger.selectAria') : t('trigger.aria', { model: modelLabel })}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={modelLabel}
        disabled={locked}
        onClick={() => {
          if (open) {
            close()
          } else {
            show()
          }
        }}
      >
        <span className={css.triggerLabel}>{modelLabel}</span>
        <IconChevronDownOutline14 className={clsx(css.chevron, open && css.chevronOpen)} />
      </button>

      {currentChoice !== undefined && reasoning !== undefined && (
        <div className={clsx(css.pillWrap, css[(effectiveEffort !== undefined ? EFFORT_LEVEL[effectiveEffort] : undefined) ?? 'levelNeutral'])}>
          <button
            type="button"
            className={css.pill}
            aria-label={t('pill.aria', { effort: effortLabel ?? '' })}
            aria-expanded={sliderPinned}
            title={effortLabel ?? ''}
            disabled={locked || busy}
            onClick={() => { setSliderPinned(value => !value) }}
          >
            <span className={css.pillLabel}>{effortLabel}</span>
          </button>
          <div className={clsx(css.sliderCard, sliderPinned && css.sliderPinned)}>
            <input
              className={css.slider}
              type="range"
              min={0}
              max={Math.max(effortChoices.length - 1, 0)}
              step={1}
              value={activeEffortIndex}
              aria-label={t('pill.sliderAria')}
              aria-valuetext={effortChoices[activeEffortIndex]?.label}
              disabled={locked || busy}
              onChange={(event) => { chooseEffort(effortChoices[Number(event.currentTarget.value)]?.effort) }}
            />
            <div className={css.stops}>
              {effortChoices.map((level, at) => (
                <button
                  key={level.key}
                  type="button"
                  className={clsx(css.stop, at === activeEffortIndex && css.stopActive)}
                  title={level.description ?? level.label}
                  disabled={locked || busy}
                  onClick={() => { chooseEffort(level.effort) }}
                >
                  {level.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {open && (
        <div
          id={`${id}-menu`}
          className={css.menu}
          role="menu"
          aria-label={t('menu.aria')}
          aria-busy={state.status === 'loading' || busy}
        >
          <input
            ref={searchRef}
            className={css.search}
            type="search"
            role="searchbox"
            aria-label={t('search.aria')}
            placeholder={t('search.placeholder')}
            value={modelSearch}
            onChange={(event) => { setModelSearch(event.target.value) }}
          />
          {state.status === 'loading' && (
            <div className={css.status}>{t('status.loading')}</div>
          )}
          {state.error !== null && lastActionRef.current === 'load' && (
            <div className={css.error}>
              <span>{t('error.action', { message: state.error })}</span>
              <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
            </div>
          )}
          {state.failures.map(failure => (
            <div className={css.warning} key={failure.id}>
              <span>{t('warning.groupLoad', { name: failure.name, message: failure.message })}</span>
              <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
            </div>
          ))}
          <div ref={groupsRef} className={clsx(css.groups, 'scrollable')}>
            {filteredGroups.map(({ group, models }) => {
              const headingId = `${id}-${group.id}`
              return (
                <section role="group" aria-labelledby={headingId} className={css.group} key={group.id}>
                  <div className={css.groupTitle} id={headingId}>
                    <ProviderLogo provider={group.id} name={group.name} size={18} />
                    <span>{group.name}</span>
                  </div>
                  {models.map((model) => {
                    const selected = state.current?.provider === group.id && state.current.model === model.id
                    return (
                      <button
                        ref={itemRef()}
                        type="button"
                        role="menuitemradio"
                        aria-checked={selected}
                        className={clsx(css.option, selected && css.selected)}
                        key={model.id}
                        title={model.name}
                        disabled={busy}
                        onClick={() => { choose({ provider: group.id, model: model.id }) }}
                      >
                        <span className={css.optionCopy}>
                          <span className={css.modelName}>{model.name}</span>
                          {model.description !== undefined && (
                            <span className={css.description}>{model.description}</span>
                          )}
                        </span>
                        <span className={css.check}>
                          {selected ? <IconCheckOutline16 /> : null}
                        </span>
                      </button>
                    )
                  })}
                </section>
              )
            })}
          </div>
          {state.status === 'ready' && choices.length === 0 && (
            <div className={css.empty}>{t('empty.models')}</div>
          )}
          {state.status === 'ready' && choices.length > 0 && visibleModels === 0 && (
            <div className={css.empty}>{t('empty.search')}</div>
          )}
        </div>
      )}
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutline16 />}
          anchor={rootRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null}
          onDone={() => { setToast(null) }}
        />
      )}
    </div>
  )
}
