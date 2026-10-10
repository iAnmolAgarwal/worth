import express from 'express'
import type { ErrorRequestHandler, Request, Response } from 'express'
import cookieParser from 'cookie-parser'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  assessPurchase,
  addDays,
  compareOptions,
  dateInTimezone,
  money,
  normalizeTimezone,
  payIn4InRange,
  purchaseReviews,
  withoutOwnHold,
} from '../shared/finance.ts'
import {
  createDemoState,
  DEMO_MERCHANT,
  DEMO_TIMEZONE,
  PRODUCTS,
  rebaseDemoState,
} from '../shared/seed.ts'
import {
  analyzeHistory,
  foreignPaymentTransaction,
  instalmentPlanReview,
  parsePayPalCsv,
  withForeignPaymentGate,
} from '../shared/csv.ts'
import { CSV_IMPORT_LIMITS, CSV_SIZE_MESSAGE, utf8Bytes } from '../shared/limits.ts'
import { checkProductLink, LINK_MAX_LENGTH, storeDomain } from '../shared/link.ts'
import type {
  AppState,
  Assessment,
  ChatReply,
  FinancialProfile,
  HandoffQuote,
  PayIn4Eligibility,
  Product,
  Purchase,
  Transaction,
} from '../shared/types.ts'
import { ACTIVE, RETENTION_MS, SESSION_DAY_MS, Store, publicPurchase } from './store.ts'
import type { SessionData, StoredPurchase, StoredQuote } from './store.ts'
import {
  approvalLink,
  createPayPalGateway,
  PayPalError,
  REAPPROVAL_ISSUES,
  toCents,
  validateOrder,
} from './paypal.ts'
import type { PayPalGateway, PayPalOrder } from './paypal.ts'
import { checkoutGuards } from './checkoutGuards.ts'
import {
  AgentTokenError,
  createAgentToken,
  listAgentTokens,
  MCP_BODY_LIMIT,
  mcpBodyError,
  mountMcp,
  revokeAgentToken,
} from './mcp.ts'
import { categoryCandidates, createChatProvider, fallbackCategories, localReply } from './chat.ts'
import type { ChatActions, ChatProvider } from './chat.ts'
import { allowedOrigins, handoffEnabled, loadConfig } from './config.ts'
import type { AppConfig } from './config.ts'
import { withoutWebsites } from './labels.ts'
import { WindowLimiter } from './limits.ts'
import { contentSecurityPolicy } from './csp.ts'
import { itemSigner } from './remember.ts'
import { createHandoff, MAX_OUTCOME_BYTES, withResult } from '../shared/handoff.ts'
import { isPlain } from '../shared/text.ts'
import type { QuotePayload, Verdict } from '../shared/handoff.ts'
import { confirmPlan, confirmRefund, PlanError, recordRefund } from './plans.ts'
import { recordOutcome } from './outcome.ts'
import { queryFor, roomToday } from './alternatives.ts'
import { createChannel3, loadFixtures } from './channel3.ts'
import type { Channel3Client } from './channel3.ts'
import type { Alternatives } from '../shared/types.ts'
import {
  addSaved,
  ASSESSMENT_ONLY,
  confirmFunds,
  fundsSchema,
  migratePlanned,
  plannedSchema,
  publicSaved,
  recheckSaved,
  removeSaved,
  saveSchema,
  SavedError,
  savedOf,
  toggleCatalog,
  wishlistOf,
} from './saved.ts'
import {
  applyDemoClock,
  DemoClockError,
  demoClockSchema,
  demoToday,
  fundsProjection,
} from './demoClock.ts'

export type { AppConfig } from './config.ts'
export interface AppOptions {
  store?: Store
  config?: Partial<AppConfig>
  paypal?: PayPalGateway
  chat?: ChatProvider
  /** Channel3 search; defaults to the live client when CHANNEL3_API_KEY is set. */
  channel3?: Channel3Client
  now?: () => Date
}
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'REQUEST_FAILED',
    readonly assessment?: Assessment,
    /** Extra fields for the response body, such as the purchase after a decline. */
    readonly extra?: Record<string, unknown>,
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
    aiChoiceMade: z.boolean().optional(),
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
/** A pasted product link: https, public host, at most 2,048 characters (checked again inside). */
const productLink = z
  .string()
  .max(LINK_MAX_LENGTH)
  .refine((value) => checkProductLink(value).ok, 'Use a store’s https product link.')
const qidSchema = z.string().regex(/^q_[A-Za-z0-9_-]{22}$/)
const compareSchema = z
  .object({
    amountCents: cents.optional(),
    itemName: z.string().trim().min(1).max(150).optional(),
    productId: identifier.optional(),
    /** For an item from a pasted link (C5): its page and who set the price. */
    sourceUrl: productLink.optional(),
    priceSource: z.enum(['channel3', 'user']).optional(),
    /** A store's quote this session opened on /check: its Pay in 4 answer replaces Worth's. */
    qid: qidSchema.optional(),
    /** A saved item of this session's: one with a store link is judged by the range alone. */
    savedId: identifier.optional(),
    /**
     * A budget the person stated in Ask. It is their own claim, so it may only lower Spend less,
     * never raise it above what keeps the cushion.
     */
    budgetCents: cents.min(1).optional(),
  })
  .strict()
  .refine(
    (input) => input.amountCents !== undefined || input.productId !== undefined,
    'Send a price or a product.',
  )
  .refine(
    (input) =>
      !(input.sourceUrl || input.priceSource) ||
      Boolean(input.sourceUrl && input.priceSource && !input.productId),
    'Send a pasted link with its price source, and no product.',
  )
const lookupSchema = z.object({ url: z.string().max(LINK_MAX_LENGTH) }).strict()
/** Lookup failures as answers: each tells the page to ask for the price instead. */
const LOOKUP_ERRORS = {
  invalid: [400, 'INVALID_URL', 'Paste a store’s https product link.'],
  off: [503, 'LOOKUP_OFF', 'Reading links is off right now.'],
  'not-found': [404, 'LOOKUP_NOT_FOUND', 'Worth couldn’t find a product on that page.'],
  failed: [502, 'LOOKUP_FAILED', 'Worth couldn’t read that page right now.'],
  limit: [429, 'RATE_LIMITED', 'Worth has read a lot of links lately.'],
} as const
const alternativesSchema = z
  .object({
    productId: identifier.optional(),
    itemName: z.string().trim().min(1).max(150).optional(),
    /** The item's own price, so its reservation is not counted against the room. */
    amountCents: z.coerce.number().int().min(0).max(100_000_000).optional(),
    /** A lower ceiling the person chose; never above what fits today. */
    maxPriceCents: z.coerce.number().int().min(0).max(100_000_000).optional(),
    /** A Channel3 product to find similar products for, such as a saved alternative. */
    similarTo: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .optional(),
  })
  .strict()
  .refine(
    (input) => Boolean(input.productId ?? input.itemName ?? input.similarTo),
    'Send a product, an item name or a Channel3 product.',
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
    /**
     * Items assessed earlier in this conversation, so a later question can return to one. Only
     * items this session's replies signed are used; any other entry is dropped.
     */
    items: z
      .array(
        z
          .object({
            amountCents: cents.min(1),
            itemName: z.string().max(150).optional(),
            tag: z
              .string()
              .regex(/^[A-Za-z0-9_-]{43}$/)
              .optional(),
          })
          .strict(),
      )
      .max(12)
      .optional(),
    sessionKey: z
      .string()
      .regex(/^[a-f0-9]{20}$/)
      .optional(),
  })
  .strict()
const csvSchema = z
  .object({
    csv: z
      .string()
      .min(1)
      .refine((value) => utf8Bytes(value) <= CSV_IMPORT_LIMITS.maxBytes, CSV_SIZE_MESSAGE),
    /** Needed only when every date in the file could be read either way. */
    dateOrder: z.enum(['MM/DD', 'DD/MM']).optional(),
  })
  .strict()
/** A foreign-currency payment is resolved by what it cost in USD, or as a one-off to leave out. */
const resolutionSchema = z.union([
  z.object({ amountCents: cents.min(1) }).strict(),
  z.object({ oneOff: z.literal(true) }).strict(),
])
/**
 * JSON escapes every quote and line break in a CSV, so a fully quoted export can double in size on
 * the way in. The import routes accept twice the CSV limit; the CSV itself is held to the limit.
 */
const IMPORT_BODY_LIMIT = 2 * CSV_IMPORT_LIMITS.maxBytes + 64 * 1024
const DAY = 86400000
const DECLINE_MESSAGES: Record<string, string> = {
  INSTRUMENT_DECLINED: 'Your payment method was declined. Choose another way to pay in PayPal.',
  PAYER_ACTION_REQUIRED:
    'PayPal needs you to finish a step before this payment can go through. Return to PayPal to continue.',
}
const CANCELLED_IN_PAYPAL =
  'You cancelled in PayPal. Approve the payment again when you are ready, or cancel this checkout.'
const UNCERTAIN_CAPTURE =
  'Payment confirmation is uncertain. Your amount stays reserved; retry to check PayPal before any further action.'
const REJECTED_CAPTURE =
  'PayPal did not accept this payment, and nothing was charged. Approve it again in PayPal, or cancel this checkout.'
