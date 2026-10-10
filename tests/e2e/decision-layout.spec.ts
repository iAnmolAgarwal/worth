import type { Page } from '@playwright/test'
import { analyse, expect, origins, test } from './fixtures'

/**
 * The decision page's layout after the user's end-to-end feedback (items 3 to 6), measured from
 * real boxes: option bodies take at most two lines, the stress row is one line, the Pay in 4 cards
 * line up block for block, and Something cheaper swaps the rail's item for similar items.
 */

/** Lines a box holds at its own line height. */
async function lines(page: Page, selector: string) {
  return page.locator(selector).evaluateAll((elements) =>
    elements.map((element) => {
      const lineHeight = parseFloat(getComputedStyle(element).lineHeight)
      return Math.round(element.getBoundingClientRect().height / lineHeight)
    }),
  )
}
/** Each matching element's top, relative to its card. */
async function tops(page: Page, selector: string, card: string) {
  return page
    .locator(selector)
    .evaluateAll(
      (elements, card) =>
        elements.map((element) =>
          Math.round(
            element.getBoundingClientRect().top -
              element.closest(card)!.getBoundingClientRect().top,
          ),
        ),
      card,
    )
}
const same = (values: number[]) => expect(new Set(values).size, values.join(', ')).toBe(1)
/**
 * Each Pay in 4 block starts at the same height, and has the same height, in every card that sits
 * on the same visual row (all four at 1440, two by two at 1024).
 */
async function expectAligned(page: Page) {
  const rows = await page.locator('.inst').evaluateAll((cards) => {
    const byRow = new Map<number, Record<string, number[]>>()
    for (const card of cards) {
      const box = card.getBoundingClientRect()
      const row = byRow.get(Math.round(box.top)) ?? {}
      for (const part of ['.ring', '.amt', '.when', '.near', '.after']) {
        const block = card.querySelector(part)!.getBoundingClientRect()
        ;(row[part] ??= []).push(Math.round(block.top - box.top))
        if (part === '.near') (row['.near height'] ??= []).push(Math.round(block.height))
      }
      byRow.set(Math.round(box.top), row)
    }
    return [...byRow.values()]
  })
  for (const row of rows) for (const values of Object.values(row)) same(values)
}

async function checkCards(page: Page) {
  const group = page.getByRole('radiogroup', { name: 'Your options' })
  await expect(group.getByRole('radio')).toHaveCount(3)
  await expect(group.getByRole('radio', { name: /Something cheaper/ })).toContainText(
    'fits today if you skip the desk chair',
  )
  for (const count of await lines(page, '.opt .why')) expect(count).toBeLessThanOrEqual(2)
  // Side by side, every body starts at the same height and holds two lines.
  const columns = await group.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' '))
  if (columns.length === 3) {
    same(await tops(page, '.opt .why', '.opt'))
    expect(await lines(page, '.opt .why')).toEqual([2, 2, 2])
  }
  await expect(group).not.toContainText('Tight')
  await expect(group).not.toContainText('Lowest that day')

  // Item 3: "Lowest $620.01" on one line, the amount in its own pill.
  await page.getByRole('button', { name: 'What went into this' }).click()
  const stress = page.locator('.kvlist dd .stress-low')
  await expect(stress).toContainText(/Lowest\s*\$620\.01/)
  const [height, lineHeight] = await stress.evaluate((el) => [
    el.closest('dd')!.getBoundingClientRect().height,
    parseFloat(getComputedStyle(el.closest('dd')!).lineHeight),
  ])
  expect(height).toBeLessThan(lineHeight * 2)

  // Item 6: four cards, each block at the same place, each relation and low two lines.
  const head = page.getByRole('button', { name: /Compare with PayPal Pay in 4/ })
  await expect(head).not.toContainText('illustrative')
  await head.click()
  const sched = page.getByRole('list', { name: 'Illustrative Pay in 4 schedule' })
  await expect(sched.getByRole('listitem')).toHaveCount(4)
  const perRow = await sched.evaluate(
    (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length,
  )
  if (perRow > 1) {
    await expectAligned(page)
    expect(await lines(page, '.inst .when')).toEqual([2, 2, 2, 2])
    expect(await lines(page, '.inst .after .lbl')).toEqual([1, 1, 1, 1])
    for (const count of await lines(page, '.inst .near')) expect(count).toBeGreaterThanOrEqual(2)
    // Whatever wraps in one card, the rows stay shared: a bill name three times as long moves
    // the same block in every card, and the dividers stay level.
    await page
      .locator('.inst .bill')
      .first()
      .evaluate((el) => (el.textContent = 'a much longer bill name that has to wrap'))
    await page
      .locator('.inst .after .val')
      .nth(2)
      .evaluate((el) => (el.textContent = '-$12,345.67 · Wed, Sep 30'))
    await expectAligned(page)
  } else {
    // Phones: one row per payment, each part one line.
    for (const count of await lines(page, '.inst .near')) expect(count).toBe(1)
    for (const count of await lines(page, '.inst .after')) expect(count).toBe(1)
  }
}

