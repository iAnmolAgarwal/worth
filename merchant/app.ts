import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import cookieParser from 'cookie-parser'
import express, { type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { WindowLimiter } from '../server/limits.ts'
import {
  createPayPalGateway,
  PayPalError,
  REAPPROVAL_ISSUES,
  toCents,
  validateOrder,
  type PayPalCapture,
  type PayPalGateway,
  type PayPalOrder,
} from '../server/paypal.ts'
import type { Product } from '../shared/types.ts'
import { findProduct, STORE_NAME } from './catalog.ts'
import { loadMerchantConfig, type MerchantConfig } from './config.ts'
import { merchantContentSecurityPolicy } from './csp.ts'
import { createHandoff, KEY_ID, MAX_TTL_S, type OutcomeBody } from './handoff-stub.ts'
import { catalogPage, notFoundPage, productPage, resultLine, type PageOptions } from './pages.ts'
import { reportOutcome, type ReportOptions } from './reportBack.ts'
import { Sessions, type OrderRecord } from './sessions.ts'

export interface MerchantAppOptions {
  config?: Partial<MerchantConfig>
  env?: Record<string, string | undefined>
  /** Injected in tests; built from the sandbox credentials otherwise. */
  paypal?: PayPalGateway
  now?: () => number
  /** The report-back transport; tests inject fetch and sleep. */
  report?: Pick<ReportOptions, 'fetch' | 'sleep' | 'log' | 'timeoutMs'>
  /** The client bundle's URL in the page. */
  scriptSrc?: string
}

/** A quote is minted for the longest life the contract allows. */
const QUOTE_TTL_S = MAX_TTL_S
const API_PER_MINUTE = 120
const QUOTES_PER_MINUTE = 30
const WEBHOOK_PER_MINUTE = 60
/** The store's own order reference carries the quote ID, so a webhook after a restart still has it. */
const REFERENCE = /^(q_[A-Za-z0-9_-]{22})\.[A-Za-z0-9_-]{8}$/
const ORDER_ID = /^[A-Za-z0-9-]{1,64}$/

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
}

