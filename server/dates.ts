import { addDays } from '../shared/finance.ts'

// Timing phrases in the user's own words. Claude resolves them to ISO dates; this
// reader decides whether timing was stated at all, which dates a known phrase may
// mean, and which phrases must be asked about instead of guessed.

export interface TimingRead {
  /** Timing phrases found in the text, in reading order. */
  phrases: string[]
  /** Dates a deterministic phrase may mean, or null when no phrase resolves deterministically. */
  candidates: string[] | null
  /** The conventional reading of a fuzzy phrase, e.g. the last day for "end of the month". */
  preferred?: string
  /** True when some stated phrase could not be resolved here; Claude may still resolve it. */
  unresolved: boolean
  /** Phrases that must be clarified whatever Claude says. */
  blocking: 'vague' | 'past' | 'invalid' | 'payday_missing' | null
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]
const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`
const SMALL: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fourteen: 14,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  couple: 2,
  few: 3,
}

export function validIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T12:00:00Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}
function daysFrom(from: string, to: string) {
  return Math.round(
    (new Date(`${to}T12:00:00Z`).valueOf() - new Date(`${from}T12:00:00Z`).valueOf()) / 86_400_000,
  )
}
function weekday(date: string) {
  return new Date(`${date}T12:00:00Z`).getUTCDay()
}
function iso(year: number, month: number, day: number) {
  const value = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  return validIsoDate(value) ? value : null
}
function lastDayOfMonth(date: string) {
  const [year, month] = date.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(year, month, 0, 12)).toISOString().slice(0, 10)
}
function nextWeekday(today: string, target: number, includeToday: boolean) {
  for (let offset = includeToday ? 0 : 1; offset <= 7; offset++) {
    const date = addDays(today, offset)
    if (weekday(date) === target) return date
  }
  return today
}
/** A calendar day-month in the coming year: this year unless it has passed. */
function upcoming(today: string, month: number, day: number) {
  const year = Number(today.slice(0, 4))
  const thisYear = iso(year, month, day)
  if (thisYear && thisYear >= today) return thisYear
  return iso(year + 1, month, day)
}
function monthIndex(name: string) {
  return MONTHS.findIndex((m) => m.startsWith(name.toLowerCase().slice(0, 3))) + 1
}
function count(value: string) {
  return /^\d+$/.test(value) ? Number(value) : (SMALL[value.toLowerCase()] ?? NaN)
}

/** A human label for an ISO date relative to today, e.g. "today" or "Fri, Oct 16". */
export function dateLabel(date: string, today: string) {
  if (date === today) return 'today'
  if (date === addDays(today, 1)) return 'tomorrow'
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}
/** A short calendar label, e.g. "Oct 16". */
export function shortLabel(date: string) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

interface Rule {
  pattern: RegExp
  /** Candidate dates, or day offsets as digit strings. */
  resolve: (match: RegExpMatchArray, today: string, incomeDate?: string) => string[] | null
  /** Whether the first candidate is the conventional reading of a fuzzy phrase. */
  prefer?: (match: RegExpMatchArray) => boolean
  blocking?: TimingRead['blocking']
}

const RULES: Rule[] = [
  // "When can I buy" asks for the earliest date; it is not itself a date.
  {
    pattern:
      /\b(?:when|how soon)\s+(?:can|could|should|would)\s+i\s+(?:(?:comfortably|safely|realistically)\s+)?(?:afford|buy|get|purchase)\b/gi,
    resolve: () => [],
  },
  {
    pattern: /\b(\d{4}-\d{2}-\d{2})\b/g,
    resolve: (m) => (validIsoDate(m[1]!) ? [m[1]!] : null),
    blocking: 'invalid',
  },
  {
    pattern: /\b(?:the\s+)?day\s+after\s+tomorrow\b/gi,
    resolve: (_m, today) => [addDays(today, 2)],
  },
  { pattern: /\btomorrow\b/gi, resolve: (_m, today) => [addDays(today, 1)] },
  {
    pattern:
      /\b(?:today|tonight|right\s+now|now|this\s+(?:morning|afternoon|evening)|immediately)\b/gi,
    resolve: (_m, today) => [today],
  },
  {
    pattern:
      /\b(?:in|within)\s+(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|fifteen|twenty|thirty|a\s+couple\s+of|a\s+few)\s+(days?|weeks?)\b|\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(days?|weeks?)\s+from\s+(?:now|today)\b/gi,
    resolve: (m) => {
      const n = count((m[1] ?? m[3])!.replace(/^a\s+(couple|few)\s*(?:of)?$/i, '$1'))
      const days = n * ((m[2] ?? m[4])!.toLowerCase().startsWith('week') ? 7 : 1)
      return Number.isInteger(days) ? [String(days)] : null
    },
  },
  {
    pattern:
      /\b(?:next|the\s+coming|the\s+following)\s+week\b|\ba\s+week\s+from\s+(?:now|today)\b/gi,
    resolve: (m, today) => {
      if (/from/i.test(m[0])) return [addDays(today, 7)]
      const monday = nextWeekday(today, 1, false)
      const week = Array.from({ length: 7 }, (_, i) => addDays(monday, i))
      return [...new Set([addDays(today, 7), ...week])]
    },
    prefer: () => true,
  },
  {
    pattern: /\b(?:(this|next|the\s+coming)\s+)?weekend\b/gi,
    resolve: (m, today) => {
      const saturday = nextWeekday(today, 6, true)
      const sunday = weekday(today) === 0 ? today : addDays(saturday, 1)
      const first = weekday(today) === 0 ? [today] : [saturday, sunday]
      if (/next/i.test(m[1] ?? '')) return [...first, ...first.map((d) => addDays(d, 7))]
      return first
    },
    prefer: (m) => !/next/i.test(m[1] ?? ''),
  },
  {
    pattern: new RegExp(
      String.raw`\b(?:(this|next|coming|on)\s+)?(${WEEKDAYS.join('|')})\b(?:\s+(?:after\s+next))?`,
      'gi',
    ),
    resolve: (m, today) => {
      const target = WEEKDAYS.indexOf(m[2]!.toLowerCase())
      const first = nextWeekday(today, target, false)
      if (/after\s+next/i.test(m[0])) return [addDays(first, 7)]
      if ((m[1] ?? '').toLowerCase() === 'next') return [first, addDays(first, 7)]
      return weekday(today) === target ? [today, first] : [first]
    },
  },
  {
    pattern:
      /\b(?:(?:at\s+|by\s+|around\s+)?the\s+)?end\s+of\s+(?:the\s+|this\s+)?month\b|\bmonth[-\s]end\b/gi,
    resolve: (_m, today) => {
      let last = lastDayOfMonth(today)
      if (addDays(last, -2) < today && last !== today) last = lastDayOfMonth(addDays(last, 1))
      return [last, addDays(last, -1), addDays(last, -2)].filter((d) => d >= today)
    },
    prefer: () => true,
  },
  {
    pattern:
      /\b(?:(?:at\s+)?the\s+)?(?:start|beginning|first)\s+of\s+next\s+month\b|\bfirst\s+of\s+the\s+month\b/gi,
    resolve: (_m, today) => [addDays(lastDayOfMonth(today), 1)],
  },
  {
    pattern: new RegExp(
      String.raw`\b${MONTH}\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?|\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH}\b(?:,?\s+(\d{4}))?`,
      'gi',
    ),
    resolve: (m, today) => {
      const month = monthIndex((m[1] ?? m[5])!)
      const day = Number(m[2] ?? m[4])
      const year = m[3] ?? m[6]
      const date = year ? iso(Number(year), month, day) : upcoming(today, month, day)
      return date ? [date] : null
    },
    blocking: 'invalid',
  },
  {
    pattern: /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/g,
    resolve: (m, today) => {
      const [a, b] = [Number(m[1]), Number(m[2])]
      const year = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : undefined
      const read = (month: number, day: number) =>
        year ? iso(year, month, day) : upcoming(today, month, day)
      const dates = [read(a, b), read(b, a)].filter((d): d is string => Boolean(d))
      return dates.length ? [...new Set(dates)] : null
    },
    blocking: 'invalid',
  },
  {
    pattern: /\b(?:on|by)\s+the\s+(\d{1,2})(?:st|nd|rd|th)\b|\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/gi,
    resolve: (m, today) => {
      const day = Number(m[1] ?? m[2])
      const [year, month] = today.split('-').map(Number) as [number, number]
      const date = iso(year, month, day)
      if (date && date >= today) return [date]
      const next = addDays(lastDayOfMonth(today), 1)
      const later = iso(Number(next.slice(0, 4)), Number(next.slice(5, 7)), day)
      return later ? [later] : null
    },
  },
  {
    pattern:
      /\b(after|on|at|once|when)\s+(?:i\s+(?:get|am|'m)\s+paid|(?:i\s+)?get\s+paid|(?:my\s+)?(?:next\s+)?(?:payday|paycheck|pay\s*day|pay\s*check|salary))\b|\b(?:next\s+)?(?:payday|pay\s*day)\b/gi,
    resolve: (m, _today, incomeDate) => {
      if (!incomeDate) return null
      return [/^(?:after|once|when)$/i.test(m[1] ?? '') ? addDays(incomeDate, 1) : incomeDate]
    },
    blocking: 'payday_missing',
  },
  {
    pattern:
      /\b(?:yesterday|last\s+(?:week|month|year|night|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|ago)\b/gi,
    resolve: () => null,
    blocking: 'past',
  },
  {
    pattern:
      /\b(?:soon|later(?:\s+on)?|someday|some\s+day|sometime|eventually|in\s+a\s+while|at\s+some\s+point|one\s+day|down\s+the\s+road|in\s+the\s+future|next\s+(?:month|year)|this\s+(?:month|year)|in\s+the\s+(?:spring|summer|fall|autumn|winter)|before\s+the\s+holidays|around\s+the\s+holidays)\b/gi,
    resolve: () => null,
    blocking: 'vague',
  },
]
// Timing words the rules above do not resolve. Claude may resolve them; if it
// cannot, the app asks.
const OTHER_TIMING = new RegExp(
  String.raw`\b(?:before|after|until|till|by|once)\s+(?:my\s+|the\s+|i\s+)?[a-z]+|\b(?:in|on|by)\s+(?:${MONTHS.filter((m) => m !== 'may').join('|')})\b|\b(?:in|on|by)\s+may\b|\b(?:next|this|coming)\s+(?:${WEEKDAYS.join('|')}|week|weekend|month|year)\b|\bin\s+[^?!.]{0,25}\b(?:days?|weeks?|months?|years?)\b`,
  'i',
)
const NON_TIMING_AFTER =
  /^(?:before|after|until|till|by|once)\s+(?:my\s+|the\s+|i\s+)?(?:buying|buy|purchasing|purchase|spending|checking|deciding|paying|it|this|that|then|all|way|myself|itself|far|card|cash|credit|paypal|default|hand|chance|comparison|contrast|accident|mistake|itself)\b/i

/** Read the timing a message states. `incomeDate` is the next confirmed income date. */
export function readTiming(text: string, today: string, incomeDate?: string): TimingRead {
  let remaining = ` ${text.toLowerCase().replace(/[’']/g, "'")} `
    // A weekday written before a calendar date ("Fri, Oct 16") adds nothing to the date.
    .replace(
      /\b(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*,?\s+(?=(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d)/g,
      ' ',
    )
  const phrases: string[] = []
  const candidates: string[][] = []
  let preferred: string | undefined
  let unresolved = false
  let blocking: TimingRead['blocking'] = null
  for (const rule of RULES) {
    remaining = remaining.replace(rule.pattern, (...args) => {
      const match = args.slice(0, -2) as unknown as RegExpMatchArray
      const offset = args.at(-2) as number
      const before = (args.at(-1) as string).slice(Math.max(0, offset - 14), offset)
      const relation = before.match(/\b(after|before|by)\s+(?:(?:the|this)\s*)?$/)?.[1]
      const resolved = rule.resolve(match, today, incomeDate)
      if (resolved && !resolved.length) return ' '
      phrases.push(relation ? `${relation} ${match[0].trim()}` : match[0].trim())
      if (!resolved) {
        unresolved = true
        if (rule.blocking && !blocking) blocking = rule.blocking
        return ' '
      }
      let dates = resolved.map((value) =>
        /^\d+$/.test(value) ? addDays(today, Number(value)) : value,
      )
      let prefer = dates.length > 1 && Boolean(rule.prefer?.(match))
      if (relation) {
        // "after the weekend" is the week that follows; "before" or "by" a day is a range.
        const sorted = [...dates].sort()
        const first = sorted[0]!
        const last = sorted.at(-1)!
        const span = (from: string, days: number) =>
          Array.from({ length: days }, (_, i) => addDays(from, i))
        dates =
          relation === 'after'
            ? span(addDays(last, 1), 7)
            : span(
                today,
                Math.max(
                  0,
                  daysFrom(today, relation === 'by' ? last : first) + (relation === 'by' ? 1 : 0),
                ),
              )
        prefer = relation === 'after'
      }
      if (!candidates.length && prefer) preferred = dates[0]
      candidates.push(dates)
      return ' '
    })
  }
  // Drop prepositions left behind by phrases already read, e.g. "after the" + weekend.
  remaining = remaining.replace(
    /\b(?:after|before|by|until|till|on|at|in|for|from)\s+(?:(?:the|this|my)\s+)?(?=\s|$)/g,
    ' ',
  )
  const other = remaining.match(OTHER_TIMING)
  if (other && !NON_TIMING_AFTER.test(other[0])) {
    phrases.push(other[0].trim())
    unresolved = true
  }
  if (!candidates.length) return { phrases, candidates: null, unresolved, blocking }
  // Several phrases must agree on at least one date; otherwise the timing is ambiguous.
  const common = candidates.reduce((acc, set) => acc.filter((d) => set.includes(d)))
  return {
    phrases,
    candidates: common.length ? common : [],
    ...(preferred && common.includes(preferred) ? { preferred } : {}),
    unresolved: unresolved || !common.length,
    blocking,
  }
}

/** The purchase window the engine supports: today through 30 days ahead. */
export function inWindow(date: string, today: string) {
  return validIsoDate(date) && date >= today && date <= addDays(today, 30)
}
