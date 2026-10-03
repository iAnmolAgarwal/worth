export class ApiError extends Error {
  code?: string
  status: number
  details?: unknown
  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}
/** The browser's IANA time zone; the server uses it to date the synthetic plan and new imports. */
function viewerTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}
export async function api<T>(path: string, data?: unknown, method?: string): Promise<T> {
  const timezone = viewerTimezone()
  const response = await fetch(`/api${path}`, {
    method: method ?? (data === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-Worth-Client': 'web',
      ...(timezone ? { 'X-Worth-Timezone': timezone } : {}),
    },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  })
  const result = await response
    .json()
    .catch(() => ({ error: 'The server could not complete this request.' }))
  if (!response.ok)
    throw new ApiError(
      result.error ?? 'Something went wrong. Please try again.',
      response.status,
      result.code,
      result,
    )
  return result as T
}
