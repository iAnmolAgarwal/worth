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
  expect(total).toBeGreaterThanOrEqual(2)
  const narrow = page.viewportSize()!.width < 720
  for (let step = 1; step <= total; step++) {
    await expect(callout.locator('.tour-count')).toHaveText(`${step} of ${total}`)
    const anchor = (await callout.getAttribute('data-step'))!
    // Let the scroll into view settle before measuring.
    await page.waitForTimeout(600)
    const [box, target] = await page.evaluate((name) => {
      const rect = (element: Element) => {
        const r = element.getBoundingClientRect()
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
      }
      const element = [...document.querySelectorAll(`[data-tour="${name}"]`)].find(
        (e) => e.getBoundingClientRect().width > 0,
      )!
      return [rect(document.querySelector('.tour-callout')!), rect(element)]
    }, anchor)
    // Never on top of its own feature.
    const overlap =
      box.left < target.right &&
      target.left < box.right &&
      box.top < target.bottom &&
      target.top < box.bottom
    expect(overlap, `callout covers ${anchor}`).toBe(false)
    if (!narrow) {
      // Beside it: the gap is the bright margin plus the arrow.
      const gap = Math.max(
        target.left - box.right,
        box.left - target.right,
        target.top - box.bottom,
        box.top - target.bottom,
      )
      expect(gap, `callout beside ${anchor}`).toBeGreaterThanOrEqual(12)
      expect(gap, `callout beside ${anchor}`).toBeLessThanOrEqual(20)
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
