import type { Page } from '@playwright/test'
import { analyseLink, expect, expectCamera, origins, pay, test } from './fixtures.ts'

// The store's swipe button (<worth-check mode="swipe">, shared/worthSwipe.ts) in a real browser:
// PayPal's own button with Worth's W tab docked on its right. Every test also fails on any
// window.open call or CSP violation on either origin (fixtures.ts).

/** The product page once the fake PayPal button is up and the signed link has settled. */
async function swipeRow(page: Page) {
  const { href } = await analyseLink(page)
  const paypal = page.locator('worth-check paypal-button')
  await expect(paypal).toBeVisible()
  const tab = page.locator('worth-check').getByRole('link', { name: 'Analyse with Worth' })
  await expect(tab).toBeVisible()
  const row = (await page.locator('worth-check .row').boundingBox())!
  const box = (await tab.boundingBox())!
  return { href, paypal, tab, row, box }
}

/** Drags the tab left by `share` of the room it can travel, with the mouse. */
async function swipe(page: Page, share: number) {
  const { row, box } = await swipeRow(page)
  const y = box.y + box.height / 2
  const from = box.x + box.width / 2
  const to = from - share * (row.width - box.width)
  await page.mouse.move(from, y)
  await page.mouse.down()
  await page.mouse.move(to, y, { steps: 12 })
  return { release: () => page.mouse.up(), row }
}

const offset = (page: Page) =>
  page
    .locator('worth-check .swipe')
    .evaluate((box) => Number(getComputedStyle(box).getPropertyValue('--d') || 0))

test.describe('the swipe button', () => {
  test('at rest PayPal’s button is PayPal’s: nothing covers it, and it still pays', async ({
    page,
  }) => {
    const { paypal, tab } = await swipeRow(page)
    const button = (await paypal.boundingBox())!
    const tabBox = (await tab.boundingBox())!
    // Docked flush on PayPal's right edge, at PayPal's height.
    expect(Math.abs(button.x + button.width - tabBox.x)).toBeLessThanOrEqual(1)
    expect(tabBox.height).toBe(45)
    expect(button.height).toBe(45)
    // The top element at PayPal's centre and near its edges is PayPal's own button.
    const hits = await page.evaluate(
      ({ x, y, width, height }) =>
        [
          [x + width / 2, y + height / 2],
          [x + 4, y + height / 2],
          [x + width - 3, y + height / 2],
          [x + width / 2, y + 3],
        ].map(([px, py]) => document.elementFromPoint(px!, py!)?.tagName),
      button,
    )
    expect(hits).toEqual(['PAYPAL-BUTTON', 'PAYPAL-BUTTON', 'PAYPAL-BUTTON', 'PAYPAL-BUTTON'])
    await expect(page.locator('worth-check .panel')).toBeHidden()
    // The hint under the tab is decoration only.
    const hint = page.locator('worth-check .hint')
    await expect(hint).toHaveText('Swipe left for Worth')
    await expect(hint).toHaveAttribute('aria-hidden', 'true')
    // A tap on PayPal's button pays with PayPal, as it always did.
    expect(await pay(page)).toMatch(/^E2E-ORDER-\d+$/)
    expect(page.url()).toBe(`${origins.store}/p/camera`)
  })

  test('a swipe past half the row lands on /check in the same tab', async ({ page }) => {
    const { release } = await swipe(page, 0.62)
    // The reveal is drawn over the button only while dragging.
    await expect(page.locator('worth-check .panel')).toBeVisible()
    await expect(page.locator('worth-check .words')).toHaveText('Analyse with Worth')
    await release()
    await page.waitForURL(`${origins.worth}/check`)
    await expectCamera(page)
  })

  test('a short swipe springs back and goes nowhere', async ({ page }) => {
    const { release } = await swipe(page, 0.1)
    const navigations: string[] = []
    page.on('framenavigated', (frame) => navigations.push(frame.url()))
    expect(await offset(page)).toBeGreaterThan(10)
    await release()
    await expect.poll(() => offset(page)).toBe(0)
    await expect(page.locator('worth-check .panel')).toBeHidden()
    expect(navigations).toEqual([])
    expect(page.url()).toBe(`${origins.store}/p/camera`)
    // The shopper has found the tab, so the hint has done its job.
    await expect(page.locator('worth-check .hint')).toBeHidden()
  })

  test('a tap on the W tab opens Worth', async ({ page }) => {
    const { tab } = await swipeRow(page)
    await tab.click()
    await page.waitForURL(`${origins.worth}/check`)
  })

  test('the keyboard reaches the tab after PayPal’s button, and Enter opens Worth', async ({
    page,
  }) => {
    const { tab } = await swipeRow(page)
    await tab.focus()
    await expect(tab).toBeFocused()
    // A visible ring, drawn inside the tab so it never spills onto PayPal's button.
    const ring = await tab.evaluate((a) => getComputedStyle(a).outlineStyle)
    expect(ring).toBe('solid')
    await page.keyboard.press('Enter')
    await page.waitForURL(`${origins.worth}/check`)
  })

  test('the tab arrow nudges, and stays still under reduced motion', async ({ page }) => {
    await swipeRow(page)
    const animations = () =>
      page
        .locator('worth-check .nudge')
        .evaluateAll((arrows) => arrows.map((arrow) => getComputedStyle(arrow).animationName))
    await expect.poll(animations).toEqual(['worth-nudge'])
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect.poll(animations).toEqual(['none'])
    // Dragging is off then, so the hint asks for a tap instead.
    await expect(page.locator('worth-check .hint')).toHaveText('Tap the W for Worth')
  })
})

