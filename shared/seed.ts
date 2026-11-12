import type {
  DemoPreset,
  FinancialProfile,
  Product,
  Purchase,
  ScheduledFlow,
  Transaction,
} from './types.ts'
import { addDays, daysBetween, forecast, todayInTimezone } from './finance.ts'

/** Time zone for the synthetic persona when the viewer's own zone is unknown. */
export const DEMO_TIMEZONE = 'America/New_York'

/** A separately branded sandbox store. Worth acts for the buyer and sells nothing itself. */
export const DEMO_MERCHANT = 'Larkspur Supply'

export const PRODUCTS: Product[] = [
  // The sample person's camera. Halden is an invented brand; the photo shows no brand mark.
  {
    id: 'halden-x5',
    name: 'Halden X5',
    subtitle: 'Full-frame mirrorless camera',
    description:
      'A full-frame mirrorless camera body for paid shoots: stills, video and low light.',
    priceCents: 189900,
    category: 'Cameras',
    image: '/images/halden-x5.jpg',
    color: '#f6a01a',
    merchant: DEMO_MERCHANT,
    tag: 'For the next shoot',
    aliases: ['halden'],
  },
  {
    id: 'headphones',
    name: 'Studio headphones',
    description: 'Closed-back over-ear headphones for focused listening at home or on the go.',
    priceCents: 34900,
    category: 'Audio',
    image: '/images/headphones.jpg',
    color: '#ebe6da',
    merchant: DEMO_MERCHANT,
    tag: 'On your radar',
    aliases: ['headphones'],
  },
  {
    id: 'camera',
    name: 'Everyday camera',
    description: 'A compact interchangeable-lens camera body for everyday photos and video.',
    priceCents: 119900,
    category: 'Cameras',
    image: '/images/camera.jpg',
    color: '#e9ece7',
    merchant: DEMO_MERCHANT,
    tag: 'A bigger little dream',
    aliases: ['camera'],
  },
  {
    id: 'chair',
    name: 'Desk chair',
    description: 'An upholstered chair with a supportive back for a small home workspace.',
    priceCents: 44900,
    category: 'Home office',
    image: '/images/chair.jpg',
    color: '#e8e1d9',
    merchant: DEMO_MERCHANT,
    aliases: ['chair'],
  },
  {
    id: 'backpack',
    name: 'Travel backpack',
    description: 'A carry-on-sized backpack with a padded laptop sleeve for weekends away.',
    priceCents: 12900,
    category: 'Travel',
    // Placeholder photograph until the catalog images are replaced.
    image: '/images/weekend.jpg',
    color: '#eee9dd',
    merchant: DEMO_MERCHANT,
    aliases: ['backpack'],
  },
  // Real products, sold here only by the sandbox store (scope amendment A3). Their photos show
  // no brand mark; see docs/DESIGN-SOURCES.md.
  {
    id: 'macbook-pro-14',
    name: 'MacBook Pro 14-inch',
    description: 'A 14-inch laptop with room for photo and video editing, listed at its US price.',
    priceCents: 249900,
    category: 'Computers',
    image: '/images/laptop.jpg',
    color: '#f3df90',
    merchant: DEMO_MERCHANT,
    aliases: ['macbook'],
  },
  {
    id: 'airpods-4',
    name: 'AirPods 4',
    description: 'Wireless earbuds with a charging case, listed at their US price.',
    priceCents: 12900,
    category: 'Audio',
    image: '/images/earbuds.jpg',
    color: '#efc84a',
    merchant: DEMO_MERCHANT,
    aliases: ['airpods'],
  },
]

/** The persona's existing Pay in 4 plan: the first payment was two days ago. */
const EXISTING_PLAN = { id: 'laptop-plan', name: 'Laptop · Pay in 4', paymentCents: 16000 }

/**
 * Maya is a labelled synthetic persona near the edge: paid every two weeks, rent due inside the
 * comparison window, and one Pay in 4 plan already running. Every date is relative to today.
 */
