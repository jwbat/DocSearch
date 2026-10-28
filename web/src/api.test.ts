import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError, getFileUrl, getManifest } from './api'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('api client', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', 'https://api.example.test')
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    fetchMock.mockReset()
  })

  function calledUrl(): string {
    return String(fetchMock.mock.calls[0][0])
  }

  it('fetches the manifest relative to the base URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, [{ path: 'a.md' }]))
    const items = await getManifest()
    expect(calledUrl()).toBe('https://api.example.test/manifest')
    expect(items).toEqual([{ path: 'a.md' }])
  })

  it('keeps a base path when the base URL has one', async () => {
    vi.stubEnv('VITE_API_URL', 'https://api.example.test/prod')
    fetchMock.mockResolvedValue(jsonResponse(200, []))
    await getManifest()
    expect(calledUrl()).toBe('https://api.example.test/prod/manifest')
  })

  it('encodes the file path in the query string', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { url: 'u', expires_in: 300 }))
    await getFileUrl('Code/Books/A Philosophy & Design #1.pdf')
    const url = new URL(calledUrl())
    expect(url.pathname).toBe('/file-url')
    expect(url.searchParams.get('path')).toBe('Code/Books/A Philosophy & Design #1.pdf')
  })

  it('turns an API error body into an ApiError with its status', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: 'file not found' }))
    const err = await getFileUrl('gone.md').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 404, message: 'file not found' })
  })

  it('falls back to the status when the error body is not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }))
    await expect(getManifest()).rejects.toMatchObject({ status: 502, message: 'Bad Gateway' })
  })

  it('fails clearly when VITE_API_URL is missing', async () => {
    vi.stubEnv('VITE_API_URL', '')
    await expect(getManifest()).rejects.toThrow(/VITE_API_URL/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
