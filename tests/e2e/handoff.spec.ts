import { signToken } from '../../shared/handoff.ts'
import {
  analyse,
  analyseLink,
  backToStore,
  claims,
  consent,
  consentBox,
  expect,
  expectCamera,
  lowestBalance,
  origins,
  pay,
  reported,
  reportedRows,
  reportLanded,
  test,
  testHandoff,
  worthLine,
} from './fixtures.ts'

// C8: the store ↔ Worth hand-off (specs/handoff-contract.md) in a real browser across two
// origins. Every test also fails on any window.open call or CSP violation on either origin
// (fixtures.ts).

const CAMERA_CENTS = 119900

test('analyse at Larkspur, consent, go back and pay: Worth shows the payment once', async ({
  page,
}) => {
  // A Worth user with the sample plan, whose Saved list has the camera.
  await page.goto(`${origins.worth}/`)
  const room = page.locator('.balance .v')
  await expect(room).toHaveText('$440.01')
  const lowestBefore = await lowestBalance(page)
  await page.goto(`${origins.worth}/#saved`)
  const savedCamera = page.getByRole('button', { name: 'Remove Everyday camera from Saved' })
  await expect(savedCamera).toHaveCount(1)

  // The store's product page renders <worth-check>; its link lands on /check, pre-filled.
  const { link, token } = await analyseLink(page)
  await expect(link).toHaveText('Analyse with Worth')
  expect(await link.getAttribute('target')).toBeNull()
  const sent: { url: string; referer?: string; body: string | null }[] = []
  page.on('request', (request) => {
    if (request.url().startsWith(origins.worth))
      sent.push({
        url: request.url(),
        referer: request.headers().referer,
        body: request.postData(),
      })
  })
  const landing = page.waitForResponse(`${origins.worth}/check`)
  await link.click()
  await page.waitForURL(`${origins.worth}/check`)
  // The token was read from the fragment and removed from the address bar.
  expect(page.url()).toBe(`${origins.worth}/check`)
  await expectCamera(page)
  // The store's own PayPal SDK said yes to Pay in 4, signed into the quote (§3.2).
  await expect(
    page
      .getByRole('button', { name: /Compare with PayPal Pay in 4/ })
      .getByText('Larkspur Supply offers PayPal Pay in 4 for this amount.'),
  ).toBeVisible()
  // It reached Worth's server only in the body of /api/handoff/open, never in a URL or Referer.
  expect((await landing).headers()['referrer-policy']).toBe('no-referrer')
  expect(
    sent.filter(
      (request) => request.url.includes(token) || /\/check|#q=/.test(request.referer ?? ''),
    ),
  ).toEqual([])
  expect(sent.filter((request) => request.body?.includes(token)).map((r) => r.url)).toEqual([
    `${origins.worth}/api/handoff/open`,
  ])
  await consent(page)

  // Back at the store: Worth's one line beside PayPal's button, then the fake PayPal approves.
  await backToStore(page)
  await expect(worthLine(page)).toHaveText(/^Worth: (fits today|fits on \w{3}, \w{3} \d{1,2})$/)
  expect(page.url()).not.toContain('worth=')
  const orderId = await pay(page)
  expect(orderId).toMatch(/^E2E-ORDER-\d+$/)
  await reportLanded(page)

  // Back on Worth: the notice once, room to spend down once, one Activity row, Saved cleared.
  await page.goto(`${origins.worth}/`)
  await expect(page.getByRole('status').filter({ hasText: 'told Worth' })).toHaveText(
    'Larkspur Supply told Worth about your $1,199.00 payment.',
  )
  await expect(room).toHaveText('$0.00')
  expect(await lowestBalance(page)).toBe(lowestBefore - CAMERA_CENTS)
  await page.goto(`${origins.worth}/#activity`)
  await expect(reportedRows(page)).toHaveCount(1)
  await expect(reportedRows(page)).toContainText('Everyday camera')
  await expect(reportedRows(page)).toContainText('−$1,199.00')
  await page.goto(`${origins.worth}/#saved`)
  await expect(
    page.getByRole('button', { name: 'Remove Studio headphones from Saved' }),
  ).toBeVisible()
  await expect(savedCamera).toHaveCount(0)

  // A reload: the notice was cleared, and nothing counts twice.
  await page.goto(`${origins.worth}/`)
  await expect(room).toHaveText('$0.00')
  await expect(page.getByText('told Worth about')).toHaveCount(0)
  expect(await reported(page)).toBe(1)

  // Each origin keeps its own session cookie, HttpOnly and SameSite=Lax (Secure and __Host- in
  // production: tests/handoff-contract.test.ts).
  const cookies = await page.context().cookies()
  const worthCookie = cookies.find((cookie) => cookie.name === 'worth_session')
  const storeCookie = cookies.find((cookie) => cookie.name === 'lk_session')
  expect(worthCookie).toMatchObject({ domain: '127.0.0.1', httpOnly: true, sameSite: 'Lax' })
  expect(storeCookie).toMatchObject({ domain: 'localhost', httpOnly: true, sameSite: 'Lax' })
})

