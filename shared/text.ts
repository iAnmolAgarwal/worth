/**
 * Characters a saved name may never hold: C0 and C1 controls, zero-width marks, bidirectional
 * overrides and isolates, word joiners and the byte-order mark, which can disguise a name.
 */
// oxlint-disable-next-line no-control-regex
export const NOT_PLAIN = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g

/** Whether a name is plain text. Letters with accents, ™, ® and dashes all are. */
export const isPlain = (value: string) => !new RegExp(NOT_PLAIN.source).test(value)

/** A third-party title made plain: hidden characters removed, spacing tidied. */
export const plainText = (value: string) =>
  value.replace(NOT_PLAIN, ' ').replace(/\s+/g, ' ').trim()

/**
 * An item or bill name inside a sentence: "Everyday camera" reads "everyday camera", but a proper
 * name keeps its case: one whose first part has a capital past its first letter ("Halden X5",
 * "MacBook Pro") or a digit inside a word ("x5"). What follows " · " ("Laptop · Pay in 4")
 * doesn't count, so a plan payment still reads "laptop · Pay in 4".
 */
export function nameInSentence(name: string) {
  const head = name.split(' · ')[0]!
  if (/\p{Lu}/u.test(head.slice(1)) || /\p{L}\p{N}|\p{N}\p{L}/u.test(head)) return name
  return name.charAt(0).toLowerCase() + name.slice(1)
}
