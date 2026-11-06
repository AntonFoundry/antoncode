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
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionTarget } from '@deepseek-ai/dsh-api-session-controller/client'
import { createBoardSessionActions } from './board-session-actions.ts'
import { createTerminalSessionDisposer } from './terminal-session-disposal.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'

/**
 * The navigation members this frame calls on `ctx.uiWorkspace`, declared here
 * rather than imported from `ui-workspace`.
 *
 * `ui-workspace` and `ui-conversation` both depend on this package, and
 * `ui-workspace`'s client builds on `ui-conversation`, so importing its
 * `UiWorkspace` type — through the package entry, the `/client` entry, or the
 * module directly — closes a project-reference cycle. Declaring the four
 * members keeps the dependency one-directional. Each signature mirrors
 * `UiWorkspace` in `packages/client/ui-workspace/src/client/navigation.ts`;
 * change both together.
 */
interface WorkspaceNavigation {
  /** Select a Session and show its Conversation as one UI navigation action. */
  openSession(target: SessionTarget): void
  /** Create or reuse a Session in a Workspace without awaiting the open. */
  startSession(workspaceId?: WorkspaceId, options?: { agentPreset?: string }): void
  /** List a directory for the dired and ido faces. */
  listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing>
}

/**
 * The right panel members this frame calls on `ctx.sidebarRight`, declared
 * here because ui-sidebar-right depends on this package. Each signature
 * mirrors `ISidebarRight` in
 * `packages/client/ui-sidebar-right/src/client/service.ts`; change both together.
 */
interface RightPanelSurface {
  /** Whether the column is currently showing its panel. */
  isExpanded(): boolean
  /** Collapse the column, or expand it and focus its active dock pane. */
  toggleExpanded(): void
}

/**
 * The cross-controller workspace navigation surface, read through ctx.get so no
 * Context merge from a dependent package is needed here.
 * @param ctx - client context.
 * @returns the navigation capability, or undefined when it is not mounted.
 */
function workspaceUiOf(ctx: ClientContext): WorkspaceNavigation | undefined {
  return ctx.get('uiWorkspace') as WorkspaceNavigation | undefined
}

/**
 * The session the main view is showing. Upstream keeps view selection out of
 * the sessions controller, so it is derived from the list's retain counts.
 * @param ctx - client context carrying the sessions controller.
 * @returns the retained main-view session id, or undefined when none is.
 */
function mainSessionOf(ctx: ClientContext): SessionId | undefined {
  const sessions = ctx.get('sessions')
  if (sessions === undefined) return undefined
  const list = sessions.list.getSnapshot()
  for (const session of Object.values(list.byId)) {
    if ((session.retainedBy.mainView ?? 0) > 0) return session.id
  }
  return undefined
}
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { PanelInfo } from './service.ts'
import { en, ja, es, fr, de, ru, pt, zh } from './shortcut-locales.ts'
import { TopbarChrome, WmFrame } from './WmFrame.tsx'
import type { WmFrameInjected, WmFrameProps } from './WmFrame.tsx'
import { useSyncExternalStore } from 'react'
import { createLayoutStore, createScratchStore, createWmStore } from './stores.ts'
import { ensureBuffer, sessionBuffer, swapBuffer } from './wm.ts'
import { watchHarnessBoot } from './bridge.ts'
import { LayoutController } from './service.ts'
import { ThemePresenter } from './theme-presenter.ts'
import { LAYOUT_THEMES, THEME_STORAGE_KEY } from './themes.ts'

// Contract exports only (export-convergence rule: cross-package consumers
// keep a symbol exported; test-only/package-internal symbols live off /src).
// ILayout: the ctx.layout face consumers and test fakes type against.
// OwnerShare contracts below are the render-side halves registrants compose
// against; the frame components and the store factory are package-internal.
export { LayoutController } from './service.ts'
export type { ILayout, IWmLayout, MainPanelId, PanelInfo } from './service.ts'

