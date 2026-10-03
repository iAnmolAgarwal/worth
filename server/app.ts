import express from 'express'
import type { ErrorRequestHandler, Request, Response } from 'express'
import cookieParser from 'cookie-parser'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  assessPurchase,
  addDays,
  compareOptions,
  normalizeTimezone,
  payIn4InRange,
  purchaseReviews,
} from '../shared/finance.ts'
import { createDemoState, DEMO_TIMEZONE, PRODUCTS, rebaseDemoState } from '../shared/seed.ts'
import { parsePayPalCsv } from '../shared/csv.ts'
import type {
  AppState,
  Assessment,
  FinancialProfile,
  Purchase,
  Transaction,
} from '../shared/types.ts'
import { ACTIVE, Store, publicPurchase } from './store.ts'
import type { SessionData, StoredPurchase } from './store.ts'
import { createPayPalGateway, PayPalError, validateOrder } from './paypal.ts'
import type { PayPalGateway, PayPalOrder } from './paypal.ts'
import {
  categoryCandidates,
  createChatProvider,
  fallbackCategories,
  fallbackReply,
} from './chat.ts'
import type { ChatProvider } from './chat.ts'
import { allowedOrigins, loadConfig } from './config.ts'
import type { AppConfig } from './config.ts'
import { WindowLimiter } from './limits.ts'
import { confirmPlan, confirmRefund, PlanError, recordRefund } from './plans.ts'

export type { AppConfig } from './config.ts'
export interface AppOptions {
  store?: Store
  config?: Partial<AppConfig>
  paypal?: PayPalGateway
  chat?: ChatProvider
  now?: () => Date
}
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'REQUEST_FAILED',
    readonly assessment?: Assessment,
  ) {
    super(message)
  }
}
const identifier = z.string().min(1).max(100)
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      !Number.isNaN(Date.parse(value)) &&
      new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value,
    'Use a valid calendar date',
  )