export function createMerchantApp(options: MerchantAppOptions = {}) {
  const config = loadMerchantConfig(options.env ?? process.env, options.config)
  const now = options.now ?? Date.now
  const handoff = createHandoff({
    secret: config.handoffSecret,
    merchantId: config.merchantId,
    now,
  })
  const paypal =
    options.paypal ??
    (config.paypalClientId && config.paypalSecret
      ? createPayPalGateway({
          clientId: config.paypalClientId,
          secret: config.paypalSecret,
          origin: config.origin,
          webhookId: config.paypalWebhookId,
          returnUrl: (order) => `${config.origin}/p/${encodeURIComponent(order.productId)}`,
        })
      : undefined)
  const sessions = new Sessions(now)
  const apiLimiter = new WindowLimiter(API_PER_MINUTE, 60_000)
  const quoteLimiter = new WindowLimiter(QUOTES_PER_MINUTE, 60_000)
  const webhookLimiter = new WindowLimiter(WEBHOOK_PER_MINUTE, 60_000)
  /**
   * Captures with a report in flight or acknowledged by Worth. A capture enters when sending
   * starts, so the capture path and the webhook never send at once, and leaves if the report
   * fails, so a later delivery can try again.
   */
  const reported = new Set<string>()
  /** Webhook events handled to the end; a delivery that failed part-way is not one of them. */
  const seenEvents = new Set<string>()
  const pageOptions = (req: Request): PageOptions => ({
    scriptSrc: options.scriptSrc ?? '/assets/store.js',
    replay: req.query.replay === 'video',
  })
  const cookieName = config.production ? '__Host-lk_session' : 'lk_session'
  const origins = new Set([config.origin])
  if (!config.production)
    for (const host of ['localhost', '127.0.0.1']) origins.add(`http://${host}:${config.port}`)

  const app = express()
  app.disable('x-powered-by')
  if (config.trustProxy) app.set('trust proxy', config.trustProxy)
  app.locals.config = config
  app.locals.cleanup = () => sessions.cleanup()

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'same-origin')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Content-Security-Policy', merchantContentSecurityPolicy())
    if (config.production)
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    // Pages carry a fresh signed quote, so nothing dynamic is cached.
    if (!req.path.startsWith('/static/') && !req.path.startsWith('/images/'))
      res.setHeader('Cache-Control', 'no-store')
    next()
  })
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'larkspur', paypal: paypal ? 'sandbox' : 'off' })
  })
  // Webhook signatures cover the exact bytes PayPal sent, so this route keeps the raw body.
  app.use('/api/paypal/webhook', express.raw({ type: () => true, limit: '64kb' }))
  app.use(express.json({ limit: '4kb' }))
  app.use(cookieParser())
  app.use('/static', express.static(resolve(import.meta.dirname, 'public'), { maxAge: '1h' }))
  app.use(
    '/images',
    express.static(resolve(import.meta.dirname, '../public/images'), { maxAge: '1d' }),
  )

  /** The shopper's first-party session; set on the first page or API call. */
  function session(req: Request, res: Response) {
    const { id, created } = sessions.resolve(req.cookies?.[cookieName])
    if (created)
      res.cookie(cookieName, id, {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.production,
        path: '/',
        maxAge: 24 * 60 * 60 * 1000,
      })
    return id
  }

  /**
   * Signs this shopper's quote for a product from the store's own catalog price (contract §3.1).
   * The qid stays the same for the session; each render re-signs it with a fresh iat and exp.
   */
  function mintQuote(
    sessionId: string,
    product: Product,
    extra: { payLater?: boolean; replay?: boolean } = {},
  ) {
    const iat = Math.floor(now() / 1000)
    const qid = sessions.quoteId(
      sessionId,
      product.id,
      () => `q_${randomBytes(16).toString('base64url')}`,
    )
    const productUrl = `${config.origin}/p/${encodeURIComponent(product.id)}`
    const token = handoff.signQuote({
      v: 1,
      kid: KEY_ID,
      mid: config.merchantId,
      qid,
      item: product.name.slice(0, 120),
      productId: product.id,
      amountCents: product.priceCents,
      currency: 'USD',
      merchant: STORE_NAME.slice(0, 60),
      returnUrl: extra.replay ? `${productUrl}?replay=video` : productUrl,
      imageUrl: `${config.origin}${product.image}`,
      ...(extra.payLater === undefined
        ? {}
        : { payLater: { eligible: extra.payLater, source: 'merchant-sdk' as const } }),
      ...(extra.replay ? { replay: 'video' as const } : {}),
      iat,
      exp: iat + QUOTE_TTL_S,
    })
    return { token, exp: iat + QUOTE_TTL_S, href: `${config.worthOrigin}/check#q=${token}` }
  }

  app.get('/', (req, res) => {
    session(req, res)
    res.type('html').send(catalogPage(pageOptions(req)))
  })
  app.get('/p/:productId', (req, res) => {
    const product = findProduct(req.params.productId)
    if (!product)
      return res
        .status(404)
        .type('html')
        .send(notFoundPage(pageOptions(req)))
    const sessionId = session(req, res)
    const page = pageOptions(req)
    // A result from Worth adds one display line, and only for this shopper's quote for this
    // product. It never changes the price, the cart or the order. A verified qid the session does
    // not hold yet (a restarted store) is adopted, so the order reports back the quote Worth opened.
    const result = handoff.verifyResult(req.query.worth)
    if (result) sessions.pinQuote(sessionId, product.id, result.qid)
    const quoted = result ? sessions.quote(sessionId, result.qid) : undefined
    const worthLine = result && quoted?.productId === product.id ? resultLine(result) : undefined
    return res.type('html').send(
      productPage(
        {
          product,
          quote: mintQuote(sessionId, product, { replay: page.replay }),
          worthOrigin: config.worthOrigin,
          paypalClientId: config.paypalClientId,
          worthLine,
        },
        page,
      ),
    )
  })

  app.use('/api', (req, _res, next) => {
    if (req.path === '/paypal/webhook') return next()
    if (!apiLimiter.take(req.ip ?? 'local', now()))
      return next(new HttpError(429, 'Please wait a moment and try again.', 'RATE_LIMITED'))
    if (req.method !== 'GET') {
      const origin = req.get('origin')
      if ((origin && !origins.has(origin)) || req.get('sec-fetch-site') === 'cross-site')
        return next(new HttpError(403, 'This request must come from the store.', 'ORIGIN_REJECTED'))
      if (!req.is('application/json'))
        return next(new HttpError(415, 'Send a JSON request.', 'INVALID_CONTENT_TYPE'))
    }
    next()
  })

  /** A fresh quote for a page left open near expiry (contract §3.1); C2 calls it. */
  app.get('/api/worth-quote', (req, res) => {
    if (!quoteLimiter.take(req.ip ?? 'local', now()))
      throw new HttpError(429, 'Please wait a moment and try again.', 'RATE_LIMITED')
    const product = findProduct(req.query.productId)
    if (!product) throw new HttpError(404, 'Unknown product.', 'UNKNOWN_PRODUCT')
    const payLater = req.query.payLater
    if (payLater !== undefined && payLater !== 'true' && payLater !== 'false')
      throw new HttpError(400, 'payLater must be true or false.', 'INVALID_REQUEST')
    const quote = mintQuote(session(req, res), product, {
      ...(payLater === undefined ? {} : { payLater: payLater === 'true' }),
      replay: req.query.replay === 'video',
    })
    res.json(quote)
  })

  const createBody = z.strictObject({ productId: z.string().max(64) })
  app.post('/api/orders', async (req, res) => {
    if (!paypal) throw new HttpError(503, 'PayPal sandbox is not configured.', 'PAYPAL_OFF')
    const parsed = createBody.safeParse(req.body)
    const product = parsed.success ? findProduct(parsed.data.productId) : undefined
    if (!product) throw new HttpError(400, 'Unknown product.', 'UNKNOWN_PRODUCT')
    const sessionId = session(req, res)
    const quote = sessions.quoteFor(sessionId, product.id)
    const suffix = randomBytes(6).toString('base64url')
    // The price is the catalog's, never the browser's.
    const record: Omit<OrderRecord, 'orderId'> = {
      id: quote ? `${quote.qid}.${suffix}` : `lk_${randomBytes(16).toString('base64url')}`,
      productId: product.id,
      name: product.name,
      amountCents: product.priceCents,
      ...(quote ? { qid: quote.qid } : {}),
    }
    const order = await paypal.create(record)
    const merchantId = validateOrder(order, record)
    sessions.addOrder(sessionId, { ...record, orderId: order.id, merchantId })
    res.status(201).json({ orderId: order.id })
  })

  app.post('/api/orders/:orderId/capture', async (req, res) => {
    if (!paypal) throw new HttpError(503, 'PayPal sandbox is not configured.', 'PAYPAL_OFF')
    const orderId = req.params.orderId
    const record = ORDER_ID.test(orderId) ? sessions.order(session(req, res), orderId) : undefined
    if (!record) throw new HttpError(404, 'This order was not started here.', 'UNKNOWN_ORDER')
    let order: PayPalOrder
    try {
      order = await paypal.capture(orderId, `capture-${record.id}`)
    } catch (error) {
      if (error instanceof PayPalError && REAPPROVAL_ISSUES.has(error.issue))
        throw new HttpError(
          422,
          'PayPal couldn’t use that payment method. Choose another in PayPal.',
          'DECLINED',
        )
      throw error
    }
    validateOrder(order, record)
    const capture = order.purchase_units?.[0]?.payments?.captures?.[0]
    if (capture?.status === 'COMPLETED') {
      sendReport(record, order.id, capture)
      return res.json({ status: 'COMPLETED', orderId: order.id })
    }
    if (capture?.status === 'PENDING') return res.json({ status: 'PENDING', orderId: order.id })
    throw new HttpError(422, 'PayPal did not complete this payment.', 'NOT_COMPLETED')
  })

  /** Fire-and-forget report to Worth (contract §5); never awaited by a shopper's request. */
  function sendReport(
    order: { qid?: string; amountCents?: number },
    orderId: string,
    capture: PayPalCapture,
  ) {
    if (!order.qid || reported.has(capture.id)) return
    let amountCents: number
    try {
      amountCents = toCents(capture.amount.value)
    } catch {
      return
    }
    if (capture.amount.currency_code !== 'USD') return
    const body: OutcomeBody = {
      v: 1,
      kid: KEY_ID,
      mid: config.merchantId,
      qid: order.qid,
      orderId,
      captureId: capture.id,
      amountCents,
      currency: 'USD',
      status: 'COMPLETED',
      capturedAt: capture.create_time ?? new Date(now()).toISOString(),
    }
    if (reported.size > 5000) reported.clear()
    reported.add(capture.id)
    const pending = reportOutcome(body, {
      worthOrigin: config.worthOrigin,
      handoff,
      ...options.report,
    }).then((result) => {
      if (result !== 'sent') reported.delete(capture.id)
      return result
    })
    app.locals.lastReport = pending
  }

  const webhookEvent = z.object({
    id: z.string().max(100),
    event_type: z.string().max(100),
    resource: z.record(z.string(), z.unknown()),
  })
  app.post('/api/paypal/webhook', async (req, res) => {
    // Limited before verification: every delivery costs an outbound PayPal call.
    if (!webhookLimiter.take(req.ip ?? 'local', now()))
      throw new HttpError(429, 'Too many webhook deliveries.', 'RATE_LIMITED')
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : ''
    if (!paypal || !raw || !(await paypal.verify(req.headers, raw)))
      throw new HttpError(401, 'Webhook signature verification failed.', 'INVALID_WEBHOOK')
    const event = webhookEvent.parse(JSON.parse(raw))
    if (seenEvents.has(event.id)) return res.json({ received: true, duplicate: true })
    // Marked only once handled: if the order re-read below fails, PayPal's redelivery is retried.
    const handled = (body: Record<string, unknown>) => {
      if (seenEvents.size > 5000) seenEvents.clear()
      seenEvents.add(event.id)
      return res.json(body)
    }
    if (event.event_type !== 'PAYMENT.CAPTURE.COMPLETED')
      return handled({ received: true, ignored: true })
    const related = event.resource.supplementary_data as
      { related_ids?: { order_id?: unknown } } | undefined
    const orderId = related?.related_ids?.order_id
    if (typeof orderId !== 'string' || !ORDER_ID.test(orderId))
      return handled({ received: true, ignored: true })
    // The event is only a hint: the order is re-read from PayPal, and only this store's own
    // orders (a reference carrying a quote ID, for a catalog item) are reported.
    const order = await paypal.get(orderId)
    const unit = order.purchase_units?.[0]
    const qid = unit?.custom_id?.match(REFERENCE)?.[1]
    const capture = unit?.payments?.captures?.find((c) => c.status === 'COMPLETED')
    if (!qid || !capture || unit?.reference_id !== unit?.custom_id)
      return handled({ received: true, ignored: true })
    sendReport({ qid }, order.id, capture)
    return handled({ received: true })
  })

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found.', 'NOT_FOUND')))
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError)
      return res.status(error.status).json({ error: error.message, code: error.code })
    if (error instanceof PayPalError)
      return res.status(502).json({
        error: 'PayPal is not answering right now. Try again.',
        code: 'PAYPAL_UNAVAILABLE',
      })
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return res.status(400).json({ error: 'Invalid request.', code: 'INVALID_REQUEST' })
    if ((error as { type?: string })?.type === 'entity.too.large')
      return res.status(413).json({ error: 'Request too large.', code: 'TOO_LARGE' })
    console.error('Store error:', req.method, req.path, error instanceof Error ? error.message : '')
    return res.status(500).json({ error: 'Something went wrong.', code: 'INTERNAL' })
  })
  return app
}
