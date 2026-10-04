import { z } from 'zod'
import { addDays, daysBetween, forecast } from '../shared/finance.ts'
import { createDemoState } from '../shared/seed.ts'
import type { Purchase } from '../shared/types.ts'
import type { SessionData } from './store.ts'

/**
 * The day the contest video was recorded. Pinning the synthetic persona to it reproduces the
 * video exactly: rent on Fri Oct 16, wait until Fri Oct 23, buy-today low −$458.99 on Thu Oct 22.
 */
export const VIDEO_REPLAY_DAY = '2026-10-03'
/** How far the clock may move past the sample plan's funds date: the comparison window. */
export const DEMO_CLOCK_MAX_DAYS = 60

export const demoClockSchema = z.union([
  z.object({ preset: z.enum(['video', 'today']) }).strict(),
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
 * user's own choice about Claude. The plan version moves on, so any open editor is stale.
 */
export function freshPersona(data: SessionData, day: string, timezone: string): SessionData {
  const seed = createDemoState(day, timezone)
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
 * Applies a demo-clock request. `video` pins a fresh persona to the recording day; a date moves
 * the clock forward from the persona's funds date without changing the plan, so today's funds
 * need confirming; `today` returns to the real date with a fresh persona. Imported data refuses.
 */
export function applyDemoClock(
  data: SessionData,
  input: DemoClockInput,
  realToday: string,
): { data: SessionData; reset: boolean } {
  if (data.profile.source !== 'demo')
    throw new DemoClockError(
      409,
      'The demo clock works only on the sample persona. Your imported data always uses today’s date.',
      'DEMO_CLOCK_SAMPLE_ONLY',
    )
  const timezone = data.profile.timezone
  if ('preset' in input) {
    if (input.preset === 'today') {
      const next = freshPersona(data, realToday, timezone)
      delete next.demoClock
      return { data: next, reset: true }
    }
    return {
      data: {
        ...freshPersona(data, VIDEO_REPLAY_DAY, timezone),
        demoClock: { today: VIDEO_REPLAY_DAY, preset: 'video' },
      },
      reset: true,
    }
  }
  // A hand-edited plan holds the user's own numbers, which never run on the clock (re-judge N1).
  // The presets restart the untouched sample persona, so only a moved day is refused.
  if (data.profile.userEdited !== false)
    throw new DemoClockError(
      409,
      'The demo clock moves only the untouched sample plan. Choose the video replay to start it again from Maya’s sample.',
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
