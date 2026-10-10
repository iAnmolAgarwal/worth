// @vitest-environment jsdom
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { worthCheckScript } from '../shared/worthCheckScript.ts'

describe('the <worth-check> script a store serves', () => {
  it('is the element as plain JavaScript, with no types and no imports', () => {
    const script = worthCheckScript()
    expect(script).toContain("customElements.define('worth-check', WorthCheck)")
    expect(script).not.toMatch(/^\s*import /m)
    expect(script).not.toMatch(/\binterface\b|: string\b|as \{/)
    expect(worthCheckScript()).toBe(script)
  })

  it('defines a working element when loaded as a module', async () => {
    // Inside the project, where the test runner may load files; node_modules is never committed.
    const cache = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '.cache')
    mkdirSync(cache, { recursive: true })
    const directory = mkdtempSync(join(cache, 'worth-check-'))
    const file = join(directory, 'worth-check.mjs')
    writeFileSync(file, worthCheckScript())
    try {
      await import(/* @vite-ignore */ file)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
    const element = document.createElement('worth-check')
    element.setAttribute('href', 'https://worth.example/check#q=a.' + 's'.repeat(43))
    document.body.append(element)
    const link = element.shadowRoot!.querySelector('a')!
    expect(link.textContent).toBe('Analyse with Worth')
    expect(link.getAttribute('href')).toBe('https://worth.example/check#q=a.' + 's'.repeat(43))
  })
})
