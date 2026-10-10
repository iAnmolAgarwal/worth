// @vitest-environment jsdom
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// The file the store serves is built, not stripped at run time (judge finding 6).
describe('the built worth-check.js', () => {
  it('is plain JavaScript that defines a working <worth-check>', async () => {
    // Inside the project, where the test runner may load files; node_modules is never committed.
    const cache = join(root, 'node_modules', '.cache')
    mkdirSync(cache, { recursive: true })
    const outDir = mkdtempSync(join(cache, 'worth-check-build-'))
    try {
      await build({
        configFile: join(root, 'merchant/vite.config.ts'),
        build: { outDir, emptyOutDir: true },
        logLevel: 'silent',
      })
      const file = join(outDir, 'worth-check.js')
      const script = readFileSync(file, 'utf8')
      expect(script).toContain('worth-check')
      expect(script).not.toMatch(/^\s*import /m)
      expect(script).not.toMatch(/\binterface\b|: string\b/)
      // The checkout module doesn't carry a second copy of the element.
      expect(readFileSync(join(outDir, 'store.js'), 'utf8')).not.toContain('Analyse with Worth')
      await import(/* @vite-ignore */ file)
      const element = document.createElement('worth-check')
      element.setAttribute('href', 'https://worth.example/check#q=a.' + 's'.repeat(43))
      document.body.append(element)
      const link = element.shadowRoot!.querySelector('a')!
      expect(link.textContent).toBe('Analyse with Worth')
      expect(link.getAttribute('href')).toBe('https://worth.example/check#q=a.' + 's'.repeat(43))
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  }, 60_000)
})