export function createDemoState(
  today?: string,
  timezone = DEMO_TIMEZONE,
): {
  profile: FinancialProfile
  transactions: Transaction[]
  purchases: Purchase[]
  wishlist: string[]
} {
  today ??= todayInTimezone(timezone)
  const scheduled = (
    days: number,
    item: Omit<ScheduledFlow, 'nextDate' | 'cadence' | 'confirmed' | 'active'> &
      Partial<Pick<ScheduledFlow, 'cadence'>>,
  ): ScheduledFlow => ({
    cadence: 'monthly',
    confirmed: true,
    active: true,
    ...item,
    nextDate: addDays(today, days),
  })
  const profile: FinancialProfile = {
    name: 'Maya',
    balanceCents: 130000,
    cushionCents: 30000,
    dailySpendCents: 3000,
    currency: 'USD',
    timezone,
    snapshotDate: today,
    confirmedAt: `${today}T12:00:00.000Z`,
    version: 1,
    confirmed: true,
    coverageDays: 90,
    source: 'demo',
    missingFields: [],
    reflectedPurchaseIds: [],
    aiConsent: false,
    userEdited: false,
    flows: [
      scheduled(5, {
        id: 'salary',
        name: 'Biweekly paycheck',
        amountCents: 210000,
        cadence: 'biweekly',
        kind: 'income',
        category: 'Income',
        color: '#b6d58d',
        icon: 'briefcase',
      }),
      scheduled(13, {
        id: 'rent',
        name: 'Apartment rent',
        amountCents: 145000,
        kind: 'bill',
        category: 'Home',
        color: '#d6af8e',
        icon: 'home',
      }),
      scheduled(2, {
        id: 'car-insurance',
        name: 'Car insurance',
        amountCents: 12800,
        kind: 'bill',
        category: 'Transport',
        color: '#b1c8d9',
        icon: 'car',
      }),
      scheduled(7, {
        id: 'gym',
        name: 'Gym membership',
        amountCents: 3500,
        kind: 'subscription',
        category: 'Health',
        color: '#bfd49e',
        icon: 'dumbbell',
      }),
      scheduled(9, {
        id: 'phone',
        name: 'Phone plan',
        amountCents: 6500,
        kind: 'bill',
        category: 'Utilities',
        color: '#c4bee0',
        icon: 'smartphone',
      }),
      scheduled(11, {
        id: 'music',
        name: 'Music streaming',
        amountCents: 1199,
        kind: 'subscription',
        category: 'Entertainment',
        color: '#b8d99c',
        icon: 'music',
      }),
      scheduled(18, {
        id: 'student-loan',
        name: 'Student loan',
        amountCents: 21000,
        kind: 'bill',
        category: 'Loans',
        color: '#e7cbb1',
        icon: 'graduation-cap',
      }),
      scheduled(22, {
        id: 'internet',
        name: 'Home internet',
        amountCents: 6000,
        kind: 'bill',
        category: 'Home',
        color: '#c4bee0',
        icon: 'wifi',
      }),
      scheduled(24, {
        id: 'video',
        name: 'Video streaming',
        amountCents: 1549,
        kind: 'subscription',
        category: 'Entertainment',
        color: '#edb6a8',
        icon: 'tv',
      }),
      scheduled(26, {
        id: 'utilities',
        name: 'Electric and gas',
        amountCents: 9500,
        kind: 'bill',
        category: 'Home',
        color: '#d7b897',
        icon: 'zap',
      }),
      ...[12, 26, 40].map((days, index) =>
        scheduled(days, {
          id: `${EXISTING_PLAN.id}-${index + 2}`,
          name: EXISTING_PLAN.name,
          amountCents: EXISTING_PLAN.paymentCents,
          cadence: 'once',
          kind: 'installment',
          category: 'Instalment plans',
          color: '#c9c2e6',
          icon: 'laptop',
          planId: EXISTING_PLAN.id,
        }),
      ),
    ],
  }
  const transactions: Transaction[] = []
  const shops = [
    { name: 'Grocery market', category: 'Groceries', color: '#b6ce9f' },
    { name: 'Corner grocer', category: 'Groceries', color: '#b6ce9f' },
    { name: 'Coffee bar', category: 'Food & drink', color: '#d7b897' },
    { name: 'Salad bar', category: 'Food & drink', color: '#bfd49e' },
    { name: 'Neighborhood Market', category: 'Groceries', color: '#b6ce9f' },
    { name: 'City transit', category: 'Transport', color: '#b1c8d9' },
    { name: 'Local kitchen', category: 'Food & drink', color: '#e4c8aa' },
  ]
  for (let daysAgo = 89; daysAgo >= 0; daysAgo--) {
    const date = addDays(today, -daysAgo)
    const shop = shops[daysAgo % shops.length]!
    // Deterministic variation keeps the sample reproducible without identical daily purchases.
    const amount = 1450 + ((daysAgo * 719 + 113) % 3950)
    transactions.push({
      id: `demo:daily:${date}`,
      date,
      ...shop,
      amountCents: -amount,
      currency: 'USD',
      kind: 'expense',
      status: 'completed',
      source: 'demo',
    })
    if (daysAgo % 3 === 0)
      transactions.push({
        id: `demo:coffee:${date}`,
        date,
        name: daysAgo % 2 ? 'Coffee bar' : 'City transit',
        amountCents: -(daysAgo % 2 ? 675 : 580),
        currency: 'USD',
        category: daysAgo % 2 ? 'Food & drink' : 'Transport',
        kind: 'expense',
        status: 'completed',
        source: 'demo',
        color: '#d7b897',
      })
  }
  const pastOccurrences = (flow: ScheduledFlow): string[] => {
    if (flow.cadence === 'once') return []
    if (flow.cadence === 'biweekly')
      return [1, 2, 3, 4, 5, 6, 7].map((cycles) => addDays(flow.nextDate, -14 * cycles))
    const [year, month, day] = flow.nextDate.split('-').map(Number)
    return [1, 2, 3, 4].map((monthsAgo) => {
      const monthStart = new Date(Date.UTC(year, month - 1 - monthsAgo, 1, 12))
      const lastDay = new Date(
        Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0, 12),
      ).getUTCDate()
      return new Date(
        Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), Math.min(day, lastDay), 12),
      )
        .toISOString()
        .slice(0, 10)
    })
  }
  for (const flow of profile.flows)
    for (const date of pastOccurrences(flow)) {
      if (date > today || date < addDays(today, -89)) continue
      transactions.push({
        id: `demo:${flow.id}:${date}`,
        date,
        name: flow.name,
        amountCents: flow.kind === 'income' ? flow.amountCents : -flow.amountCents,
        currency: 'USD',
        category: flow.category,
        kind: flow.kind === 'income' ? 'income' : 'expense',
        status: 'completed',
        source: 'demo',
        color: flow.color,
      })
    }
  transactions.push(
    {
      id: `demo:${EXISTING_PLAN.id}-1`,
      date: addDays(today, -2),
      name: EXISTING_PLAN.name,
      amountCents: -EXISTING_PLAN.paymentCents,
      currency: 'USD',
      category: 'Instalment plans',
      kind: 'expense',
      status: 'completed',
      source: 'demo',
      color: '#c9c2e6',
    },
    {
      id: 'demo:transfer',
      date: addDays(today, -9),
      name: 'Transfer from checking',
      amountCents: 30000,
      currency: 'USD',
      category: 'Transfers',
      kind: 'transfer',
      status: 'completed',
      source: 'demo',
      color: '#c4c6bb',
    },
    {
      id: 'demo:refund',
      date: addDays(today, -16),
      name: 'Clothing store · returned item',
      amountCents: 4900,
      currency: 'USD',
      category: 'Refunds',
      kind: 'refund',
      status: 'completed',
      source: 'demo',
      color: '#c4c6bb',
      referenceId: 'demo:clothing',
    },
    {
      id: 'demo:clothing',
      date: addDays(today, -22),
      name: 'Clothing store',
      amountCents: -4900,
      currency: 'USD',
      category: 'Shopping',
      kind: 'expense',
      status: 'completed',
      source: 'demo',
      color: '#e7cbb1',
    },
  )
  return {
    profile,
    transactions: transactions.sort(
      (a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id),
    ),
    purchases: [],
    wishlist: ['headphones', 'camera'],
  }
}

