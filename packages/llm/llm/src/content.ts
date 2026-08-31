/** Content-block structure helpers. @module @deepseek-ai/dsh-llm/content */

import type { ContentBlock } from './types.ts'

/**
 * True when typed model content contains an image block, walking nested
 * tool-result content. This is the one recursive image walk shared by every
 * image policy (capability gating, text-only serialization, compaction
 * survey), so a consumer cannot silently diverge on nesting depth.
 * @param content - typed model content blocks.
 * @returns whether any nested block is an image.
 */
export function contentHasImage(content: readonly ContentBlock[]): boolean {
  return content.some(block => block.type === 'image'
    || (block.type === 'tool-result' && contentHasImage(block.content)))
}

/** Text swapped in for an image block when the target model cannot accept image input. */
export const IMAGE_OMITTED_TEXT = '[image omitted: the selected model cannot accept image input]'

/**
 * Replace image blocks — recursively inside tool results — with the omitted
 * placeholder text. Returns the same array untouched when no image is
 * present, so callers keep reference stability on the common path. This is
 * the graceful-degradation counterpart to {@link contentHasImage}: instead
 * of failing a step because the selected model cannot view images, the
 * request retries (or simply proceeds) with images omitted.
 * @param blocks - typed model content blocks.
 * @returns content with every image block replaced by placeholder text.
 */
export function withoutImageBlocks(blocks: readonly ContentBlock[]): ContentBlock[] {
  if (!contentHasImage(blocks)) return [...blocks]
  const out: ContentBlock[] = []
  for (const block of blocks) {
    if (block.type === 'image') {
      out.push({ type: 'text', text: IMAGE_OMITTED_TEXT })
      continue
    }
    if (block.type === 'tool-result' && contentHasImage(block.content)) {
      out.push({ ...block, content: [...withoutImageBlocks(block.content)] })
      continue
    }
    out.push(block)
  }
  return out.length > 0 ? out : [{ type: 'text', text: IMAGE_OMITTED_TEXT }]
}
