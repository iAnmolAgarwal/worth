import { z } from 'zod'
import { addDays, daysBetween, forecast } from '../shared/finance.ts'
import { randomUUID } from 'node:crypto'
import {
  ALEX_CAMERA_ID,
  ALEX_DEMO_DAY,
  ALEX_RETURN_DAY,
  createCameraScenario,
  createDemoState,
  DEMO_PRESET_DAYS,
  DEMO_PRESETS,
  PRODUCTS,
} from '../shared/seed.ts'
import type { Purchase, SamplePersona, SavedItem } from '../shared/types.ts'
import type { SessionData } from './store.ts'

export { VIDEO_REPLAY_DAY } from '../shared/seed.ts'
/** How far the clock may move past the sample plan's funds date: the comparison window. */
export const DEMO_CLOCK_MAX_DAYS = 60
/** A new session's sample plan: Alex on the pinned demo day, or Maya on the viewer's today. */
export function sampleSession(
  persona: SamplePersona,
  realToday: string,
  timezone: string,
  now = new Date(),
): Pick<SessionData, 'profile' | 'transactions' | 'wishlist' | 'demoClock' | 'saved'> {
  if (persona === 'maya') {
    const { profile, transactions, wishlist } = createDemoState(realToday, timezone)
    return { profile, transactions, wishlist }
  }
  const { profile, transactions, wishlist } = createCameraScenario(ALEX_DEMO_DAY, timezone)
  return {
    profile,
    transactions,
    wishlist,
    saved: alexSaved('demo', now),
    demoClock: { today: ALEX_DEMO_DAY, preset: 'demo' },
  }
}

/** A catalog item Alex saved before the story starts: marked `seeded`, never a store's. */
function seededItem(productId: string, now: Date, waitDate?: string): SavedItem {
  const product = PRODUCTS.find((p) => p.id === productId)!
  return {
    id: randomUUID(),
    kind: 'catalog',
    productId,
    name: product.name,
    amountCents: product.priceCents,
    ...(waitDate ? { option: 'wait' as const, waitDate } : {}),
    createdAt: now.toISOString(),
    status: 'active',
    seeded: true,
  }
}

/**
 * Alex's Saved on a pinned day: the Halden X5 and the studio headphones. On the demo day the
 * camera has no date yet (its check offers "Save for Tue, Dec 15"); on the return visit it is
 * saved for Dec 15, so it is ready. Neither carries a store name or link.
 */
function alexSaved(preset: 'demo' | 'demo-dec15', now: Date): SavedItem[] {
  return [
    seededItem('headphones', now),
    seededItem(ALEX_CAMERA_ID, now, preset === 'demo-dec15' ? ALEX_RETURN_DAY : undefined),
  ]
}

/** The items the person saved themselves; seeded ones belong only to the sample they came with. */
export function ownSaved(saved: SavedItem[] | undefined): SavedItem[] {
  return (saved ?? []).filter((item) => !item.seeded)
}

export const demoClockSchema = z.union([
  z.object({ preset: z.enum([...DEMO_PRESETS, 'today']) }).strict(),
  z
    .object({
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .refine((value) => {
          const parsed = new Date(`${value}T12:00:00Z`)
          return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
        }, 'Use a valid calendar date'),
    })
    .strict(),
])
export type DemoClockInput = z.infer<typeof demoClockSchema>

export class DemoClockError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
}

/** The demo clock's day, only while the session holds the synthetic persona. */
export function demoToday(data: SessionData): string | undefined {
  return data.profile.source === 'demo' ? data.demoClock?.today : undefined
}

/**
 * A fresh synthetic persona dated `day`, keeping the session's saved items, retention and the
 * user's own choice about Claude. The plan version moves on, so any open editor is stale. Maya
 * can be dated any day; Alex only from his demo day on.
 */
