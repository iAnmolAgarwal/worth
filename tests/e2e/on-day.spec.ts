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