/** Selector hook over root-scoped panel selection. */
export type UsePanelInfo = SnapshotSelectorHook<PanelInfo>

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The outward face only; the concrete service stays inside this plugin. */
    layout: import('./service.ts').ILayout
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Layout keyboard command labels. */
    'shortcuts.layout': keyof typeof zh
  }

  interface GlobalStandardProps {
    /** Subscribe to the selected main panel independently of parent renders. */
    usePanelInfo: UsePanelInfo
  }

  interface SlotMap {
    // The 'root' entry itself is the runtime's built-in slot (declared
    // there); these are the frame's children, declared by the same
    // register() call that contributes WmFrame. Session owners never pass
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
     * Central panel selected by sidebar entry id, rendered in each chat
     * window pane. The reserved `conversation` key hosts the Conversation;
     * other keys receive no Session binding. A pane pinned to a Session
     * renders its occurrence inside that Session's scope area.
     */
    'main': { kind: 'keyed'; scope: 'root' }
    /**
     * The right column, rendered in the details window pane. OCCUPIED by the
     * right Sidebar, which uses the resolved column width in normal mode and
     * covers the viewport in fullscreen.
     *
     * Whether the panel is shown is the occupant's own recorded business — it
     * reports the composition of its expanded and presentation state through
     * `ctx.layout`, and the frame opens or closes the details pane from that.
     * The occupant decides when to render its Session-bound content.
     */
    'rightbar': { kind: 'single'; scope: 'root'; owner: RightbarOwnerProps }
    /**
     * Full-width bottom content below the window tree. Its rendered height
     * reduces the panes' available height; empty content reserves no space.
     * The occupant owns its height, visibility, and controls. It receives no
     * Session binding and remains mounted across main-panel navigation.
     */
    'shell.bottom': { kind: 'single'; scope: 'root' }
    /**
     * Window-chrome seat for the frame's top-left. OCCUPIED by ui-sidebar's
     * reopen/New Session controls. The window-manager frame does not render
     * it: its brand row owns the sidebar toggle at that position, so an
     * occupant registers but stays unmounted.
     */
    'shell.leading': { kind: 'single'; scope: 'root' }
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
    /**
     * Brand-row additions, left of the centered mode switch. Occupants are
     * icon buttons (the sidebar/context toggles remain layout-owned brand
     * controls).
     */
    'shell.topbar.left': { kind: 'list'; scope: 'root' }
    /**
     * Brand-row additions right of the mode switch (notification, account,
     * and future chrome). The context-panel toggle stays layout-owned.
     */
    'shell.topbar.right': { kind: 'list'; scope: 'root' }
    /**
     * One interactive PTY terminal surface. OCCUPIED by ui-terminal's
     * xterm.js view; the owning buffer's session id rides the owner props.
     */
    'terminal.view': {
      kind: 'single'
      scope: 'root'
      owner: {
        sessionId?: string | undefined
        workspacePath?: string | undefined
        onSessionCreated?: ((sessionId: string) => void) | undefined
      }
    }
    /**
     * Keyed inline file view for the `file` buffers, dispatched by
     * `viewerKeyFor(path)` (`markdown` | `image` | `video`). Register with
     * `key: '<viewer id>'` to own how one viewer family renders; an
     * unclaimed key falls back to the built-in text FileViewer (shiki-
     * highlighted when `viewerLanguageFor` resolves the extension), so
     * registering a viewer is additive and the text fallback always stands.
     * Each shipped viewer is its own package (ui-file-markdown /
     * ui-file-image / ui-file-video); the key→package coupling lives in the
     * web-app composition rows beside this declaration.
     */
    'file.view': { kind: 'keyed'; scope: 'root'; owner: FileViewOwnerProps }
    /**
     * The settings window body (the `settings` buffer, opened through
     * ctx.layout's openSettings/toggleSettings — the sidebar-foot trigger is
     * the shipped driver). OCCUPIED by ui-settings-general's window shell,
     * which declares the header/action/section seats inside it. No owner
     * props: window open/close is ctx.layout's, and closing via the pane's
     * own close gesture is equivalent.
     */
    'settings.view': { kind: 'single'; scope: 'root' }
    /**
     * One live GPU-composited webcam surface for a `webcam` buffer leaf.
     * OCCUPIED by ui-webcam's view; no owner props — the engine, settings
     * store, and theme tokens arrive through the occupant's inject face.
     */
    'webcam.view': { kind: 'single'; scope: 'root' }
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
  /** Session whose chat buffer is active; sidebar memory panels use it as their scope. */
  scopeSessionId?: string | undefined
}

/** Right column owner share: resolved normal geometry and opening eligibility. */
export interface RightbarOwnerProps {
  /** Resolved normal panel width in px, not the saved preference; zero if it cannot fit. */
  width: number
  /** Current frame width in px. */
  viewportWidth: number
  /** Whether a normal right panel fits beside the centre. */
  canShow: boolean
}

