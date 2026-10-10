import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { shareTags } from '../vite.config'

const root = resolve(import.meta.dirname, '..')
const html = readFileSync(resolve(root, 'index.html'), 'utf8')
const meta = (key: string) =>
  html.match(new RegExp(`(?:property|name)="${key}"\\s+content="([^"]*)"`))?.[1]

describe('link previews', () => {
  it('names PayPal in the title, description and share cards', () => {
    expect(html).toContain('<title>Worth · When and how to pay with PayPal</title>')
    expect(meta('description')).toMatch(
      /^Check a purchase before you pay with PayPal: .*Sandbox demo\.$/,
    )
    expect(meta('og:title')).toBe('Worth · When and how to pay with PayPal')
    expect(meta('og:description')).toBe(meta('description'))
    expect(meta('og:type')).toBe('website')
    expect(meta('twitter:card')).toBe('summary_large_image')
    expect(meta('twitter:title')).toBe(meta('og:title'))
    expect(meta('og:image')).toBe('/og-image.png')
    expect(meta('twitter:image')).toBe('/og-image.png')
  })

  it('ships a 1200 by 630 PNG share image', () => {
    const png = readFileSync(resolve(root, 'public', meta('og:image')!.slice(1)))
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG')
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630])
  })

  it('keeps the trademark out of every URL and file name', () => {
    const urls = [
      ...html.matchAll(/(?:href|src)="([^"]+)"/g),
      ...html.matchAll(/content="(\/[^"]*)"/g),
    ]
    expect(urls.length).toBeGreaterThan(0)
    for (const [, url] of urls) expect(url).not.toMatch(/paypal/i)
  })

  it('makes the image absolute and adds og:url only when the build knows the origin', () => {
    expect(shareTags(html, undefined)).toBe(html)
    expect(shareTags(html, '')).toBe(html)
    expect(shareTags(html, 'not a url')).toBe(html)
    expect(shareTags(html, 'https://evil.example/"><script>')).toBe(html)
    const built = shareTags(html, 'https://worth.example.com/')
    expect(built).toContain(
      '<meta property="og:image" content="https://worth.example.com/og-image.png" />',
    )
    expect(built).toContain(
      '<meta name="twitter:image" content="https://worth.example.com/og-image.png" />',
    )
    expect(built).toContain('<meta property="og:url" content="https://worth.example.com/" />')
    expect(html).not.toContain('og:url')
  })
})
