/**
 * Web markdown-viewer plugin, node half.
 *
 * Deliberately empty: the package contributes a browser-side slot occupant
 * (the `markdown` key of ui-layout's `file.view` keyed slot) and owns no
 * host service, tool, or event. The dsh.client manifest is the composition
 * surface; the web-app bundle's cordis.patch.yml row mounts this package.
 */

/** Host plugin body — the viewer renders in the browser, nothing lives here. */
export function apply(): void {}
