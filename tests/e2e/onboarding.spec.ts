import { expect, origins, test } from './fixtures.ts'

// P3a: the PayPal-first start in a real browser, at 1440×900 and 390×844.

test('the hero comes first and stays above the fold, with the sample strip under it', async ({
  page,
}) => {
  await page.goto(`${origins.worth}/`)
  const hero = page.getByRole('region', { name: 'Safe to spend today' })
  await expect(hero.locator('.hero-v .sr')).toHaveText('$440.01')
  await expect(page.getByRole('region', { name: 'Start with your PayPal activity' })).toBeVisible()
  const viewport = page.viewportSize()!
  const box = (await hero.boundingBox())!
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
})

test('the sample PayPal export builds a believable month with its calm note', async ({ page }) => {
  await page.goto(`${origins.worth}/`)
  await page.getByRole('button', { name: /Try a sample export/ }).click()
  await expect(page.getByRole('heading', { name: 'Check what Worth found' })).toBeVisible()
  await expect(page.getByText('Northwind Payroll')).toBeVisible()
  await expect(page.getByText(/, the day after Maple Court rent\.$/)).toBeVisible()
  await page.getByRole('radio', { name: 'All paid' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  const hero = page.getByRole('region', { name: 'Safe to spend today' })
  await expect(hero).toContainText('From your PayPal activity')
  const room = Number((await hero.locator('.hero-v .sr').innerText()).replace(/[$,]/g, ''))
  expect(room).toBeGreaterThanOrEqual(250)
  expect(room).toBeLessThanOrEqual(600)
  await expect(page.getByText('The day after Maple Court rent.', { exact: true })).toBeVisible()
})
