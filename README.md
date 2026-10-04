# Worth

**Know what a purchase means for the rest of your month.**

Worth combines PayPal activity exports with confirmed funds, income, subscriptions, bills, and a cash cushion. Ask a purchase question, inspect the projected low point, compare timing or price, and deliberately complete a PayPal sandbox checkout. Claude interprets the question; deterministic code calculates every financial result.

## Run

Use **Node.js 24** and npm. SQLite is built into Node; no Docker, database service, or local model is needed.

```sh
npm ci
npm run dev
```

Open **http://localhost:5173**. For provider integration, create `.env` from `.env.example` if it does not exist, preserve existing settings, and restart the server after changes.

| Environment variable | Value/purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Server-side Anthropic key. |
| `ANTHROPIC_MODEL` | Selected model: `claude-sonnet-5-5`; requires access in your Anthropic account. |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Credentials from a PayPal **sandbox** REST app associated with a sandbox business account. |
| `PAYPAL_WEBHOOK_ID` | Registered sandbox webhook ID; required for signature verification, optional for foreground checkout. |
| `APP_ORIGIN` | Public browser origin. Falls back to `APP_URL`, then Render's `RENDER_EXTERNAL_URL`, then `http://localhost:$PORT`. Production refuses to start on localhost or plain HTTP. Locally, `localhost` and `127.0.0.1` both work. |
| `PORT`, `HOST` | Defaults: `5173`; `HOST` is `0.0.0.0` in production and `127.0.0.1` otherwise. |
| `TRUST_PROXY` | Reverse-proxy hops trusted for the client IP used by rate limits. **Required in production** (the server refuses to start without it); `0` locally. Confirm the value from the hop count logged on the first hosted request. |
| `CLAUDE_IP_HOURLY_LIMIT`, `CLAUDE_DAILY_LIMIT` | Claude requests per client IP per hour (20) and per server per day (200). Beyond either, answers use labelled local calculations. |
| `SESSION_IP_HOURLY_LIMIT`, `MAX_SESSIONS`, `MAX_TRANSACTIONS` | New sessions per IP per hour (30), live sessions (5,000), and stored transactions per session (20,000). |
| `MAX_HEAP_MB` | Heap limit for `npm start` (384). Set it in the shell or host environment; `.env` is read too late. |
| `DATABASE_PATH` | `.env.example` uses `.runtime/worth.sqlite`; server fallback is `.data/worth.sqlite`. |

Keys remain in the ignored server environment, never frontend source or `VITE_` variables. Only the public PayPal client ID reaches the browser. The gateway only calls PayPal sandbox; live payments are unsupported.

Without Anthropic, Worth labels replies as local calculations. Without PayPal credentials, checkout is explicitly simulated. Neither fallback is presented as a successful provider integration.

## Try the flow

1. Explore Alex's labelled synthetic plan, or import an English-language PayPal activity CSV.
2. Review funds, everyday spending, upcoming income/bills/subscriptions, and the cushion. Include obligations outside PayPal. Imported recurring items need confirmation.
3. Ask **“Can I afford a $1,199 camera today?”** Compare the low point, waiting, and a lower total price. Missing or stale inputs require review before a positive result.
4. Assess the **$349 Studio headphones**, review buying today, confirm current funds, and continue to PayPal sandbox.
5. Approve with a separate sandbox buyer, then explicitly confirm payment in Worth. The completed capture updates the activity and forecast once.

The financial-picture editor has four short steps: **Funds → Income → Bills & subscriptions → Review**. Each step validates its inputs; Back preserves edits, and only the final Save writes the plan. A “wait” recommendation is a useful outcome. The assistant cannot buy, cancel subscriptions, edit financial inputs, or move money.

### See the exact video scenario

Open the app with **`/?replay=video`** (or choose **See the exact video scenario** in the Sandbox demo chip, or **Video replay** under Settings → Demo clock). The labelled demo clock pins the synthetic persona to **Sat, Oct 3, 2026**, the recording day, so every date matches the video: rent on Fri, Oct 16; the $1,199 camera dips to −$458.99 on Thu, Oct 22; waiting until Fri, Oct 23 keeps the cushion.

To show the return visit, save the camera **for Fri, Oct 23** from Ask Worth, then set **Maya’s day** to Oct 23 under Settings → Demo clock. Home and Saved say *“Your plan suggests this may fit now — confirm today’s funds”*; confirming runs a fresh check, and only then does **Buy with PayPal** prepare the order, behind the same guards as the assistant’s `prepare_checkout`. The demo clock only ever moves the synthetic persona; imported data always uses today’s date.

### Imports and calculations

Use a PayPal activity CSV under **1 MB**, at most 10,000 rows. Both the personal export (Amount, Fees, Total) and the business “Download activity” export (Gross, Fee, Net, Balance Impact, Reference Txn ID) work; the amount comes from Net, then Total, then Amount, then Gross. “Today” follows the plan's time zone: the synthetic persona uses your browser's, and an import keeps it (editable under Name & time zone). Malformed rows block import. The preview shows coverage, duplicates, exclusions, and recurring suggestions, and:

- **Dates** may be `YYYY-MM-DD`, `MM/DD/YYYY` or `DD/MM/YYYY`. Any day above 12 settles the order for the file; when every date could be read either way, the preview asks, and nothing is imported until you answer.
- **Other currencies:** Worth plans in USD. A foreign-currency payment counts once, through the USD conversion that paid for it. Other non-USD rows are left out with a warning. A foreign purchase without a conversion withholds every positive result until you enter its USD cost or mark it as a one-off in Activity.
- **Row types:** only funding and withdrawal rows are transfers; a Direct Deposit paycheck is income. Memo rows and authorization holds are left out, pending rows are never counted, and PayPal balance corrections are listed but not counted.
- **Pay in 4 / Pay Later** rows are proposed as an existing plan to confirm, never counted as everyday spending.
- **Recurring suggestions** keep their day of the month, including the last day (rent on Jul 31, Aug 31 and Sep 30 is next due Oct 31).

Category suggestions are reviewed before application; a category edit does not silently change the confirmed daily estimate.

Historical transactions help estimate patterns. They are never deducted again from today's funds snapshot. The engine uses integer USD cents, expenses before same-day income, and the lowest balance throughout the forecast. Waiting extends the horizon to 30 days after the purchase. The 20% spending stress case is a stated assumption, not a statistical confidence interval.

### PayPal setup

Create/select a sandbox REST app in the [PayPal Developer dashboard](https://developer.paypal.com/dashboard/) and use its sandbox business credentials. Approve purchases with a separate sandbox personal buyer. The browser uses the PayPal JavaScript SDK v6 when available, with the server-provided approval redirect as fallback. Approval and capture remain separate actions.

Remote webhook delivery needs an authorized reachable HTTPS endpoint at `/api/paypal/webhook`; localhost alone cannot receive it. The handler verifies signatures and retrieves authoritative order status. No tunnel or deployment is created by setup.

## Verification

```sh
npm run check
npm run lint
```

`check` runs lint, TypeScript, single-worker tests, and the production build. `npm start` serves that build for hosting. Production mode uses a `__Host-` secure cookie and HSTS, and it refuses to start unless the origin is a public HTTPS address; use `npm run dev` locally.

**The full test suite passes**, along with TypeScript, the production build, and lint. Coverage includes financial/import rules, server boundaries, frontend privacy/recovery, and the four-step editor. The editor was also checked on desktop and at 390 px mobile width.

**Demonstrated with real providers:** Claude Sonnet 5.5 answered the camera question. A $349 headphones checkout used PayPal's approval redirect; a later $249 weekend checkout used the **SDK v6 popup**. Approval alone left the order uncaptured; Worth's separate confirmation completed it. Each purchase appeared once. Synthetic purchase capacity changed **$850.52 → $501.52 → $252.52**.

The production build was exercised with a synthetic CSV import, required recurring-item confirmation, explicit category correction, and consent-off local replies. Live Claude category suggestions and SDK cancellation/recovery were also verified. GitHub CI passes. External webhook delivery remains untested; handler tests use a fake gateway. See [BUILD.md](docs/BUILD.md) for evidence.

## Privacy and boundaries

Each browser gets an isolated temporary session, expiring 24 hours after creation. Settings offers an opt-in **“Keep my plan on this device for 30 days”** so a saved wait plan survives until its date; it is off by default, has no account or recovery, and **Delete my data now** still works at any time. Raw CSV files are not saved; normalized data is stored in local SQLite without application-level encryption. Reset removes session records and clears the conversation. Reset/import/session replacement also invalidates old conversation responses. There is no account recovery; browser-cookie loss loses session access.

Edited or imported personal financial context requires AI-sharing consent, which can be toggled in the chat panel. Only the synthetic persona, before you save your own inputs or import, may use Claude without that opt-in; demo purchases do not change this, and they are archived when you import. With sharing on, Anthropic receives your messages, recent chat history (including figures), the item, price and date you ask about, the items and prices you asked about earlier in the same conversation, a forecast summary, 30-day spending totals by category, income and bill names with amounts and dates, and minimized merchant labels. This is minimization, not guaranteed anonymization. Calculations work with sharing off. See [architecture](docs/ARCHITECTURE.md) for boundaries.

Worth is independently branded and **not embedded in PayPal**. Consumer history is **CSV-only**; automatic access to all personal PayPal activity is unverified. It supports USD and a demo merchant catalog, with no goods sold or shipped. Estimates depend on confirmed inputs, not a guarantee of future funds. Production payments, autonomous purchases, bank aggregation, and refund management are outside this prototype. The app remains **undeployed**; public hackathon source/video publication is pending. Source has been pushed to the [private repository](https://github.com/iAnmolAgarwal/worth); GitHub CI passes.

[Demo script](docs/DEMO.md) · [Architecture](docs/ARCHITECTURE.md) · [Design credits](docs/DESIGN-SOURCES.md) · [Audited scope](project%20scope.md)

Source: [MIT License](LICENSE). Third-party assets and dependencies retain their own licenses and trademarks.