/** PayPal's Pay Later answer is cached per price band for about ten minutes. */
const ELIGIBILITY_TTL_MS = 10 * 60_000
const ELIGIBILITY_RETRY_MS = 60_000
const ELIGIBILITY_BANDS = [10_000, 50_000, 100_000]
function eligibilityBand(amountCents: number) {
  return ELIGIBILITY_BANDS.filter((edge) => amountCents >= edge).length
}
/** Store hand-off calls (open, consent, return) per client IP per minute. */
const HANDOFF_PER_MINUTE = 30
/** The one message for any store link that fails verification; the link's contents are never echoed. */
const HANDOFF_UNVERIFIED =
  'We couldn’t verify this link from the store. You can still check the item yourself.'
/** Webhook deliveries accepted per sender IP per minute; each one costs a PayPal verification call. */
const WEBHOOK_PER_MINUTE = 60
/** Signed store reports accepted per merchant per minute (contract §7: after the signature). */
const OUTCOMES_PER_MINUTE = 60
/** The one body for a refused store report, whatever the reason: nothing about the check leaks. */
const OUTCOME_REFUSED = { error: 'This report was not accepted.', code: 'OUTCOME_REJECTED' }
const OUTCOME_NOT_FOUND = { error: 'Not found.', code: 'NOT_FOUND' }
const SPENDING_REVIEW = 'Review your everyday spending:'
const CLAUDE_LIMIT_REASON = {
  ip: 'You have reached this demo’s Claude limit for the hour',
  daily: 'This demo’s Claude allowance for today is used up',
}

