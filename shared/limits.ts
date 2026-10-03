/**
 * The one size and row limit for CSV imports. The browser, the server and the parser all read it,
 * so a file that one of them accepts is never rejected by another.
 */
export const CSV_IMPORT_LIMITS = {
  /** UTF-8 bytes of the CSV text: the documented 1 MB. */
  maxBytes: 1_000_000,
  /** Data rows, not counting the header. */
  maxRows: 10_000,
} as const

export const CSV_SIZE_MESSAGE = `Use a CSV smaller than ${CSV_IMPORT_LIMITS.maxBytes / 1_000_000} MB.`

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength
}
