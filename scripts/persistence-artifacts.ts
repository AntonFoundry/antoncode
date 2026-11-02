/** Render English persistence documentation without Git or file mutation. */

/** One repository-relative generated file and its complete UTF-8 content. */
export interface PersistenceArtifact {
  readonly path: string
  readonly content: string
}

/**
 * Render one English persistence artifact.
 * Link existence remains the Markdown gate's responsibility.
 * @param _root - checkout root reserved for caller compatibility.
 * @param source - repository-relative English document path.
 * @param en - complete authored or generated English Markdown.
 * @param _zh - legacy generated text ignored by the English-only documentation generator.
 * @returns the English document without writing files.
 */
export function renderPersistencePair(_root: string, source: string, en: string, _zh: string): PersistenceArtifact[] {
  return [{ path: source, content: en }]
}
