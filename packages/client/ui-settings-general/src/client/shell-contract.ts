/**
 * Settings shell contract — the types of the two occupants this package
 * renders: the `sidebar.settings` trigger root and the `settings.view`
 * window body. They live here rather than in ui-settings because they
 * reference other packages' slot types: ui-settings is the settings domain's
 * base layer and must not depend on any `ui-*` presentation package, or the
 * reference graph closes a cycle through ui-sidebar → ui-layout → ui-theme.
 * The settings SLOT types (what registrants contribute) stay in ui-settings.
 */
import type { HostObservable, InjectFace, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-sidebar's SlotMap merge (the 'sidebar.settings' entry)
// into every program that sees this contract.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls ui-layout's SlotMap merge (the 'settings.view' entry) and
// the settings window's owner share into this program.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the settings slot declarations the shell renders into.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

/** One nav row projected from a settings.section registration's options. */
export interface SettingsSectionRow {
  id: string
  order: number
  label: string
}

/** One ordered onboarding step projected from a slot registration. */
export interface SettingsOnboardingStep {
  id: string
  order: number
}

/**
 * Registrant-private injected share of the trigger root (assembled in apply):
 * the onboarding ledger projection plus the window open action over
 * ctx.layout. The root reads no locale state and subscribes through the
 * bound hook.
 */
export type SettingsRootInjected = {
  /** Ask the layout to open (or focus) the settings window. */
  openWindow: () => void
  /** Select a section and open the window on it (the onboarding path). */
  openSection: (id: string) => void
  hooks: {
    /** settings.onboarding ledger projected into coordinator order. */
    onboardingSteps: HostObservable<readonly SettingsOnboardingStep[]>
  }
}

/**
 * Full component props of the trigger root: the sidebar owner share
 * (wide/rail state) plus the declared render shares and the injected face.
 * No store is registered — completed-onboarding step ids stay component-local.
 */
export type SettingsRootComponentProps =
  PropsRuntime<'sidebar.settings'>
  & PropsRenderSlots<'settings.trigger' | 'settings.onboarding'>
  & InjectFace<SettingsRootInjected>

/**
 * Registrant-private injected share of the settings window body: the section
 * ledger projection, the shared active-section source (onboarding's
 * openSection writes it; the nav reads and writes it), and the window close
 * action over ctx.layout.
 */
export type SettingsWindowInjected = {
  /** Close the settings window (sections receive it as their `close` prop). */
  closeWindow: () => void
  /** Select the window's active section (undefined = first-row fallback). */
  setActiveSection: (id: string | undefined) => void
  hooks: {
    /** settings.section ledger projected into ordered nav rows. */
    sections: HostObservable<readonly SettingsSectionRow[]>
    /** The window's active section id (undefined = fall back to the first row). */
    activeSection: HostObservable<{ activeId: string | undefined }>
  }
}

/**
 * Full component props of the settings window body: the frame owner share
 * (empty) plus the declared render shares and the injected face. The window
 * chrome (title, close gesture) is the WM pane's own mode line.
 */
export type SettingsWindowComponentProps =
  PropsRuntime<'settings.view'>
  & PropsRenderSlots<'settings.header' | 'settings.action' | 'settings.section'>
  & InjectFace<SettingsWindowInjected>
