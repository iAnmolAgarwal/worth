import { expect, origins, test } from './fixtures'

/**
 * The guide drives the chart: a chat reply carrying a show_on_chart directive (stubbed here, so
 * no model runs) presses the pills, picks the range and pins the day on the chart on screen.
 */
test('a chart answer changes the pills, the range and the day in focus', async ({ page }) => {
  await page.goto(`${origins.worth}/?replay=demo&tour=0`)
  // The replay pins this session to Alex's demo day; the comparison then opens on its own.
  await expect(page.getByText(/as of Fri, Nov 13, 2026/)).toBeVisible()
  await page.goto(`${origins.worth}/?tour=0#decision?product=halden-x5&from=home`)
  const chart = page.getByRole('region', { name: 'Your balance day by day' })
  const pills = chart.getByRole('group', { name: 'Options on the chart' })
  await expect(pills.getByRole('button', { name: /^Wait until/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  let sent: { view?: unknown } | undefined
  await page.route('**/api/chat', async (route) => {
    sent = route.request().postDataJSON()
    await route.fulfill({
      json: {
        message:
          'Buy today: Below your $300.00 cushion from Thu, Nov 19 and below zero from Fri, Nov 20. Lowest −$726.74 on Mon, Nov 30.',
        mode: 'demo',
        intent: 'overview',
        suggestions: [],
        toolCalls: ['show_on_chart'],
        chart: {
          options: ['buyToday'],
          range: 'payday',
          focusDay: '2026-11-30',
          item: { name: 'Halden X5', amountCents: 189900, productId: 'halden-x5' },
        },
      },
    })
  })
  await page.locator('[data-tour="guide"]').click()
  await page
    .getByRole('textbox', { name: 'Message Worth' })
    .fill('Show me what happens if I buy today')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('The chart now shows this.')).toBeVisible()
  expect(sent?.view).toMatchObject({ screen: 'decision', productId: 'halden-x5' })
  await expect(pills.getByRole('button', { name: 'Buy today' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(pills.getByRole('button', { name: /^Wait until/ })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  await expect(
    chart.getByRole('group', { name: 'Days shown' }).getByRole('button', { name: 'To payday' }),
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(chart.getByRole('complementary', { name: 'Day in focus' })).toContainText(
    'Mon, Nov 30',
  )
})
