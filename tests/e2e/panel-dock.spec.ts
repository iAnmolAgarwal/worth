import type { Page } from '@playwright/test'
import { expect, origins, test } from './fixtures'

/**
 * The Ask Worth panel's composer sits at the panel's bottom edge with its normal padding, with
 * and without the item chip above it, on an empty and a long thread, at 900 and 720 px tall.
 */
async function gap(page: Page) {
  return page.evaluate(() => {
    const panel = document.querySelector('.agent-panel')!.getBoundingClientRect()
    const composer = document.querySelector('.ask-panel .composer')!.getBoundingClientRect()
    return Math.round(panel.bottom - composer.bottom)
  })
}

for (const height of [900, 720]) {
  test(`the composer sits at the panel's bottom (${height} px tall)`, async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop-1440', 'the desktop panel')
    await page.setViewportSize({ width: 1440, height })
    await page.route('**/api/chat', (route) =>
      route.fulfill({
        json: {
          message: 'A long answer. '.repeat(40),
          mode: 'demo',
          intent: 'overview',
          suggestions: [],
          toolCalls: [],
        },
      }),
    )
    await page.goto(`${origins.worth}/?replay=demo&tour=0`)
    await expect(page.getByText(/as of Fri, Nov 13, 2026/)).toBeVisible()
    await page.goto(`${origins.worth}/?tour=0#decision?product=halden-x5&from=home`)
    await expect(page.getByRole('region', { name: 'Your balance day by day' })).toBeVisible()
    await page.locator('[data-tour="guide"]').click()
    // The item chip sits above the input: the composer still meets the bottom.
    await expect(page.locator('.offer-chip')).toBeVisible()
    expect(await gap(page)).toBeLessThanOrEqual(16)
    // Without the chip, and with a thread longer than the panel.
    await page.getByRole('button', { name: /Don’t ask about/ }).click()
    expect(await gap(page)).toBeLessThanOrEqual(16)
    for (let i = 0; i < 3; i++) {
      await page.getByRole('textbox', { name: 'Message Worth' }).fill(`Question ${i}`)
      await page.getByRole('button', { name: 'Send' }).click()
      await expect(page.locator('.ask-panel .bot.enter')).toHaveCount(i + 1)
    }
    expect(await gap(page)).toBeLessThanOrEqual(16)
    await page.screenshot({ path: info.outputPath(`panel-${height}.png`) })
  })
}