async function checkSwap(page: Page, narrow: boolean) {
  const group = page.getByRole('radiogroup', { name: 'Your options' })
  const cheaper = group.getByRole('radio', { name: /Something cheaper/ })
  await expect(cheaper).toContainText('See similar items')
  const limit = (await cheaper.locator('.v').textContent())!
  await cheaper.click()
  const list = page.getByRole('region', { name: 'Similar items that fit today' })
  // Item 5: the list states the card's own limit, never a rounded one.
  await expect(list).toContainText(`Up to ${limit} · from other stores`)
  await expect(list).toContainText('From other stores · via Channel3 · prices may change')
  // The card names the list it shows, and the swap is announced; focus stays on the card.
  const controls = (await cheaper.getAttribute('aria-controls'))!
  await expect(page.locator(`[id="${controls}"]`).getByRole('region')).toHaveCount(1)
  await expect(page.getByRole('status').filter({ hasText: 'Similar items up to' })).toHaveText(
    `Similar items up to ${limit} are shown ${narrow ? 'below' : 'beside'} the options.`,
  )
  await expect(cheaper).toBeFocused()
  const rail = page.locator('.decision-rail')
  if (narrow) {
    // Under the cards when the rail drops below, above the Pay in 4 comparison.
    const top = async (locator: typeof list) => (await locator.boundingBox())!.y
    expect(await top(list)).toBeGreaterThan(await top(group))
    expect(await top(list)).toBeLessThan(await top(page.locator('.disclosure')))
    await expect(rail.getByRole('region', { name: 'Similar items that fit today' })).toHaveCount(0)
  } else {
    await expect(rail.getByRole('region', { name: 'Similar items that fit today' })).toBeVisible()
    await expect(rail.getByText('Sold by Larkspur Supply')).toHaveCount(0)
    await group.getByRole('radio', { name: /Buy today/ }).click()
    await expect(list).toHaveCount(0)
    await expect(rail.getByText('Sold by Larkspur Supply')).toBeVisible()
  }
}

test('the /check cards keep two lines, one-line stress and aligned Pay in 4 cards', async ({
  page,
}) => {
  await analyse(page, 'chair')
  await checkCards(page)
})

test('at 1024 the cards stack and the Pay in 4 cards still line up', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop-1440', 'one tablet run is enough')
  await page.setViewportSize({ width: 1024, height: 900 })
  await analyse(page, 'chair')
  await checkCards(page)
})

test('Something cheaper swaps the rail’s item for similar items under the same limit', async ({
  page,
}) => {
  await analyse(page, 'chair')
  await checkSwap(page, (page.viewportSize()?.width ?? 0) < 1024)
})

test('the Decision page names the third card Something cheaper too', async ({ page }) => {
  await page.goto(`${origins.worth}/#decision?product=camera`)
  const group = page.getByRole('radiogroup', { name: 'Your options' })
  await expect(group.getByRole('radio', { name: /Something cheaper/ })).toContainText(
    'fits today if you skip the everyday camera',
  )
  await expect(group).not.toContainText('Spend less')
})
