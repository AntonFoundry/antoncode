/**
 * @deepseek-ai/dsh-host-frontend-static — SPA dist server over the webserver
 * fallback seat: serves the built frontend directory with the semantics the
 * Web shell locked at step1 — traversal outside the dist root is 403, any
 * miss falls back to index.html with HTTP 200 (SPA routing), unknown
 * extensions ship as octet-stream, non-GET/HEAD is 405. Every index response
 * runs through the webserver's registered index taps (boot-manifest
 * injection). The dist location is workspace knowledge of the composing
 * application, so `distIndex` is typically supplied through a `!!js`
 * expression, never hardcoded by a deployment.
 * @module @deepseek-ai/dsh-host-frontend-static
 */

import { randomUUID } from 'node:crypto'
import type { ServerResponse, IncomingMessage } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'frontend-static'

/** Service required before the fallback seat can be claimed. */
export const inject = ['webServer']

/** Plugin config: the dist anchor. */
export interface Config {
  /** Absolute path of index.html inside the dist root. */
  distIndex: string
}

export const Config: z<Config> = z.object({
  distIndex: z.string().required(),
})

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
}

/**
 * Serve one GET/HEAD static request from the dist root.
 * @param pathname - decoded URL pathname of the request.
 * @param res - the node:http response to write.
 * @param distRoot - absolute dist root directory (resolved by the caller).
 * @param distIndex - absolute path of index.html inside distRoot.
 * @param renderIndex - produces the index.html body (index-tap injection) for
 * `/` and every SPA fallback.
 */
export async function serveStatic(
  pathname: string, res: ServerResponse, distRoot: string, distIndex: string,
  renderIndex: () => Promise<string>, req?: IncomingMessage, bootId?: string,
): Promise<void> {
  // The boot id rides every response (header on all bodies, meta on the
  // shell): a client that remembers the value it loaded under can detect a
  // harness restart and drop its in-memory bundle instead of requesting old
  // hashed chunks that no longer exist.
  if (bootId !== undefined) res.setHeader('x-dsh-boot', bootId)
  const target = resolve(normalize(join(distRoot, pathname)))
  // Traversal rejection: the target must be distRoot itself (`/`) or stay under
  // it. `sep`, not '/': resolve() emits backslash paths on Windows, where a '/'
  // suffix would reject every legitimate subpath as traversal.
  if (target !== distRoot && !target.startsWith(distRoot + sep)) {
    res.writeHead(403)
    res.end()
    return
  }
  const serveIndex = async (): Promise<void> => {
    const stamped = bootId === undefined
      ? undefined
      : `<meta name="dsh-boot" content="${bootId}">`
    const body = stamped === undefined
      ? await renderIndex()
      // Insert after <head> so the restart marker is the shell's first tag.
      : (await renderIndex()).replace(/<head(\s[^>]*)?>/i, head => `${head}\n    ${stamped}`)
    // The shell references every bundle; it must never come from a stale cache.
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' })
    res.end(body)
  }
  if (target === distRoot || target === distIndex) {
    await serveIndex()
    return
  }
  try {
    const [body, fileStat] = await Promise.all([readFile(target), stat(target)])
    // Revalidate-always caching: the bundles are replaced in place on deploy,
    // so heuristic browser caching would serve a stale shell or plugin for
    // days. no-cache + a weak size-mtime ETag makes every request a cheap
    // conditional fetch that picks up new bytes immediately.
    const etag = `W/"${fileStat.size.toString(16)}-${fileStat.mtimeMs.toString(16)}"`
    const headers: Record<string, string> = {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      etag,
    }
    if (req?.headers['if-none-match'] === etag) {
      res.writeHead(304, headers)
      res.end()
      return
    }
    res.writeHead(200, headers)
    res.end(body)
  } catch {
    // Miss (ENOENT/EISDIR) falls back to index.html with 200 (SPA routing).
    await serveIndex()
  }
}

/**
 * Claim the webserver fallback seat and serve the dist.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const distIndex = config.distIndex
  const distRoot = dirname(distIndex)
  // One id per plugin activation: a harness restart remounts the plugin, so
  // every served response carries the boot it came from.
  const bootId = randomUUID()
  const renderIndex = async (): Promise<string> =>
    ctx.webServer.applyIndexTaps(await readFile(distIndex, 'utf8'))
  ctx.effect(() => ctx.webServer.registerFallback(async (req, res) => {
    // Non-GET/HEAD without a matching named route is 405 (fallback-only
    // semantics: named routes own their method handling).
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    /* v8 ignore next -- node:http always sets url on server requests */
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    await serveStatic(decodeURIComponent(rawPath), res, distRoot, distIndex, renderIndex, req, bootId)
  }), 'frontend-static: fallback seat')
}