/** The demo day: Alex checks the camera on Fri Nov 13 2026. Every Alex date is absolute. */
export const ALEX_DEMO_DAY = '2026-11-13'
/** The return visit: the day the camera fits, after the Dec 14 invoice is paid. */
export const ALEX_RETURN_DAY = '2026-12-15'
/**
 * The day the contest video was recorded. Pinning Maya to it reproduces that video exactly: rent
 * on Fri Oct 16, wait until Fri Oct 23, buy-today low −$458.99 on Thu Oct 22.
 */
export const VIDEO_REPLAY_DAY = '2026-10-03'
/** The day each pinned preset shows. */
export const DEMO_PRESET_DAYS: Record<DemoPreset, string> = {
  video: VIDEO_REPLAY_DAY,
  demo: ALEX_DEMO_DAY,
  'demo-dec15': ALEX_RETURN_DAY,
}
/** The pinned sample days a `?replay=` link can ask for, on Worth and on the store. */
export const DEMO_PRESETS = ['video', 'demo', 'demo-dec15'] as const satisfies DemoPreset[]
/** A `?replay=` value when it names a preset; anything else is ignored. */
export const demoPreset = (value: unknown): DemoPreset | undefined =>
  DEMO_PRESETS.find((preset) => preset === value)
/** The camera Alex wants, in the catalog above. */
export const ALEX_CAMERA_ID = 'halden-x5'

