import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { ChatReply, RememberedItem, SignedItem } from '../shared/types.ts'

/**
 * Signs the items a conversation assessed, so a later question can return to one at the price
 * Worth read, never at a price the browser sent (pre-merge judge finding 3). The key lives only in
 * this process, and each tag is bound to one session.
 */
export function itemSigner(key: Buffer = randomBytes(32)) {
  const tagFor = (session: string, item: RememberedItem) =>
    createHmac('sha256', key)
      .update(JSON.stringify([session, item.amountCents, item.itemName ?? '']))
      .digest('base64url')
  const valid = (session: string, item: Partial<SignedItem>) => {
    if (typeof item.tag !== 'string' || typeof item.amountCents !== 'number') return false
    const expected = Buffer.from(
      tagFor(session, { amountCents: item.amountCents, itemName: item.itemName }),
    )
    const given = Buffer.from(item.tag)
    return given.length === expected.length && timingSafeEqual(given, expected)
  }
  return {
    /** Adds the signed assessed item to a reply. */
    sign(session: string, reply: ChatReply): ChatReply {
      if (!reply.assessment) return reply
      const item = {
        amountCents: reply.assessment.amountCents,
        itemName: reply.assessment.itemName.slice(0, 150),
      }
      return { ...reply, remember: { ...item, tag: tagFor(session, item) } }
    },
    /** The items this session's replies signed; anything else is dropped. */
    verify(session: string, items: Partial<SignedItem>[] | undefined): RememberedItem[] {
      return (items ?? [])
        .filter((item) => valid(session, item))
        .map((item) => ({
          amountCents: item.amountCents!,
          ...(item.itemName !== undefined ? { itemName: item.itemName } : {}),
        }))
    },
  }
}
