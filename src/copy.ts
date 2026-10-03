/** Everything that reaches Anthropic when Claude answers. Update it with any change to the chat tools. */
export const CLAUDE_SHARED_DATA =
  'your messages, recent chat history (including figures), the item, price and date you ask about, a forecast summary, 30-day spending totals by category, income and bill names with amounts and dates, minimized merchant labels, whether PayPal offers Pay in 4 for the price, and whether Worth prepared a checkout for a catalog item and how it went'

/** The short list shown wherever Claude's access is summarised; Ask and Settings use the same rows. */
export const CLAUDE_USES: [string, string][] = [
  ['Plan totals and dates', 'Yes'],
  ['Bill and subscription names', 'Shortened labels'],
  ['Your messages', 'Yes'],
  ['PayPal login or card numbers', 'Never'],
]