type MonthlyItem = Omit<ScheduledFlow, 'nextDate' | 'cadence' | 'confirmed' | 'active'> & {
  anchorDay: number | 'last'
}
type OnceItem = Omit<ScheduledFlow, 'cadence' | 'confirmed' | 'active'>

const LAPTOP_PLAN = { id: 'laptop-plan', name: 'Laptop · Pay in 4', paymentCents: 32475 }

const ALEX_MONTHLY: MonthlyItem[] = [
  {
    id: 'salary',
    name: 'Salary',
    amountCents: 390000,
    anchorDay: 'last',
    kind: 'income',
    category: 'Income',
    color: '#b6d58d',
    icon: 'briefcase',
  },
  {
    id: 'rent',
    name: 'Rent',
    amountCents: 175000,
    anchorDay: 1,
    kind: 'bill',
    category: 'Home',
    color: '#d6af8e',
    icon: 'home',
  },
  {
    id: 'phone',
    name: 'Phone plan',
    amountCents: 6500,
    anchorDay: 18,
    kind: 'bill',
    category: 'Utilities',
    color: '#c4bee0',
    icon: 'smartphone',
  },
  {
    id: 'internet',
    name: 'Home internet',
    amountCents: 7000,
    anchorDay: 22,
    kind: 'bill',
    category: 'Home',
    color: '#c4bee0',
    icon: 'wifi',
  },
  {
    id: 'car-insurance',
    name: 'Car insurance',
    amountCents: 13200,
    anchorDay: 25,
    kind: 'bill',
    category: 'Transport',
    color: '#b1c8d9',
    icon: 'car',
  },
  {
    id: 'utilities',
    name: 'Electric and gas',
    amountCents: 11000,
    anchorDay: 5,
    kind: 'bill',
    category: 'Home',
    color: '#d7b897',
    icon: 'zap',
  },
  {
    id: 'student-loan',
    name: 'Student loan',
    amountCents: 28000,
    anchorDay: 10,
    kind: 'bill',
    category: 'Loans',
    color: '#e7cbb1',
    icon: 'graduation-cap',
  },
  {
    id: 'gym',
    name: 'Gym membership',
    amountCents: 4000,
    anchorDay: 20,
    kind: 'subscription',
    category: 'Health',
    color: '#bfd49e',
    icon: 'dumbbell',
  },
  {
    id: 'video',
    name: 'Video streaming',
    amountCents: 1599,
    anchorDay: 27,
    kind: 'subscription',
    category: 'Entertainment',
    color: '#edb6a8',
    icon: 'tv',
  },
  {
    id: 'music',
    name: 'Music streaming',
    amountCents: 1199,
    anchorDay: 9,
    kind: 'subscription',
    category: 'Entertainment',
    color: '#b8d99c',
    icon: 'music',
  },
]

/** Dated one-off items: the photo-shoot invoice and the laptop plan's four payments. */
const ALEX_ONCE: OnceItem[] = [
  {
    id: 'photo-invoice',
    name: 'Photo shoot invoice · PayPal',
    amountCents: 165000,
    nextDate: '2026-12-14',
    kind: 'income',
    category: 'Income',
    color: '#b6d58d',
    icon: 'camera',
    origin: 'paypal',
  },
  ...['2026-11-06', '2026-11-20', '2026-12-04', '2026-12-18'].map((nextDate, index): OnceItem => ({
    id: `${LAPTOP_PLAN.id}-${index + 1}`,
    name: LAPTOP_PLAN.name,
    amountCents: LAPTOP_PLAN.paymentCents,
    nextDate,
    kind: 'installment',
    category: 'Instalment plans',
    color: '#c9c2e6',
    icon: 'laptop',
    planId: LAPTOP_PLAN.id,
    planTotalCents: 129900,
    origin: 'paypal',
  })),
]

