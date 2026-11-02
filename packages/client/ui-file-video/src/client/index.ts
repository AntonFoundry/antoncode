/**
 * Web video-viewer plugin, browser half: VideoFileView registered as the
 * `video` key of ui-layout's `file.view` keyed slot (the frame dispatches
 * every matching file buffer by the viewerKeyFor map). Injection into
 * another package's declaration is the slots.inject route — it waits for
 * the declaration, removes the contribution when it collapses, and leaves
 * with this plugin's fiber. Export discipline: packages/client/AGENTS.md —
 * apply/inject plus no value exports.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls ui-layout's SlotMap augmentation ('file.view') into this
// compilation so PropsRuntime<'file.view'> resolves.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { VideoFileView } from './VideoFileView.tsx'
import { NS, de, en, es, fr, ja, pt, ru, zh } from './locales.ts'

/** Required services: the slot registry and the locale dictionaries the viewer copy reads. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the viewer copy and the video key of the file.view slot.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-file-video: dictionaries')
  ctx.slots.inject('file.view', () => ctx.slots.register(
    { name: 'file.view', key: 'video', locale: NS },
    VideoFileView,
  ))
}
