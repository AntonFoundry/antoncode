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
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionTarget } from '@deepseek-ai/dsh-api-session-controller/client'
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
  const sessions = ctx.get('sessions') as ISessions | undefined
  if (sessions === undefined) return undefined
  const list = sessions.list.getSnapshot()
  for (const session of Object.values(list.byId)) {
    if ((session.retainedBy.mainView ?? 0) > 0) return session.id
  }
  return undefined
}
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
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
    'conversation': {
      kind: 'single'
      scope: 'session-maybe'
      owner: ConvOwnerProps
      /** The session this render occurrence is bound to; the frame renders one conversation per window pane. */
      hookContext: { scopeSessionId: string }
    }
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

/**
 * Conversation owner share: business state and actions belong to the
 * registrant; the frame contributes the pane facts a per-window session
 * surface needs. Kept in this file so ui-conversation can adopt it without a
 * dependency cycle.
 */
export interface ConvOwnerProps {
  /**
   * How many conversation-visible windows the frame currently shows: 'multi'
   * enables per-pane affordances (e.g. pane-local drag targets); 'single' is
   * the one-window layout.
   */
  layoutSpan: 'single' | 'multi'
  /**
   * The session this pane is pinned to (a wm session buffer with a defined
   * sessionId); undefined = the pane follows the global current session.
   */
  scopeSessionId?: string | undefined
  /**
   * Re-pin THIS pane to a session by id (leaf-bound by the frame). A
   * composer minting a new session inside a pinned pane calls this instead
   * of `sessions.open`, so the other panes keep their sessions; unpinned
   * panes keep `sessions.open`.
   */
  rebindPane?: ((sessionId: string) => void) | undefined
}

/** Details owner share: empty — sessionId arrives as a framework-standard prop. */
export interface DetailsOwnerProps {}

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
export const inject = ['slots', 'theme', 'workspaces', 'sessions', 'connection', 'uiWorkspace', 'uiSession']

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
  const layout = new LayoutController()
  const wmStore = createWmStore()
  const scratchStore = createScratchStore()
  // One shared instance, wrapped so create() returns it: upstream's own frame
  // does this so the registrant reads the same actions the component renders
  // from, without needing an inject face.
  const layoutHandle = createLayoutStore()
  const layoutInstance = layoutHandle.create()
  const layoutStore: typeof layoutHandle = { ...layoutHandle, create: () => layoutInstance }
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
          // window-tree change): staging opens pinned sessions' history
          // windows without moving the global selection.
          // The staged (preview) set is a view concern; the workspace UI owns it.
          syncStagedSessions: (sessionIds: readonly string[]) => {
            const ui0 = workspaceUiOf(ctx)
            const staged = (ui0 as unknown as {
              setStagedSessions?(ids: readonly SessionId[]): void
            }).setStagedSessions
            const ui = workspaceUiOf(ctx)
            if (staged !== undefined && ui !== undefined) staged.call(ui, sessionIds as SessionId[])
          },
          writeScratch: (text: string) => { scratch.actions.setText(text) },
          openSession: (sessionId: string) => { workspaceUiOf(ctx)?.openSession(sessionId as SessionId) },
          interruptSession: (sessionId: string) =>
            (ctx.sessions as unknown as {
              interruptSession(id: string): Promise<{ ok: boolean; error?: { message: string } }>
            }).interruptSession(sessionId),
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
          fetchSessionTail: async (sessionId: string, depth?: 'brief' | 'cli') => {
            type WireTail = { ok: boolean; value?: { lines: readonly { kind: string; label: string }[] } }
            const result = await (ctx.sessions as unknown as {
              sessionTail(id: string, depth?: 'brief' | 'cli'): Promise<WireTail>
            }).sessionTail(sessionId, depth)
            if (!result.ok || result.value === undefined) return undefined
            return result.value.lines.map(line => ({ kind: line.kind as 'user' | 'tool' | 'assistant' | 'error', label: line.label }))
          },
          fetchSessionModel: async (sessionId: string) => {
            // The same `session.models` advisory RPC the model picker uses:
            // the routed provider/model is the swarm fact the pane strip shows.
            type WireModels = { ok: boolean; value?: { current?: { provider?: string; model?: string } | null } }
            const result = await (ctx.sessions as unknown as {
              models(payload: { sessionId: string }): Promise<WireModels>
            }).models({ sessionId })
            const current = result.ok ? result.value?.current : undefined
            if (current?.provider === undefined || current.model === undefined) return undefined
            return `${current.provider}/${current.model}`
          },
          promptSession: (sessionId: string, text: string, mode: 'queue' | 'steer') =>
            (ctx.sessions as unknown as {
              promptSession(id: string, text: string, mode: 'queue' | 'steer'): Promise<{ ok: boolean; error?: { message: string } }>
            }).promptSession(sessionId, text, mode),
          openWorkspace: (workspaceId: string) => {
            const view = ctx.workspaces.list.getSnapshot().items.find(w => w.workspaceId === workspaceId)
            const list = ctx.sessions.list.getSnapshot()
            const latest = view?.sessionIds
              .map(id => list.byId[id])
              .filter(session => session !== undefined)
              .sort((a, b) => b.updatedAt - a.updatedAt)[0]
            if (latest !== undefined) workspaceUiOf(ctx)?.openSession(latest.id as SessionId)
            else workspaceUiOf(ctx)?.startSession(view?.workspaceId as never, undefined)
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
          disposeTerminalSession: async (sessionId: string): Promise<void> => {
            const conn = ctx.get('connection') as unknown as { api?: { term?: { dispose(req: { sessionId: string }): Promise<unknown> } } } | undefined
            if (conn?.api?.term?.dispose) {
              await conn.api.term.dispose({ sessionId }).catch(() => {})
            }
          },
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
    props: Omit<WmFrameProps, keyof WmFrameInjected | 'useSessions' | 'useWorkspaces'>,
  ): ReturnType<typeof WmFrame> {
    // useSessions and useWorkspaces ARE framework standard props at runtime,
    // merged into GlobalStandardProps by ui-session and ui-workspace. Both
    // depend on this package, so this compilation unit cannot see the merge
    // and the composed type omits them; the assertion states that runtime fact
    // rather than fabricating the values.
    return WmFrame({ ...props, ...frameShare } as WmFrameProps)
  }

  ctx.effect(() => {
    const disposeService = ctx.reflect.provide('layout', layout)
    const disposeRegistration = ctx.slots.register({
      name: 'root',
      children: {
        'sidebar': { kind: 'single', scope: 'root' },
        'conversation': { kind: 'single', scope: 'session-maybe' },
        'details': { kind: 'single', scope: 'session' },
        'shell.overlay': { kind: 'list', scope: 'root' },
        'shell.topbar.left': { kind: 'list', scope: 'root' },
        'shell.topbar.right': { kind: 'list', scope: 'root' },
        'terminal.view': { kind: 'single', scope: 'root' },
        'settings.view': { kind: 'single', scope: 'root' },
        'webcam.view': { kind: 'single', scope: 'root' },
        'file.view': { kind: 'keyed', scope: 'root' },
      },
      store: layoutStore,
    }, BoundWmFrame)
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
      if (snapshot.preference === 'light' || snapshot.preference === 'dark' || snapshot.preference === 'system') {
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