/** The `anchor` day of the month that `date` is in, clamped to the month's length. */
function anchoredIn(date: string, anchor: number | 'last'): string {
  const [year, month] = date.split('-').map(Number) as [number, number]
  const lastDay = new Date(Date.UTC(year, month, 0, 12)).getUTCDate()
  const day = anchor === 'last' ? lastDay : Math.min(anchor, lastDay)
  return `${date.slice(0, 8)}${String(day).padStart(2, '0')}`
}

/** The first day on or after `from` that falls on `anchor`. */
function nextAnchored(from: string, anchor: number | 'last'): string {
  const here = anchoredIn(from, anchor)
  if (here >= from) return here
  const [year, month] = from.split('-').map(Number) as [number, number]
  const next = new Date(Date.UTC(year, month, 1, 12)).toISOString().slice(0, 10)
  return anchoredIn(next, anchor)
}

/** Alex's plan as it stands on `today`: monthly items from their next date, one-offs still ahead. */
function alexFlows(today: string): ScheduledFlow[] {
  return [
    ...ALEX_MONTHLY.map((item): ScheduledFlow => ({
      ...item,
      cadence: 'monthly',
      confirmed: true,
      active: true,
      nextDate: nextAnchored(today, item.anchorDay),
    })),
    ...ALEX_ONCE.filter((item) => item.nextDate >= today).map((item): ScheduledFlow => ({
      ...item,
      cadence: 'once',
      confirmed: true,
      active: true,
    })),
  ]
}

/**
 * Alex is the sample person the demo and the video share: salaried at month end, rent on the 1st,
 * a laptop on PayPal Pay in 4 and a photo-shoot invoice due Mon Dec 14. On Fri Nov 13 the $1,899
 * Halden X5 does not fit; on Tue Dec 15 it does. Unlike Maya, every date is absolute, so the
 * story holds only on the days it was tuned for: `today` is the demo day or a later day, and a
 * later day starts from the funds the Nov 13 plan projects for that morning.
 */
export function createCameraScenario(
  today: string = ALEX_DEMO_DAY,
  timezone = DEMO_TIMEZONE,
): {
  profile: FinancialProfile
  transactions: Transaction[]
  purchases: Purchase[]
  wishlist: string[]
} {
  if (today < ALEX_DEMO_DAY || daysBetween(ALEX_DEMO_DAY, today) > 60)
    throw new Error(`Alex's plan starts on ${ALEX_DEMO_DAY} and runs 60 days.`)
  const base: FinancialProfile = {
    name: 'Alex',
    balanceCents: 254000,
    cushionCents: 30000,
    dailySpendCents: 4000,
    currency: 'USD',
    timezone,
    snapshotDate: ALEX_DEMO_DAY,
    confirmedAt: `${ALEX_DEMO_DAY}T12:00:00.000Z`,
    version: 1,
    confirmed: true,
    coverageDays: 90,
    source: 'demo',
    missingFields: [],
    reflectedPurchaseIds: [],
    aiConsent: false,
    userEdited: false,
    flows: alexFlows(ALEX_DEMO_DAY),
  }
  // A later day opens on the balance the demo-day plan projects for that morning.
  const days = daysBetween(ALEX_DEMO_DAY, today)
  const balanceCents = days
    ? forecast(base, [], { today: ALEX_DEMO_DAY, days: days - 1 }).at(-1)!.baselineCents
    : base.balanceCents
  const profile: FinancialProfile = {
    ...base,
    balanceCents,
    snapshotDate: today,
    confirmedAt: `${today}T12:00:00.000Z`,
    flows: alexFlows(today),
  }
  return { profile, transactions: alexHistory(today), purchases: [], wishlist: [] }
}

