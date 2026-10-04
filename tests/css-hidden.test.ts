import { readFileSync } from 'node:fs'
import { chromium, type Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Judge F2: `.kvlist { display: flex }` overrode the browser's [hidden] rule, so the "How Ask
// Worth read this" list stayed open while its toggle said collapsed. jsdom reports any [hidden]
// element as display:none whatever the CSS says, so this runs the app's stylesheet in Chromium.

const css = readFileSync(`${process.cwd()}/src/index.css`, 'utf8')
const markup = `<div class="trace-box" data-open="false">
  <button class="trace trace-toggle" aria-expanded="false" aria-controls="t">How Ask Worth read this</button>
  <dl class="kvlist stacked" id="t" hidden><div><dt>Tool</dt><dd>interpret_purchase</dd></div></dl>
</div>`

let browser: Browser | undefined
beforeAll(async () => {
  browser = await chromium.launch().catch(() => undefined)
})
afterAll(async () => {
  await browser?.close()
})

describe('[hidden] hides even components that set their own display', () => {
  it('keeps a rule that makes [hidden] win over component display values', () => {
    expect(css).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/)
  })

  it('collapses the trace list in a real browser until its toggle opens it', async (context) => {
    if (!browser) return context.skip()
    const page = await browser.newPage()
    await page.setContent(`<style>${css}</style>${markup}`)
    const display = () => page.$eval('#t', (el) => getComputedStyle(el).display)
    expect(await display()).toBe('none')
    await page.$eval('#t', (el) => el.removeAttribute('hidden'))
    expect(await display()).toBe('flex')
    await page.close()
  })
})
