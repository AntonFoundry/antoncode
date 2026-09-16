/**
 * Settings shell and ownerless-copy plugin, browser half: renders the
 * `sidebar.settings` occupant — panel chrome, section navigation, and the
 * onboarding stage — and registers everything on the Settings pages that
 * belongs to no single feature: the trigger/header chrome content,
 * local-document action, General section, and `settings` dictionaries.
 * Feature-owned rows and sections stay with their features.
 * Export discipline: packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { createElement, type CSSProperties } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
// Type-only: the settings slot declarations plus the ctx.settingsScope Context
// merge. Cross-plugin collaboration goes through the service, never a value
// import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls ctx.locale into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {
  SettingsOnboardingStep, SettingsRootInjected, SettingsSectionRow,
} from './shell-contract.ts'
import { SettingsRoot } from './SettingsRoot.tsx'
import { CloseLabel, HeaderContent, TriggerContent } from './chrome.tsx'
import { GeneralSection } from './GeneralSection.tsx'
import { SettingsDocumentAction } from './SettingsDocumentAction.tsx'
import type { SettingsDocumentActionInjected } from './SettingsDocumentAction.tsx'
import { refreshDocumentIfLoaded, SettingsDocumentStore } from './settings-document-store.ts'
import { en, zh, type SettingsKey } from './locales.ts'

export type {
  CloseLabelProps, HeaderContentProps, TriggerContentProps,
} from './chrome.tsx'
export type {
  GeneralSectionComponentProps,
} from './GeneralSection.tsx'
export type { SettingsDocumentActionInjected, SettingsDocumentActionProps } from './SettingsDocumentAction.tsx'
export type { SettingsDocumentState } from './settings-document-store.ts'
export { SettingsDocumentStore } from './settings-document-store.ts'
export type { SettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Shell chrome + shell-owned General section copy. */
    settings: SettingsKey
  }
}

/** Dictionary namespace owned by this plugin (shell chrome + General copy). */
const NS = 'settings'

/**
 * Required services (cordis fiber inject). The target slots are declared by
 * ui-settings' apply, whose activation order relative to this one is NOT
 * constrained; registrations depend on their slots through `slots.inject()`.
 */
export const inject = ['slots', 'locale', 'connection']