/** About 90 days of history before `today` that matches the plan: every item on its own day. */
function alexHistory(today: string): Transaction[] {
  const transactions: Transaction[] = []
  const add = (
    id: string,
    date: string,
    name: string,
    amountCents: number,
    category: string,
    color?: string,
  ) =>
    transactions.push({
      id: `demo:${id}:${date}`,
      date,
      name,
      amountCents,
      currency: 'USD',
      category,
      kind: amountCents > 0 ? 'income' : 'expense',
      status: 'completed',
      source: 'demo',
      ...(color ? { color } : {}),
    })
  // Each shop spends within its own range; with a coffee every other day, about $38 a day.
  const shops = [
    { name: 'Grocery market', category: 'Groceries', color: '#b6ce9f', from: 6000, to: 9500 },
    { name: 'City transit', category: 'Transport', color: '#b1c8d9', from: 275, to: 550 },
    { name: 'Corner grocer', category: 'Groceries', color: '#b6ce9f', from: 2500, to: 4500 },
    { name: 'Noodle house', category: 'Food & drink', color: '#e4c8aa', from: 1600, to: 3200 },
    { name: 'Gas station', category: 'Transport', color: '#b1c8d9', from: 3500, to: 5500 },
    {
      name: 'Camera shop · film and batteries',
      category: 'Hobbies',
      color: '#c4c6bb',
      from: 1500,
      to: 4500,
    },
    { name: 'Neighborhood market', category: 'Groceries', color: '#b6ce9f', from: 4000, to: 7000 },
    { name: 'Pharmacy', category: 'Health', color: '#bfd49e', from: 900, to: 2500 },
  ]
  for (let daysAgo = 90; daysAgo >= 1; daysAgo--) {
    const date = addDays(today, -daysAgo)
    // Keyed by the date itself, so the same day reads the same on every visit.
    const index = daysBetween(ALEX_DEMO_DAY, date) + 1000
    const { from, to, ...shop } = shops[index % shops.length]!
    const amount = from + ((index * 719 + 113) % (to - from))
    add('daily', date, shop.name, -amount, shop.category, shop.color)
    if (index % 2)
      add('coffee', date, 'Coffee bar', -(450 + (index % 5) * 90), 'Food & drink', '#d7b897')
    for (const item of ALEX_MONTHLY)
      if (anchoredIn(date, item.anchorDay) === date)
        add(
          item.id,
          date,
          item.name,
          item.kind === 'income' ? item.amountCents : -item.amountCents,
          item.category,
          item.color,
        )
    for (const item of ALEX_ONCE)
      if (item.nextDate === date)
        add(
          item.id,
          date,
          item.name,
          item.kind === 'income' ? item.amountCents : -item.amountCents,
          item.category,
          item.color,
        )
  }
  // An earlier shoot, paid the same way, so the invoice due Dec 14 is not a one-off out of nowhere.
  const earlier = '2026-09-21'
  if (earlier < today && earlier >= addDays(today, -90))
    add('photo-invoice', earlier, 'Photo shoot invoice · PayPal', 90000, 'Income', '#b6d58d')
  return transactions.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
}

/**
 * Moves an untouched synthetic persona to the viewer's day: the funds snapshot becomes today, and
 * scheduled items and synthetic history shift by the same number of days. Completed purchases keep
 * their real dates. Returns undefined when nothing changes or the plan holds the user's own data.
 */
export function rebaseDemoState<
  T extends { profile: FinancialProfile; transactions: Transaction[] },
>(data: T, today: string, timezone: string): T | undefined {
  const { profile } = data
  if (profile.source !== 'demo' || profile.userEdited !== false) return undefined
  if (profile.snapshotDate === today && profile.timezone === timezone) return undefined
  const delta = daysBetween(profile.snapshotDate, today)
  const shift = (date: string) => (delta ? addDays(date, delta) : date)
  return {
    ...data,
    profile: {
      ...profile,
      timezone,
      snapshotDate: today,
      confirmedAt: `${today}T12:00:00.000Z`,
      // The plan changed under any open editor, so stale saves are rejected.
      version: profile.version + 1,
      flows: profile.flows.map((flow) => ({ ...flow, nextDate: shift(flow.nextDate) })),
    },
    transactions: data.transactions.map((transaction) =>
      transaction.source === 'demo'
        ? { ...transaction, date: shift(transaction.date) }
        : transaction,
    ),
  }
}