test.describe('on a touch screen', () => {
  test.skip(({ hasTouch }) => !hasTouch, 'touch only')

  /**
   * One finger from `from` to `to`, through CDP's touch events. `beforeLift` runs with the finger
   * still down, so a test can wait on the component's own state before the release.
   */
  async function touch(
    page: Page,
    from: [number, number],
    to: [number, number],
    beforeLift?: () => Promise<void>,
  ) {
    const cdp = await page.context().newCDPSession(page)
    const point = ([x, y]: [number, number]) => [{ x, y, id: 1 }]
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(from) })
    for (let i = 1; i <= 10; i++) {
      const at: [number, number] = [
        from[0] + ((to[0] - from[0]) * i) / 10,
        from[1] + ((to[1] - from[1]) * i) / 10,
      ]
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(at) })
    }
    await beforeLift?.()
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }

  /**
   * Waits until the page has stopped scrolling. A touch scroll ends in a fling that can run on for
   * a while on a slow machine; a finger that lands mid-fling only stops the fling, as on a real
   * phone, and the tab it was aimed at has moved on by then. This was the CI flake.
   */
  async function scrollSettled(page: Page) {
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              new Promise<boolean>((done) => {
                const start = window.scrollY
                setTimeout(() => done(window.scrollY === start), 250)
              }),
          ),
        { timeout: 10_000 },
      )
      .toBe(true)
  }

  test('a vertical drag on the tab scrolls the page; a sideways swipe opens Worth', async ({
    page,
  }) => {
    if (process.env.E2E_CPU_THROTTLE)
      await (
        await page.context().newCDPSession(page)
      ).send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.E2E_CPU_THROTTLE) })
    const { row, box } = await swipeRow(page)
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    const before = await page.evaluate(() => window.scrollY)
    await touch(page, [x, y], [x, y - 200])
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before + 50)
    expect(page.url()).toBe(`${origins.store}/p/camera`)
    // The vertical drag never started a swipe.
    await expect(page.locator('worth-check .swipe')).not.toHaveClass(/dragging|committing/)
    // Aim at the tab only once the page is still, and listen for the navigation before the swipe.
    await scrollSettled(page)
    const moved = (await page.locator('worth-check .tab').boundingBox())!
    const at = moved.y + moved.height / 2
    const opened = page.waitForURL(`${origins.worth}/check`)
    await touch(page, [x, at], [x - 0.7 * (row.width - box.width), at], () =>
      // The sideways move is the component's drag, recognised before the finger lifts.
      expect(page.locator('worth-check .swipe')).toHaveClass(/dragging/),
    )
    await opened
  })
})
