/**
 * Web markdown-viewer plugin, browser half: MarkdownFileView registered as
 * the `markdown` key of ui-layout's `file.view` keyed slot (the frame
 * dispatches every .md/.markdown file buffer by the viewerKeyFor map).
 * Injection into another package's declaration is the slots.inject route —
 * it waits for the declaration, removes the contribution when it collapses,
 * and leaves with this plugin's fiber. Export discipline:
 * packages/client/AGENTS.md — apply/inject plus no value exports.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls ui-layout's SlotMap augmentation ('file.view') into this
// compilation so PropsRuntime<'file.view'> resolves.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { MarkdownFileView } from './MarkdownFileView.tsx'

/** Required services: the slot registry only — the owner share carries all data. */
export const inject = ['slots']

/**
 * Client plugin body: register the markdown viewer into the file.view slot.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('file.view', () => ctx.slots.register(
    { name: 'file.view', key: 'markdown' },
    MarkdownFileView,
  ))
}
