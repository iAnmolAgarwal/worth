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