/**
 * File-view owner share: the plain data and callbacks every inline file
 * viewer receives from the frame. Viewers stay pure consumers — content
 * fetches ride `readText`, binary media rides the trust-fenced streaming
 * endpoint URL `mediaUrl` builds, and `openWithOs` is the escape hatch to
 * the host's OS default application.
 */
export interface FileViewOwnerProps {
  /** Absolute path of the file this buffer shows. */
  path: string
  /** Read one file's head as text (the markdown viewer's fetch face). */
  readText: (path: string) => Promise<{ content: string; truncated: boolean } | undefined>
  /** Streaming media URL for one path (the `/api/host/media` endpoint). */
  mediaUrl: (path: string) => string
  /** Open the path with the host OS default application (viewer escape hatch). */
  openWithOs: (path: string) => void
}

/** Required services (cordis fiber inject — the loader passes all module exports as an object plugin). */
export const inject = ['slots', 'theme', 'locale', 'shortcuts', 'workspaces', 'sessions']

/**
 * Bind a snapshot source to a selector hook. The framework normally
 * synthesizes these from an inject hooks compartment; `root` carries no
 * inject face, so the frame's share binds them here.
 * @param source - snapshot source (a store instance).
 * @returns a selector hook over that source's snapshot.
 */
function bindSelector<T>(source: {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}): <S>(select: (snapshot: T) => S, equal?: (a: S, b: S) => boolean) => S {
  const subscribe = (listener: () => void): () => void => source.subscribe(listener)
  const getSnapshot = (): T => source.getSnapshot()
  return function useSelector<S>(select: (snapshot: T) => S): S {
    return useSyncExternalStore(subscribe, () => select(getSnapshot()))
  }
}

