# Build and verification ledger

**Worth is implemented and running locally.** Its minimal interface uses a four-step financial picture: Funds → Income → Bills & subscriptions → Review. Source is in the [private GitHub repository](https://github.com/iAnmolAgarwal/worth). Source was delivered in focused scope, implementation, AI-guard, and UI commits; local `main` tracks `origin/main`. Final source revision: `e05c046`. [GitHub CI](https://github.com/iAnmolAgarwal/worth/actions/workflows/ci.yml) runs the same checks on each push.

## Verified

Latest recorded checks: **02:23 IST, October 3, 2026** — **135 tests pass**, TypeScript passes, production build passes, lint is clean. Breakdown: 46 finance/CSV, 73 server, 10 frontend, 6 wizard. The application/chart chunks are approximately 354/360 kB (109/104 kB gzip), with no chunk-size warning.

| Area | Evidence |
| --- | --- |
| Real Claude | Sonnet 5.5 answered the camera purchase question in the UI using deterministic calculation tools. |
| PayPal approval redirect | User approved $349 Studio headphones; explicit capture in Worth completed it. One activity entry; purchase capacity $850.52 → $501.52. |
| PayPal SDK v6 popup | $249 “A weekend away” approved through the sandbox buyer flow. `onApprove` displayed the approval notice while purchase remained `CREATED`, without capture. Explicit Confirm sandbox payment produced `COMPLETED`; Activity filtering showed exactly one row; capacity $501.52 → $252.52. |
| Four-step editor | Desktop and 390 px mobile screenshots inspected. Funds initially shows three financial fields with name/timezone collapsed. Enter did not submit. A $4,150 draft survived Continue/Back, then was restored to $4,200. Income/bills use compact rows. Review kept completed purchases unchecked because the snapshot had not already deducted them; explicit consent/final confirmation and Save preserved $252.52 capacity. |
| Frontend/session boundaries | Automated cases cover reset/import history clearing, late responses, queued prompts, uncertainty recovery, foreground session replacement, request-bound `SESSION_CHANGED` handling, and SDK approve/cancel callbacks. |
| Live cancellation | SDK cancel callback fired; closing and reopening retained the checkout. Explicit cancellation returned CANCELLED and capacity returned to $252.52. |
| Production/import/privacy | Built app served at an isolated local origin with providers disabled. Six synthetic CSV records previewed/imported, funds started at zero, future income required entry, an unconfirmed Netflix renewal blocked progression, and final consent stayed off. Manual Groceries correction kept the $39/day input unchanged. Local chat labelled its fallback. |
| Live categorization | Claude suggested Travel for the sandbox weekend purchase. Explicit Apply changed the category, while purchase capacity stayed $252.52. |
| Responsive/accessibility | Desktop, 768 px tablet, 390 px phone and 320 px narrow layouts checked without horizontal overflow. Mobile navigation trapped focus and Escape restored it. Reduced-motion emulation returned zero animation duration; overrides were reset. |
| Accounting/import/server rules | Automated cases cover integer-cent chronology, cushion boundaries, extended horizons, missing inputs, capture/CSV deduplication, profile versions, ownership, reservations, retries, and webhook reconciliation. |

## Final delivery

- Automated checks and real foreground-provider journeys pass. Final source and documentation are committed and pushed; the handoff reports the final CI result.
- Reset/import/session-expiry history boundaries are covered by component/server tests. Browser import used only generated synthetic data; no personal history was imported.
- The development app remains available at `http://localhost:5173`. The temporary production QA process has been stopped after verification.

External PayPal webhook delivery is **unperformed**. The handler is tested with a fake gateway; actual delivery requires a registered reachable HTTPS endpoint. No public deployment, real-money transaction, public hackathon video/source publication, or contest submission has occurred. Those are separate from the private source push.

## Operational boundaries

- Workspace: `/Users/anmolagarwal/paypal`. React/Vite + Express + built-in Node SQLite, Node 24+. Keep one dev server and one test worker on the 8 GB Mac; no Docker/local model/browser downloads.
- Preserve `claude-sonnet-5-5` and ignored `.env` settings; never expose keys or buyer credentials. SDK v6 receives only the public client ID. Orders v2 remains server-side and sandbox-only.
- Consumer history is English-language USD CSV or labelled synthetic data, not automatic personal PayPal synchronization. Include outside-PayPal commitments and confirm today's funds.
- Financial math/classification is deterministic. Claude tools are read-only; buyer approval and explicit capture are separate. Catalog prices are illustrative; no goods are sold or shipped.
- State refreshes on focus/foreground and every 60 seconds while visible. Chat includes the hash-derived session key; mismatches are rejected before provider calls and clear/refresh the client conversation.
- SQLite stores temporary isolated sessions for 24 hours. Raw CSV is not retained; edited/imported context requires explicit AI consent.

`shared/types.ts` and the current routes are the source of truth for contracts. [ARCHITECTURE.md](ARCHITECTURE.md) explains the accounting, AI, session, and payment boundaries. [README.md](../README.md) is the run guide; [DEMO.md](DEMO.md) is the 2:45 recording plan. Preserve the original scope as the audited requirements artifact.