test.describe('when something is wrong', () => {
  test('an expired quote says so and offers the plain way back', async ({ page }) => {
    const hourAgo = Date.now() - 60 * 60 * 1000
    const token = testHandoff(() => hourAgo).signQuote({
      ...claims((await analyseLink(page)).token),
      iat: undefined,
      exp: undefined,
    })
    await page.goto(`${origins.worth}/check#q=${token}`)
    await expect(page.getByRole('heading', { name: 'This link has expired' })).toBeVisible()
    await expect(page.getByRole('alert').or(page.getByRole('status'))).toContainText(
      'This link from Larkspur Supply has expired. Go back and tap Analyse with Worth again.',
    )
    const back = page.getByRole('link', { name: 'Back to Larkspur Supply' })
    await expect(back).toHaveAttribute('href', `${origins.store}/p/camera`)
    // The token never stays in the address bar.
    expect(page.url()).toBe(`${origins.worth}/check`)
    await back.click()
    await page.waitForURL(`${origins.store}/p/camera`)
    await expect(worthLine(page)).toHaveCount(0)
  })

  for (const [name, change] of [
    ['a tampered price', (token: string) => tamper(token, { amountCents: 100 })],
    ['a forged signature', (token: string) => `${token.split('.')[0]}.${'A'.repeat(43)}`],
    ['another key', (token: string) => forge(claims(token))],
  ] as const)
    test(`${name} can’t be verified and offers no way back`, async ({ page }) => {
      const { token } = await analyseLink(page)
      await page.goto(`${origins.worth}/check#q=${change(token)}`)
      await expect(page.getByRole('heading', { name: 'Check an item yourself' })).toBeVisible()
      await expect(page.getByText('We couldn’t verify this link from the store.')).toBeVisible()
      // The composer opens empty, and nothing from the token is shown or linked.
      await expect(page.getByLabel('Item')).toHaveValue('')
      await expect(page.getByRole('link', { name: /Back to/ })).toHaveCount(0)
      await expect(page.locator(`a[href^="${origins.store}"]`)).toHaveCount(0)
      await expect(page.getByText('Everyday camera')).toHaveCount(0)
    })

  test('an edited price goes back with no Worth line', async ({ page }) => {
    await analyse(page)
    await expectCamera(page)
    await page.getByRole('button', { name: 'Not right? Edit' }).click()
    await page.getByLabel('Total price, USD').fill('999')
    await page.locator('form.readas-edit').getByRole('button').first().click()
    await expect(
      page.getByText('Larkspur Supply won’t show Worth’s answer, because you changed the price.'),
    ).toBeVisible()
    const visited: string[] = []
    page.on('request', (request) => {
      if (request.isNavigationRequest()) visited.push(request.url())
    })
    await backToStore(page)
    // Worth signed nothing for a price the store didn't quote: a plain link back.
    expect(visited).toEqual([`${origins.store}/p/camera`])
    await expect(worthLine(page)).toHaveCount(0)
  })

  test('with the hand-off off, /check can’t verify any link', async ({ page }) => {
    const { token } = await analyseLink(page)
    await page.goto(`${origins.worthOff}/check#q=${token}`)
    await expect(page.getByText('We couldn’t verify this link from the store.')).toBeVisible()
    await expect(page.getByRole('link', { name: /Back to/ })).toHaveCount(0)
    expect(page.url()).toBe(`${origins.worthOff}/check`)
  })
})