/**
 * Client plugin body: provide ctx.layout, then one register() call — WmFrame
 * into 'root' with the four child-slot declarations, the layout store seat,
 * and the inject hook that hands the store's bound actions to the service.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const wmStore = createWmStore()
  const scratchStore = createScratchStore()
  // One shared instance, wrapped so create() returns it: upstream's own frame
  // does this so the registrant reads the same actions the component renders
  // from, without needing an inject face.
  const layoutHandle = createLayoutStore()
  const layoutInstance = layoutHandle.create()
  const layoutStore: typeof layoutHandle = { ...layoutHandle, create: () => layoutInstance }
  const panelInfo: HostObservable<PanelInfo> = {
    getSnapshot: () => layoutInstance.getSnapshot().panelInfo,
    subscribe: listener => layoutInstance.subscribe(listener),
  }
  const layout = new LayoutController(
    layoutInstance.actions,
    id => ctx.slots.entries('main').some(entry => entry.options.key === id),
    panelInfo,
  )
  ctx.effect(() => ctx.locale.register('shortcuts.layout', { zh, en, ja, es, fr, de, ru, pt }), 'layout: command labels')
  const t = ctx.locale.bind('shortcuts.layout')
  const boardLifetime = new AbortController()
  ctx.effect(() => () => { boardLifetime.abort() }, 'ui-layout: board operations')
  const boardActions = createBoardSessionActions(ctx.sessions, boardLifetime.signal)
  const disposeTerminalSession = createTerminalSessionDisposer({
    dispose: (request) => {
      const remote = ctx.get('remote')
      if (remote === undefined) throw new Error('ui-layout: terminal Remote is not mounted')
      return remote.guiTerminal.dispose(request)
    },
  })
  /**
   * The registrant-private share the frame renders from.
   *
   * `root` is seeded by the slot core, so no parent registration supplies an
   * inject face for it — upstream's `inject` is the face a PARENT declares on
   * a child slot. Binding the same members in a closure here is that
   * capability in userland, and it keeps the frame's props unchanged.
   * @returns the wm and scratch hooks plus the navigation, file and theme share.
   */
  function buildFrameShare(): WmFrameInjected {
    const actions = layoutInstance.actions
    layout.attachPanels(actions)
    const wm = wmStore.create()
    layout.attachWm(wm)
    const scratch = scratchStore.create()
    // Inline file open lives on the controller (ILayout.openFile): the
    // same buffer-beside-the-focused-leaf flow, shared with every
    // cross-plugin caller. The opener face below only keeps the routing
    // decision's Host fallback.
    let previewOriginal: string | undefined
    return {
      useWm: bindSelector(wm),
      useScratch: bindSelector(scratch),
      setTree: (tree: Parameters<typeof wm.actions.setTree>[0]) => { wm.actions.setTree(tree) },
      setSidebarBootDropped: (dropped: boolean) => { wm.actions.setSidebarBootDropped(dropped) },
      setFocus: (leafId: string | undefined) => { wm.actions.setFocus(leafId) },
      setBuffers: (buffers: Parameters<typeof wm.actions.setBuffers>[0]) => { wm.actions.setBuffers(buffers) },
      setMode: (mode: Parameters<typeof actions.setMode>[0]) => { actions.setMode(mode) },
      setSidebarWidth: (px: number) => { actions.setSidebar(px) },
      themeList: () => LAYOUT_THEMES.map(t => ({ id: t.id, colorScheme: t.colorScheme })),
      loadTheme: (id: string) => {
        previewOriginal = undefined
        ctx.theme.setTheme(id)
        try { window.localStorage.setItem(THEME_STORAGE_KEY, id) } catch { /* private mode */ }
      },
      // Load-theme live preview: apply the highlighted palette without
      // persisting; null restores the pre-prompt theme (C-g). The original
      // is captured at the first preview so an untouched prompt is a no-op,
      // and an executed selection cancels the preview session.
      previewTheme: (id: string | null) => {
        if (id === null) {
          if (previewOriginal !== undefined) ctx.theme.setTheme(previewOriginal)
          previewOriginal = undefined
          return
        }
        if (previewOriginal === undefined) previewOriginal = ctx.theme.getTheme().preference
        ctx.theme.setTheme(id)
      },
      reconcileBuffers: () => { wm.actions.reconcile() },
      // Pane-aware re-pin (per-window session buffers): pin one leaf's
      // window to a session buffer without touching the global selection.
      rebindPane: (leafId: string, sessionId: string) => {
        const snapshot = wm.store.getSnapshot()
        const buffer = sessionBuffer(sessionId)
        wm.actions.setBuffers(ensureBuffer(snapshot.buffers, buffer))
        wm.actions.setTree(swapBuffer(snapshot.tree, leafId, buffer.id))
      },
      // Pinned-pane staging sync (the frame calls this on every
      // window-tree change). Upstream's workspace UI has no staged-session
      // set, so pinned panes stage nothing until per-pane Session pinning
      // lands (see the package README).
      syncStagedSessions: () => {},
      writeScratch: (text: string) => { scratch.actions.setText(text) },
      // A window showing the right panel's buffer expands its surface; the
      // surface exists only while a Session is on screen.
      expandRightPanel: () => {
        const surface = ctx.get('sidebarRight') as RightPanelSurface | undefined
        if (surface === undefined || mainSessionOf(ctx) === undefined || surface.isExpanded()) return
        surface.toggleExpanded()
      },
      openSession: (sessionId: string) => { workspaceUiOf(ctx)?.openSession(sessionId as SessionId) },
      interruptSession: boardActions.interruptSession,
      // Text reads go through the workspace-files Remote namespace, the same
      // call the document preview makes. The viewer needs the truncation
      // flag as well as the text, so both ride the result.
      readTextFile: async (path: string) => {
        const remote = ctx.get('remote')
        if (remote === undefined) return undefined
        const files = (remote as unknown as {
          workspaceFiles: {
            read(
              sessionId: string, path: string, opts: { offset?: number }, signal?: AbortSignal,
            ): Promise<{ ok: boolean; value?: { content?: string; truncated?: boolean } }>
          }
        }).workspaceFiles
        const current = mainSessionOf(ctx)
        if (current === undefined) return undefined
        const result = await files.read(current, path, {})
        if (!result.ok || result.value === undefined) return undefined
        return { content: result.value.content ?? '', truncated: result.value.truncated ?? false }
      },
      fetchSessionTail: () => Promise.resolve(undefined),
      fetchSessionModel: boardActions.fetchSessionModel,
      promptSession: boardActions.promptSession,
      openWorkspace: (workspaceId: string) => {
        const view = ctx.workspaces.list.getSnapshot().items.find(w => w.workspaceId === workspaceId)
        const list = ctx.sessions.list.getSnapshot()
        const latest = view?.sessionIds
          .map(id => list.byId[id])
          .filter(session => session !== undefined)
          .sort((a, b) => b.updatedAt - a.updatedAt)[0]
        if (latest !== undefined) workspaceUiOf(ctx)?.openSession(latest.id)
        else workspaceUiOf(ctx)?.startSession(view?.workspaceId, undefined)
      },
      // The dired faces route through the workspace navigation seam. Its
      // listing reports directories only, so the files buffer shows
      // directories until it reads files through workspaceFiles.list.
      listDirectory: (path?: string, _opts?: { includeFiles?: boolean }, signal?: AbortSignal) =>
        workspaceUiOf(ctx)?.listDirectory(path, signal)
            ?? Promise.reject(new Error('ui-layout: no workspace UI is mounted')),
      // The opener face: one routing decision for ido Enter and dired's
      // open action alike, delegated to the controller's inline opener
      // (ILayout.openFile — text, markdown, image, video split beside the
      // focused window). The OS-open binary families (file-view.ts)
      // leave the app through the workspaces service.
      openPath: (path: string): Promise<void> => {
        if (layout.openFile(path)) return Promise.resolve()
        // The OS-open binary families leave the app through the host opener.
        const remote = ctx.get('remote')
        const host = remote === undefined ? undefined : (remote as unknown as {
          host?: { openPath?(path: string): Promise<void> }
        }).host
        if (host?.openPath === undefined) throw new Error('ui-layout: no host opener is mounted')
        return host.openPath(path)
      },
      // The inline viewers' binary-media face: the trust-fenced streaming
      // endpoint URL for one path (images and video render from it).
      mediaUrl: (path: string) => `/api/host/media?path=${encodeURIComponent(path)}`,
      disposeTerminalSession,
      // The api client returns the RpcResponse envelope: the business
      // result sits under `result` ({ ok: true, value } | { ok: false }).
    }
  }

  const frameShare = buildFrameShare()

  /**
   * WmFrame with its registrant-private share applied; the framework supplies
   * the standard, store and render-slot props.
   * @param props - framework-composed root props.
   * @returns the frame element tree.
   */
  function BoundWmFrame(
    props: Omit<WmFrameProps, keyof WmFrameInjected | 'useWorkspaces'>,
  ): ReturnType<typeof WmFrame> {
    // useWorkspaces IS a framework standard prop at runtime, merged into
    // GlobalStandardProps by ui-workspace. ui-workspace depends on this
    // package, so this compilation unit cannot see the merge and the composed
    // type omits it; the assertion states that runtime fact rather than
    // fabricating the value.
    return WmFrame({ ...props, ...frameShare } as WmFrameProps)
  }

  ctx.effect(() => {
    const retainMainPanels = (): void => {
      layoutInstance.actions.retainMainPanels(ctx.slots.entries('main').flatMap(entry =>
        entry.options.key === undefined ? [] : [entry.options.key]))
    }
    const disposePanelInfo = ctx.slots.provideRoot({ hooks: { panelInfo: layout.panelInfo } })
    const disposeService = ctx.reflect.provide('layout', layout)
    const disposeRegistration = ctx.slots.register({
      name: 'root',
      children: {
        'sidebar': { kind: 'single', scope: 'root' },
        'shell.overlay': { kind: 'list', scope: 'root' },
        'shell.topbar.left': { kind: 'list', scope: 'root' },
        'shell.topbar.right': { kind: 'list', scope: 'root' },
        'terminal.view': { kind: 'single', scope: 'root' },
        'settings.view': { kind: 'single', scope: 'root' },
        'webcam.view': { kind: 'single', scope: 'root' },
        'file.view': { kind: 'keyed', scope: 'root' },
        'main': { kind: 'keyed', scope: 'root' },
        'rightbar': { kind: 'single', scope: 'root' },
        'shell.bottom': { kind: 'single', scope: 'root' },
        'shell.leading': { kind: 'single', scope: 'root' },
      },
      store: layoutStore,
    }, BoundWmFrame)
    const disposeShortcut = ctx.shortcuts.register({
      id: 'sidebar.left.toggle' as ShortcutCommandId, label: () => t('toggle'), aliases: ['sidebar', 'toggle left sidebar'],
      defaults: {
        'desktop:macos': { code: 'KeyB', modifiers: ['primary'] },
        'desktop:windows': { code: 'KeyB', modifiers: ['primary'] },
        'desktop:linux': { code: 'KeyB', modifiers: ['primary'] },
        'web:macos': { code: 'KeyB', modifiers: ['primary', 'alt'] },
        'web:windows': { code: 'KeyB', modifiers: ['primary', 'alt'] },
      },
      regions: ['page', 'editable'], modals: [],
      resolve: () => ({ status: 'handled', run: () => { layout.toggleSidebar() } }),
    })
    const disposePanels = ctx.slots.subscribe('main', retainMainPanels)
    retainMainPanels()
    return () => {
      disposeShortcut()
      layout.dispose()
      disposePanels()
      disposeRegistration()
      disposePanelInfo()
      // provide()'s disposer settles asynchronously; teardown is synchronous fire-and-forget.
      void disposeService()
    }
  }, 'ui-layout: service + root registration')

  // Theme presentation: pure DOM writes from resolved snapshots — initial
  // state through the getter once, then event-driven only; no React path.
  ctx.effect(() => {
    const presenter = new ThemePresenter()
    // The compos-style palette: register the named themes, restore the
    // persisted choice (localStorage — the theme service persists only the
    // light/dark/system preference, not registered ids), or fall back to the
    // Aqua default while the user has made no explicit choice.
    const disposers = LAYOUT_THEMES.map(t => ctx.theme.register(t))
    const stored = (() => { try { return window.localStorage.getItem(THEME_STORAGE_KEY) } catch { return null } })()
    if (stored !== null && LAYOUT_THEMES.some(t => t.id === stored)) {
      try { ctx.theme.setTheme(stored) } catch { /* a race with registration is not user-facing */ }
    } else if (ctx.theme.getTheme().preference === 'system') {
      // The default experience: the macOS Aqua palettes follow the OS
      // appearance while the user has made no explicit choice. A built-in
      // Light/Dark selection persists through the theme service and suppresses
      // this on later boots; System returns to the Aqua default. Not persisted
      // here — an explicit load-theme choice remains the only sticky palette.
      // Restored as the boot default, not a user choice: the durable read is
      // usually still in flight at this point, and a persisted dark/light
      // preference must win the race instead of being blocked behind the
      // palette for the session.
      const aqua = ctx.theme.getTheme().active.colorScheme === 'dark' ? 'macos-dark' : 'macos'
      // restoreBootDefault is gone upstream; setTheme expresses the same
      // boot-default intent, and a theme not yet registered simply loses the
      // race, which is not user-facing.
      try { ctx.theme.setTheme(aqua) } catch { /* a race with registration is not user-facing */ }
    }
    presenter.apply(ctx.theme.getTheme())
    const off = ctx.on('theme/change', (snapshot) => {
      // An explicit built-in choice (Settings → Appearance row) releases the
      // stored palette so it cannot resurrect on the next boot. The adopt()
      // guard in ui-theme means no other built-in publish can arrive while a
      // palette is active, and this listener attaches only after the boot
      // restore, so boot traffic cannot race it.
      // ThemeRuntime stores a registered palette id as the preference too, so
      // the runtime value is wider than ThemePreference.
      const preference: string = snapshot.preference
      if (preference === 'light' || preference === 'dark' || preference === 'system') {
        try {
          if (window.localStorage.getItem(THEME_STORAGE_KEY) !== null) window.localStorage.removeItem(THEME_STORAGE_KEY)
        } catch { /* private mode */ }
      }
      presenter.apply(snapshot)
    })
    return () => {
      off()
      presenter.dispose()
      for (const d of disposers) d()
    }
  }, 'ui-layout: theme presenter')

  // Restart detection: reload the page when the managed harness PID changes,
  // so every restart path (M-x, supervisor tool, macOS menu) lands the
  // browser on the new process without a manual refresh.
  ctx.effect(() => watchHarnessBoot(), 'ui-layout: harness boot watcher')
  // Brand-row chrome placeholders: notifications and account occupy the
  // right slot until ui-jobs / identity ship richer occupants (the slot is
  // the seam — these are layout-owned stand-ins, not ad-hoc chrome).
  ctx.effect(() => {
    const dispose = ctx.slots.inject('shell.topbar.right', () => ctx.slots.register({
      name: 'shell.topbar.right',
      id: 'ui-layout-topbar-chrome',
    }, TopbarChrome))
    return dispose
  }, 'ui-layout: topbar chrome placeholders')
}
