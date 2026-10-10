import { expect, origins, test } from './fixtures.ts'

// P3a: the PayPal-first start in a real browser, at 1440×900 and 390×844.

test('the start card keeps the room to spend and the first starter above the fold', async ({
  page,
}, testInfo) => {
  await page.goto(`${origins.worth}/`)
  await expect(page.locator('.balance .v')).toHaveText('$440.01')
  await expect(page.getByRole('region', { name: 'Start with your PayPal activity' })).toBeVisible()
  const viewport = page.viewportSize()!
  const hero = (await page.locator('section.balance').boundingBox())!
  expect(hero.y + hero.height).toBeLessThanOrEqual(viewport.height)
  if (testInfo.project.name === 'phone-390') {
    // Main put the camera starter's top at about 785 px at 390×844, above the tab bar.
    const starter = (await page
      .getByRole('button', { name: 'Can I afford a $1,199 camera?' })
      .boundingBox())!
    expect(starter.y).toBeLessThanOrEqual(785)
  }
})

test('the sample PayPal export builds a believable month with its calm note', async ({ page }) => {
  await page.goto(`${origins.worth}/`)
  await page.getByRole('button', { name: /Try with a sample PayPal export|Try a sample/ }).click()
  await expect(page.getByRole('heading', { name: 'Check what Worth found' })).toBeVisible()
  await expect(page.getByText('Northwind Payroll')).toBeVisible()
  await expect(page.getByText(/, the day after Maple Court rent\.$/)).toBeVisible()
  await page.getByRole('radio', { name: 'All paid' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  const hero = page.getByRole('region', { name: /Your month from PayPal/ })
  await expect(hero).toContainText('With what you’ve confirmed')
  const room = Number((await hero.locator('.v').innerText()).replace(/[$,]/g, ''))
  expect(room).toBeGreaterThanOrEqual(250)
  expect(room).toBeLessThanOrEqual(600)
  await expect(page.getByText('The day after Maple Court rent.', { exact: true })).toBeVisible()
})