test.describe('report-back', () => {
  test('a repeated report, from the store’s webhook or resent, stays one row', async ({
    page,
    request,
  }) => {
    const { qid } = await analyse(page)
    await consent(page)
    await backToStore(page)
    const orderId = await pay(page)
    await reportLanded(page)
    const lowest = await lowestBalance(page)

    // PayPal redelivers its capture webhook to the store: the store sends nothing again.
    const webhook = await request.post(`${origins.store}/api/paypal/webhook`, {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({
        id: `WH-${orderId}`,
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: { supplementary_data: { related_ids: { order_id: orderId } } },
      }),
    })
    expect(webhook.status()).toBe(200)

    // The same signed report arrives at Worth twice more, and then another capture for the quote.
    const handoff = testHandoff()
    const report = (captureId: string) => {
      const signed = handoff.signOutcome({
        v: 1,
        kid: '1',
        mid: 'larkspur',
        qid,
        orderId,
        captureId,
        amountCents: CAMERA_CENTS,
        currency: 'USD',
        status: 'COMPLETED',
        capturedAt: new Date().toISOString(),
      })
      return request.post(`${origins.worth}/api/handoff/outcome`, {
        headers: signed.headers,
        data: signed.body,
      })
    }
    const captureId = orderId.replace('ORDER', 'CAPTURE')
    for (let i = 0; i < 2; i++) {
      const repeat = await report(captureId)
      expect(repeat.status()).toBe(200)
      expect(await repeat.json()).toEqual({ recorded: true })
    }
    const another = await report(`${captureId}-2`)
    expect(await another.json()).toEqual({ recorded: false })

    await page.goto(`${origins.worth}/#activity`)
    await expect(reportedRows(page)).toHaveCount(1)
    expect(await reported(page)).toBe(1)
    expect(await lowestBalance(page)).toBe(lowest)
  })

  test('a forwarded link credits only the shopper who analysed it and came back', async ({
    page: minter,
    newShopper,
  }) => {
    // The first shopper copies the store's link and sends it on before using it.
    const { href } = await analyseLink(minter)
    const friend = await newShopper()
    await friend.goto(href)
    await friend.waitForURL(`${origins.worth}/check`)
    await expectCamera(friend)
    await consent(friend)
    await backToStore(friend)
    await expect(worthLine(friend)).toHaveText(/^Worth: /)
    await pay(friend)
    await reportLanded(friend)

    // The first shopper now follows the same link: Worth offers no consent for a quote another
    // session opened, signs nothing, and the store shows no line and reports nothing.
    await minter
      .locator('worth-check')
      .getByRole('link', { name: /Analyse with Worth/ })
      .click()
    await minter.waitForURL(`${origins.worth}/check`)
    await expectCamera(minter)
    await expect(consentBox(minter)).toHaveCount(0)
    await backToStore(minter)
    await expect(worthLine(minter)).toHaveCount(0)
    await pay(minter)

    expect(await reported(minter)).toBe(0)
    expect(await reported(friend)).toBe(1)
    await minter.goto(`${origins.worth}/#activity`)
    await expect(minter.getByText('Search activity')).toBeVisible()
    await expect(reportedRows(minter)).toHaveCount(0)
  })
})

/** The token with its payload changed and the old signature kept. */
function tamper(token: string, change: object) {
  const [body, sig] = token.split('.')
  const payload = { ...JSON.parse(Buffer.from(body!, 'base64url').toString('utf8')), ...change }
  return `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`
}

/** A well-formed quote signed with a key that isn't the shared one. */
function forge(payload: object) {
  return signToken(Buffer.alloc(32, 9), 'quote', payload)
}
