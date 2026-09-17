/**
 * Settings shell: the sidebar-foot trigger row (which opens the settings
 * window through ctx.layout) and the window body — the section nav rail plus
 * the active section's page. Both are pure composition faces — every piece of
 * text (trigger label, window title, sections) arrives from registrants
 * through slots; accessible names resolve to that content (trigger: its own
 * text). The active section id lives in the apply-scope shared source so the
 * onboarding coordinator's openSection lands on the same window; completed
 * step ids are component-local viewing state. Visible dialog chrome belongs
 * to the step, so a mounted-but-deciding step paints nothing here.
 */
import { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import {
  IconAgentPresetOutline16, IconDataOutline16,
  IconPersonalizationOutline16, IconSettingsOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsRootComponentProps, SettingsSectionRow, SettingsWindowComponentProps } from './shell-contract.ts'
import css from './SettingsRoot.module.css'

/** Nav glyph by section id; unknown ids fall back to the settings gear. */
function navIcon(id: string) {
  if (id === 'models') return <IconDataOutline16 className={css.navIcon} size={16} />
  if (id === 'agent-presets') return <IconAgentPresetOutline16 className={css.navIcon} size={16} />
  if (id === 'plugins') return <IconPersonalizationOutline16 className={css.navIcon} size={16} />
  return <IconSettingsOutline16 className={css.navIcon} size={16} />
}

type WindowProps = {
  rows: readonly SettingsSectionRow[]
  renderSlot: SettingsWindowComponentProps['renderSlot']
  activeId: string | undefined
  onSelect: (id: string) => void
  onClose: () => void
}

/**
 * The window body: nav rail over the `settings.section` entries plus the
 * active section's page. Closing is the pane's own WM close gesture or the
 * `close` prop sections receive; there is no mask, Escape handling, or
 * dialog semantics — the window manager owns the window.
 */
function SettingsWindowBody({ rows, renderSlot, activeId, onSelect, onClose }: WindowProps) {
  // Entries can unmount underneath the requested id, so the render-time
  // projection falls back to the first row when the id is gone.
  const active = rows.find(r => r.id === activeId)?.id ?? rows[0]?.id
  return (
    <div className={css.root}>
      <nav className={css.nav}>
        <div className={css.navTitle}>{renderSlot('settings.header', {})}</div>
        <div className={css.navList}>
          {rows.map(row => (
            <button
              key={row.id}
              type="button"
              className={clsx(css.navCell, row.id === active && css.active)}
              aria-current={row.id === active ? 'true' : undefined}
              onClick={() => { onSelect(row.id) }}
            >
              {navIcon(row.id)}
              <span className={css.navLabel}>{row.label}</span>
            </button>
          ))}
        </div>
      </nav>
      <div className={css.content}>
        <div className={css.header}>
          <div className={css.actions}>{renderSlot('settings.action', {})}</div>
        </div>
        <div className={css.options}>
          {active !== undefined && renderSlot('settings.section', { close: onClose }, { only: active })}
        </div>
      </div>
    </div>
  )
}

/**
 * Render the settings window body.
 * @param props - composed slot props (contract/shell-contract.ts).
 * @returns the settings window element tree.
 */
export function SettingsWindow(props: SettingsWindowComponentProps) {
  const { useSections, useActiveSection, renderSlot, closeWindow, setActiveSection } = props
  const rows = useSections(s => s)
  const { activeId } = useActiveSection(s => s)
  return (
    <SettingsWindowBody
      rows={rows}
      renderSlot={renderSlot}
      activeId={activeId}
      onSelect={setActiveSection}
      onClose={closeWindow}
    />
  )
}

/**
 * Render the settings trigger and onboarding stage.
 * @param props - composed slot props (contract/shell-contract.ts).
 * @returns the settings trigger element tree.
 */
export function SettingsRoot(props: SettingsRootComponentProps) {
  const { wide, useSessions, useOnboardingSteps, renderSlot, openWindow, openSection } = props
  const [completedOnboarding, setCompletedOnboarding] = useState<ReadonlySet<string>>(() => new Set())
  const onboardingSteps = useOnboardingSteps(s => s)
  // The onboarding stage runs only while the workspace shows a blank (or no)
  // session: a live conversation means onboarding has already happened.
  const onboardingActive = useSessions(state =>
    state.phase === 'ready'
    && (state.current === undefined || state.byId[state.current]?.blank === true))

  useEffect(() => {
    if (onboardingActive) return
    setCompletedOnboarding(new Set())
  }, [onboardingActive])

  const completeOnboardingStep = useCallback((id: string) => {
    setCompletedOnboarding((previous) => {
      if (previous.has(id)) return previous
      return new Set([...previous, id])
    })
  }, [])

  const step = onboardingActive ? onboardingSteps.find(s => !completedOnboarding.has(s.id)) : undefined

  return (
    <>
      <button
        type="button"
        className={clsx(css.trigger, !wide && css.rail)}
        aria-haspopup="dialog"
        onClick={openWindow}
      >
        {renderSlot('settings.trigger', { wide })}
      </button>
      {/* Dialog chrome and `#root` inert ownership live inside each step's
          visible branch. A step still deciding (private facts loading)
          renders null, so nothing paints or blocks while it decides. */}
      {step !== undefined && renderSlot('settings.onboarding', {
        stepId: step.id,
        complete: () => { completeOnboardingStep(step.id) },
        openSection,
      }, { only: step.id })}
    </>
  )
}