/**
 * Register the `settings` dictionaries, the chrome content, and the General
 * section, each once its slot declaration is on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-general: dictionaries')

  // Copy freshness is framework-owned: components read the standard `t`
  // seat, and the nav label is a thunk the owner resolves per render — no
  // locale/change re-registration wiring.
  const t = ctx.locale.bind(NS)
  const connection = ctx.get('connection') as ConnectionHandle
  const documentController = connection.isLoopback
    ? new SettingsDocumentStore(connection.api)
    : undefined
  const documentInjected = documentController === undefined
    ? undefined
    : (() => {
      const useSnapshot = bindSnapshotSelector(documentController.store)
      return (): SettingsDocumentActionInjected => ({ controller: documentController, useSnapshot })
    })()
  ctx.effect(() => ctx.on('connection/reset', () => {
    refreshDocumentIfLoaded(documentController)
  }), 'ui-settings-general: metadata invalidations')
  // The settings shell: this package occupies the sidebar-owned hole and
  // declares the settings slots. Ledger → nav-row projection as an observable
  // source (uSES contract: getSnapshot returns the cached rows until the
  // ledger version moves). Labels may be locale-following thunks, so the cache
  // key includes the locale revision and subscribers ride both sources.
  let rowsVersion = -1
  let rowsRevision = -1
  let rows: readonly SettingsSectionRow[] = []
  let onboardingVersion = -1
  let onboardingSteps: readonly SettingsOnboardingStep[] = []
  const shellInjected = (): SettingsRootInjected => ({
    hooks: {
      sections: {
        getSnapshot: () => {
          const version = ctx.slots.getVersion('settings.section')
          const revision = ctx.locale.getSnapshot().revision
          if (version !== rowsVersion || revision !== rowsRevision) {
            rowsVersion = version
            rowsRevision = revision
            rows = ctx.slots.entries('settings.section')
              .map(e => ({
                /* v8 ignore next -- list-slot registration requires id (SlotCore rejects an entry without one) */
                id: e.options.id ?? '',
                order: e.options.order ?? 0,
                label: resolveSlotLabel(e.options.label) ?? '',
              }))
              .sort((a, b) => a.order - b.order)
          }
          return rows
        },
        subscribe: (listener) => {
          const offLedger = ctx.slots.subscribe('settings.section', listener)
          const offLocale = ctx.locale.subscribe(listener)
          return () => {
            offLedger()
            offLocale()
          }
        },
      },
      onboardingSteps: {
        getSnapshot: () => {
          const version = ctx.slots.getVersion('settings.onboarding')
          if (version !== onboardingVersion) {
            onboardingVersion = version
            onboardingSteps = ctx.slots.entries('settings.onboarding')
              .map(e => ({
                /* v8 ignore next -- list-slot registration requires id */
                id: e.options.id ?? '',
                order: e.options.order ?? 0,
              }))
              .sort((a, b) => a.order - b.order)
          }
          return onboardingSteps
        },
        subscribe: listener => ctx.slots.subscribe('settings.onboarding', listener),
      },
    },
  })
  ctx.slots.inject('sidebar.settings', () => ctx.slots.register({
    name: 'sidebar.settings',
    children: {
      'settings.trigger': { kind: 'single', scope: 'root' },
      'settings.header': { kind: 'single', scope: 'root' },
      'settings.action': { kind: 'list', scope: 'root' },
      'settings.close': { kind: 'single', scope: 'root' },
      'settings.section': { kind: 'list', scope: 'root' },
      'settings.onboarding': { kind: 'list', scope: 'root' },
    },
    inject: shellInjected,
  }, SettingsRoot))

  ctx.slots.inject('settings.trigger', () =>
    ctx.slots.register({ name: 'settings.trigger', locale: NS }, TriggerContent))
  ctx.slots.inject('settings.header', () =>
    ctx.slots.register({ name: 'settings.header', locale: NS }, HeaderContent))
  if (documentInjected !== undefined) {
    ctx.slots.inject('settings.action', () => ctx.slots.register({
      name: 'settings.action',
      id: 'open-document',
      order: 0,
      locale: NS,
      inject: documentInjected,
    }, SettingsDocumentAction))
  }
  ctx.slots.inject('settings.close', () =>
    ctx.slots.register({ name: 'settings.close', locale: NS }, CloseLabel))
  // Efficiency-discipline row: reads/writes the 'tools-discipline' settings
  // section that the tools runtime consumes per assembly. Registered natively
  // here because the General section is this package's own settings surface.
  const efficiencyScope = ctx.get('settingsScope')
  if (efficiencyScope !== undefined && typeof (efficiencyScope as { bind?: unknown }).bind === 'function') {
    const bound = (efficiencyScope as {
      bind: (options: { namespace: string }) => {
        getSnapshot: () => { value: { efficiencyDiscipline?: boolean } | undefined; revision: number }
        subscribe: (listener: () => void) => () => void
        set: (field: string, value: boolean) => Promise<void> | void
      }
    }).bind({ namespace: 'tools-discipline' })
    const readEnabled = (): boolean => {
      const section = bound.getSnapshot().value
      return section === undefined ? true : section.efficiencyDiscipline !== false
    }
    let snap = { enabled: readEnabled() }
    const store = {
      getSnapshot: () => snap,
      subscribe: (listener: () => void) => bound.subscribe(() => { snap = { enabled: readEnabled() }; listener() }),
    }
    const useEnabled = bindSnapshotSelector(store)
    const setEnabled = (enabled: boolean): void => { void bound.set('efficiencyDiscipline', enabled) }
    ctx.slots.inject('settings.general.item', () => ctx.slots.register({
      name: 'settings.general.item',
      id: 'efficiency-discipline',
      order: 15,
      locale: NS,
    }, (rowProps) => {
      const enabled = useEnabled(state => state.enabled)
      const group: CSSProperties = {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 16, padding: '16px 0', borderBottom: '1px solid var(--dsw-alias-border-l2)', minWidth: 0,
      }
      const copy: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }
      const title: CSSProperties = { fontSize: 14, fontWeight: 400, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' }
      const description: CSSProperties = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' }
      const toggle: CSSProperties = {
        position: 'relative', flex: 'none', width: 38, height: 22, border: 0,
        borderRadius: 999, background: enabled
          ? 'var(--dsw-alias-state-success-primary, #34c759)'
          : 'var(--dsw-alias-border-l1, #3a3a3c)',
        cursor: 'pointer', padding: 0, margin: 0, boxSizing: 'border-box',
        transition: 'background 200ms cubic-bezier(0.2, 0.8, 0.2, 1)', userSelect: 'none',
      }
      const thumb: CSSProperties = {
        position: 'absolute', top: 2, left: 2, width: 18, height: 18,
        borderRadius: '50%', background: '#ffffff',
        boxShadow: '0 2px 4px rgba(0,0,0,0.25), 0 0 1px rgba(0,0,0,0.3)',
        transition: 'transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1)', pointerEvents: 'none',
        transform: enabled ? 'translateX(16px)' : 'translateX(0)',
      }
      return createElement('div', { style: group },
        createElement('div', { style: copy },
          createElement('div', { style: title }, rowProps.t('efficiency.title')),
          createElement('div', { style: description }, rowProps.t('efficiency.description')),
        ),
        createElement('button', {
          style: toggle, type: 'button', role: 'switch', 'aria-checked': enabled,
          'aria-label': rowProps.t('efficiency.title'), onClick: () => { setEnabled(!enabled) },
        }, createElement('span', { style: thumb })),
      )
    }))
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'general',
    order: 0,
    label: () => t('general.nav'),
    locale: NS,
    children: { 'settings.general.item': { kind: 'list', scope: 'root' } },
  }, GeneralSection))
}
