import { describe, expect, it, vi } from 'vitest'
import { ZaiSearchProvider } from '@deepseek-ai/dsh-web-search-zai'

/**
 * Credential-bearing providers must reject redirects before the `Location` target
 * is contacted (packages/web/AGENTS.md). `fetch(redirect: 'error')` fails the
 * request on the redirect response itself; this spec proves both the failure and
 * that no second request ever reaches the redirect target.
 */

const options = { apiKey: 'zai-key', baseURL: 'https://api.zai.test/v4', searchEngine: 'search-prime' }

function redirectResponse(): Response {
  return new Response(null, { status: 302, headers: { location: 'https://evil.test/capture' } })
}

describe('Z.AI search redirect rejection', () => {
  it('fails a redirect response as WEB_PROVIDER_ERROR and never contacts the target', async () => {
    const fetchMock = vi.fn(async () => redirectResponse())
    vi.stubGlobal('fetch', fetchMock)
    await expect(new ZaiSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toBe('https://api.zai.test/v4/web_search')
  })

  it('opts into the policy on the request itself', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await new ZaiSearchProvider(options).search({ query: 'q' }).catch(() => {})
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.redirect).toBe('error')
  })
})
