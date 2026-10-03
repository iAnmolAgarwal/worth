import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../src/api.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('API client', () => {
  it('sends the browser time zone with every request', async () => {
    const fetch = vi.fn(async (_path: string, _init: RequestInit) => Response.json({ ok: true }))
    vi.stubGlobal('fetch', fetch)
    await api('/state')
    await api('/consent', { aiConsent: true })
    for (const [, init] of fetch.mock.calls)
      expect(init.headers).toMatchObject({
        'X-Worth-Client': 'web',
        'X-Worth-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
  })
  it('omits the header when the browser cannot report a time zone', async () => {
    const fetch = vi.fn(async (_path: string, _init: RequestInit) => Response.json({ ok: true }))
    vi.stubGlobal('fetch', fetch)
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => {
      throw new RangeError('unsupported')
    })
    await api('/state')
    expect(fetch.mock.calls[0]![1].headers).not.toHaveProperty('X-Worth-Timezone')
  })
})
