import { expect, origins, test } from './fixtures.ts'

// Connect PayPal end to end against a fake MCP server: log in once, review and confirm, then the
// plan stays up to date without a login, and Disconnect PayPal ends it with the plan kept.

test('connect once, refresh without a login, then disconnect', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'phone-390', 'One run is enough; the flow is the same')
  // PayPal's login and consent: Worth's own start of the login runs on the server, and its
  // redirect to PayPal is replaced by PayPal's answer, a straight return with a code. (A request
  // reached by a redirect is never routed, so the start itself is where to step in.)
  await page.route(`${origins.connect}/api/paypal/connect`, async (route) => {
    const response = await route.fetch({ maxRedirects: 0 })
    const authorize = new URL(response.headers().location!)
    expect(authorize.origin).toBe('https://mcp.sandbox.paypal.com')
    const back = new URL('/api/paypal/connect/callback', origins.connect)
    back.searchParams.set('code', 'e2e-code')
    back.searchParams.set('state', authorize.searchParams.get('state') ?? '')
    await route.fulfill({ status: 303, headers: { location: back.href } })
  })
  const syncs: string[] = []
  page.on('request', (request) => {
    if (request.url().endsWith('/api/paypal/sync')) syncs.push(request.method())
  })
  await page.goto(`${origins.connect}/?tour=0`)
  await page
    .getByRole('button', { name: /Connect PayPal/ })
    .first()
    .click()
  await page.getByRole('button', { name: 'Continue to PayPal' }).click()
  await expect(page.getByRole('heading', { name: 'Check what Worth found' })).toBeVisible()
  await expect(
    page.getByText(/keeps the connection to refresh it; disconnect in Settings/),
  ).toBeVisible()
  await page.getByRole('textbox', { name: /Everyday spending/ }).fill('35.00')
  await page.getByLabel('Money available today').fill('1800.00')
  await page.getByLabel('Cushion').fill('300.00')
  await page.getByRole('button', { name: 'Continue' }).click()

  const row = page.locator('[data-tour="connect"]')
  await expect(row).toContainText('PayPal connected')
  await expect(row).toContainText('Updated today')
  // Just read: no background read on this load.
  expect(syncs).toEqual([])

  // The refresh button reads again with the kept connection: no login, and the new row lands.
  await row.getByRole('button', { name: 'Read your PayPal activity again' }).click()
  await expect(page.getByText('Updated from PayPal: 1 new transaction.')).toBeVisible()
  expect(syncs).toEqual(['POST'])
  await page.goto(`${origins.connect}/?tour=0#activity`)
  await expect(page.getByText('Corner coffee')).toBeVisible()

  await page.goto(`${origins.connect}/?tour=0#settings`)
  await page.getByRole('button', { name: 'Disconnect PayPal' }).click()
  await expect(page.getByText('PayPal disconnected. Your plan stays as it is.')).toBeVisible()
  await page.goto(`${origins.connect}/?tour=0#home`)
  await expect(row).toContainText('Connect PayPal')
  await expect(row).toContainText('Updated today')
  await expect(row).not.toContainText('PayPal connected')
})
