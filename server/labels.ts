// Merchant and flow names come from CSV counterparties and user edits. They are
// data: minimize them before they reach Claude or appear in Worth's own sentences.

/** A minimized merchant label for categorization prompts. */
export function merchantLabel(name: string, maxLength = 100) {
  const label = name
    .replace(/https?:\/\/\S+|www\.\S+/gi, '[website]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:[a-z]{2,6})\b(?:\/\S*)?/gi, (match) =>
      /^[a-z]+\.[a-z]+$/i.test(match) &&
      !/\.(?:com|co|net|org|io|app|ly|me|xyz|info|biz|us|uk|ai)$/i.test(match)
        ? match
        : '[website]',
    )
    .replace(
      /\b\d+\s+(?:[a-z]+\s+){1,4}(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|boulevard|blvd)\b/gi,
      '[address]',
    )
    .replace(/\+?\d[\d ()-]{7,}\d/g, '[number]')
    .replace(/\b\d{4,}\b/g, '[number]')
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F\r\n\t]/g, ' ')
    .replace(/[<>{}`"]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return label.length > maxLength ? `${label.slice(0, maxLength - 1).trimEnd()}…` : label
}

/** A short label for chat context and Worth's deterministic answers. */
export function chatLabel(name: string) {
  return merchantLabel(name, 40) || 'Unnamed item'
}
