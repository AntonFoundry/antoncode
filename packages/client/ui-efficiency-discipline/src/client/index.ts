/**
 * Browser half of the efficiency-discipline preference: binds the durable
 * settings scope, mirrors it into the row store, and registers the row into
 * the settings General section's item slot (a feature owns its settings
 * surface).
 */
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the ctx.settingsScope Context merge. Cross-plugin collaboration
// goes through the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { EfficiencyRow, type EfficiencyRowInjected } from './EfficiencyRow.tsx'
import { createEfficiencyRowStore } from './settings-store.ts'
import { en, zh, type EfficiencyKey } from './locales.ts'
import {
  DEFAULT_DISCIPLINE, DISCIPLINE_FIELD, DISCIPLINE_SETTINGS_NAMESPACE,
  type DisciplineSettings,
} from '../discipline-settings.ts'

export type { EfficiencyRowComponentProps, EfficiencyRowInjected } from './EfficiencyRow.tsx'
export type { EfficiencyRowState } from './settings-store.ts'
export type { EfficiencyKey } from './locales.ts'

/** Namespace owning this feature's settings-row copy. */
export const SETTINGS_NS = 'settings.efficiency'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The efficiency settings row's copy. */
    'settings.efficiency': EfficiencyKey
  }
}

/**
 * Required services: settings transport plus slots/locale for the row.
 * `remote` carries the forwarded settings invalidation that
 * `bindSettingsScope` subscribes to on this context.
 */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/**
 * Client plugin body: register the feature-owned efficiency preference row
 * into the General section's item slot.
 * @param ctx - client cordis context.
 */
export function apply(ctx: ClientContext): void {
  const host = ctx.settingsScope.bind<DisciplineSettings>({ namespace: DISCIPLINE_SETTINGS_NAMESPACE })

  ctx.effect(() => ctx.locale.register(SETTINGS_NS, { zh, en }), 'ui-efficiency: settings row dictionaries')

  const store = createEfficiencyRowStore()
  let bound: BoundActions<typeof store> | undefined
  const sync = (): void => {
    const snapshot = host.getSnapshot()
    const section = snapshot.value
    const enabled = section === undefined ? DEFAULT_DISCIPLINE : section[DISCIPLINE_FIELD] !== false
    // No revision before the first Host view; -1 keeps the store's fence a no-op until one lands.
    bound?.sync(enabled, snapshot.revision ?? -1)
  }
  ctx.effect(() => host.subscribe(() => { sync() }), 'ui-efficiency: settings scope adoption')
  const injected = (actions: BoundActions<typeof store>): EfficiencyRowInjected => {
    bound = actions
    sync()
    return {
      setEnabled: (enabled) => { void host.set(DISCIPLINE_FIELD, enabled) },
    }
  }
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'efficiency-discipline',
    order: 15,
    store,
    locale: SETTINGS_NS,
    inject: injected,
  }, EfficiencyRow))
}
