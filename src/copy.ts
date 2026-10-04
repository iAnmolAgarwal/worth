/** Everything that reaches Anthropic when Claude answers. Update it with any change to the chat tools. */
export const CLAUDE_SHARED_DATA =
  'your messages, recent chat history (including figures), the item, price and date you ask about, a forecast summary, 30-day spending totals by category, income and bill names with amounts and dates, minimized merchant labels, whether PayPal offers Pay in 4 for the price, whether Worth prepared a checkout for a catalog item and how it went, and, when you ask for something cheaper, the kind of item to look for and whether similar items were found (never their names, stores or prices)'

/** The short list shown wherever Claude's access is summarised; Ask and Settings use the same rows. */
export const CLAUDE_USES: [string, string][] = [
  ['Plan totals and dates', 'Yes'],
  ['Bill and subscription names', 'Shortened labels'],
  ['Your messages', 'Yes'],
  ['PayPal login or card numbers', 'Never'],
]

/** The rows as they stand: with Claude off, nothing is sent. */
export const claudeUses = (on: boolean): [string, string][] =>
  CLAUDE_USES.map(([label, value]) => [label, on || value === 'Never' ? value : 'Not sent'])

/** What reaches Channel3 when Worth looks for similar items. It applies with the assistant off too. */
export const CHANNEL3_SHARED_DATA =
  'A generic kind of item (such as “desk chair”) and a price limit rounded down to $25, even when the assistant is off'
