# Worth

**Know what a purchase means for the rest of your month.**

Worth combines PayPal activity exports with confirmed funds, income, subscriptions, bills, and a cash cushion. Ask a purchase question, inspect the projected low point, compare timing or price, and deliberately complete a PayPal sandbox checkout. Claude interprets the question; deterministic code calculates every financial result.

## Run

Use **Node.js 24+** and npm. SQLite is built into Node; no Docker, database service, or local model is needed.

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
| `APP_ORIGIN` | Exact browser origin, normally `http://localhost:5173`. |
| `PORT`, `HOST` | Defaults: `5173`, `127.0.0.1`. |
| `DATABASE_PATH` | `.env.example` uses `.runtime/worth.sqlite`; server fallback is `.data/worth.sqlite`. |

Keys remain in the ignored server environment, never frontend source or `VITE_` variables. Only the public PayPal client ID reaches the browser. The gateway only calls PayPal sandbox; live payments are unsupported.

Without Anthropic, Worth labels replies as local calculations. Without PayPal credentials, checkout is explicitly simulated. Neither fallback is presented as a successful provider integration.

## Try the flow

1. Explore Alex's labelled synthetic plan, or import an English-language USD PayPal CSV.
2. Review funds, everyday spending, upcoming income/bills/subscriptions, and the cushion. Include obligations outside PayPal. Imported recurring items need confirmation.
3. Ask **“Can I afford a $1,199 camera today?”** Compare the low point, waiting, and a lower total price. Missing or stale inputs require review before a positive result.
4. Assess the **$349 Studio headphones**, review buying today, confirm current funds, and continue to PayPal sandbox.
5. Approve with a separate sandbox buyer, then explicitly confirm payment in Worth. The completed capture updates the activity and forecast once.

The financial-picture editor has four short steps: **Funds → Income → Bills & subscriptions → Review**. Each step validates its inputs; Back preserves edits, and only the final Save writes the plan. A “wait” recommendation is a useful outcome. The assistant cannot buy, cancel subscriptions, edit financial inputs, or move money.

### Imports and calculations

Use a CSV under **1 MB**, at most 10,000 rows, with recognized Date, Currency, and Net/Amount/Gross headers. `Net` takes precedence. Dates support `YYYY-MM-DD` and US `MM/DD/YYYY`; unsupported currencies and malformed rows block import. The preview shows coverage, duplicates, exclusions, and recurring suggestions. Category suggestions are reviewed before application; a category edit does not silently change the confirmed daily estimate.

Historical transactions help estimate patterns. They are never deducted again from today's funds snapshot. The engine uses integer USD cents, expenses before same-day income, and the lowest balance throughout the forecast. Waiting extends the horizon to 30 days after the purchase. The 20% spending stress case is a stated assumption, not a statistical confidence interval.

### PayPal setup

Create/select a sandbox REST app in the [PayPal Developer dashboard](https://developer.paypal.com/dashboard/) and use its sandbox business credentials. Approve purchases with a separate sandbox personal buyer. The browser uses the PayPal JavaScript SDK v6 when available, with the server-provided approval redirect as fallback. Approval and capture remain separate actions.

Remote webhook delivery needs an authorized reachable HTTPS endpoint at `/api/paypal/webhook`; localhost alone cannot receive it. The handler verifies signatures and retrieves authoritative order status. No tunnel or deployment is created by setup.

## Verification

```sh
npm run check
npm run lint
```

`check` runs lint, TypeScript, single-worker tests, and the production build. `npm start` serves that build; production mode uses secure cookies, so hosting requires HTTPS and the correct origin.

**135 tests pass**, along with TypeScript, the production build, and lint. Coverage includes financial/import rules, server boundaries, frontend privacy/recovery, and the four-step editor. The editor was also checked on desktop and at 390 px mobile width.

**Demonstrated with real providers:** Claude Sonnet 5.5 answered the camera question. A $349 headphones checkout used PayPal's approval redirect; a later $249 weekend checkout used the **SDK v6 popup**. Approval alone left the order uncaptured; Worth's separate confirmation completed it. Each purchase appeared once. Synthetic purchase capacity changed **$850.52 → $501.52 → $252.52**.

The production build was exercised with a synthetic CSV import, required recurring-item confirmation, explicit category correction, and consent-off local replies. Live Claude category suggestions and SDK cancellation/recovery were also verified. GitHub CI passes. External webhook delivery remains untested; handler tests use a fake gateway. See [BUILD.md](docs/BUILD.md) for evidence.

## Privacy and boundaries

Each browser gets an isolated temporary session, expiring 24 hours after creation. Raw CSV files are not saved; normalized data is stored in local SQLite without application-level encryption. Reset removes session records and clears the conversation. Reset/import/session replacement also invalidates old conversation responses. There is no account recovery; browser-cookie loss loses session access.

Edited or imported personal financial context requires AI-sharing consent. Only an untouched synthetic persona may use Claude without that opt-in. When sharing is enabled, chat messages and relevant summaries/merchant labels can reach Anthropic. This is minimization, not guaranteed anonymization. Calculations work with sharing off. See [architecture](docs/ARCHITECTURE.md) for boundaries.

Worth is independently branded and **not embedded in PayPal**. Consumer history is **CSV-only**; automatic access to all personal PayPal activity is unverified. It supports USD and a demo merchant catalog, with no goods sold or shipped. Estimates depend on confirmed inputs, not a guarantee of future funds. Production payments, autonomous purchases, bank aggregation, and refund management are outside this prototype. The app remains **undeployed**; public hackathon source/video publication is pending. Source has been pushed to the [private repository](https://github.com/iAnmolAgarwal/worth); GitHub CI passes.

[Demo script](docs/DEMO.md) · [Architecture](docs/ARCHITECTURE.md) · [Design credits](docs/DESIGN-SOURCES.md) · [Audited scope](project%20scope.md)

Source: [MIT License](LICENSE). Third-party assets and dependencies retain their own licenses and trademarks.
