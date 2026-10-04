## What changed

<!-- One or two sentences: what this pull request changes and why. -->

## How it was checked

- [ ] `npm run check` passes (lint, typecheck, tests, build)
- [ ] New behaviour has a test, or the reason it cannot is stated here
- [ ] Docs match the code (README, `docs/ARCHITECTURE.md`, `docs/MCP.md`) where behaviour changed

## Money, payments and the model

- [ ] Every figure the user sees still comes from the engine, never from model text
- [ ] PayPal calls stay sandbox-only, and capture still needs the user's own confirmation
- [ ] No secret, key, token or sandbox login is committed or logged
