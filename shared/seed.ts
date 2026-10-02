import type { FinancialProfile, Product, Purchase, Transaction } from './types.ts'
import { addDays, todayInTimezone } from './finance.ts'

export const PRODUCTS: Product[] = [
  {
    id: 'headphones',
    name: 'Studio headphones',
    description: 'A little less noise. A lot more you. Make space for the music you love.',
    priceCents: 34900,
    category: 'Everyday upgrade',
    image: '/images/headphones.jpg',
    color: '#ebe6da',
    merchant: 'Worth Demo Store',
    tag: 'On your radar',
  },
  {
    id: 'camera',
    name: 'Everyday camera',
    description: 'For the moments worth keeping. Turn everyday scenes into something special.',
    priceCents: 119900,
    category: 'Creative tools',
    image: '/images/camera.jpg',
    color: '#e9ece7',
    merchant: 'Worth Demo Store',
    tag: 'A bigger little dream',
  },
  {
    id: 'chair',
    name: 'Form accent chair',
    description:
      'Your favorite corner, made a little more inviting. A considered addition to your space.',
    priceCents: 44900,
    category: 'Your space',
    image: '/images/chair.jpg',
    color: '#e8e1d9',
    merchant: 'Worth Demo Store',
  },
  {
    id: 'weekend',
    name: 'A weekend away',
    description: 'A change of scenery. A little room to breathe. Plan your next escape.',
    priceCents: 24900,
    category: 'Out of office',
    image: '/images/weekend.jpg',
    color: '#eee9dd',
    merchant: 'Worth Demo Store',
  },
]

export function createDemoState(today = todayInTimezone('America/New_York')): {
  profile: FinancialProfile
  transactions: Transaction[]
  purchases: Purchase[]
  wishlist: string[]
} {
  const profile: FinancialProfile = {
    name: 'Alex',
    balanceCents: 420000,
    cushionCents: 100000,
    dailySpendCents: 3900,
    currency: 'USD',
    timezone: 'America/New_York',
    snapshotDate: today,
    confirmedAt: `${today}T12:00:00.000Z`,
    version: 1,
    confirmed: true,
    coverageDays: 90,
    source: 'demo',
    missingFields: [],
    reflectedPurchaseIds: [],
    aiConsent: false,
    flows: [
      {
        id: 'rent',
        name: 'Apartment rent',
        amountCents: 175000,
        nextDate: addDays(today, 5),
        cadence: 'monthly',
        kind: 'bill',
        category: 'Home',
        confirmed: true,
        active: true,
        color: '#d6af8e',
        icon: 'home',
      },
      {
        id: 'salary',
        name: 'Monthly paycheck',
        amountCents: 420000,
        nextDate: addDays(today, 12),
        cadence: 'monthly',
        kind: 'income',
        category: 'Income',
        confirmed: true,
        active: true,
        color: '#b6d58d',
        icon: 'briefcase',
      },
      {
        id: 'spotify',
        name: 'Spotify Premium',
        amountCents: 1199,
        nextDate: addDays(today, 2),
        cadence: 'monthly',
        kind: 'subscription',
        category: 'Entertainment',
        confirmed: true,
        active: true,
        color: '#b8d99c',
        icon: 'music',
      },
      {
        id: 'netflix',
        name: 'Netflix',
        amountCents: 1549,
        nextDate: addDays(today, 7),
        cadence: 'monthly',
        kind: 'subscription',
        category: 'Entertainment',
        confirmed: true,
        active: true,
        color: '#edb6a8',
        icon: 'tv',
      },
      {
        id: 'icloud',
        name: 'iCloud+',
        amountCents: 299,
        nextDate: addDays(today, 18),
        cadence: 'monthly',
        kind: 'subscription',
        category: 'Software',
        confirmed: true,
        active: true,
        color: '#b9cddd',
        icon: 'cloud',
      },
      {
        id: 'adobe',
        name: 'Adobe Creative Cloud',
        amountCents: 2999,
        nextDate: addDays(today, 23),
        cadence: 'monthly',
        kind: 'subscription',
        category: 'Software',
        confirmed: true,
        active: true,
        color: '#e7cbb1',
        icon: 'pen-tool',
      },
      {
        id: 'internet',
        name: 'Home internet',
        amountCents: 6500,
        nextDate: addDays(today, 8),
        cadence: 'monthly',
        kind: 'bill',
        category: 'Home',
        confirmed: true,
        active: true,
        color: '#c4bee0',
        icon: 'wifi',
      },
    ],
  }
  const transactions: Transaction[] = []
  const shops = [
    { name: 'Whole Foods Market', category: 'Groceries', color: '#b6ce9f' },
    { name: 'Trader Joe’s', category: 'Groceries', color: '#b6ce9f' },
    { name: 'Blue Bottle Coffee', category: 'Food & drink', color: '#d7b897' },
    { name: 'Sweetgreen', category: 'Food & drink', color: '#bfd49e' },
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
        name: daysAgo % 2 ? 'Blue Bottle Coffee' : 'City transit',
        amountCents: -(daysAgo % 2 ? 675 : 580),
        currency: 'USD',
        category: daysAgo % 2 ? 'Food & drink' : 'Transport',
        kind: 'expense',
        status: 'completed',
        source: 'demo',
        color: '#d7b897',
      })
  }
  for (const flow of profile.flows) {
    const [year, month, day] = flow.nextDate.split('-').map(Number)
    for (let monthsAgo = 1; monthsAgo <= 4; monthsAgo++) {
      const monthStart = new Date(Date.UTC(year, month - 1 - monthsAgo, 1, 12))
      const lastDay = new Date(
        Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0, 12),
      ).getUTCDate()
      const date = new Date(
        Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), Math.min(day, lastDay), 12),
      )
        .toISOString()
        .slice(0, 10)
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
  }
  transactions.push(
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
      name: 'Uniqlo · returned item',
      amountCents: 4900,
      currency: 'USD',
      category: 'Refunds',
      kind: 'refund',
      status: 'completed',
      source: 'demo',
      color: '#c4c6bb',
      referenceId: 'demo:uniqlo',
    },
    {
      id: 'demo:uniqlo',
      date: addDays(today, -22),
      name: 'Uniqlo',
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