export function freshPersona(
  data: SessionData,
  day: string,
  timezone: string,
  persona: SamplePersona = 'maya',
): SessionData {
  const seed =
    persona === 'maya' ? createDemoState(day, timezone) : createCameraScenario(day, timezone)
  const previous = data.profile
  return {
    ...data,
    profile: {
      ...seed.profile,
      version: previous.version + 1,
      aiConsent: previous.aiConsent,
      ...(previous.aiChoiceMade ? { aiChoiceMade: true } : {}),
    },
    transactions: seed.transactions,
    foreignPayments: undefined,
  }
}

/**
 * Applies a demo-clock request. A preset pins a fresh persona to its day: `video` is Maya on the
 * recording day, `demo` and `demo-dec15` are Alex on Nov 13 and on Dec 15 with the camera saved
 * and ready. A date moves the clock forward from the persona's funds date without changing the
 * plan, so today's funds need confirming. `today` restarts the default sample: Maya on the real
 * date, or Alex on his demo day, whose dates are fixed. Imported data refuses.
 */
export function applyDemoClock(
  data: SessionData,
  input: DemoClockInput,
  realToday: string,
  options: {
    persona?: SamplePersona
    now?: Date
  } = {},
): { data: SessionData; reset: boolean } {
  const persona = options.persona ?? 'alex'
  if (data.profile.source !== 'demo')
    throw new DemoClockError(
      409,
      'The demo clock works only on the sample persona. Your imported data always uses today’s date.',
      'DEMO_CLOCK_SAMPLE_ONLY',
    )
  const timezone = data.profile.timezone
  if ('preset' in input) {
    if (input.preset === 'today' && persona === 'maya') {
      const next = freshPersona(data, realToday, timezone)
      delete next.demoClock
      return { data: next, reset: true }
    }
    const preset = input.preset === 'today' ? 'demo' : input.preset
    const day = DEMO_PRESET_DAYS[preset]
    const next = freshPersona(data, day, timezone, preset === 'video' ? 'maya' : 'alex')
    // A restart brings back the preset's own saved items; what the person saved stays.
    const own = ownSaved(data.saved)
    next.saved =
      preset === 'video'
        ? own
        : [
            ...own.filter((item) => item.productId !== ALEX_CAMERA_ID),
            ...alexSaved(preset, options.now ?? new Date()),
          ]
    return { data: { ...next, demoClock: { today: day, preset } }, reset: true }
  }
  // A hand-edited plan holds the user's own numbers, which never run on the clock (re-judge N1).
  // The presets restart the untouched sample persona, so only a moved day is refused.
  if (data.profile.userEdited !== false)
    throw new DemoClockError(
      409,
      'The demo clock moves only the untouched sample plan. Start the sample again to use it.',
      'DEMO_CLOCK_SAMPLE_ONLY',
    )
  const from = data.profile.snapshotDate
  if (input.date < from || input.date > addDays(from, DEMO_CLOCK_MAX_DAYS))
    throw new DemoClockError(
      400,
      `Choose a day from ${from} through ${addDays(from, DEMO_CLOCK_MAX_DAYS)}: the clock moves forward from the sample plan’s funds date.`,
      'INVALID_DATE',
    )
  return { data: { ...data, demoClock: { today: input.date } }, reset: false }
}

/**
 * The synthetic persona's projected balance at the start of `today`: the sample plan's own
 * forecast from its funds date through yesterday's close. Never computed for imported data or a
 * hand-edited plan.
 */
export function fundsProjection(
  data: SessionData,
  purchases: Purchase[],
  today: string,
): { cents: number; from: string } | undefined {
  const { profile } = data
  if (
    profile.source !== 'demo' ||
    profile.userEdited !== false ||
    !profile.confirmed ||
    profile.snapshotDate >= today
  )
    return undefined
  const days = daysBetween(profile.snapshotDate, today)
  if (days > DEMO_CLOCK_MAX_DAYS + 30) return undefined
  const points = forecast(profile, purchases, { today: profile.snapshotDate, days: days - 1 })
  return { cents: points.at(-1)!.baselineCents, from: profile.snapshotDate }
}
