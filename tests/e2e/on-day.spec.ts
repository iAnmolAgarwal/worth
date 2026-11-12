import { expect, origins, test } from './fixtures.ts'

// A day agreed in Ask Worth travels to the comparison as `on=`: a day in the wait window reaches
// /api/compare and comes back as `chosen`; anything else is dropped and the page uses today.

const after = (day: string, days: number) => {
  const date = new Date(`${day}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

test('the on= link asks the comparison for that day, and ignores a day outside the window', async ({
  page,
}) => {
  await page.goto(`${origins.worth}/`)
  const today = await page.evaluate(async () => {
    const state = await (await fetch('/api/state', { headers: { 'X-Worth-Client': 'web' } })).json()
    return state.today as string
  })
  // The comparison for the page's own item (Home asks /api/compare for other things too).
  const compare = (productId: string) =>
    page.waitForRequest(
      (request) =>
        request.url().endsWith('/api/compare') && request.postDataJSON()?.productId === productId,
    )

  const day = after(today, 2)
  let sent = compare('camera')
  const answered = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/compare') && response.request().postDataJSON()?.onDate === day,
  )
  await page.goto(`${origins.worth}/#decision?product=camera&on=${day}&from=ask`)
  expect((await sent).postDataJSON()).toMatchObject({ productId: 'camera', onDate: day })
  expect((await (await answered).json()).chosen).toMatchObject({ date: day })

  sent = compare('headphones')
  await page.goto(`${origins.worth}/#decision?product=headphones&on=${after(today, 40)}&from=ask`)
  expect((await sent).postDataJSON()).toEqual({ productId: 'headphones' })
  await expect(page.getByRole('radiogroup', { name: 'Your options' })).toBeVisible()
})

test('with on=, the first card is buying on that day, selected, and the item saves for it', async ({
  page,
}) => {
  await page.goto(`${origins.worth}/`)
  const today = await page.evaluate(async () => {
    const state = await (await fetch('/api/state', { headers: { 'X-Worth-Client': 'web' } })).json()
    return state.today as string
  })
  const day = after(today, 2)
  const label = new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
  await page.goto(`${origins.worth}/#decision?amount=1000&item=Lamp&on=${day}&from=ask`)
  const group = page.getByRole('radiogroup', { name: 'Your options' })
  const first = group.getByRole('radio').first()
  await expect(first).toContainText(`Buy ${label}`)
  await expect(first).toHaveAttribute('aria-checked', 'true')
  await expect(group).not.toContainText('Buy today')
  await expect(page.locator('h1:visible')).toHaveText(`Buy ${label}`)
  await expect(page.getByRole('button', { name: `Save for ${label}` }).first()).toBeVisible()
})