// Only the labelled sample persona, before the user saves their own financial inputs or imports
// history, can use external AI without opt-in. Purchases and other server updates do not count.
function mayUseExternalAi(profile: FinancialProfile) {
  return (
    profile.aiConsent ||
    (profile.source === 'demo' && profile.userEdited === false && !profile.aiChoiceMade)
  )
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
  const channel3 =
    options.channel3 ??
    createChannel3({
      apiKey: config.channel3ApiKey,
      mode: config.channel3Mode,
      dailyLimit: config.channel3DailyLimit,
      fixtures: loadFixtures(),
      now: () => now().getTime(),
    })
  // Signs the items each conversation assessed (see remember.ts).
  const signer = itemSigner()
  // Store hand-offs (specs/handoff-contract.md): off until the key and the store origin are set.
  const handoff = handoffEnabled(config)
    ? createHandoff({
        secret: config.handoffSecret,
        mid: config.handoffMerchantId,
        merchantOrigin: config.merchantOrigin,
        now: () => now().getTime(),
      })
    : undefined
  /** The hand-off's store for Saved: its items keep its name; in dev its localhost link is allowed. */
  const savedStore = handoff
    ? { origin: handoff.merchantOrigin, allowLocal: !config.production }
    : {}
  /**
   * The demo store's own page for a catalog item (decision 0.2): where Ask Worth and outside agents
   * send someone who wants to buy it. Worth prepares no order; the store sells it. Undefined while
   * the hand-off is off. The video replay carries over, so both origins show the same dates.
   */
  function storeProductUrl(sessionId: string, productId: string) {
    const product = PRODUCTS.find((p) => p.id === productId && p.merchant === DEMO_MERCHANT)
    if (!handoff || !product) return undefined
    const url = new URL(`/p/${encodeURIComponent(product.id)}`, handoff.merchantOrigin)
    const data = store.get(sessionId)
    if (data?.profile.source === 'demo' && data.demoClock?.preset === 'video')
      url.searchParams.set('replay', 'video')
    return url.href
  }
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
  const eligibilityCache = new Map<number, { value: PayIn4Eligibility; until: number }>()
  const webhookLimiter = new WindowLimiter(WEBHOOK_PER_MINUTE, 60_000)
  const handoffLimiter = new WindowLimiter(HANDOFF_PER_MINUTE, 60_000)
  const outcomeLimiter = new WindowLimiter(OUTCOMES_PER_MINUTE, 60_000)
  const chatBusy = new Set<string>()
  const requestLimiter = new WindowLimiter(config.requestsPerMinute, 60_000)
  const sessionLimiter = new WindowLimiter(config.sessionIpHourlyLimit, 60 * 60_000)
  const claudePerIp = new WindowLimiter(config.claudeIpHourlyLimit, 60 * 60_000)
  const claudeDaily = new WindowLimiter(config.claudeDailyLimit, DAY, 1)
  const channel3PerIp = new WindowLimiter(config.channel3IpHourlyLimit, 60 * 60_000)
  /** Price checks per session and per IP per hour; each one is a Channel3 product read. */
  const priceChecksPerSession = new WindowLimiter(30, 60 * 60_000)
  const priceChecksPerIp = new WindowLimiter(60, 60 * 60_000)
  /**
   * Channel3 products each session has been shown (or, from Phase 5, saved). Only these can seed
   * "More like this" or a price check, so no client can make Worth read arbitrary products.
   */
  const shownProducts = new Map<string, Set<string>>()
  function rememberShown(id: string, result: Alternatives | undefined) {
    if (!result || result.status === 'off') return
    const rows = [...result.items, ...(result.unverified ?? [])]
    if (!rows.length) return
    const shown = shownProducts.get(id) ?? new Set<string>()
    shownProducts.delete(id)
    shownProducts.set(id, shown)
    for (const row of rows) shown.add(row.id)
    while (shown.size > 200) shown.delete(shown.values().next().value!)
    while (shownProducts.size > config.maxSessions)
      shownProducts.delete(shownProducts.keys().next().value!)
  }
  const wasShown = (id: string, productId: string) => shownProducts.get(id)?.has(productId) ?? false
  /** For Phase 5: register a Channel3 product the session saved, so its price can be checked. */
  app.locals.rememberAlternative = (id: string, productId: string) =>
    rememberShown(id, {
      status: 'ok',
      query: '',
      maxPriceCents: 0,
      items: [],
      unverified: [{ id: productId, title: '', retailer: '', source: 'channel3' }],
    })
  /** Each client's share of the day's live Channel3 searches; cached results never count. */
  const liveSearches = (req: Request) => ({
    allowLive: () => channel3PerIp.take(req.ip ?? 'local', now().getTime()),
  })
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
  /**
   * The session's today: the labelled demo clock's day on the synthetic persona, otherwise the
   * real date in the plan's time zone. Imported data never follows the demo clock.
   */
  function sessionToday(data: SessionData) {
    return demoToday(data) ?? today(data.profile.timezone)
  }
  /** The browser's IANA time zone, sent on every API call; anything unsupported is ignored. */
  function viewerTimezone(req: Request) {
    return normalizeTimezone(req.get('X-Worth-Timezone'))
  }
  /** Keeps an untouched synthetic persona dated today for the viewer, so it never goes stale. */
  function followViewerDay(id: string, viewer: string | undefined) {
    const data = store.get(id)
    // A pinned demo clock holds the persona on its own day.
    if (!data || data.demoClock) return
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
    // An older session's catalog wishlist becomes saved items once, with stable IDs.
    if (!data.saved) {
      savedOf(data, now())
      store.save(id, data)
    }
    const purchases = livePurchases(id).map(publicPurchase)
    const day = sessionToday(data)
    const saved = publicSaved(data.saved, day, purchases, savedStore)
    const projection = fundsProjection(data, purchases, day)
    const { saved: _saved, createdAt: _created, keep30: _keep, demoClock, ...rest } = data
    return {
      ...rest,
      sessionKey: createHash('sha256').update(id).digest('hex').slice(0, 20),
      purchases,
      reviews: purchaseReviews(purchases),
      products: PRODUCTS,
      saved,
      wishlist: wishlistOf(saved),
      retention: {
        keep30: Boolean(data.keep30),
        expiresAt: new Date(store.expiry(id) ?? now().getTime()).toISOString(),
      },
      ...(demoClock && data.profile.source === 'demo' ? { demoClock } : {}),
      ...(projection ? { fundsProjection: projection } : {}),
      today: day,
      config: {
        ai: chat ? 'anthropic' : 'demo',
        paypal: paypal ? 'sandbox' : 'demo',
        ...(paypal && config.paypalClientId ? { paypalClientId: config.paypalClientId } : {}),
        ...(chat ? { model: config.anthropicModel } : {}),
        alternatives: channel3.health(),
        handoff: handoff ? 'on' : 'off',
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
    const data: SessionData = {
      profile: seed.profile,
      transactions: seed.transactions,
      wishlist: seed.wishlist,
      createdAt: time,
    }
    savedOf(data, now())
    const id = store.create(data, time)
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
    const data = store.get(id)!
    const day = sessionToday(data)
    return assessPurchase(
      data.profile,
      livePurchases(id).filter((p) => p.id !== excludeId),
      { amountCents, itemName, today: day, purchaseDate: day, findEarliest: false },
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
      const data = store.get(id)!
      // The user's own calendar day, not the UTC date of the timestamp; on the synthetic persona
      // under the demo clock, the clock's day, so "bought on" matches every other date shown.
      const completedOn = current.archived
        ? dateInTimezone(completedAt, data.profile.timezone)
        : (demoToday(data) ?? dateInTimezone(completedAt, data.profile.timezone))
      const completed: StoredPurchase = {
        ...current,
        ...(purchase.merchantId ? { merchantId: purchase.merchantId } : {}),
        status: 'completed',
        captureId,
        completedAt,
        completedOn,
        // Only a checkout PayPal could have offered Pay Later for raises "Confirm your plan".
        ...(current.mode === 'sandbox' && current.payLaterCapable === false && !current.paymentPlan
          ? { paymentPlan: { product: 'full' as const } }
          : {}),
      }
      delete completed.needsReapproval
      delete completed.lastError
      delete completed.captureAttemptedAt
      store.putPurchase(id, completed)
      // A payment for a persona purchase set aside on import never enters the user's own plan.
      if (current.archived) return completed
      if (
        !data.transactions.some(
          (t) => t.referenceId === captureId || t.id === `purchase-${current.id}`,
        )
      ) {
        data.transactions.unshift({
          id: `purchase-${current.id}`,
          date: completedOn,
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
  /** Local states a PayPal event can never reopen: only a completed capture still settles them. */
  const TERMINAL = new Set<Purchase['status']>(['cancelled', 'failed'])
  function reconcile(id: string, purchase: StoredPurchase, order: PayPalOrder) {
    const current = store.purchase(purchase.id, id) ?? purchase
    let merchantId: string
    try {
      merchantId = validateOrder(order, current)
    } catch {
      if (current.status !== 'completed' && !TERMINAL.has(current.status) && !current.archived)
        store.putPurchase(id, {
          ...current,
          status: 'unknown',
          lastError: {
            code: 'PAYMENT_MISMATCH',
            message:
              'PayPal returned details that do not match this purchase. Funds stay reserved.',
          },
        })
      throw new HttpError(
        502,
        'PayPal returned details that do not match this purchase. Funds stay reserved until reconciliation.',
        'PAYMENT_MISMATCH',
      )
    }
    const capture = order.purchase_units?.[0]?.payments?.captures?.[0]
    if (capture?.status === 'COMPLETED')
      return complete(
        id,
        { ...current, merchantId },
        capture.id,
        capture.create_time ?? now().toISOString(),
      )
    if (current.status === 'completed') return current
    // A late APPROVED or other event never revives a cancelled, failed or archived checkout.
    if (TERMINAL.has(current.status) || current.archived) return current
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
              ? current.captureAttemptedAt
                ? current.status
                : 'created'
              : current.status
    const next: StoredPurchase = { ...current, merchantId, orderId: order.id, status }
    if (status === 'failed')
      next.lastError = {
        code: 'PAYMENT_FAILED',
        message: 'PayPal did not complete this payment. Nothing was charged; start a new checkout.',
      }
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
      const approvalUrl = approvalLink(order.links)
      if (
        order.links?.some((link) => ['payer-action', 'approve'].includes(link.rel)) &&
        !approvalUrl
      )
        throw new Error('Unexpected approval destination')
      const updated: StoredPurchase = {
        ...purchase,
        orderId: order.id,
        merchantId,
        ...(approvalUrl ? { approvalUrl } : {}),
        status: 'created',
      }
      delete updated.lastError
      store.putPurchase(id, updated)
      return reconcile(id, updated, order)
    } catch (error) {
      const current = store.purchase(purchase.id, id)
      if (current && current.status !== 'completed')
        store.putPurchase(id, {
          ...current,
          status: 'unknown',
          lastError: {
            code: 'PAYPAL_UNCERTAIN',
            message: 'PayPal order creation could not be confirmed. Retry to check PayPal.',
          },
        })
      if (error instanceof HttpError) throw error
      throw new HttpError(
        502,
        'PayPal order creation could not be confirmed. Retry this same checkout to reconcile it.',
        'PAYPAL_UNCERTAIN',
      )
    }
  }
  /** Pay in 4 availability for one amount: the configured range, then PayPal's own check. */
  async function payIn4Eligibility(amountCents: number): Promise<PayIn4Eligibility> {
    if (!payIn4InRange(amountCents)) return 'unavailable'
    if (!paypal) return 'range-only'
    const band = eligibilityBand(amountCents)
    const time = now().getTime()
    const cached = eligibilityCache.get(band)
    if (cached && cached.until > time) return cached.value
    let value: PayIn4Eligibility
    try {
      // Only a yes is PayPal's word (contract §3.2); a no before the buyer logs in is unknown.
      value = (await paypal.eligibility(amountCents)).payLater ? 'paypal' : 'range-only'
    } catch {
      value = 'range-only'
    }
    // A failed check is retried sooner than a confirmed answer.
    eligibilityCache.set(band, {
      value,
      until: time + (value === 'range-only' ? ELIGIBILITY_RETRY_MS : ELIGIBILITY_TTL_MS),
    })
    return value
  }
  /**
   * Creates the purchase reservation and, in the sandbox, its PayPal order. Only the person's own
   * buttons come here: agents link to the store instead (decision 0.2).
   */
  async function startCheckout(
    id: string,
    product: Product,
    options: {
      acknowledgeShortfall: boolean
      /** The plan the saved plan's guard check used; any change since makes it stale. */
      assessed?: { profileVersion: number; today: string }
    },
  ) {
    const payLater = paypal ? await payIn4Eligibility(product.priceCents) : undefined
    let purchase = store.atomic(() => {
      const existing = active(id)
      if (existing) {
        if (existing.productId !== product.id)
          throw new HttpError(
            409,
            'You already have a checkout in progress. Finish or cancel it first.',
            'CHECKOUT_ACTIVE',
          )
        return existing
      }
      const assessment = assessmentFor(id, product.priceCents, product.name)
      if (
        options.assessed &&
        (options.assessed.profileVersion !== assessment.profileVersion ||
          options.assessed.today !== assessment.today)
      )
        throw new HttpError(
          409,
          'Your plan or the date changed. Check this purchase again before checkout.',
          'ASSESSMENT_EXPIRED',
        )
      assertAssessment(assessment, options.acknowledgeShortfall)
      const created: StoredPurchase = {
        id: randomUUID(),
        productId: product.id,
        name: product.name,
        amountCents: product.priceCents,
        currency: 'USD',
        mode: paypal ? 'sandbox' : 'demo',
        status: 'created',
        createdAt: now().toISOString(),
        profileVersion: assessment.profileVersion,
        assessmentDate: assessment.today,
        acknowledgedShortfall: options.acknowledgeShortfall,
        preparedBy: 'user',
        ...(payLater ? { payLaterCapable: payLater !== 'unavailable' } : {}),
      }
      store.putPurchase(id, created)
      return created
    })
    if (purchase.mode === 'sandbox')
      purchase = await withPurchaseLock(purchase.id, () => ensureOrder(id, purchase))
    return purchase
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
    // /check is where a store's hand-off lands; no referrer leaves it, even on the way back.
    const check = req.path === '/check' || req.path.startsWith('/check/')
    res.setHeader('Referrer-Policy', check ? 'no-referrer' : 'same-origin')
    res.setHeader('X-Frame-Options', 'DENY')
    // The full policy needs the built app; Vite's development server injects inline scripts.
    res.setHeader(
      'Content-Security-Policy',
      config.contentSecurityPolicy
        ? contentSecurityPolicy(handoff ? [handoff.merchantOrigin] : [])
        : "frame-ancestors 'none'",
    )
    if (config.production)
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    if (req.path.startsWith('/api/') || req.path === '/mcp')
      res.setHeader('Cache-Control', 'no-store')
    next()
  })
  // Webhook signatures cover the exact bytes PayPal sent, so this route keeps the raw body.
  app.use('/api/paypal/webhook', express.raw({ type: () => true, limit: '64kb' }))
  // A store's report is signed over its exact bytes, and is at most 2 KB.
  app.use(
    '/api/handoff/outcome',
    express.raw({ type: () => true, limit: MAX_OUTCOME_BYTES, inflate: false }),
  )
  app.use('/api/import', express.json({ limit: IMPORT_BODY_LIMIT }))
  // A hand-off token is at most 4 KB.
  app.use('/api/handoff', express.json({ limit: '8kb' }))
  // MCP messages are small tool calls; the parser leaves other content types unparsed.
  app.use('/mcp', express.json({ limit: MCP_BODY_LIMIT }))
  app.use(express.json({ limit: '1200kb' }))
  app.use(cookieParser())
  // Worth as an outside agent's affordability check (Phase MCP). Bearer tokens only: this route is
  // mounted outside /api, so it never reads or sets the session cookie.
  mountMcp(app, {
    store,
    config,
    origins,
    now,
    plan: (id) => {
      const data = store.get(id)
      if (!data) return undefined
      // An older session's wishlist becomes saved items once, with stable IDs, as in state().
      if (!data.saved) {
        savedOf(data, now())
        store.save(id, data)
      }
      return {
        profile: data.profile,
        purchases: livePurchases(id),
        transactions: data.transactions,
        saved: data.saved,
        today: sessionToday(data),
      }
    },
    payIn4Eligibility,
    storeProductUrl,
  })
  app.get('/api/health', (_req, res) =>
    res.json({
      ok: true,
      service: 'worth',
      channel3: channel3.health(),
      handoff: handoff ? 'on' : 'off',
    }),
  )
  const webhookEvent = z.object({
    id: identifier,
    event_type: z.string().max(100),
    resource: z.record(z.string(), z.unknown()),
  })
  app.post('/api/paypal/webhook', async (req, res) => {
    // Limited before verification: every delivery attempt costs an outbound PayPal call.
    if (!webhookLimiter.take(req.ip ?? 'local', now().getTime()))
      throw new HttpError(429, 'Too many webhook deliveries.', 'RATE_LIMITED')
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : ''
    if (!paypal || !raw || !(await paypal.verify(req.headers, raw)))
      throw new HttpError(401, 'Webhook signature verification failed.', 'INVALID_WEBHOOK')
    const event = webhookEvent.parse(JSON.parse(raw))
    if (store.hasEvent(event.id)) return res.json({ received: true, duplicate: true })
    if (/^PAYMENT\.CAPTURE\.(?:REFUNDED|REVERSED)$/.test(event.event_type)) {
      const outcome = await handleRefundEvent(event.resource)
      if (outcome.sessionId) store.recordEvent(event.id, outcome.sessionId)
      return res.json({ received: true, ...(outcome.ignored ? { ignored: true } : {}) })
    }
    const related = event.resource.supplementary_data as
      { related_ids?: { order_id?: string } } | undefined
    const orderId =
      related?.related_ids?.order_id ??
      (event.event_type.startsWith('CHECKOUT.ORDER.') ? event.resource.id : undefined)
    if (typeof orderId !== 'string') return res.json({ received: true, ignored: true })
    const match = store.byOrder(orderId)
    if (!match) return res.json({ received: true, ignored: true })
    await withPurchaseLock(match.purchase.id, async () => {
      reconcile(match.sessionId, match.purchase, await paypal.get(orderId))
      store.recordEvent(event.id, match.sessionId)
    })
    return res.json({ received: true })
  })
  /**
   * A refund (or a reversal) arrives as a refund resource whose `up` link names the capture. The
   * refund is re-read from PayPal, then recorded for the user to review; spending room is unchanged.
   */
  async function handleRefundEvent(
    resource: Record<string, unknown>,
  ): Promise<{ sessionId?: string; ignored?: boolean }> {
    if (typeof resource.id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(resource.id))
      return { ignored: true }
    const refund = await paypal!.getRefund(resource.id)
    const captureId = refund.links
      ?.find((link) => link.rel === 'up')
      ?.href.match(/\/v2\/payments\/captures\/([A-Za-z0-9-]+)$/)?.[1]
    const match = captureId ? store.byCapture(captureId) : undefined
    if (!match) return { ignored: true }
    if (refund.status !== 'COMPLETED' || refund.amount?.currency_code !== 'USD')
      return { sessionId: match.sessionId, ignored: true }
    let cents: number
    try {
      cents = toCents(refund.amount.value)
    } catch {
      return { sessionId: match.sessionId, ignored: true }
    }
    try {
      app.locals.recordRefund(match.sessionId, match.purchase.id, refund.id, cents)
    } catch (error) {
      // An impossible refund (over the paid amount, or on an unpaid purchase) is not retried.
      if (error instanceof PlanError) return { sessionId: match.sessionId, ignored: true }
      throw error
    }
    return { sessionId: match.sessionId }
  }
  /**
   * The store's server reports its own completed PayPal capture (specs/handoff-contract.md §5).
   * Server to server, so it sits before the browser-only checks and never reads or sets a session
   * cookie. Checks run in the contract's order: size, timestamp, signature, shape, key ids, USD
   * (verifyOutcome), then the per-merchant limit, then the quote. Every refusal has one generic
   * body; the store learns nothing about the shopper beyond `recorded`.
   */
  app.post('/api/handoff/outcome', (req, res) => {
    if (!handoff) return void res.status(404).json(OUTCOME_NOT_FOUND)
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : ''
    const verified = handoff.verifyOutcome(
      raw,
      req.get('Worth-Handoff-Timestamp'),
      req.get('Worth-Handoff-Signature'),
    )
    if (!verified.ok)
      return void res
        .status(
          ['bad_timestamp', 'bad_signature', 'unknown_key'].includes(verified.reason) ? 401 : 400,
        )
        .json(OUTCOME_REFUSED)
    if (!outcomeLimiter.take(verified.payload.mid, now().getTime()))
      return void res
        .status(429)
        .json({ error: 'Too many reports. Try again shortly.', code: 'RATE_LIMITED' })
    const answer = recordOutcome(store, verified.payload, now())
    if (answer.status === 'unknown') return void res.status(404).json(OUTCOME_NOT_FOUND)
    res.json({ recorded: answer.recorded })
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
  /**
   * PayPal's redirect back to Worth. It records whether the buyer approved or cancelled, then
   * opens the app at the checkout. Nothing is captured here.
   */
  app.get('/api/checkout/:id/return', (req, res) => {
    const result = req.query.paypal === 'cancelled' ? 'cancelled' : 'approved'
    const purchaseId = String(req.params.id).slice(0, 100)
    const purchase = store.purchase(purchaseId, sessionId(res))
    if (purchase?.status === 'created' && !busy.has(purchase.id)) {
      const next: StoredPurchase = { ...purchase }
      if (result === 'cancelled')
        next.lastError = { code: 'PAYPAL_CANCELLED', message: CANCELLED_IN_PAYPAL }
      else {
        delete next.lastError
        delete next.needsReapproval
      }
      store.putPurchase(sessionId(res), next)
    }
    res.redirect(303, `/?checkout=${encodeURIComponent(purchaseId)}&paypal=${result}`)
  })
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
    res.json(
      assessPurchase(current.profile, withoutOwnHold(current.purchases, input), {
        ...input,
        today: current.today,
      }),
    )
  })
  /** A quote this session opened; anything else, including another session's, is not found. */
  function sessionQuote(res: Response, qid: string) {
    const quote = store.quote(qid, now().getTime())
    if (!quote || quote.sessionId !== sessionId(res))
      throw new HttpError(404, 'This store link isn’t open in this session.', 'NOT_FOUND')
    return quote
  }
  /**
   * The store's Pay in 4 answer applies only to the price it was asked about (§3.2). A price the
   * shopper corrected, or a quote without an answer, falls back to the amount range alone.
   */
  function quoteEligibility(quote: StoredQuote, amountCents: number): PayIn4Eligibility {
    if (!payIn4InRange(amountCents)) return 'unavailable'
    if (!quote.payLater || amountCents !== quote.amountCents) return 'range-only'
    // Only a yes is signed now (§3.2); an older quote's signed no reads as unknown too.
    return quote.payLater.eligible ? 'paypal' : 'range-only'
  }
  function quoteView(quote: StoredQuote, canConsent: boolean): HandoffQuote {
    return {
      qid: quote.qid,
      merchant: quote.merchant,
      item: quote.item,
      amountCents: quote.amountCents,
      returnUrl: quote.returnUrl,
      ...(quote.imageUrl ? { imageUrl: quote.imageUrl } : {}),
      // A signed no is unknown, like an absent answer (§3.2); a yes outside the range isn't an offer.
      payLater: !quote.payLater?.eligible
        ? 'unknown'
        : payIn4InRange(quote.amountCents)
          ? 'offered'
          : 'not-offered',
      consent: canConsent && quote.consent,
      canConsent,
    }
  }
  function handoffLimit(req: Request) {
    if (!handoffLimiter.take(req.ip ?? 'local', now().getTime()))
      throw new HttpError(429, 'Please wait a moment before making more requests.', 'RATE_LIMITED')
  }
  /**
   * The store's "Analyse with Worth" click lands here from /check (specs/handoff-contract.md
   * §3.3). The token is verified in the contract's order; a verified quote is bound to this
   * session for 24 hours. Only an expired or non-USD quote, whose signature and return origin
   * checked out, offers the way back to the store.
   */
  app.post('/api/handoff/open', (req, res) => {
    handoffLimit(req)
    const input = z.object({ token: z.string() }).strict().safeParse(req.body)
    if (!handoff || !input.success)
      throw new HttpError(400, HANDOFF_UNVERIFIED, 'HANDOFF_UNVERIFIED')
    const verified = handoff.verifyQuote(input.data.token)
    if (!verified.ok) {
      if (verified.reason === 'expired')
        throw new HttpError(
          400,
          `This link from ${verified.payload.merchant} has expired. Go back and tap Analyse with Worth again.`,
          'HANDOFF_EXPIRED',
          undefined,
          { merchant: verified.payload.merchant, returnUrl: verified.payload.returnUrl },
        )
      if (verified.reason === 'non_usd')
        throw new HttpError(
          400,
          'Worth checks US dollar prices for now.',
          'HANDOFF_CURRENCY',
          undefined,
          {
            merchant: verified.payload.merchant,
            item: verified.payload.item,
            returnUrl: verified.payload.returnUrl,
          },
        )
      throw new HttpError(400, HANDOFF_UNVERIFIED, 'HANDOFF_UNVERIFIED')
    }
    const id = sessionId(res)
    const time = now().getTime()
    const opened = store.openQuote(storedQuote(verified.payload, id, time), time)
    const mine = opened.sessionId === id
    // The video replay follows /?replay=video: the sample persona only, never imported data.
    let replay = false
    const data = dataFor(res)
    if (
      verified.payload.replay === 'video' &&
      data.profile.source === 'demo' &&
      data.demoClock?.preset !== 'video' &&
      !active(id)
    ) {
      const next = applyDemoClock(data, { preset: 'video' }, today(data.profile.timezone))
      store.atomic(() => {
        for (const purchase of store.purchases(id))
          if (!purchase.archived) store.putPurchase(id, { ...purchase, archived: true })
        store.save(id, next.data)
      })
      replay = true
    }
    res.json({
      quote: quoteView(mine ? opened : storedQuote(verified.payload, id, time), mine),
      state: state(id),
      ...(replay ? { replay } : {}),
    })
  })
  function storedQuote(payload: QuotePayload, id: string, time: number): StoredQuote {
    return {
      qid: payload.qid,
      sessionId: id,
      mid: payload.mid,
      item: payload.item,
      productId: payload.productId,
      amountCents: payload.amountCents,
      merchant: payload.merchant,
      returnUrl: payload.returnUrl,
      ...(payload.imageUrl ? { imageUrl: payload.imageUrl } : {}),
      ...(payload.payLater ? { payLater: payload.payLater } : {}),
      openedAt: time,
      consent: false,
    }
  }
  /**
   * "Save for <date>" on /check (contract §4). The client sends only the quote and the plan's day;
   * the link, the store's name and the price come from the verified quote this session holds, so
   * only here does an item get priceSource "component". A price the shopper changed on /check is
   * saved as theirs ("user"), with the store's link and name still from the quote.
   */
  app.post('/api/handoff/save', (req, res) => {
    handoffLimit(req)
    const input = z
      .object({
        qid: qidSchema,
        waitDate: date,
        amountCents: cents.min(1).optional(),
        itemName: z
          .string()
          .trim()
          .min(1)
          .max(120)
          .refine(isPlain, 'Use a plain-text name')
          .optional(),
      })
      .strict()
      .parse(req.body)
    const quote = sessionQuote(res, input.qid)
    const edited = input.amountCents !== undefined && input.amountCents !== quote.amountCents
    const id = sessionId(res)
    const data = dataFor(res)
    const item = addSaved(
      data,
      {
        kind: 'custom',
        name: input.itemName ?? quote.item,
        amountCents: edited ? input.amountCents! : quote.amountCents,
        waitDate: input.waitDate,
      },
      sessionToday(data),
      now(),
      {
        sourceUrl: quote.returnUrl,
        merchantName: quote.merchant,
        priceSource: edited ? 'user' : 'component',
        qid: quote.qid,
      },
    )
    store.save(id, data)
    res.json({ item, state: state(id) })
  })
  /** The quote again after a reload of /check, for the session that opened it. */
  app.get('/api/handoff/quotes/:qid', (req, res) => {
    handoffLimit(req)
    const quote = sessionQuote(res, qidSchema.parse(req.params.qid))
    res.json({ quote: quoteView(quote, true) })
  })
  /** The report-back choice (§3.3 step 6), for the session that opened the quote only. */
  app.post('/api/handoff/consent', (req, res) => {
    handoffLimit(req)
    const input = z.object({ qid: qidSchema, consent: z.boolean() }).strict().parse(req.body)
    if (!store.setQuoteConsent(input.qid, sessionId(res), input.consent, now().getTime()))
      throw new HttpError(404, 'This store link isn’t open in this session.', 'NOT_FOUND')
    res.json({ qid: input.qid, consent: input.consent })
  })
  /**
   * "Back to <store>" (§4): the store's page with a signed verdict, computed here from the plan,
   * never taken from the browser. The result names no price, so it is only ever about the store's
   * own: after the shopper changes the price, or while the plan needs details first, the link
   * goes back with no token and the store shows nothing.
   */
  app.post('/api/handoff/return', (req, res) => {
    handoffLimit(req)
    const input = z
      .object({ qid: qidSchema, amountCents: cents.min(1).optional() })
      .strict()
      .parse(req.body)
    const quote = sessionQuote(res, input.qid)
    if (!handoff || (input.amountCents !== undefined && input.amountCents !== quote.amountCents))
      return res.json({ url: quote.returnUrl })
    const { amountCents } = quote
    const current = state(sessionId(res))
    const comparison = compareOptions(
      current.profile,
      withoutOwnHold(current.purchases, { itemName: quote.item, amountCents }),
      {
        amountCents,
        itemName: quote.item,
        today: current.today,
        payIn4Eligible: quoteEligibility(quote, amountCents) !== 'unavailable',
      },
    )
    const verdict: Verdict | undefined =
      comparison.recommendation === 'buyToday'
        ? 'buy_today'
        : comparison.recommendation === 'wait'
          ? 'wait'
          : comparison.recommendation === 'spendLess'
            ? 'spend_less'
            : undefined
    if (!verdict) return res.json({ url: quote.returnUrl })
    const fitsOn =
      verdict === 'buy_today'
        ? current.today
        : verdict === 'wait' && comparison.wait.date
          ? comparison.wait.date
          : undefined
    const token = handoff.signResult({
      qid: quote.qid,
      verdict,
      ...(fitsOn ? { fitsOn } : {}),
      ...(comparison.payIn4.available ? { payIn4Fits: comparison.payIn4.outcome === 'fits' } : {}),
    })
    // Anti-forwarding (§5): only a quote whose shopper came back through Worth can report a purchase.
    store.markQuoteReturned(quote.qid, sessionId(res), now().getTime())
    res.json({ url: withResult(quote.returnUrl, token) })
  })
  /** The shopper has seen "<store> told Worth about your payment" for these purchases (C4). */
  app.post('/api/handoff/notices/seen', (req, res) => {
    // Like every hand-off route, it isn't there while the hand-off is off (contract §1).
    if (!handoff) throw new HttpError(404, 'Not found.', 'NOT_FOUND')
    const { purchaseIds } = z
      .object({ purchaseIds: z.array(identifier).min(1).max(20) })
      .strict()
      .parse(req.body)
    const id = sessionId(res)
    store.atomic(() => {
      for (const purchaseId of purchaseIds) {
        const purchase = store.purchase(purchaseId, id)
        if (!purchase?.reportNotice) continue
        const { reportNotice: _seen, ...rest } = purchase
        store.putPurchase(id, rest)
      }
    })
    res.json(state(id))
  })
  app.post('/api/compare', async (req, res) => {
    const input = compareSchema.parse(req.body)
    const product = input.productId ? PRODUCTS.find((p) => p.id === input.productId) : undefined
    if (input.productId && !product) throw new HttpError(404, 'Product not found.', 'NOT_FOUND')
    if (product && input.amountCents !== undefined && input.amountCents !== product.priceCents)
      throw new HttpError(400, 'Use the catalog price for this product.', 'PRICE_MISMATCH')
    const amountCents = product?.priceCents ?? input.amountCents!
    // A store's item uses the store's own Pay in 4 answer; Worth asks PayPal only for its own.
    const quote = input.qid ? sessionQuote(res, input.qid) : undefined
    // PayPal's eligibility check runs first; the session is read afterwards so it is current. It
    // answers for Worth's own demo merchant, so another store's item is judged by the range only.
    // A saved item from a store page (a /check save or a pasted link) is another store's item too.
    const savedFromStore =
      input.savedId !== undefined &&
      (dataFor(res).saved ?? []).some(
        (item) => item.id === input.savedId && item.status !== 'removed' && item.sourceUrl,
      )
    const eligibility = quote
      ? quoteEligibility(quote, amountCents)
      : input.sourceUrl || savedFromStore
        ? payIn4InRange(amountCents)
          ? 'range-only'
          : 'unavailable'
        : await payIn4Eligibility(amountCents)
    const current = state(sessionId(res))
    const comparison = compareOptions(
      current.profile,
      withoutOwnHold(current.purchases, {
        productId: product?.id,
        itemName: product?.name ?? input.itemName,
        amountCents,
      }),
      {
        amountCents,
        itemName: product?.name ?? input.itemName,
        today: current.today,
        payIn4Eligible: eligibility !== 'unavailable',
        ...(input.budgetCents !== undefined ? { budgetCents: input.budgetCents } : {}),
      },
    )
    // The store is named from the link itself, never from text the browser sends.
    const source =
      input.sourceUrl && input.priceSource
        ? {
            sourceUrl: input.sourceUrl,
            merchantName: storeDomain(new URL(input.sourceUrl).hostname),
            priceSource: input.priceSource,
          }
        : undefined
    res.json({
      ...comparison,
      payIn4: { ...comparison.payIn4, eligibility },
      ...(source ? { source } : {}),
    })
  })
  /**
   * A pasted product link (C5): Channel3 reads the page and Worth returns the product for the
   * shopper to confirm. Worth's server never fetches the link, and nothing from the page reaches
   * Claude. Live lookups count against the Channel3 daily budget and this client's hourly share.
   */
  app.post('/api/lookup', async (req, res) => {
    const input = lookupSchema.parse(req.body)
    const result = await channel3.lookup(input.url, liveSearches(req))
    if (result.ok) return res.json(result.product)
    const [status, code, message] = LOOKUP_ERRORS[result.reason]
    throw new HttpError(status, message, code)
  })
  /**
   * Similar items from other stores, priced at or below what fits today (the Spend less amount,
   * rounded down to $25). Only a generic description and the price band reach Channel3. With
   * nothing to show, the answer is status "off" and the panel stays hidden.
   */
  app.get('/api/alternatives', async (req, res) => {
    const input = alternativesSchema.parse(req.query)
    const product = input.productId ? PRODUCTS.find((p) => p.id === input.productId) : undefined
    if (input.productId && !product) throw new HttpError(404, 'Product not found.', 'NOT_FOUND')
    const current = state(sessionId(res))
    const room = roomToday(
      current.profile,
      withoutOwnHold(current.purchases, {
        productId: product?.id,
        itemName: product?.name ?? input.itemName,
        amountCents: product?.priceCents ?? input.amountCents ?? 0,
      }),
      current.today,
    )
    const ceiling = Math.min(room, input.maxPriceCents ?? room)
    const query = input.similarTo
      ? undefined
      : queryFor({ productId: product?.id, itemName: input.itemName })
    if (!input.similarTo && !query)
      return res.json({ status: 'off', query: '', maxPriceCents: 0, items: [] })
    const id = sessionId(res)
    // "More like this" only starts from a product this session was shown.
    if (input.similarTo && !wasShown(id, input.similarTo))
      return res.json({ status: 'off', query: input.similarTo, maxPriceCents: 0, items: [] })
    const result = input.similarTo
      ? await channel3.similar(input.similarTo, ceiling, liveSearches(req))
      : await channel3.search(query!, ceiling, liveSearches(req))
    rememberShown(id, result)
    res.json(result)
  })
  /**
   * Whether a saved Channel3 product is cheaper now than when it was saved, read with Channel3's
   * free product endpoint (no search credits). For Phase 5's Saved list: "price dropped to $X".
   */
  app.get('/api/alternatives/price', async (req, res) => {
    const input = z
      .object({
        id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
        savedPriceCents: z.coerce.number().int().min(1).max(100_000_000),
      })
      .strict()
      .parse(req.query)
    const id = sessionId(res)
    // Shown this session, or saved from Similar items (which outlives a server restart).
    const saved = (dataFor(res).saved ?? []).some(
      (item) => item.channel3Id === input.id && item.status !== 'removed',
    )
    if (!wasShown(id, input.id) && !saved)
      throw new HttpError(404, 'Check prices only for items Worth showed you.', 'NOT_FOUND')
    const time = now().getTime()
    if (!priceChecksPerSession.take(id, time) || !priceChecksPerIp.take(req.ip ?? 'local', time))
      throw new HttpError(429, 'Please wait a while before checking more prices.', 'RATE_LIMITED')
    // Product reads are cached per ID for 15 minutes inside the Channel3 client.
    res.json(await channel3.checkPrice(input.id, input.savedPriceCents))
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
        sessionToday(dataFor(res)),
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
    // The demo clock replays the sample persona as it is: a hand-edited plan is the user's own
    // numbers, which never run on the clock (pre-merge judge finding 4).
    if (demoToday(data))
      throw new HttpError(
        409,
        'The demo clock is replaying Maya’s sample plan as it is. Choose Back to today before editing a plan.',
        'DEMO_CLOCK_RUNNING',
      )
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
      // Saving the plan never clears unresolved foreign-currency payments; resolving them does.
      missingFields: withForeignPaymentGate(input.missingFields, data.foreignPayments),
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
    // An explicit choice, so the sample profile's default no longer applies.
    data.profile.aiChoiceMade = true
    store.save(id, data)
    res.json(state(id))
  })
  app.post('/api/wishlist', (req, res) => {
    const { productId } = z.object({ productId: identifier }).strict().parse(req.body)
    if (!PRODUCTS.some((p) => p.id === productId))
      throw new HttpError(404, 'Product not found.', 'NOT_FOUND')
    const data = dataFor(res)
    toggleCatalog(data, productId, sessionToday(data), now())
    store.save(sessionId(res), data)
    res.json(state(sessionId(res)))
  })
  /** Saves an item for later: a catalog item, or any item Ask Worth assessed (C-17, A3). */
  app.post('/api/saved', (req, res) => {
    const parsed = saveSchema.parse(req.body)
    const id = sessionId(res)
    // A Channel3 product ID (and its link) is kept only for a product this session was shown, so a
    // saved item can never make Worth read an arbitrary product (spec item 15).
    const input =
      parsed.kind === 'custom' && parsed.channel3Id && !wasShown(id, parsed.channel3Id)
        ? { ...parsed, channel3Id: undefined, url: undefined }
        : parsed
    const data = dataFor(res)
    const item = addSaved(data, input, sessionToday(data), now())
    store.save(id, data)
    // Registers the saved row, so its price can be checked later at /api/alternatives/price.
    if (item.channel3Id) app.locals.rememberAlternative(id, item.channel3Id)
    res.json({ item, state: state(id) })
  })
  app.post('/api/saved/migrate', (req, res) => {
    const { planned } = plannedSchema.parse(req.body)
    const id = sessionId(res)
    const data = dataFor(res)
    const moved = migratePlanned(data, planned, sessionToday(data), now())
    store.save(id, data)
    res.json({ moved, state: state(id) })
  })
  /**
   * The ready day's price re-check for a saved item whose price Channel3 read (C6). The Saved
   * screen asks once when it opens on or after the plan's day, never on a timer. It is the same
   * lookup as a pasted link, sharing its cache, the daily budget and this client's hourly share.
   */
  app.post('/api/saved/:id/recheck', async (req, res) => {
    z.object({}).strict().parse(req.body)
    const data = dataFor(res)
    res.json(
      await recheckSaved(
        data,
        String(req.params.id).slice(0, 100),
        sessionToday(data),
        now(),
        (url) => channel3.lookup(url, liveSearches(req)),
      ),
    )
  })
  app.post('/api/saved/:id/remove', (req, res) => {
    z.object({}).strict().parse(req.body)
    const id = sessionId(res)
    const data = dataFor(res)
    removeSaved(data, String(req.params.id).slice(0, 100), now())
    store.save(id, data)
    res.json(state(id))
  })
  /**
   * The button path for a saved plan on return: checkoutGuards (funds confirmed today, a fresh
   * assessment for the plan's option, the catalog price, one active checkout), then the same
   * checkout path as the Buy button. Custom items never check out.
   */
  app.post('/api/saved/:id/prepare', async (req, res) => {
    z.object({}).strict().parse(req.body)
    const id = sessionId(res)
    const data = dataFor(res)
    const item = savedOf(data, now()).find(
      (saved) => saved.id === String(req.params.id) && saved.status !== 'removed',
    )
    if (!item) throw new HttpError(404, 'Saved item not found.', 'NOT_FOUND')
    const product = item.kind === 'catalog' && PRODUCTS.find((p) => p.id === item.productId)
    if (!product) throw new HttpError(409, `${ASSESSMENT_ONLY}.`, 'NOT_IN_STORE')
    const decision = checkoutGuards({
      profile: data.profile,
      purchases: livePurchases(id),
      today: sessionToday(data),
      product,
      request: { option: item.option === 'wait' ? 'wait' : 'buyToday' },
    })
    if (!decision.ok) throw new HttpError(409, decision.message, decision.code)
    const purchase = await startCheckout(id, product, {
      acknowledgeShortfall: false,
      assessed: { profileVersion: decision.profileVersion, today: decision.today },
    })
    res.json({
      purchase: publicPurchase(purchase),
      orderId: purchase.orderId,
      approvalUrl: purchase.approvalUrl,
      mode: purchase.mode,
      state: state(id),
    })
  })
  /** Agent tokens for "Connect an agent" in Settings: list, create (shown once) and revoke. */
  const tokenCreations = new WindowLimiter(10, 60 * 60_000)
  const mcpEndpoint = `${config.origin}/mcp`
  app.get('/api/agent-tokens', (_req, res) => {
    const id = sessionId(res)
    dataFor(res)
    res.json({ endpoint: mcpEndpoint, tokens: listAgentTokens(store, id, now().getTime()) })
  })
  app.post('/api/agent-tokens', (req, res) => {
    z.object({}).strict().parse(req.body)
    const id = sessionId(res)
    dataFor(res)
    const time = now().getTime()
    if (!tokenCreations.take(id, time))
      throw new HttpError(429, 'Please wait before creating more agent tokens.', 'RATE_LIMITED')
    const created = createAgentToken(store, id, time, config.maxAgentTokens)
    res.json({
      endpoint: mcpEndpoint,
      token: created.token,
      item: created.item,
      tokens: listAgentTokens(store, id, time),
    })
  })
  app.post('/api/agent-tokens/:id/revoke', (req, res) => {
    z.object({}).strict().parse(req.body)
    const id = sessionId(res)
    const time = now().getTime()
    revokeAgentToken(store, id, String(req.params.id).slice(0, 100), time)
    res.json({ endpoint: mcpEndpoint, tokens: listAgentTokens(store, id, time) })
  })
  /** Confirms today's available funds, the step a saved plan asks for before a fresh check. */
  app.post('/api/funds/confirm', (req, res) => {
    const input = fundsSchema.parse(req.body)
    const id = sessionId(res)
    noActive(id)
    const data = dataFor(res)
    const day = sessionToday(data)
    const purchases = livePurchases(id)
    data.profile = confirmFunds(data.profile, input, {
      today: day,
      now: now(),
      completed: purchases.filter((p) => p.status === 'completed').map((p) => p.id),
      projectionCents: fundsProjection(data, purchases, day)?.cents,
    })
    store.save(id, data)
    res.json(state(id))
  })
  /** D-9 (a): keep this device's plan for 30 days, or return to the 24-hour default. */
  app.post('/api/retention', (req, res) => {
    const { keep30 } = z.object({ keep30: z.boolean() }).strict().parse(req.body)
    const id = sessionId(res)
    const data = dataFor(res)
    const time = now().getTime()
    // Turning retention off never extends a session: it ends within 24 hours, or sooner if it
    // was never kept longer (a session that never opted in keeps its own expiry).
    const expires = keep30
      ? time + RETENTION_MS
      : Math.min(store.expiry(id) ?? time + SESSION_DAY_MS, time + SESSION_DAY_MS)
    const lifetime = Math.max(0, expires - time)
    data.keep30 = keep30
    store.atomic(() => {
      store.save(id, data)
      store.setExpiry(id, expires)
    })
    res.cookie(cookieName, id, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.production,
      maxAge: lifetime,
      path: '/',
    })
    res.json(state(id))
  })
  /**
   * The labelled demo clock, synthetic persona only: the video replay preset, a later day for a
   * return visit, or back to today. Persona purchases are set aside when the persona restarts.
   */
  app.post('/api/demo-clock', (req, res) => {
    const input = demoClockSchema.parse(req.body)
    const id = sessionId(res)
    noActive(id)
    const current = dataFor(res)
    const { data, reset } = applyDemoClock(current, input, today(current.profile.timezone))
    store.atomic(() => {
      if (reset)
        for (const purchase of store.purchases(id))
          if (!purchase.archived) store.putPurchase(id, { ...purchase, archived: true })
      store.save(id, data)
    })
    res.json(state(id))
  })
  function mergeTransactions(existing: Transaction[], incoming: Transaction[]) {
    return [...new Map([...existing, ...incoming].map((t) => [t.id, t])).values()]
  }
  /** The store behind each Activity row a store reported (C4), for the CSV match's wording. */
  function storeNames(id: string) {
    return Object.fromEntries(
      store
        .purchases(id)
        .filter((purchase) => purchase.reportedBy)
        .map((purchase) => [`purchase-${purchase.id}`, purchase.reportedBy!]),
    )
  }
  function transactionLimitMessage(total: number) {
    return `This import would keep ${total.toLocaleString('en-US')} transactions, but a session holds at most ${config.maxTransactions.toLocaleString('en-US')}. Import a shorter date range.`
  }
  app.post('/api/import/preview', (req, res) => {
    const { csv, dateOrder } = csvSchema.parse(req.body)
    const data = dataFor(res)
    const existing = retainedHistory(data)
    const preview = parsePayPalCsv(csv, existing, {
      today: today(data.profile.timezone),
      dateOrder,
      foreignPayments: data.foreignPayments,
      storeNames: storeNames(sessionId(res)),
    })
    const total = mergeTransactions(existing, preview.transactions).length
    if (total > config.maxTransactions)
      preview.errors.unshift({ row: 1, message: transactionLimitMessage(total) })
    res.json(preview)
  })
  app.post('/api/import/commit', (req, res) => {
    const { csv, dateOrder } = csvSchema.parse(req.body)
    const id = sessionId(res)
    noActive(id)
    const data = dataFor(res)
    const retained = retainedHistory(data)
    const preview = parsePayPalCsv(csv, retained, {
      today: today(data.profile.timezone),
      dateOrder,
      foreignPayments: data.foreignPayments,
      storeNames: storeNames(sessionId(res)),
    })
    if (preview.needsDateOrder)
      throw new HttpError(
        400,
        'Choose whether this file’s dates are month/day or day/month, then import it again. No history was changed.',
        'DATE_ORDER_REQUIRED',
      )
    if (preview.errors.length)
      throw new HttpError(
        400,
        'Correct the flagged rows before importing. No history was changed.',
        'IMPORT_ERRORS',
      )
    if (!preview.transactions.length && !preview.duplicates && !preview.unresolved.length)
      throw new HttpError(400, 'No supported transactions found.', 'EMPTY_IMPORT')
    // Keep each store-report match (C4), so a later import never takes another payment for it.
    const matched = new Map((preview.storeMatches ?? []).map((m) => [m.reportId, m.importId]))
    const kept = retained.map((t) =>
      matched.has(t.id) ? { ...t, matchedImportId: matched.get(t.id)! } : t,
    )
    const merged = mergeTransactions(kept, preview.transactions)
    if (merged.length > config.maxTransactions)
      throw new HttpError(400, transactionLimitMessage(merged.length), 'TOO_MANY_TRANSACTIONS')
    const switching = data.profile.source === 'demo'
    // Imported data is real: it never follows the demo clock.
    delete data.demoClock
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
    const known = switching ? [] : (data.foreignPayments ?? [])
    const inHistory = new Set(merged.map((t) => t.id))
    data.foreignPayments = [
      // A payment this export pairs with its USD conversion is answered by PayPal's own figure.
      ...known.map((payment) =>
        preview.converted.includes(payment.id) || (!payment.resolution && inHistory.has(payment.id))
          ? { ...payment, resolution: { kind: 'matched' as const } }
          : payment,
      ),
      ...preview.unresolved.filter((payment) => !known.some((item) => item.id === payment.id)),
    ]
    const plans = instalmentPlanReview(preview.instalmentPlans)
    data.profile.missingFields = withForeignPaymentGate(
      [
        'Confirm current available funds, income, upcoming bills, and everyday spending after import.',
        ...(plans ? [plans] : []),
      ],
      data.foreignPayments,
    )
    store.atomic(() => {
      // Purchases made as the persona never reduce the user's own plan or appear in their activity.
      if (switching)
        for (const purchase of store.purchases(id))
          if (!purchase.archived) store.putPurchase(id, { ...purchase, archived: true })
      store.save(id, data)
    })
    res.json(state(id))
  })
  app.post('/api/import/unresolved/:paymentId', (req, res) => {
    const input = resolutionSchema.parse(req.body)
    const id = sessionId(res)
    noActive(id)
    const data = dataFor(res)
    const payment = data.foreignPayments?.find((item) => item.id === String(req.params.paymentId))
    if (!payment) throw new HttpError(404, 'Foreign-currency payment not found.', 'NOT_FOUND')
    if (payment.resolution)
      throw new HttpError(409, 'This payment is already resolved.', 'ALREADY_RESOLVED')
    if (data.transactions.some((t) => t.id === payment.id))
      throw new HttpError(
        409,
        'This payment is already in your history with its USD cost.',
        'ALREADY_IN_HISTORY',
      )
    if ('oneOff' in input) payment.resolution = { kind: 'oneOff' }
    else {
      if (data.transactions.length >= config.maxTransactions)
        throw new HttpError(
          400,
          transactionLimitMessage(data.transactions.length + 1),
          'TOO_MANY_TRANSACTIONS',
        )
      payment.resolution = { kind: 'usd', amountCents: input.amountCents }
      // Its USD cost joins the history, so the history-based suggestions can be checked again.
      data.transactions = [
        ...data.transactions,
        foreignPaymentTransaction(payment, input.amountCents),
      ].sort((a, b) => b.date.localeCompare(a.date))
      const analysis = analyzeHistory(data.transactions, today(data.profile.timezone))
      data.profile.coverageDays = analysis.coverageDays
      const names = new Set(data.profile.flows.map((flow) => flow.name.toLowerCase()))
      data.profile.flows.push(
        ...analysis.recurring.filter(
          (flow) =>
            flow.name.toLowerCase() === payment.name.toLowerCase() &&
            !names.has(flow.name.toLowerCase()),
        ),
      )
      data.profile.missingFields = data.profile.missingFields.filter(
        (field) => !field.startsWith(SPENDING_REVIEW),
      )
      if (analysis.suggestedDailySpendCents > data.profile.dailySpendCents)
        data.profile.missingFields.push(
          `${SPENDING_REVIEW} with ${payment.name.slice(0, 60)} included, your imported history suggests ${money(analysis.suggestedDailySpendCents)} a day, more than your ${money(data.profile.dailySpendCents)} estimate.`,
        )
    }
    data.profile.missingFields = withForeignPaymentGate(
      data.profile.missingFields,
      data.foreignPayments,
    )
    data.profile.version += 1
    store.save(id, data)
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
  /** What Claude's tools may ask the server for in this session, each behind its own guard. */
  function chatActions(req: Request, id: string): ChatActions {
    return {
      payIn4Eligibility,
      storeProductUrl: (productId) => storeProductUrl(id, productId),
      findAlternatives: (query, maxPriceCents) =>
        channel3.search(query, maxPriceCents, liveSearches(req)),
    }
  }
  app.post('/api/chat', async (req, res) => {
    const parsed = chatSchema.parse(req.body)
    const session = sessionId(res)
    // A remembered item counts only with this session's signature, so its price is one Worth read.
    const { items: sent, ...rest } = parsed
    const items = signer.verify(session, sent)
    // Links never reach Claude (C5): the page sends them to /api/lookup, and any that arrive here
    // anyway are replaced in the message and history.
    const input = {
      ...rest,
      message: withoutWebsites(rest.message),
      history: rest.history.map((turn) => ({ ...turn, content: withoutWebsites(turn.content) })),
      ...(items.length ? { items } : {}),
    }
    const reply = (answer: ChatReply) => res.json(signer.sign(session, answer))
    const current = state(session)
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
    const id = session
    const actions = chatActions(req, id)
    // Local answers still search other stores for something cheaper; nothing goes to Claude.
    /** Answers that list similar items record them as shown to this session. */
    const shown = (answer: ChatReply) => {
      rememberShown(id, answer.alternatives)
      return answer
    }
    const local = async (reason?: string) => shown(await localReply(input, data, reason, actions))
    if (!mayUseExternalAi(current.profile))
      return reply(
        await local(
          'AI sharing is off. This is a local calculation, not an AI response; your financial context was not sent to Claude.',
        ),
      )
    if (!chat) return reply(await local())
    if (chatBusy.has(id))
      throw new HttpError(
        429,
        'Your assistant is still answering. Please wait a moment.',
        'CHAT_BUSY',
      )
    const limited = claudeLimit(req)
    if (limited)
      return reply(
        await local(
          `${CLAUDE_LIMIT_REASON[limited]}, so this answer uses local calculations, not an AI response.`,
        ),
      )
    chatBusy.add(id)
    try {
      return reply(shown(await chat.reply(input, data, actions)))
    } catch (error) {
      // Error class only: never the message text, financial data, or credentials.
      console.warn('Worth chat used local fallback:', error instanceof Error ? error.name : 'Error')
      return reply(
        await local(
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
    const purchase = await startCheckout(sessionId(res), product, { acknowledgeShortfall })
    res.json({
      purchase: publicPurchase(purchase),
      orderId: purchase.orderId,
      approvalUrl: purchase.approvalUrl,
      mode: purchase.mode,
    })
  })
  const captureSchema = z
    .object({
      mockDecline: z.literal(true).optional(),
      /** The user's explicit decision, at payment time, to go ahead below the cushion. */
      acknowledgeShortfall: z.boolean().optional(),
    })
    .strict()
  app.post('/api/checkout/:id/capture', async (req, res) => {
    const { mockDecline = false, acknowledgeShortfall = false } = captureSchema.parse(req.body)
    if (mockDecline && !config.paypalNegativeTesting)
      throw new HttpError(
        400,
        'The sandbox decline demo is turned off on this server.',
        'NEGATIVE_TESTING_DISABLED',
      )
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
      let order: PayPalOrder | undefined
      if (purchase.mode === 'sandbox') {
        purchase = await ensureOrder(id, purchase)
        // One lookup serves both reconciliation and the approval check.
        order = await paypal!.get(purchase.orderId!)
        purchase = reconcile(id, purchase, order)
        if (purchase.status === 'completed' || purchase.status === 'pending') return purchase
        if (!ACTIVE.has(purchase.status))
          throw new HttpError(
            409,
            'PayPal did not complete this payment. Start a new checkout.',
            'CHECKOUT_CLOSED',
          )
      }
      const data = dataFor(res)
      if (
        purchase.assessmentDate !== sessionToday(data) ||
        purchase.profileVersion !== data.profile.version
      )
        throw new HttpError(
          409,
          'The date or financial plan changed. Cancel this checkout, confirm your current funds, and assess again.',
          'ASSESSMENT_EXPIRED',
        )
      // An order Claude prepared below the cushion is paid only on the user's own confirmation,
      // sent with this capture request; nothing earlier in the chat counts.
      if (purchase.proceedConfirmRequired && !acknowledgeShortfall)
        throw new HttpError(
          409,
          'This purchase dips below your cushion. Confirm that you want to go ahead before Worth completes the payment.',
          'SHORTFALL_ACKNOWLEDGEMENT_REQUIRED',
          undefined,
          { purchase: publicPurchase(purchase) },
        )
      assertAssessment(
        assessmentFor(id, purchase.amountCents, purchase.name, purchase.id),
        purchase.acknowledgedShortfall || acknowledgeShortfall,
      )
      if (purchase.mode === 'demo')
        return complete(id, purchase, `demo-${purchase.id}`, now().toISOString())
      if (order!.status !== 'APPROVED')
        throw new HttpError(
          409,
          'Approve this order in the PayPal sandbox before confirming payment.',
          'BUYER_APPROVAL_REQUIRED',
          undefined,
          { purchase: publicPurchase(purchase) },
        )
      // After a decline the buyer approves again; that capture needs its own request ID, because
      // PayPal answers a repeated ID with the earlier result.
      const retries = purchase.captureRetries ?? 0
      const requestId = retries ? `capture-${purchase.id}-${retries}` : `capture-${purchase.id}`
      const attempting: StoredPurchase = {
        ...purchase,
        status: 'pending',
        captureAttemptedAt: now().toISOString(),
      }
      delete attempting.needsReapproval
      delete attempting.lastError
      store.putPurchase(id, attempting)
      try {
        return reconcile(
          id,
          attempting,
          await paypal!.capture(purchase.orderId!, requestId, { mockDecline }),
        )
      } catch (error) {
        return captureFailed(id, attempting, error)
      }
    })
    res.json({ purchase: publicPurchase(purchase), state: state(id) })
  })
  /**
   * Classifies a failed capture. A decline reopens approval, a definitive rejection releases the
   * attempt, and only transport failures and server errors leave the payment uncertain.
   */
  async function captureFailed(id: string, attempted: StoredPurchase, error: unknown) {
    const stored = store.purchase(attempted.id, id)!
    if (stored.status === 'completed') return stored
    if (error instanceof HttpError) throw error
    const retries = (attempted.captureRetries ?? 0) + 1
    if (error instanceof PayPalError && REAPPROVAL_ISSUES.has(error.issue)) {
      const declined: StoredPurchase = {
        ...stored,
        status: 'created',
        captureRetries: retries,
        needsReapproval: true,
        approvalUrl: approvalLink(error.links) ?? stored.approvalUrl,
        lastError: { code: error.issue, message: DECLINE_MESSAGES[error.issue]! },
      }
      delete declined.captureAttemptedAt
      store.putPurchase(id, declined)
      throw new HttpError(409, declined.lastError!.message, 'PAYMENT_DECLINED', undefined, {
        purchase: publicPurchase(declined),
      })
    }
    if (error instanceof PayPalError && error.issue === 'ORDER_ALREADY_CAPTURED')
      return reconcile(id, stored, await paypal!.get(attempted.orderId!))
    const definitive =
      error instanceof PayPalError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408 &&
      error.status !== 429
    if (definitive) {
      // PayPal refused the request itself, so no capture exists and nothing stays locked.
      const approval = error.issue === 'ORDER_NOT_APPROVED'
      const released: StoredPurchase = {
        ...stored,
        status: 'created',
        captureRetries: retries,
        lastError: {
          code: approval ? 'BUYER_APPROVAL_REQUIRED' : 'CAPTURE_REJECTED',
          message: approval ? 'Approve the order in PayPal before capture.' : REJECTED_CAPTURE,
        },
      }
      delete released.captureAttemptedAt
      store.putPurchase(id, released)
      throw new HttpError(409, released.lastError!.message, released.lastError!.code, undefined, {
        purchase: publicPurchase(released),
      })
    }
    // A network failure may follow a successful capture. Keep the allocation and reconcile on retry.
    store.putPurchase(id, {
      ...stored,
      status: 'unknown',
      lastError: { code: 'PAYPAL_UNCERTAIN', message: UNCERTAIN_CAPTURE },
    })
    throw new HttpError(502, UNCERTAIN_CAPTURE, 'PAYPAL_UNCERTAIN')
  }
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
      // Without an order no capture can exist, so the reservation is released locally.
      if (purchase.mode === 'sandbox' && ACTIVE.has(purchase.status) && purchase.orderId) {
        let order: PayPalOrder
        try {
          order = await paypal!.get(purchase.orderId)
        } catch (error) {
          // PayPal no longer has the order, and Worth never tried to capture it: nothing was paid.
          if (
            error instanceof PayPalError &&
            (error.status === 404 || error.issue === 'RESOURCE_NOT_FOUND') &&
            !purchase.captureAttemptedAt
          ) {
            store.putPurchase(id, { ...purchase, status: 'cancelled' })
            return
          }
          throw error
        }
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
      if (ACTIVE.has(purchase.status)) store.putPurchase(id, { ...purchase, status: 'cancelled' })
    })
    res.json(state(id))
  })
  app.use('/api', (_req, res) =>
    res.status(404).json({ error: 'API endpoint not found.', code: 'NOT_FOUND' }),
  )
  const errors: ErrorRequestHandler = (error, req, res, _next) => {
    // /mcp speaks JSON-RPC: a body the parser refused gets a JSON-RPC error, never the CSV message.
    if (req.path === '/mcp' && (error?.type === 'entity.too.large' || error instanceof SyntaxError))
      return void mcpBodyError(res, error?.type === 'entity.too.large' ? 'too_large' : 'parse')
    if (error instanceof z.ZodError)
      return void res
        .status(400)
        .json({ error: error.issues[0]?.message ?? 'Invalid request.', code: 'INVALID_INPUT' })
    if (
      error instanceof PlanError ||
      error instanceof SavedError ||
      error instanceof DemoClockError ||
      error instanceof AgentTokenError
    )
      return void res.status(error.status).json({ error: error.message, code: error.code })
    if (error instanceof HttpError)
      return void res.status(error.status).json({
        ...error.extra,
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
    // A store report over 2 KB is refused like any other; with the hand-off off, it isn't there.
    if (req.path === '/api/handoff/outcome' && error?.type)
      return void (handoff
        ? res.status(400).json(OUTCOME_REFUSED)
        : res.status(404).json(OUTCOME_NOT_FOUND))
    // A store link too large to read is an unverifiable link, never a file upload.
    if (req.path.startsWith('/api/handoff/') && error?.type === 'entity.too.large')
      return void res.status(400).json({ error: HANDOFF_UNVERIFIED, code: 'HANDOFF_UNVERIFIED' })
    if (error?.type === 'entity.too.large')
      return void res
        .status(413)
        .json({ error: `This file is too large. ${CSV_SIZE_MESSAGE}`, code: 'TOO_LARGE' })
    console.error('Worth request failed:', error instanceof Error ? error.name : 'UnknownError')
    res
      .status(500)
      .json({ error: 'Something went wrong. Please try again.', code: 'INTERNAL_ERROR' })
  }
  app.use(errors)
  return app
}
