// Typed client for the read-only DocSearch API (the Go Lambda behind
// API Gateway). The base URL comes from VITE_API_URL at build time.

export interface ManifestItem {
  path: string
  sha256: string
  size_bytes: number
  content_type: string
  modified_time: string
}

export interface FileUrl {
  url: string
  expires_in: number
}

// ApiError carries the HTTP status so callers can tell "file not found"
// (404) apart from a broken request or a server failure.
export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

function apiBase(): URL {
  const raw = import.meta.env.VITE_API_URL
  if (!raw) {
    throw new Error('VITE_API_URL is not set (see web/.env.example)')
  }
  // A trailing slash makes relative paths resolve under the base instead of
  // replacing its last segment.
  return new URL(raw.endsWith('/') ? raw : `${raw}/`)
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(new URL(path, apiBase()), { signal })
  if (!res.ok) {
    // Every API error has the shape {"error": "..."}; fall back to the
    // status text if something upstream (e.g. API Gateway) answered instead.
    let message = res.statusText || `HTTP ${res.status}`
    try {
      const body = await res.json()
      if (typeof body?.error === 'string') message = body.error
    } catch {
      // not JSON — keep the status text
    }
    throw new ApiError(res.status, message)
  }
  return res.json() as Promise<T>
}

// getManifest returns every live file, sorted by path.
export function getManifest(signal?: AbortSignal): Promise<ManifestItem[]> {
  return request<ManifestItem[]>('manifest', signal)
}

// getFileUrl returns a short-lived presigned URL for one file's content.
export function getFileUrl(path: string, signal?: AbortSignal): Promise<FileUrl> {
  const query = new URLSearchParams({ path })
  return request<FileUrl>(`file-url?${query}`, signal)
}