const cents = z.number().int().min(0).max(100_000_000)
const profileSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    balanceCents: cents,
    cushionCents: cents,
    dailySpendCents: cents,
    currency: z.literal('USD'),
    timezone: z
      .string()
      .max(80)
      .refine((value) => normalizeTimezone(value) !== undefined, 'Invalid timezone'),
    snapshotDate: date,
    confirmedAt: z.string().max(40),
    version: z.number().int().min(0),
    confirmed: z.boolean(),
    coverageDays: z.number().int().min(0).max(3650),
    source: z.enum(['demo', 'import']),
    missingFields: z.array(z.string().max(300)).max(30),
    reflectedPurchaseIds: z.array(identifier).max(1000),
    aiConsent: z.boolean(),
    userEdited: z.boolean().optional(),
    flows: z
      .array(
        z
          .object({
            id: identifier,
            name: z.string().trim().min(1).max(100),
            amountCents: cents,
            nextDate: date,
            anchorDay: z.union([z.number().int().min(1).max(31), z.literal('last')]).optional(),
            cadence: z.enum(['once', 'weekly', 'biweekly', 'monthly', 'yearly']),
            kind: z.enum(['income', 'subscription', 'bill', 'installment']),
            category: z.string().max(80),
            confirmed: z.boolean(),
            active: z.boolean(),
            color: z.string().max(30).optional(),
            icon: z.string().max(40).optional(),
            planId: identifier.optional(),
            paidOn: date.optional(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
const assessmentSchema = z
  .object({
    amountCents: cents,
    itemName: z.string().trim().min(1).max(150).optional(),
    purchaseDate: date.optional(),
  })
  .strict()
const compareSchema = z
  .object({
    amountCents: cents.optional(),
    itemName: z.string().trim().min(1).max(150).optional(),
    productId: identifier.optional(),
  })
  .strict()
  .refine(
    (input) => input.amountCents !== undefined || input.productId !== undefined,
    'Send a price or a product.',
  )
const instalmentsSchema = z.array(z.object({ date, amountCents: cents }).strict()).max(4)
const planSchema = z.discriminatedUnion('product', [
  z.object({ product: z.literal('full') }).strict(),
  z.object({ product: z.literal('payIn4'), instalments: instalmentsSchema.min(1) }).strict(),
])
const refundConfirmationSchema = z
  .object({ returnedCents: cents, remainingInstalments: instalmentsSchema.optional() })
  .strict()
const chatSchema = z
  .object({
    message: z.string().trim().min(1).max(2000),
    history: z
      .array(
        z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) }).strict(),
      )
      .max(16)
      .default([]),
    context: assessmentSchema.optional(),
    sessionKey: z
      .string()
      .regex(/^[a-f0-9]{20}$/)
      .optional(),
  })
  .strict()
const csvSchema = z.object({ csv: z.string().min(1).max(1_000_000) }).strict()
const DAY = 86400000
const CLAUDE_LIMIT_REASON = {
  ip: 'You have reached this demo’s Claude limit for the hour',
  daily: 'This demo’s Claude allowance for today is used up',
}

// Only the labelled sample persona, before the user saves their own financial inputs or imports
// history, can use external AI without opt-in. Purchases and other server updates do not count.
function mayUseExternalAi(profile: FinancialProfile) {
  return profile.aiConsent || (profile.source === 'demo' && profile.userEdited === false)
}

export function createApp(options: AppOptions = {}) {
  const config: AppConfig = loadConfig(process.env, options.config)
  const origins = allowedOrigins(config)
  const store = options.store ?? new Store(process.env.DATABASE_PATH ?? '.data/worth.sqlite')
  const now = options.now ?? (() => new Date())
  const paypal =
    options.paypal ??
    (config.paypalClientId && config.paypalSecret
      ? createPayPalGateway({
          clientId: config.paypalClientId,
          secret: config.paypalSecret,
          origin: config.origin,
          webhookId: config.paypalWebhookId,
        })
      : undefined)
  const chat =
    options.chat ??
    (config.anthropicKey
      ? createChatProvider(config.anthropicKey, config.anthropicModel)
      : undefined)
  const app = express()
  app.disable('x-powered-by')
  // Behind a proxy, req.ip must be the client address the proxy appended, not the proxy itself.
  if (config.trustProxy) app.set('trust proxy', config.trustProxy)
  app.locals.store = store
  app.locals.cleanup = () => store.cleanup(now().getTime())
  /** For payment webhooks: records a refund for the user to review, once per refund ID. */
  app.locals.recordRefund = (
    sessionId: string,
    purchaseId: string,
    refundId: string,
    amountCents: number,
  ) => recordRefund(store, sessionId, purchaseId, refundId, amountCents, now()).purchase
  const busy = new Set<string>()
  const chatBusy = new Set<string>()
  const requestLimiter = new WindowLimiter(config.requestsPerMinute, 60_000)
  const sessionLimiter = new WindowLimiter(config.sessionIpHourlyLimit, 60 * 60_000)
  const claudePerIp = new WindowLimiter(config.claudeIpHourlyLimit, 60 * 60_000)
  const claudeDaily = new WindowLimiter(config.claudeDailyLimit, DAY, 1)
  /** Spends one Claude request from the client's hourly and the server's daily allowance. */
  function claudeLimit(req: Request): keyof typeof CLAUDE_LIMIT_REASON | undefined {
    const time = now().getTime()
    if (!claudePerIp.take(req.ip ?? 'local', time)) return 'ip'
    if (!claudeDaily.take('all', time)) return 'daily'
    return undefined
  }
  // The __Host- prefix makes browsers require Secure, Path=/ and no Domain for the session cookie.
  const cookieName = config.production ? '__Host-worth_session' : 'worth_session'
  function today(timezone = 'UTC') {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now())
    return `${parts.find((p) => p.type === 'year')!.value}-${parts.find((p) => p.type === 'month')!.value}-${parts.find((p) => p.type === 'day')!.value}`
  }
  /** The browser's IANA time zone, sent on every API call; anything unsupported is ignored. */
  function viewerTimezone(req: Request) {
    return normalizeTimezone(req.get('X-Worth-Timezone'))
  }
  /** Keeps an untouched synthetic persona dated today for the viewer, so it never goes stale. */
  function followViewerDay(id: string, viewer: string | undefined) {
    const data = store.get(id)
    if (!data) return
    const timezone = viewer ?? data.profile.timezone
    const rebased = rebaseDemoState(data, today(timezone), timezone)
    if (rebased) store.save(id, rebased)
  }
  function sessionId(res: Response): string {
    return res.locals.sessionId as string
  }
  function dataFor(res: Response): SessionData {
    const data = store.get(sessionId(res))
    if (!data)
      throw new HttpError(
        401,
        'This session has expired. Reload to begin again.',
        'SESSION_EXPIRED',
      )
    return data
  }
  function state(id: string): AppState {
    const data = store.get(id)
    if (!data)
      throw new HttpError(401, 'Session expired. Reload to begin again.', 'SESSION_EXPIRED')
    const purchases = livePurchases(id).map(publicPurchase)
    return {
      ...data,
      sessionKey: createHash('sha256').update(id).digest('hex').slice(0, 20),
      purchases,
      reviews: purchaseReviews(purchases),
      products: PRODUCTS,
      today: today(data.profile.timezone),
      config: {
        ai: chat ? 'anthropic' : 'demo',
        paypal: paypal ? 'sandbox' : 'demo',
        ...(paypal && config.paypalClientId ? { paypalClientId: config.paypalClientId } : {}),
        ...(chat ? { model: config.anthropicModel } : {}),
      },
    }
  }
  function startSession(req: Request, res: Response, replacing = false) {
    const time = now().getTime()
    // A replacement (reset) deletes the previous session, so it cannot grow storage.
    if (!replacing && store.count(time) >= config.maxSessions)
      throw new HttpError(
        503,
        'Worth is at capacity right now. Please try again later.',
        'AT_CAPACITY',
      )
    if (!replacing && !sessionLimiter.take(req.ip ?? 'local', time))
      throw new HttpError(
        429,
        'Too many new sessions from this network. Please try again later.',
        'SESSION_RATE_LIMITED',
      )
    const timezone = viewerTimezone(req) ?? DEMO_TIMEZONE
    const seed = createDemoState(today(timezone), timezone)
    const id = store.create(
      { profile: seed.profile, transactions: seed.transactions, wishlist: seed.wishlist },
      time,
    )
    res.cookie(cookieName, id, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.production,
      maxAge: DAY,
      path: '/',
    })
    res.locals.sessionId = id
    return id
  }
  /** Purchases that belong to the current plan; archived persona purchases are kept only for PayPal. */
  function livePurchases(id: string) {
    return store.purchases(id).filter((p) => !p.archived)
  }
  /** History kept on import. Purchases made as the synthetic persona never carry into a user's plan. */
  function retainedHistory(data: SessionData) {
    return data.transactions.filter(
      (t) => t.source === 'import' || (t.source === 'purchase' && data.profile.source === 'import'),
    )
  }
  function active(id: string) {
    return store.purchases(id).find((p) => ACTIVE.has(p.status))
  }
  function noActive(id: string) {
    if (active(id))
      throw new HttpError(
        409,
        'Finish or cancel your active checkout before editing the plan.',
        'CHECKOUT_ACTIVE',
      )
  }
  function purchaseFor(req: Request, res: Response) {
    const purchase = store.purchase(String(req.params.id), sessionId(res))
    if (!purchase) throw new HttpError(404, 'Purchase not found.', 'NOT_FOUND')
    return purchase
  }
  function assessmentFor(id: string, amountCents: number, itemName: string, excludeId?: string) {
    const profile = store.get(id)!.profile
    return assessPurchase(
      profile,
      livePurchases(id).filter((p) => p.id !== excludeId),
      {
        amountCents,
        itemName,
        today: today(profile.timezone),
        purchaseDate: today(profile.timezone),
        findEarliest: false,
      },
    )
  }
  function assertAssessment(assessment: Assessment, acknowledged: boolean) {
    if (assessment.outcome === 'incomplete')
      throw new HttpError(
        409,
        'Confirm your current funds and complete your plan before checkout.',
        'PLAN_INCOMPLETE',
        assessment,
      )
    if (assessment.outcome === 'tight' && !acknowledged)
      throw new HttpError(
        409,
        'Buying today dips below your cushion. Review this current-date result before choosing to proceed.',
        'SHORTFALL_ACKNOWLEDGEMENT_REQUIRED',
        assessment,
      )
  }
  function complete(id: string, purchase: StoredPurchase, captureId: string, completedAt: string) {
    return store.atomic(() => {
      const current = store.purchase(purchase.id, id)!
      if (current.status === 'completed') {
        if (current.captureId !== captureId)
          throw new HttpError(
            409,
            'Capture identity mismatch. Payment needs reconciliation.',
            'PAYMENT_MISMATCH',
          )
        return current
      }
      const completed = { ...current, status: 'completed' as const, captureId, completedAt }
      store.putPurchase(id, completed)
      const data = store.get(id)!
      if (
        !data.transactions.some(
          (t) => t.referenceId === captureId || t.id === `purchase-${current.id}`,
        )
      ) {
        data.transactions.unshift({
          id: `purchase-${current.id}`,
          date: completedAt.slice(0, 10),
          name: current.name,
          amountCents: -current.amountCents,
          currency: 'USD',
          category: 'Shopping',
          kind: 'expense',
          status: 'completed',
          source: 'purchase',
          referenceId: captureId,
        })
      }
      data.profile.version += 1
      store.save(id, data)
      return completed
    })
  }
  function reconcile(id: string, purchase: StoredPurchase, order: PayPalOrder) {
    let merchantId: string
    try {
      merchantId = validateOrder(order, purchase)
    } catch {
      if (purchase.status !== 'completed') store.putPurchase(id, { ...purchase, status: 'unknown' })
      throw new HttpError(
        502,
        'PayPal returned details that do not match this purchase. Funds stay reserved until reconciliation.',
        'PAYMENT_MISMATCH',
      )
    }
    const capture = order.purchase_units?.[0]?.payments?.captures?.[0]
    const current = store.purchase(purchase.id, id)!
    if (capture?.status === 'COMPLETED')
      return complete(
        id,
        { ...current, merchantId },
        capture.id,
        capture.create_time ?? now().toISOString(),
      )
    if (current.status === 'completed') return current
    const status: Purchase['status'] =
      capture?.status === 'PENDING'
        ? 'pending'
        : capture?.status === 'DECLINED' ||
            capture?.status === 'FAILED' ||
            order.status === 'VOIDED'
          ? 'failed'
          : order.status === 'COMPLETED'
            ? 'unknown'
            : ['APPROVED', 'CREATED', 'PAYER_ACTION_REQUIRED', 'SAVED'].includes(order.status)
              ? 'created'
              : current.status
    const next = { ...current, merchantId, orderId: order.id, status }
    store.putPurchase(id, next)
    return next
  }
  async function withPurchaseLock<T>(id: string, fn: () => Promise<T>) {
    if (busy.has(id))
      throw new HttpError(
        409,
        'This payment is being checked. Please try again in a moment.',
        'PAYMENT_IN_PROGRESS',
      )
    busy.add(id)
    try {
      return await fn()
    } finally {
      busy.delete(id)
    }
  }
  async function ensureOrder(id: string, purchase: StoredPurchase) {
    if (purchase.orderId) return purchase
    if (!paypal)
      throw new HttpError(503, 'Sandbox credentials are not configured.', 'PAYPAL_UNAVAILABLE')
    try {
      const order = await paypal.create(purchase)
      const merchantId = validateOrder(order, purchase)
      const approvalUrl = order.links?.find(
        (link) => link.rel === 'payer-action' || link.rel === 'approve',
      )?.href
      if (
        approvalUrl &&
        new URL(approvalUrl).hostname !== 'www.sandbox.paypal.com' &&
        new URL(approvalUrl).hostname !== 'sandbox.paypal.com'
      )
        throw new Error('Unexpected approval destination')
      const updated = {
        ...purchase,
        orderId: order.id,
        merchantId,
        approvalUrl,
        status: 'created' as const,
      }
      store.putPurchase(id, updated)
      return reconcile(id, updated, order)
    } catch (error) {
      const current = store.purchase(purchase.id, id)
      if (current && current.status !== 'completed')
        store.putPurchase(id, { ...current, status: 'unknown' })
      if (error instanceof HttpError) throw error
      throw new HttpError(
        502,
        'PayPal order creation could not be confirmed. Retry this same checkout to reconcile it.',
        'PAYPAL_UNCERTAIN',
      )
    }
  }
  let proxyHopsLogged = !config.production
  app.use((req, res, next) => {
    // Logs the forwarding chain length once so TRUST_PROXY can be checked after a deploy.
    const forwarded = req.get('X-Forwarded-For')
    if (!proxyHopsLogged && forwarded) {
      proxyHopsLogged = true
      console.info(
        `X-Forwarded-For carries ${forwarded.split(',').length} address(es); TRUST_PROXY is ${config.trustProxy}.`,
      )
    }
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'same-origin')
    res.setHeader('X-Frame-Options', 'DENY')
    // Framing only. Script and connection rules wait until the PayPal SDK is tested live.
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'")
    if (config.production)
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store')
    next()
  })
  app.use(express.json({ limit: '1200kb' }))
  app.use(cookieParser())
  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'worth' }))
  app.post('/api/paypal/webhook', async (req, res) => {
    if (!paypal || !(await paypal.verify(req.headers, req.body)))
      throw new HttpError(401, 'Webhook signature verification failed.', 'INVALID_WEBHOOK')
    const event = z
      .object({
        id: identifier,
        event_type: z.string(),
        resource: z.record(z.string(), z.unknown()),
      })
      .parse(req.body)
    if (store.hasEvent(event.id)) return res.json({ received: true, duplicate: true })
    const related = event.resource.supplementary_data as
      { related_ids?: { order_id?: string } } | undefined
    const orderId =
      related?.related_ids?.order_id ??
      (event.event_type.startsWith('CHECKOUT.ORDER.') ? event.resource.id : undefined)
    if (typeof orderId !== 'string') return res.json({ received: true, ignored: true })
    const match = store.byOrder(orderId)
    if (!match) return res.json({ received: true, ignored: true })
    await withPurchaseLock(match.purchase.id, async () => {
      const current = reconcile(match.sessionId, match.purchase, await paypal.get(orderId))
      if (
        /REFUNDED|REVERSED|DENIED/.test(event.event_type) &&
        current.status === 'completed' &&
        !current.archived
      ) {
        const data = store.get(match.sessionId)!
        const message =
          'A PayPal payment changed after capture. Confirm your current balance before relying on this plan.'
        if (!data.profile.missingFields.includes(message)) data.profile.missingFields.push(message)
        data.profile.confirmed = false
        data.profile.version += 1
        store.save(match.sessionId, data)
      }
      store.recordEvent(event.id, match.sessionId)
    })
    return res.json({ received: true })
  })
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('origin')
      if (
        req.get('X-Worth-Client') !== 'web' ||
        (origin && !origins.has(origin)) ||
        req.get('sec-fetch-site') === 'cross-site'
      )
        return next(
          new HttpError(
            403,
            'This action must come from the Worth application.',
            'ORIGIN_REJECTED',
          ),
        )
      if (!req.is('application/json'))
        return next(new HttpError(415, 'Send a JSON request.', 'INVALID_CONTENT_TYPE'))
    }
    const time = now().getTime()
    if (!requestLimiter.take(req.ip ?? 'local', time))
      return next(
        new HttpError(429, 'Please wait a moment before making more requests.', 'RATE_LIMITED'),
      )
    // Expired rows are removed by the periodic cleanup timer, never by a per-request table scan.
    const cookie = req.cookies[cookieName] as unknown
    if (
      typeof cookie === 'string' &&
      /^[A-Za-z0-9_-]{43}$/.test(cookie) &&
      store.isLive(cookie, time)
    ) {
      res.locals.sessionId = cookie
      followViewerDay(cookie, viewerTimezone(req))
    } else startSession(req, res)
    next()
  })
  app.get('/api/state', (_req, res) => res.json(state(sessionId(res))))
  app.post('/api/assess', (req, res) => {
    const input = assessmentSchema.parse(req.body)
    const current = state(sessionId(res))
    if (
      input.purchaseDate &&
      (input.purchaseDate < current.today || input.purchaseDate > addDays(current.today, 30))
    )
      throw new HttpError(
        400,
        'Choose a purchase date from today through 30 days ahead.',
        'INVALID_DATE',
      )
    res.json(assessPurchase(current.profile, current.purchases, { ...input, today: current.today }))
  })
  app.post('/api/compare', (req, res) => {
    const input = compareSchema.parse(req.body)
    const product = input.productId ? PRODUCTS.find((p) => p.id === input.productId) : undefined
    if (input.productId && !product) throw new HttpError(404, 'Product not found.', 'NOT_FOUND')
    if (product && input.amountCents !== undefined && input.amountCents !== product.priceCents)
      throw new HttpError(400, 'Use the catalog price for this product.', 'PRICE_MISMATCH')
    const amountCents = product?.priceCents ?? input.amountCents!
    const current = state(sessionId(res))
    res.json(
      compareOptions(current.profile, current.purchases, {
        amountCents,
        itemName: product?.name ?? input.itemName,
        today: current.today,
        // PayPal's own eligibility check arrives with the Pay Later button; until then, the range.
        payIn4Eligible: payIn4InRange(amountCents),
      }),
    )
  })
  /** Saves a purchase's new cash effect and moves the plan version, so older answers expire. */
  function savePurchase(id: string, purchase: StoredPurchase) {
    store.atomic(() => {
      store.putPurchase(id, purchase)
      const data = store.get(id)!
      data.profile.version += 1
      store.save(id, data)
    })
  }
  app.post('/api/purchases/:id/plan', (req, res) => {
    const input = planSchema.parse(req.body)
    const id = sessionId(res)
    noActive(id)
    savePurchase(id, confirmPlan(purchaseFor(req, res), input, now()))
    res.json(state(id))
  })
  app.post('/api/purchases/:id/refunds/:refundId/confirm', (req, res) => {
    const input = refundConfirmationSchema.parse(req.body)
    const id = sessionId(res)
    noActive(id)
    savePurchase(
      id,
      confirmRefund(
        purchaseFor(req, res),
        String(req.params.refundId),
        input,
        now(),
        today(dataFor(res).profile.timezone),
      ),
    )
    res.json(state(id))
  })
  app.patch('/api/profile', (req, res) => {
    const input = z.object({ profile: profileSchema }).strict().parse(req.body)
      .profile as FinancialProfile
    const id = sessionId(res)
    noActive(id)
    const data = dataFor(res)
    if (input.version !== data.profile.version)
      throw new HttpError(
        409,
        'Your plan changed in another tab. Refresh before saving.',
        'STALE_PROFILE',
      )
    if (new Set(input.flows.map((f) => f.id)).size !== input.flows.length)
      throw new HttpError(400, 'Each scheduled item needs a unique identity.', 'DUPLICATE_FLOW')
    const completed = livePurchases(id).filter((p) => p.status === 'completed')
    if (input.reflectedPurchaseIds.some((ref) => !completed.some((p) => p.id === ref)))
      throw new HttpError(
        400,
        'Only completed purchases can be included in your balance snapshot.',
        'INVALID_SNAPSHOT',
      )
    if (input.snapshotDate > today(input.timezone))
      throw new HttpError(400, 'The balance snapshot cannot be in the future.', 'INVALID_SNAPSHOT')
    if (input.flows.some((flow) => flow.paidOn && flow.paidOn > input.snapshotDate))
      throw new HttpError(
        400,
        'Only items due on or before your funds date can be marked as already paid.',
        'INVALID_PAID_DATE',
      )
    data.profile = {
      ...input,
      version: data.profile.version + 1,
      source: data.profile.source,
      coverageDays: data.profile.coverageDays,
      confirmedAt: input.confirmed ? now().toISOString() : '',
      userEdited: true,
    }
    store.save(id, data)
    res.json(state(id))
  })
  app.post('/api/reset', (req, res) => {
    const previous = sessionId(res)
    noActive(previous)
    const id = startSession(req, res, true)
    store.delete(previous)
    res.json(state(id))
  })
  app.post('/api/consent', (req, res) => {
    const { aiConsent } = z.object({ aiConsent: z.boolean() }).strict().parse(req.body)
    const id = sessionId(res)
    const data = dataFor(res)
    // Consent changes no financial input, so it keeps the plan version and any active checkout.
    data.profile.aiConsent = aiConsent
    store.save(id, data)
    res.json(state(id))
  })
  app.post('/api/wishlist', (req, res) => {
    const { productId } = z.object({ productId: identifier }).strict().parse(req.body)
    if (!PRODUCTS.some((p) => p.id === productId))
      throw new HttpError(404, 'Product not found.', 'NOT_FOUND')
    const data = dataFor(res)
    data.wishlist = data.wishlist.includes(productId)
      ? data.wishlist.filter((id) => id !== productId)
      : [...data.wishlist, productId]
    store.save(sessionId(res), data)
    res.json(state(sessionId(res)))
  })
  function mergeTransactions(existing: Transaction[], incoming: Transaction[]) {
    return [...new Map([...existing, ...incoming].map((t) => [t.id, t])).values()]
  }
  function transactionLimitMessage(total: number) {
    return `This import would keep ${total.toLocaleString('en-US')} transactions, but a session holds at most ${config.maxTransactions.toLocaleString('en-US')}. Import a shorter date range.`
  }
  app.post('/api/import/preview', (req, res) => {
    const { csv } = csvSchema.parse(req.body)
    const data = dataFor(res)
    const existing = retainedHistory(data)
    const preview = parsePayPalCsv(csv, existing, { today: today(data.profile.timezone) })
    const total = mergeTransactions(existing, preview.transactions).length
    if (total > config.maxTransactions)
      preview.errors.unshift({ row: 1, message: transactionLimitMessage(total) })
    res.json(preview)
  })
  app.post('/api/import/commit', (req, res) => {
    const { csv } = csvSchema.parse(req.body)
    const id = sessionId(res)
    noActive(id)
    const data = dataFor(res)
    const retained = retainedHistory(data)
    const preview = parsePayPalCsv(csv, retained, { today: today(data.profile.timezone) })
    if (preview.errors.length)
      throw new HttpError(
        400,
        'Correct the flagged rows before importing. No history was changed.',
        'IMPORT_ERRORS',
      )
    if (!preview.transactions.length && !preview.duplicates)
      throw new HttpError(400, 'No supported transactions found.', 'EMPTY_IMPORT')
    const merged = mergeTransactions(retained, preview.transactions)
    if (merged.length > config.maxTransactions)
      throw new HttpError(400, transactionLimitMessage(merged.length), 'TOO_MANY_TRANSACTIONS')
    const switching = data.profile.source === 'demo'
    if (switching) {
      data.profile = {
        ...data.profile,
        name: 'Your plan',
        source: 'import',
        balanceCents: 0,
        dailySpendCents: preview.suggestedDailySpendCents,
        flows: preview.recurring,
        aiConsent: false,
        reflectedPurchaseIds: [],
      }
    } else {
      const existingNames = new Set(data.profile.flows.map((f) => f.name.toLowerCase()))
      data.profile.flows.push(
        ...preview.recurring.filter((f) => !existingNames.has(f.name.toLowerCase())),
      )
    }
    data.transactions = merged.sort((a, b) => b.date.localeCompare(a.date))
    const dates = data.transactions
      .filter((t) => t.source === 'import')
      .map((t) => t.date)
      .sort()
    data.profile.coverageDays = dates.length
      ? Math.round((Date.parse(dates[dates.length - 1]!) - Date.parse(dates[0]!)) / DAY) + 1
      : preview.coverageDays
    data.profile.confirmed = false
    data.profile.confirmedAt = ''
    data.profile.version += 1
    data.profile.userEdited = true
    data.profile.missingFields = [
      'Confirm current available funds, income, upcoming bills, and everyday spending after import.',
    ]
    store.atomic(() => {
      // Purchases made as the persona never reduce the user's own plan or appear in their activity.
      if (switching)
        for (const purchase of store.purchases(id))
          if (!purchase.archived) store.putPurchase(id, { ...purchase, archived: true })
      store.save(id, data)
    })
    res.json(state(id))
  })
  app.post('/api/transactions/categories', async (req, res) => {
    z.object({}).strict().parse(req.body)
    const current = state(sessionId(res))
    const rows = categoryCandidates(current.transactions)
    if (!mayUseExternalAi(current.profile))
      return res.json(
        fallbackCategories(
          rows,
          'AI sharing is off. These are your current local categories; your financial context was not sent to Claude. You can correct them individually.',
        ),
      )
    if (!chat?.categorize) return res.json(fallbackCategories(rows))
    const id = sessionId(res)
    if (chatBusy.has(id))
      throw new HttpError(
        429,
        'Your assistant is still answering. Please wait a moment.',
        'CHAT_BUSY',
      )
    const limited = claudeLimit(req)
    if (limited)
      return res.json(
        fallbackCategories(
          rows,
          `${CLAUDE_LIMIT_REASON[limited]}. These are your current categories, not AI proposals. You can correct them individually.`,
        ),
      )
    chatBusy.add(id)
    try {
      return res.json(await chat.categorize(rows))
    } catch {
      return res.json(
        fallbackCategories(
          rows,
          'Claude is temporarily unavailable. These are your current categories, not AI proposals. You can correct them individually.',
        ),
      )
    } finally {
      chatBusy.delete(id)
    }
  })
  app.patch('/api/transactions/:id', (req, res) => {
    // Labels must exclude control characters before display and categorization.
    const { category } = z
      .object({
        category: z
          .string()
          .trim()
          .min(1)
          .max(80)
          // oxlint-disable-next-line no-control-regex
          .refine((value) => !/[\u0000-\u001F\u007F]/.test(value), 'Use a plain-text category'),
      })
      .strict()
      .parse(req.body)
    const id = sessionId(res)
    noActive(id)
    const data = dataFor(res)
    const transaction = data.transactions.find((t) => t.id === String(req.params.id))
    if (!transaction) throw new HttpError(404, 'Transaction not found.', 'NOT_FOUND')
    transaction.category = category
    data.profile.version += 1
    store.save(id, data)
    res.json(state(id))
  })
  app.post('/api/chat', async (req, res) => {
    const input = chatSchema.parse(req.body)
    const current = state(sessionId(res))
    if (input.sessionKey && input.sessionKey !== current.sessionKey)
      throw new HttpError(
        409,
        'Your session changed. Refresh your plan before starting a new conversation.',
        'SESSION_CHANGED',
      )
    const data = {
      profile: current.profile,
      purchases: current.purchases,
      transactions: current.transactions,
      today: current.today,
    }
    if (!mayUseExternalAi(current.profile))
      return res.json(
        fallbackReply(
          input,
          data,
          'AI sharing is off. This is a local calculation, not an AI response; your financial context was not sent to Claude.',
        ),
      )
    if (!chat) return res.json(fallbackReply(input, data))
    const id = sessionId(res)
    if (chatBusy.has(id))
      throw new HttpError(
        429,
        'Your assistant is still answering. Please wait a moment.',
        'CHAT_BUSY',
      )
    const limited = claudeLimit(req)
    if (limited)
      return res.json(
        fallbackReply(
          input,
          data,
          `${CLAUDE_LIMIT_REASON[limited]}, so this answer uses local calculations, not an AI response.`,
        ),
      )
    chatBusy.add(id)
    try {
      return res.json(await chat.reply(input, data))
    } catch {
      return res.json(
        fallbackReply(
          input,
          data,
          'Claude is temporarily unavailable. This answer uses local calculations, not an AI response.',
        ),
      )
    } finally {
      chatBusy.delete(id)
    }
  })
  app.post('/api/checkout/create', async (req, res) => {
    const { productId, acknowledgeShortfall = false } = z
      .object({ productId: identifier, acknowledgeShortfall: z.boolean().optional() })
      .strict()
      .parse(req.body)
    const product = PRODUCTS.find((p) => p.id === productId)
    if (!product) throw new HttpError(404, 'Product not found.', 'NOT_FOUND')
    const id = sessionId(res)
    let purchase = store.atomic(() => {
      const existing = active(id)
      if (existing) {
        if (existing.productId !== productId)
          throw new HttpError(
            409,
            'You already have a checkout in progress. Finish or cancel it first.',
            'CHECKOUT_ACTIVE',
          )
        return existing
      }
      const assessment = assessmentFor(id, product.priceCents, product.name)
      assertAssessment(assessment, acknowledgeShortfall)
      const created: StoredPurchase = {
        id: randomUUID(),
        productId,
        name: product.name,
        amountCents: product.priceCents,
        currency: 'USD',
        mode: paypal ? 'sandbox' : 'demo',
        status: 'created',
        createdAt: now().toISOString(),
        profileVersion: assessment.profileVersion,
        assessmentDate: assessment.today,
        acknowledgedShortfall: acknowledgeShortfall,
      }
      store.putPurchase(id, created)
      return created
    })
    if (purchase.mode === 'sandbox')
      purchase = await withPurchaseLock(purchase.id, () => ensureOrder(id, purchase))
    res.json({
      purchase: publicPurchase(purchase),
      orderId: purchase.orderId,
      approvalUrl: purchase.approvalUrl,
      mode: purchase.mode,
    })
  })
  app.post('/api/checkout/:id/capture', async (req, res) => {
    z.object({}).strict().parse(req.body)
    const id = sessionId(res)
    let purchase = purchaseFor(req, res)
    if (purchase.status === 'completed')
      return res.json({ purchase: publicPurchase(purchase), state: state(id) })
    if (!ACTIVE.has(purchase.status))
      throw new HttpError(
        409,
        'This checkout is no longer active. Start a new purchase assessment.',
        'CHECKOUT_CLOSED',
      )
    purchase = await withPurchaseLock(purchase.id, async () => {
      if (purchase.mode === 'sandbox') {
        purchase = await ensureOrder(id, purchase)
        purchase = reconcile(id, purchase, await paypal!.get(purchase.orderId!))
        if (purchase.status === 'completed' || purchase.status === 'pending') return purchase
      }
      const data = dataFor(res)
      if (
        purchase.assessmentDate !== today(data.profile.timezone) ||
        purchase.profileVersion !== data.profile.version
      )
        throw new HttpError(
          409,
          'The date or financial plan changed. Cancel this checkout, confirm your current funds, and assess again.',
          'ASSESSMENT_EXPIRED',
        )
      assertAssessment(
        assessmentFor(id, purchase.amountCents, purchase.name, purchase.id),
        purchase.acknowledgedShortfall,
      )
      if (purchase.mode === 'demo')
        return complete(id, purchase, `demo-${purchase.id}`, now().toISOString())
      const current = await paypal!.get(purchase.orderId!)
      if (current.status !== 'APPROVED')
        throw new HttpError(
          409,
          'Approve this order in the PayPal sandbox before confirming payment.',
          'BUYER_APPROVAL_REQUIRED',
        )
      store.putPurchase(id, {
        ...purchase,
        status: 'pending',
        captureAttemptedAt: now().toISOString(),
      })
      try {
        return reconcile(id, purchase, await paypal!.capture(purchase.orderId!, purchase.id))
      } catch (error) {
        // A network failure may follow a successful capture. Keep the allocation and reconcile on retry.
        const stored = store.purchase(purchase.id, id)!
        if (stored.status !== 'completed') store.putPurchase(id, { ...stored, status: 'unknown' })
        if (error instanceof PayPalError && error.issue === 'ORDER_NOT_APPROVED')
          throw new HttpError(
            409,
            'Approve the order in PayPal before capture.',
            'BUYER_APPROVAL_REQUIRED',
          )
        if (error instanceof HttpError) throw error
        throw new HttpError(
          502,
          'Payment confirmation is uncertain. Your amount stays reserved; retry to check PayPal before any further action.',
          'PAYPAL_UNCERTAIN',
        )
      }
    })
    res.json({ purchase: publicPurchase(purchase), state: state(id) })
  })
  app.post('/api/checkout/:id/cancel', async (req, res) => {
    z.object({}).strict().parse(req.body)
    const id = sessionId(res)
    let purchase = purchaseFor(req, res)
    await withPurchaseLock(purchase.id, async () => {
      if (purchase.status === 'completed')
        throw new HttpError(
          409,
          'This payment is already completed. Cancellation cannot reverse it.',
          'ALREADY_COMPLETED',
        )
      if (purchase.mode === 'sandbox' && ACTIVE.has(purchase.status)) {
        purchase = await ensureOrder(id, purchase)
        const order = await paypal!.get(purchase.orderId!)
        purchase = reconcile(id, purchase, order)
        if (purchase.status === 'completed')
          throw new HttpError(
            409,
            'PayPal confirms this payment completed. Your plan has been updated.',
            'ALREADY_COMPLETED',
          )
        if (
          (purchase.captureAttemptedAt && ACTIVE.has(purchase.status)) ||
          order.purchase_units?.[0]?.payments?.captures?.some((c) => c.status === 'PENDING') ||
          (order.status === 'COMPLETED' && purchase.status === 'unknown')
        )
          throw new HttpError(
            409,
            'PayPal is still resolving this payment. The reservation must stay in place.',
            'PAYMENT_PENDING',
          )
      }
      store.putPurchase(id, { ...purchase, status: 'cancelled' })
    })
    res.json(state(id))
  })
  app.use('/api', (_req, res) =>
    res.status(404).json({ error: 'API endpoint not found.', code: 'NOT_FOUND' }),
  )
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof z.ZodError)
      return void res
        .status(400)
        .json({ error: error.issues[0]?.message ?? 'Invalid request.', code: 'INVALID_INPUT' })
    if (error instanceof PlanError)
      return void res.status(error.status).json({ error: error.message, code: error.code })
    if (error instanceof HttpError)
      return void res.status(error.status).json({
        error: error.message,
        code: error.code,
        ...(error.assessment ? { assessment: error.assessment } : {}),
      })
    if (error instanceof PayPalError)
      return void res.status(502).json({
        error: 'PayPal could not confirm this request. Your existing reservation is preserved.',
        code: 'PAYPAL_UNAVAILABLE',
      })
    if (error instanceof SyntaxError)
      return void res.status(400).json({ error: 'Invalid JSON request.', code: 'INVALID_JSON' })
    if (error?.type === 'entity.too.large')
      return void res
        .status(413)
        .json({ error: 'This file is too large. Use a CSV under 1 MB.', code: 'TOO_LARGE' })
    console.error('Worth request failed:', error instanceof Error ? error.name : 'UnknownError')
    res
      .status(500)
      .json({ error: 'Something went wrong. Please try again.', code: 'INTERNAL_ERROR' })
  }
  app.use(errors)
  return app
}
