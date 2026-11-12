import { expect, origins, test } from './fixtures.ts'

// The first-visit tour in a real browser: it stays away under automation unless ?tour=1 asks for
// it, then walks every step whose feature is on Home, each callout beside its own feature.

test('the tour stays off under automation, and ?tour=0 keeps it off', async ({ page }) => {
  await page.goto(`${origins.worth}/`)
  await expect(page.getByRole('region', { name: 'Safe to spend today' })).toBeVisible()
  await page.goto(`${origins.worth}/?tour=0`)
  await expect(page.getByRole('region', { name: 'Safe to spend today' })).toBeVisible()
  await page.waitForTimeout(1500)
  await expect(page.locator('.tour-callout')).toHaveCount(0)
})

test('?tour=1 walks every step beside its feature and remembers it was seen', async ({ page }) => {
  await page.goto(`${origins.worth}/?tour=1`)
  const callout = page.locator('.tour-callout')
  await expect(callout).toBeVisible()
  const counter = (await callout.locator('.tour-count').innerText()).split(' of ')
  const total = Number(counter[1])
  // The sample Home shows every feature: the amount, the bar, Check a purchase, the guide, Saved
  // and the Connect PayPal row (there in every state, as "Import a file" when Connect is off).
  expect(total).toBe(6)
  const narrow = page.viewportSize()!.width < 720
  for (let step = 1; step <= total; step++) {
    await expect(callout.locator('.tour-count')).toHaveText(`${step} of ${total}`)
    const anchor = (await callout.getAttribute('data-step'))!
    // Let the scroll into view settle before measuring.
    await page.waitForTimeout(600)
    const [box, spot, target] = await page.evaluate((name) => {
      const rect = (element: Element) => {
        const r = element.getBoundingClientRect()
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
      }
      const element = [...document.querySelectorAll(`[data-tour="${name}"]`)].find(
        (e) => e.getBoundingClientRect().width > 0,
      )!
      return [
        rect(document.querySelector('.tour-callout')!),
        rect(document.querySelector('.tour-spot')!),
        rect(element),
      ]
    }, anchor)
    type Rect = typeof box
    const overlaps = (a: Rect, b: Rect) =>
      a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
    // The bright cut-out is on the feature, and the callout never covers it.
    expect(overlaps(spot, target), `cut-out on ${anchor}`).toBe(true)
    expect(overlaps(box, spot), `callout covers ${anchor}`).toBe(false)
    if (!narrow) {
      // Beside it: the gap to the cut-out is the arrow's length.
      const gap = Math.max(
        spot.left - box.right,
        box.left - spot.right,
        spot.top - box.bottom,
        box.top - spot.bottom,
      )
      expect(gap, `callout beside ${anchor}`).toBeGreaterThanOrEqual(8)
      expect(gap, `callout beside ${anchor}`).toBeLessThanOrEqual(12)
    }
    await callout.getByRole('button', { name: step === total ? 'Done' : 'Next' }).click()
  }
  await expect(callout).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('worth.tour.seen'))).toBe('1')
  // Seen: a plain reload doesn't bring it back.
  await page.goto(`${origins.worth}/`)
  await expect(page.getByRole('region', { name: 'Safe to spend today' })).toBeVisible()
  await page.waitForTimeout(1500)
  await expect(callout).toHaveCount(0)
})

test('a real first visit starts on the amount, and the guide’s nudge waits for the tour', async ({
  page,
}) => {
  // As a person's browser: no automation flag, nothing stored.
  await page.addInitScript(() =>
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }),
  )
  await page.goto(`${origins.worth}/`)
  const callout = page.locator('.tour-callout')
  await expect(callout.locator('.tour-count')).toHaveText('1 of 6')
  await expect(callout).toHaveAttribute('data-step', 'safe')
  // The nudge neither shows nor uses up its one showing while the tour is open.
  await page.waitForTimeout(2500)
  await expect(page.locator('.agent-nudge')).toHaveCount(0)
  expect(await page.evaluate(() => sessionStorage.getItem('worth.guide.nudged'))).toBeNull()
  await page.keyboard.press('Escape')
  await expect(callout).toHaveCount(0)
  await expect(page.locator('.agent-nudge[role="status"]')).toBeVisible({ timeout: 5000 })
})
