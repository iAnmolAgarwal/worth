import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

/**
 * Starts tests/e2e/serve.ts once for the run and hands its origins and the test HANDOFF_SECRET to
 * the tests through the environment. The child gets a clean environment, so no key from the shell
 * or a .env (PayPal, Claude, Channel3) ever reaches it. The returned teardown stops it by PID.
 */
export default async function globalSetup() {
  const root = resolve(import.meta.dirname, '../..')
  if (!existsSync(resolve(root, 'dist/index.html')) || !existsSync(resolve(root, 'dist-merchant')))
    throw new Error('Build first: npm run test:e2e builds both apps before running Playwright.')
  const secret = randomBytes(32).toString('base64url')
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/e2e/serve.ts'], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: 'test',
      E2E_HANDOFF_SECRET: secret,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const ready = await new Promise<{ worthOrigin: string; storeOrigin: string; offOrigin: string }>(
    (done, fail) => {
      const timer = setTimeout(
        () => fail(new Error('The E2E servers did not start in 60 s.')),
        60_000,
      )
      child.once('exit', (code) => fail(new Error(`The E2E servers exited (${code}).`)))
      createInterface({ input: child.stdout! }).on('line', (line) => {
        if (!line.startsWith('{"ready"')) return void process.stdout.write(`${line}\n`)
        clearTimeout(timer)
        done(JSON.parse(line))
      })
    },
  )
  process.env.E2E_HANDOFF_SECRET = secret
  process.env.E2E_WORTH = ready.worthOrigin
  process.env.E2E_STORE = ready.storeOrigin
  process.env.E2E_WORTH_OFF = ready.offOrigin
  return async () => {
    if (child.exitCode !== null) return
    const exited = new Promise((done) => child.once('exit', done))
    child.kill('SIGTERM')
    await exited
  }
}
