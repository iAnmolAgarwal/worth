import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let script: string | undefined
/**
 * `<worth-check>` as JavaScript, for a store to serve from its own origin as a module script
 * (`<script type="module" src="/worth-check.js">`). The element is written in TypeScript with only
 * erasable syntax, so Node removes the types and no build step or bundler is needed. Server-only.
 */
export function worthCheckScript() {
  script ??= stripTypeScriptTypes(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'worthCheck.ts'), 'utf8'),
  )
  return script
}
