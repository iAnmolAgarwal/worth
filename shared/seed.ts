import type { FinancialProfile, Product, Purchase, ScheduledFlow, Transaction } from './types.ts'
import { addDays, daysBetween, todayInTimezone } from './finance.ts'

/** Time zone for the synthetic persona when the viewer's own zone is unknown. */
export const DEMO_TIMEZONE = 'America/New_York'

/** A separately branded sandbox store. Worth acts for the buyer and sells nothing itself. */
export const DEMO_MERCHANT = 'Larkspur Supply'

export const PRODUCTS: Product[] = [
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
