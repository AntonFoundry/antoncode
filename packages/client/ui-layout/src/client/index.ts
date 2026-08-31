/**
 * Layout plugin, browser half: one register() call contributes WmFrame (the
 * Emacs-style window-manager frame) into the runtime's built-in 'root' slot
 * and, in the same breath, declares the four child slots (declaration =
 * exclusive render authority), seats the layout store (panel geometry) and
 * the wm store (persisted window tree, `dsh.layout.wm`), and wires the
 * panel-action service face plus the frame's wm hooks source. ctx.layout is
 * the cross-plugin panel-action contract; navigation state lives with the
 * runtime sessions service. A second effect seats the theme presenter, which
 * projects ctx.theme snapshots onto document.body.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type { PanelActions } from './service.ts'
import { WmFrame } from './WmFrame.tsx'
import { createLayoutStore, createScratchStore, createWmStore } from './stores.ts'
import { LayoutController } from './service.ts'
import { ThemePresenter } from './theme-presenter.ts'

// Contract exports only (export-convergence rule: cross-package consumers
// keep a symbol exported; test-only/package-internal symbols live off /src).
// ILayout: the ctx.layout face consumers and test fakes type against.
// OwnerShare contracts below are the render-side halves registrants compose
// against; the frame components and the store factory are package-internal.
export { LayoutController } from './service.ts'
export type { ILayout } from './service.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The outward face only; the concrete service stays inside this plugin. */
    layout: import('./service.ts').ILayout
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    // The 'root' entry itself is the runtime's built-in slot (declared
    // there); these four are the frame's children, declared by the same
    // register() call that contributes AppFrame. Session owners never pass
    // sessionId: the framework injects it as a standard prop.
    /**
     * The whole left column. OCCUPIED by ui-sidebar's SidebarRoot, which
     * declares the workspace and settings seats inside it — registering here
     * replaces the navigation column outright rather than adding to it, and
     * the seats it declares disappear with it. To add something to the
     * sidebar, register into one of those inner seats instead.
     *
     * The occupant receives the frame's live column state (collapsed, width)
     * and is expected to render the compact control rail while collapsed.
     * When the frame renders the brand strip it passes `brandInFrame: true`,
     * and the shell skips its own logo row (the frame owns the brand).
     */
    'sidebar': { kind: 'single'; scope: 'root'; owner: SidebarOwnerProps }
    /**
     * The whole center column, across both the no-session hero and a live
     * conversation. OCCUPIED by ui-conversation's ConversationRoot, which
     * declares the session body, composer, and input seats inside it —
     * registering here replaces the entire conversation surface (and removes
     * every seat it declares) rather than adding to it.
     *
     * Current-session-optional: the occupant owns both states without
     * changing its React identity, so it keeps its own state across a session
     * switch. It receives no owner props; session facts arrive through the
     * framework hooks of the `session-maybe` scope.
     */
    'conversation': { kind: 'single'; scope: 'session-maybe'; owner: ConvOwnerProps }
    /**
     * The right details column, shown when the layout opens it. OCCUPIED by
     * ui-conversation's DetailsPanel, which declares the tool-details seat
     * inside it — registering here replaces the column and takes that seat
     * with it. Absent an occupant the column renders nothing.
     *
     * No owner props: the framework injects the session id and hooks for the
     * `session` scope, and `ctx.layout` owns whether the column is open.
     */
    'details': { kind: 'single'; scope: 'session'; owner: DetailsOwnerProps }
    /**
     * Frame-wide floating layer, above every column and outside their scroll
     * containers. Deliberately generic and unowned by any feature: a badge, a
     * toast stack or a status pill all belong here, and entries order among
     * themselves. The layer itself is click-through — entries opt back into
     * pointer events — so an occupant never blocks the app underneath.
     *
     * This is the additive seat for a frame-wide surface of your own: a fresh
     * `id` is added beside the shipped entries instead of replacing them.
     */
    'shell.overlay': { kind: 'list'; scope: 'root' }
  }
}

// OwnerShare contracts — the render-side share the slot owner supplies at
// renderSlot. Registrants IMPORT these and compose their full component props
// through the four-share intersection (PropsRuntime & PropsRenderSlots &
// PropsStore & I). Conversation business state and actions arrive through
// framework-standard hooks and each registrant's inject face, not owner props.

