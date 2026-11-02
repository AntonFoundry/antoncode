/**
 * Settings shell contract — the types of the two occupants this package
 * renders: the `sidebar.settings` trigger root and the `settings.view`
 * window body. They live here rather than in ui-settings because they
 * reference other packages' slot types: ui-settings is the settings domain's
 * base layer and must not depend on any `ui-*` presentation package, or the
 * reference graph closes a cycle through ui-sidebar → ui-layout → ui-theme.
 * The settings SLOT types (what registrants contribute) stay in ui-settings.
 */
import type { ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-sidebar's SlotMap merge (the 'sidebar.settings' entry)
// into every program that sees this contract.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls ui-layout's SlotMap merge (the 'settings.view' entry) and
// the settings window's owner share into this program.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the settings slot declarations the shell renders into.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ShortcutCatalogEntry } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { DesktopUpdateView } from '../types.ts'

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
 * connection state, the onboarding ledger projection, and the settings-window
 * open state (the trigger's `aria-expanded`) arrive as hook-compartment
 * sources; the window open actions over ctx.layout, the update action, and
 * the reconnect command remain plain callbacks.
 */
export type SettingsRootInjected = {
  /** Ask the layout to open (or focus) the settings window. */
  openWindow: () => void
  /** Select a section and open the window on it (the onboarding path). */
  openSection: (id: string) => void
  /** Request the current shell-owned update action. */
  openDesktopUpdate: () => void
  /** Request a fresh logical generation and physical WebSocket immediately. */
  reconnect: () => void
  hooks: {
    /** Effective command presentation, shared with the reference. */
    shortcuts: HostObservable<readonly ShortcutCatalogEntry[]>
    /** Shared Electron status for both sidebar locations. */
    desktopUpdate: HostObservable<DesktopUpdateView>
    /** Connection-owned state for the current Host connection. */
    connectionState: HostObservable<ConnectionState | undefined>
    /** Whether the settings window leaf currently exists in the wm tree. */
    settingsOpen: HostObservable<boolean>
    /** settings.onboarding ledger projected into coordinator order. */
    onboardingSteps: HostObservable<readonly SettingsOnboardingStep[]>
  }
}

/**
 * Full component props of the trigger root: the sidebar owner share
 * (wide/rail state) plus the declared render shares, the injected face, and
 * the shell locale seat. No store is registered — completed-onboarding step
 * ids and the explicitly requested step stay component-local.
 */
export type SettingsRootComponentProps =
  PropsRuntime<'sidebar.settings'>
  & PropsRenderSlots<'settings.launcher' | 'settings.trigger' | 'settings.onboarding'>
  & InjectFace<SettingsRootInjected>
  & PropsLocale<'settings'>

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
 * (empty) plus the declared render shares, the injected face, and the locale
 * seat for the window's own accessible name. The window chrome (title, close
 * gesture) is the WM pane's own mode line.
 */
export type SettingsWindowComponentProps =
  PropsRuntime<'settings.view'>
  & PropsRenderSlots<'settings.header' | 'settings.action' | 'settings.section'>
  & PropsLocale<'settings'>
  & InjectFace<SettingsWindowInjected>