/** Sidebar owner share: live column state from the frame's concession solve. */
export interface SidebarOwnerProps {
  /** True when the sidebar is closed (the column renders the compact control rail). */
  collapsed: boolean
  /** Rendered column width in px (SIDEBAR_COLLAPSED when collapsed). */
  width: number
  /**
   * True when the frame renders the brand strip: the shell skips its own
   * logo row (brand + toggle live in the frame's strip instead).
   */
  brandInFrame?: boolean
}

/** Conversation owner share: business state and actions belong to the registrant. */
export interface ConvOwnerProps {}

/** Details owner share: empty — sessionId arrives as a framework-standard prop. */
export interface DetailsOwnerProps {}

/** Required services (cordis fiber inject — the loader passes all module exports as an object plugin). */
export const inject = ['slots', 'theme', 'workspaces', 'sessions']

/**
 * Client plugin body: provide ctx.layout, then one register() call — WmFrame
 * into 'root' with the four child-slot declarations, the layout store seat,
 * and the inject hook that hands the store's bound actions to the service.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const layout = new LayoutController()
  const wmStore = createWmStore()
  const scratchStore = createScratchStore()
  ctx.effect(() => {
    const disposeService = ctx.reflect.provide('layout', layout)
    const disposeRegistration = ctx.slots.register({
      name: 'root',
      children: {
        'sidebar': { kind: 'single', scope: 'root' },
        'conversation': { kind: 'single', scope: 'session-maybe' },
        'details': { kind: 'single', scope: 'session' },
        'shell.overlay': { kind: 'list', scope: 'root' },
      },
      // Exclusive store: the factory itself — the framework instantiates per
      // entry and delivers useStore/actions to WmFrame as standard props.
      store: createLayoutStore,
      // The hook connects the root store (panel state) and the wm store
      // (window tree + focus) to the service face and the frame: panel
      // actions to ctx.layout, the wm instance as the registrant-private
      // hooks source (bound to `useWm`), its write callbacks, and the
      // workspace-open resolver over ctx.workspaces/ctx.sessions.
      inject: (actions: PanelActions) => {
        layout.attachPanels(actions)
        const wm = wmStore.create()
        layout.attachWm(wm)
        const scratch = scratchStore.create()
        return {
          hooks: { wm, scratch },
          setTree: (tree: Parameters<typeof wm.actions.setTree>[0]) => { wm.actions.setTree(tree) },
          setFocus: (leafId: string | undefined) => { wm.actions.setFocus(leafId) },
          setBuffers: (buffers: Parameters<typeof wm.actions.setBuffers>[0]) => { wm.actions.setBuffers(buffers) },
          reconcileBuffers: () => { wm.actions.reconcile() },
          writeScratch: (text: string) => { scratch.actions.setText(text) },
          openWorkspace: (workspaceId: string) => {
            const view = ctx.workspaces.list.getSnapshot().items.find(w => w.workspaceId === workspaceId)
            const list = ctx.sessions.list.getSnapshot()
            const latest = view?.sessionIds
              .map(id => list.byId[id])
              .filter(session => session !== undefined)
              .sort((a, b) => b.updatedAt - a.updatedAt)[0]
            if (latest !== undefined) ctx.sessions.open(latest.id)
            else ctx.workspaces.startSession(view?.workspaceId)
          },
          // The dired faces route through the workspaces service (the browse
          // capability's client seam — ctx has no direct 'host' service).
          listDirectory: (path?: string, signal?: AbortSignal) => ctx.workspaces.listDirectory(path, signal),
          openPath: (path: string) => ctx.workspaces.openPath(path),
        }
      },
    }, WmFrame)
    return () => {
      disposeRegistration()
      // provide()'s disposer settles asynchronously; teardown is synchronous fire-and-forget.
      void disposeService()
    }
  }, 'ui-layout: service + root registration')

  // Theme presentation: pure DOM writes from resolved snapshots — initial
  // state through the getter once, then event-driven only; no React path.
  ctx.effect(() => {
    const presenter = new ThemePresenter()
    presenter.apply(ctx.theme.getTheme())
    const off = ctx.on('theme/change', (snapshot) => { presenter.apply(snapshot) })
    return () => {
      off()
      presenter.dispose()
    }
  }, 'ui-layout: theme presenter')
}
