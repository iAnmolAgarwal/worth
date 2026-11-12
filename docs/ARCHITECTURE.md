# Worth architecture

Worth is one TypeScript application: a React client, an Express server, a deterministic
financial engine shared by both, and SQLite. Claude interprets questions and chooses what to
show through read-only engine tools; its one action, preparing a checkout, is decided by server
guards. Payment execution belongs to explicit server endpoints and the user's own confirmation.

This document describes the code on `main`. The README is the short version; the
[evaluation](EVALUATION.md) and the [MCP contract](MCP.md) are separate.

## Request path

```mermaid
flowchart LR
  UI[React client] -->|JSON + X-Worth-Client| API[Express API]
  API --> Store[(Session-scoped SQLite)]
  API --> Engine[Deterministic engine<br/>shared/finance.ts]
  API --> Import[CSV normalisation]
  API --> Claude[Claude Sonnet 5.5<br/>engine tools]
  Claude --> Engine
  Claude -.open_purchase_check.-> CheckLink[Worth's own comparison<br/>#decision?product=id]
  API --> Guards[checkoutGuards]
  Guards --> PayPal[PayPal sandbox<br/>Orders v2 · eligibility]
  API --> Channel3[Channel3 search]
  UI --> SDK[PayPal JS SDK v6<br/>button · popup · Messages]
  SDK --> Approval[Buyer approval in PayPal]
  PayPal -->|webhook, raw body| Webhook[Verify signature<br/>re-read order or refund]
  Webhook --> Store
  Agent[MCP client] -->|bearer token| MCP["/mcp · Worth guardrail MCP"]
  MCP --> Engine
  MCP -.purchase_check_link.-> CheckLink
```

In development, `server/index.ts` mounts Vite middleware in the same Express process. In
production it serves the built `dist/` client. Credentials are read by the server; the client
receives only public configuration (`state.config`: AI mode, PayPal mode, the public client ID,
the model name and the Channel3 status).

## Code map

| Module | Responsibility |
| --- | --- |
| `shared/finance.ts` | Recurrence, commitments, integer-cent forecasts, missing-data precedence, outcomes, the earliest-date search, option comparison, the illustrative Pay in 4 schedule and instalment stacking. |
| `shared/collision.ts` | Which bill or other instalment a Pay in 4 payment lands next to, and the wording for it. |
| `shared/csv.ts` | PayPal personal and business export parsing: headers, per-file date order, currency-conversion pairing, transfer/memo/hold rules, Pay in 4 proposals, transaction identity, recurring suggestions and the daily-spending estimate. |
| `shared/seed.ts` | The sample person Alex (absolute dates from Fri Nov 13 2026), the relative-dated test fixture persona, and the server-owned demo catalog (also sold by the example store in `merchant/`). |
| `shared/handoff.ts` | The store ↔ Worth hand-off: quote and result tokens signed with direction labels, strict schemas, origin and expiry checks, and outcome-report signatures. Server-only. |
| `shared/worthCheck.ts` | The `<worth-check>` element a store places beside its PayPal button; the store's build emits it as `worth-check.js`. |
| `shared/worthSwipe.ts` | Its `mode="swipe"`: Worth's W tab docked on the right of the store's own PayPal button, swiped left (or tapped) to open Worth. |
| `shared/types.ts`, `shared/limits.ts`, `shared/text.ts` | API contracts, the one CSV size and row limit, and plain-text rules for saved names. |
| `server/app.ts` | Sessions, validation, routes, ownership, plan rules, checkout reservation, capture, cancel, webhooks and reconciliation. |
| `server/store.ts` | SQLite tables, atomic operations, uniqueness constraints, expiry and deletion. |
| `server/chat.ts` | The Claude tool loop, tool schemas, the answer's trace, and the deterministic local fallback. |
| `server/chartGuide.ts` | Chart questions: the facts from the engine in the chart's words, `show_on_chart`, its checks, and the rules used without Claude. |
| `server/paypalConnect.ts` | Connect PayPal: OAuth with PKCE against PayPal's MCP server, refresh-token reads one at a time, the allow-listed `list_transactions` read, the sync and disconnect routes, timeouts and the health gate. |
| `server/paypalVault.ts` | The kept refresh token: AES-256-GCM sealing under `PAYPAL_TOKEN_KEY` with the session, or memory only. |
| `server/paypalSync.ts` | The rules for applying a background read to a confirmed plan: additive only. |
| `server/interpret.ts`, `server/money.ts`, `server/dates.ts` | Checks Claude's reading against the user's own words: amounts, currencies, timing phrases and which item a follow-up means. |
| `server/narration.ts` | Every sentence the user reads: verdict templates, fact catalogs, the Pay in 4 wording and `checkSentence` for Claude's one sentence. |
| `server/checkoutGuards.ts` | `checkoutGuards` for the saved-plan Buy button. Agents (Ask Worth and MCP) never prepare orders; they link to Worth's own comparison. |
| `server/paypal.ts` | Sandbox OAuth, Orders v2 create/get/capture, refunds, `find-eligible-methods`, webhook signature verification and order validation. |
| `server/channel3.ts`, `server/alternatives.ts` | The Channel3 adapter (band, parsing, URL lookup, cache, back-off, limits, recorded fallback) and what Worth searches for. |
| `server/outcome.ts` | A store's verified report-back (C4): idempotent on captureId, recorded once with consent and `returnedAt`. |
| `server/saved.ts`, `server/plans.ts`, `server/remember.ts` | Saved items and wait plans, confirmed Pay in 4 and refund schedules, and signed memory of items assessed earlier in a conversation. |
| `server/demoClock.ts` | The labelled demo clock for the sample persona: the persona switch (`SAMPLE_PERSONA`) and the pinned presets (`/?replay=demo`, `demo-dec15`, `video`). |
| `server/mcp.ts`, `server/mcpDecision.ts`, `server/mcpStdio.ts` | The MCP server, its decision contract with coherence invariants, and the stdio relay. |
| `server/config.ts`, `server/csp.ts`, `server/limits.ts` | Environment parsing with production guards, the Content-Security-Policy, and fixed-window rate limiters. |
| `src/App.tsx` | Routing, state refresh, toasts and the `?replay=` entry. |
| `src/Home.tsx`, `src/Hero.tsx` | Home: the "Safe to spend today" card and its Free / Needed by / Cushion bar (or "Short by …"), the Check a purchase and Connect PayPal rows, Coming up and Saved. |
| `src/Ask.tsx`, `src/AskTrace.tsx`, `src/AgentLauncher.tsx` | The conversation, "How Ask Worth read this", and the guide's launcher, panel and per-screen nudge. |
| `src/Tour.tsx` | The six-step first-visit tour of Home (`?tour=1` forces it, `?tour=0` suppresses it; "Take the tour" in the panel replays it). |
| `src/ConnectPayPal.tsx` | Connect PayPal: the note before the redirect, the reading screen, and the one-at-a-time background sync. |
| `src/Decision.tsx`, `src/BalanceChart.tsx`, `src/chartModel.ts`, `src/chartLayout.ts`, `src/chartControl.ts` | The option comparison, the Pay in 4 panel, the SVG balance chart (model and layout), and the guide's view-only hold on the chart. |
| `src/Checkout.tsx`, `src/paypal.tsx`, `src/paypalSdk.ts` | The checkout dialog and the SDK v6 loader, button, eligibility and Messages. |
| `src/Saved.tsx`, `src/Alternatives.tsx`, `src/Activity.tsx`, `src/Reviews.tsx` | Saved items and wait plans, similar items, activity, and the "how did you pay" and refund reviews. |
| `src/Plan.tsx`, `src/Import.tsx`, `src/ForeignPayments.tsx` | The four-step plan editor, CSV import preview and unresolved foreign payments. |
| `src/Check.tsx` | `/check`: a store's verified item, the decision for it, report-back consent and Back to the store. |
| `src/ConnectAgent.tsx` | Settings → Connect an agent: create, copy and revoke MCP tokens. |
| `shared/link.ts`, `src/PasteLink.tsx` | Pasted product links: link checks, title cleaning and the "Is $X right?" card with its manual fallback. |

## Financial calculation

All money is represented as integer USD cents. A forecast starts from the confirmed funds snapshot, not from the sum of historical transactions:

```text
funds snapshot
+ confirmed dated income
- confirmed dated bills and subscriptions
- estimated everyday spending
- unreflected completed purchases and active reservations
- proposed purchase on its proposed date
```

The cushion is a comparison threshold, not another debit. Historical rows inform spending estimates and recurrence proposals; they do not reduce the current snapshot again. On refreshing funds, `reflectedPurchaseIds` explicitly records which completed app purchases are already included.

`forecast()` emits daily closing balances and intraday minima for baseline, purchase, and stress paths. On a date with unknown timing, bills, everyday spending, and purchases occur before income. `assessPurchase()` classifies using the lowest path value, retaining earlier baseline shortfalls. It returns the dates, inputs, drivers, assumptions, and profile version with the result.

Purchase dates range from today through 35 days ahead. Each candidate is judged over the same window, today through today + 60, whatever its purchase date. Recurring entries repeat by their confirmed cadence; month-end recurrence remains anchored to the original calendar day. Stress spending is `ceil(dailySpendCents × 1.2)` per day, a stated assumption rather than a calibrated confidence bound.

Missing confirmation, a funds snapshot that is not for today, unconfirmed active flows, invalid amounts, or unresolved profile fields force `incomplete`. The forecast remains inspectable, but it cannot support a positive result.

The financial-picture editor separates Funds, Income, Bills & subscriptions, and Review. It validates each step, preserves drafts through Back navigation, and only writes on final Save. Review includes completed-purchase inclusion and explicit AI consent. Name/timezone are an optional disclosure; recurring items use compact rows with one editor at a time.

## CSV import

`POST /api/import/preview` and `POST /api/import/commit` take `{ csv, dateOrder? }`. The parser validates every row, leaves out memo rows and authorization holds, and pairs each USD currency-conversion leg with the foreign-currency payment it paid for (by Reference Txn ID, or, in personal exports, which have no reference, among rows within two seconds of each other; with several conversions at once, each payment pairs through the foreign-currency leg of its own amount). A paired payment, pending or completed, is recorded once at its USD cost under its own transaction ID, and never added when its USD leg is already in history. A payment left beside an unpaired USD leg is covered by that leg. The preview adds `dateOrder`, `needsDateOrder`, `leftOut`, `adjustments`, `unresolved`, `converted` and `instalmentPlans` to the counts above.

- When every slash date reads both ways, the preview returns `needsDateOrder: true` without importing anything, and the commit answers `400 DATE_ORDER_REQUIRED` until `dateOrder` is `MM/DD` or `DD/MM`.
- Completed foreign spending with no conversion is stored with the session as an unresolved payment. While any remain, the profile carries a missing-information entry that saving the plan cannot remove, so every assessment is `incomplete`. `POST /api/import/unresolved/:paymentId` resolves one with `{ amountCents }` (its USD cost, added to the imported history) or `{ oneOff: true }`; if the added cost raises the history-based daily estimate above the plan's, the user is asked to review it. A later export that pairs the payment marks it `matched` and its USD leg replaces any entered cost; resolving a payment already in history returns `409 ALREADY_IN_HISTORY`.
- Recurring suggestions carry `anchorDay` (1–31 or `last`), which `occurrence()` follows for monthly and yearly items while it agrees with `nextDate`.

## Connect PayPal

`GET /api/paypal/connect` starts OAuth 2.1 (authorization code, PKCE S256, a single-use `state`
bound to the session, 10 minutes) against PayPal's MCP server at `https://mcp.sandbox.paypal.com`,
with a client Worth registers there with the `authorization_code` and `refresh_token` grants (or
`PAYPAL_MCP_CLIENT_ID`). The callback keeps the access token in server memory and the refresh
token in the session's link vault (below); neither reaches the browser.
`POST /api/paypal/activity` opens an MCP session (25 s limit; about 12 s measured) and calls only
`list_transactions`, over six 31-day windows side by side (about 186 days); every other tool is
refused. The rows become the same CSV text a personal export holds, with `T1600` (buyer-credit
funding) mapped to a Pay Later row, and the browser shows them in the usual import review. A
purchase funded by Pay Later with no payment rows is drafted as "1 of 4 paid", because PayPal
takes the first payment at checkout. Committing the review sets the server-owned
`importedFrom` (`paypal` only when the CSV is the exact text built from that login, else `file`)
and `importedAt`, which Home shows as "PayPal connected · updated today"; a profile save never
changes them. Two session timeouts in a row hide Connect for everyone for a minute;
`PAYPAL_CONNECT=off` turns it off.

### Staying connected

Connect once. When a visitor with a connected plan opens Worth and the last read is over 15
minutes old, the browser asks `POST /api/paypal/sync` once; the hero's refresh button does the same
on demand. The server reads with the held access token, or first exchanges the refresh token for a
new one (`grant_type=refresh_token`), one at a time per session, and applies the read without the
review step (`server/paypalSync.ts`), only in ways that cannot overwrite what the user confirmed:

- new transactions are added to Activity;
- a Pay in 4 plan is added only when its purchase is new in this read, so a plan left out at review
  never comes back;
- a known plan loses its earliest remaining payments when PayPal now shows them as made.

Bills, paydays, the cushion, money available and everyday spending are never changed, and a read
with rows the import can't use applies nothing. Not applied automatically (they wait for an
explicit import): new recurring bills or paydays, payments of a plan whose purchase isn't in the
history, and foreign-currency payments that need a USD cost. `importedAt` moves to the time of the
read, which Home shows as "PayPal connected · updated <day>". PayPal's own transaction index can
lag by up to about three hours, so a purchase can take that long to appear.

**What is stored, and why it is safe enough.** Per session, only the newest refresh token and the
MCP client it was issued to (`server/paypalVault.ts`). With `PAYPAL_TOKEN_KEY` set it is sealed
with AES-256-GCM (a fresh 96-bit IV, the session ID as associated data, so a row copied to another
session fails to open) in `paypal_links`, which references the session and is deleted with it
(`secure_delete` is on). Without the key it lives in process memory only. Access tokens are
memory-only and used for at most 55 minutes. No token is logged, put in a response, sent to the
browser, included in the plan summary sent to Claude, or kept in the clear on disk.

In principle the token could do whatever PayPal's MCP connector was granted on the consent screen,
including creating and sending invoices, because PayPal ignores a narrower `scope`. Worth's server
therefore calls one tool, `list_transactions`, through `callTool`, which refuses every other name
before any request is made (tested, including with a refreshed token). The browser never holds a
token, so nothing in the page can call PayPal directly. Refresh tokens rotate, and PayPal does not
revoke the previous one, so Worth replaces the stored token with each new one and never keeps two.
Disconnect PayPal (Settings), Delete my data, an expired session, or PayPal answering
`invalid_grant`/`invalid_client` deletes the link; the plan is left as it is and the next Connect
PayPal logs in again. A network failure keeps the link for a later visit. Logins in progress stay
in memory, so the service runs as one instance.

## AI boundary

Ask Worth calls `claude-sonnet-5-5` through `@anthropic-ai/sdk` with a fixed system prompt
(prompt-cached) and strict tool schemas. The loop allows at most four model rounds and six tool
calls under a per-answer deadline (15 seconds by default), with no SDK retries and at most one
retry of a retryable provider error while time remains. The person's message, up to
eight prior messages and a bounded request context are sent; transaction and merchant strings
are minimised and marked as data, never instructions.

Tools, all read-only:

| Tool | What Claude reports | What the server does |
| --- | --- | --- |
| `interpret_purchase` | Items in the user's words, stated price in cents, ISO currency, quantity, whether it continues the previous item, the timing phrase copied verbatim and its date, and the option (check, earliest date, most to spend) | Checks every amount and date against the message (`server/money.ts`, `server/dates.ts`); asks instead of guessing when the price is missing, not USD, ambiguous, or the date is vague, past or beyond 35 days; then runs `assessPurchase` and, when asked, the Pay in 4 scenario |
| `list_commitments` | Subscriptions, bills or both | Lists confirmed obligations due in the next 30 days |
| `spending_summary` | — | Totals completed USD spending by category for 30 days |
| `get_plan_summary` | — | Safe to spend today, the baseline low point and its cause |
| `find_alternatives` | A generic kind of item and a ceiling the user wrote | Refuses for "cheaper" about timing, payment method or services; otherwise searches Channel3 within the room today; only the outcome returns to Claude, never product names or prices |
| `open_purchase_check` | A catalog item ID, when the person asks to buy it | Assesses the item at its catalog price today and links to Worth's own comparison, `#decision?product=<id>`. Worth prepares no order; Claude receives only whether a link was shown |
| `show_on_chart` | Offered only when the request carries a chart view and the question is about the chart: one to three fact ids, and the pills, range (`payday`, `30`, `60`) and focus day the chart should show, all from enums built for this item | Rebuilds the item's comparison, writes each fact in the chart's own words (`src/chartModel.ts`), drops any option, range or day outside this item and window, and returns the view change as `chart` in the reply. View state only: it cannot navigate, save, buy or edit the plan. Without Claude the same facts and view come from Worth's own rules (`server/chartGuide.ts`) |

Every read tool also takes **presentation fields**: up to three facts from a fixed catalog for
that tool, a reason for each from a fixed set (`answers_question`, `explains_result`,
`shows_timing`, `shows_risk`, `adds_context`), an optional lead-in from a fixed set (including
refusals for skipping bills, credit and dipping into the cushion) and up to three follow-up
chips. The server writes each fact from engine values and drops any that do not apply. Chips
pass `chipAllowed` (short questions with no numbers and no verdict); the client also drops any
that name a price other than the item's.

**One sentence.** After the tool result, Claude is asked once (low effort, JSON output) for one
sentence of at most 30 words explaining the result, naming every amount, date, count and name
only through the placeholders the server lists for that answer. `checkSentence` in
`server/narration.ts` requires one plain ASCII sentence with known placeholders, and rejects free
numbers or number words, dates and time words, advice and judgement words, Pay in 4 when it was
not asked about or in terms that rate it, values placed against the wrong role or out of date
order, and claims that contradict the engine's outcome. On any rejection the engine's template
sentence is shown and the trace records why. The verdict sentence is always a template.

**The trace.** Each answer carries how it was read (item, price source, timing words → date),
which tool ran, the facts Claude picked with their reasons, every server check that passed or
stopped the answer, and Claude's raw placeholder sentence with whether it was accepted. The
client shows it under "How Ask Worth read this".

**Buying a listed item.** Ask Worth never prepares an order (decision 0.2 of the checkout
pivot). When the person asks to buy a catalog item, `open_purchase_check` shows the engine's
assessment of buying it today and an "Open Worth's comparison" link to the purchase answer page for that
item. The link, name and price come from the server's catalog, never from Claude. On the
comparison the person presses "Buy today anyway" or "Save for <date>" themselves, and Worth's own
PayPal sandbox checkout opens only behind `checkoutGuards`. The Worth app never names or links to
the example store (final-day plan §0): the only exception is `/check` after a verified hand-off.

**Saved-plan checkout.** `checkoutGuards` (`server/checkoutGuards.ts`) guards the saved plan's
Buy button: no other active checkout, funds confirmed today, a complete plan, the wait date
reached for the wait option, the spend-less limit for that option, and the cushion kept.
Creating the order then re-checks a fresh assessment. The price, currency and merchant come from
the catalog. An order an agent prepared below the cushion before decision 0.2 is stored as
needing confirmation, and capture still refuses until the user confirms that in the checkout.

**Fallback.** Without a key, on a provider error or timeout, past `CLAUDE_IP_HOURLY_LIMIT` or
`CLAUDE_DAILY_LIMIT`, or when AI sharing is off for an edited or imported plan, `fallbackReply()`
answers with labelled local calculations from the same engine and the same sentences. Only the
untouched sample plan can use Claude without opt-in.

**Categories** are a separate bounded request: `POST /api/transactions/categories` sends at most
30 minimised merchant labels with temporary aliases, without amounts, dates, transaction IDs or
profile fields. Returned aliases and category names are validated; nothing is applied until the
user applies it, and an edit never changes the confirmed daily-spending estimate.

## Pay in 4 comparison

PayPal does not tell the merchant how the buyer paid (neither the order nor the capture says),
and its schedule is set at checkout, so Worth treats Pay in 4 as a labelled comparison and a
confirmed fact afterwards, never as a prediction.

- **Eligibility.** `/api/compare` asks PayPal's `find-eligible-methods` (US buyer, USD amount)
  and caches the answer per price band; Worth's own $10–$2,000 range applies on top. If the call
  fails the comparison is shown as range-only. The browser's `findEligibleMethods` decides only
  whether to render the button and `<paypal-message>`.
- **Schedule.** `payIn4Schedule` splits the total into four whole-cent payments on days 0, 14,
  28 and 42, with any remainder on the first ($1,899.00 is 4 × $474.75). The sandbox's real
  schedule used 16-day gaps, so every date is "about".
- **Collisions.** Each payment is paired with the nearest bill, subscription or other plan's
  payment at most three days away (`shared/collision.ts`), and instalment plans already running
  in the window are reported as stacking.
- **After purchase.** A completed purchase counts at full price until the user confirms how they
  paid (`POST /api/purchases/:id/plan`); a confirmed plan replaces the debit with its remaining
  payments. Refunds arrive as review items and change nothing until confirmed.

## Balance chart

`src/BalanceChart.tsx` draws the forecast as inline SVG with no chart library, on the purchase
answer page; `src/chartModel.ts` turns engine output into the chart's series, stretches and
sentences, and `src/chartLayout.ts` computes the geometry and label placement.

- **Pills are the options.** Buy today, Wait until <date> and Pay in 4 (Something cheaper when it
  applies) are toggle pills. Worth's recommendation is pressed on load; any pill can be unpressed,
  and with none pressed the chart shows the "No purchase" line. Each pressed option gets one
  summary box with its below-cushion stretches.
- **What is drawn.** Each pressed option's daily low as a line, the cushion as a dotted line, red
  shading wherever a line is below the cushion (and a zero line when one goes below zero), thin
  green lines on days money comes in and thin red lines on days money goes out.
- **Reading it.** A range control (To payday, 30 days, 60 days); a day-in-focus panel for the day
  under the pointer or pinned with the arrow keys (Escape unpins), with the other pressed
  options' value on the same day; an `aria-live` region; and "View as table" with the same
  values. Every value is read from engine output; the chart computes no money of its own.

Ask Worth's guide can read and steer the chart through `src/chartControl.ts`: the chart publishes
what it shows (options offered and pressed, range, pinned day, the item) and applies a
`ChartCommand` through its own state setters, announcing the change in its live region. Ask sends
that view with a question (the server re-validates it), and applies a reply's `chart` change only
while the chart for the same item is on screen; otherwise the answer links to the comparison.

## Agents over MCP

`/mcp` is mounted outside `/api`: it reads only an `Authorization: Bearer wrth_…` token, never
the session cookie. Tokens are created in Settings → Connect an agent, stored as SHA-256
fingerprints with the last four characters, bound to one session's plan, capped at three per
plan, and expire with the plan or after 30 days. Worth guardrail MCP has three tools, each
mapping existing engine functions: `check_affordability` (the guardrail for any store: a decision
contract checked by `checkDecision` before it is sent), `purchase_check_link` (a link to
Worth's own comparison for a listed item plus the same verdict, never an order) and `list_saved_plans`.
Orders an agent requested before decision 0.2 stay labelled in Activity. The MCP path makes no
Anthropic call. Limits, refusals and setup are in [MCP.md](MCP.md).

## Store hand-off (/check)

This is the example store's path (`merchant/`, a separate demo app the hosted Worth app does not link to). A store that takes PayPal places `<worth-check>` beside its PayPal button. The link opens Worth's `/check` in the same tab with a quote the store's server signed; Worth advises and sends the shopper back, and the store sells and creates its own PayPal order. The binding contract is `specs/handoff-contract.md` in the project workspace.

- **Tokens.** `<payload>.<sig>`: base64url JSON and an HMAC-SHA256 over `worth-handoff.v1.<direction>.<payload>` with `HANDOFF_SECRET`, so a quote can't be replayed as a result or the reverse. `shared/handoff.ts` checks, in order: size (4 KB) and format, `kid`/`mid`, the signature in constant time, `v`, a strict schema, `returnUrl` and `imageUrl` on `MERCHANT_ORIGIN`, USD, a lifetime of at most 900 s, expiry and a future `iat` with 60 s of skew. Item and store names lose hidden characters and are capped at 120 and 60 characters.
- **Intake.** The token rides in `#q=`, so it never reaches a log or a `Referer`; `/check` sends `Referrer-Policy: no-referrer`, and the client removes the fragment before calling `POST /api/handoff/open`. A verified quote is bound to the session that opened it first for 24 hours (`handoff_quotes`), with report-back consent off until the shopper ticks it (`POST /api/handoff/consent`). A first visit gets the sample plan, and `replay: "video"` applies the demo clock only to it.
- **Errors.** An unverifiable link shows one message and an empty item form, never the link's contents or a way back. An expired or non-USD quote, whose signature and origin checked out, offers the plain link back to the store.
- **Decision.** The normal comparison runs for the store's price, with the store's own Pay in 4 answer (`payLater` from its SDK) in place of Worth's PayPal check. "Not right? Edit" makes the price user-claimed; the store's answer then no longer applies.
- **Back to the store.** `POST /api/handoff/return` computes the verdict from the plan on the server and signs a result token (`buy_today`, `wait` or `spend_less`, with the date it fits) that carries no amounts or plan data. After the shopper changes the price, the link goes back with no token, because the result would read as one about the store's own price. The store may show one line for a result and never changes price, cart or order because of it.
- **Save for <date>.** A wait verdict on /check offers Save. `POST /api/handoff/save` takes only `{ qid, waitDate }` (plus the shopper's changed price or name): the link (the returnUrl), the store's name and the price come from the verified quote this session holds, and only this route sets `priceSource: "component"`; a changed price saves as `user`. Saved shows "Price from <store>" and never re-reads that price through the lookup. The item keeps the quote's `qid`, so the store's report of that purchase can clear it (C4). Opened from Saved, any item with a store link is compared by its saved ID: the server reads the link and judges Pay in 4 by the range alone, never by Worth's own PayPal answer. A Pay Later "no", from PayPal or signed by a store, is unknown (contract §3.2). In development only, the saved-link check also allows exactly `MERCHANT_ORIGIN`, so a local store's link can be saved.
- **Anti-forwarding.** A quote link can be forwarded, so consent alone never records a purchase. Worth marks `returnedAt` on the quote when it signs a result; the store (`merchant/`, which uses the same `shared/handoff.ts`) reports an order's quote only when that store session came back with a verified result for it; and the report-back (C4) records only with consent and `returnedAt`.
- **Report-back (C4).** After its own PayPal capture completes, the store's server posts `{ v, kid, mid, qid, orderId, captureId, amountCents, currency, status, capturedAt }` to `POST /api/handoff/outcome`, signed over `worth-handoff.v1.outcome.<timestamp>.<raw body>` in `Worth-Handoff-Signature`, with `Worth-Handoff-Timestamp`. The route sits before the browser checks and sets no cookie. It refuses, with one generic body, a body over 2 KB, a timestamp more than 300 s off, a bad or non-canonical signature (401), a shape outside the strict schema, an unknown `kid`/`mid` (401) or a non-USD capture, then limits each merchant to 60 signed reports a minute; an unknown or expired `qid` is a generic 404. `server/outcome.ts` answers once per `captureId` (the `handoff_outcomes` key, deleted with the session), so the store's capture path and webhook can both send and a repeat gets the first answer with no effect. It records only when the quote's session consented, Worth signed a result for it (`returnedAt`) and the session is live, and only once per quote; otherwise `{ recorded: false }`. Recording adds one completed purchase at the captured amount (`reportedBy`, the quote's price kept as `quotedCents` when it differs; the store's order and capture IDs stay in `storeReport`, apart from Worth's own `orderId`/`captureId`), which lowers room to spend once until a funds snapshot reflects it; one Activity row, "Payment to <store> · PayPal" on the plan's day for `capturedAt`; and removes the Saved item for what was sold: by `qid` (a /check save), by `sourceUrl`, or, for the demo store, the catalog item with the quote's product ID (the sample plan's Saved list). The browser names every new report in one notice ("<store> told Worth about your $X payment.") and clears exactly those with `POST /api/handoff/notices/seen`, which, like the other hand-off routes, is a 404 while the hand-off is off. A later PayPal CSV import counts that payment once: the shopper's export names it by their own transaction ID, so `parsePayPalCsv` matches a reported row (`referenceId` `store:<captureId>`) by exact amount within a day: one transaction per report, preferring a row whose name contains the store's name, then the nearest date. Every row of that transaction (pending, then settled) counts once, and the preview names the row it took, in view (`storeMatches`). A committed import keeps the match on the report (`matchedImportId`), so no later import matches that report again, and later copies of the transaction it took are duplicates.
- **Off switch.** With `HANDOFF_SECRET` and `MERCHANT_ORIGIN` both unset, the hand-off is off: one start-up line says so, `/api/health` and the state config report `handoff: off`, and every `/api/handoff/*` route answers with its generic error. One without the other is refused in production.
- **Who is named.** Only here does Worth show a store's name: on `/check` and on items saved from it ("Sold by <store>", "Back to <store>"), and on the Activity row for a payment that store reported. Items reached inside Worth carry no seller line, and Worth's own checkout pays a neutral sandbox payee (`PAYPAL_BRAND_NAME`, default "Sandbox demo merchant").
- **Swipe mode.** The example store (Larkspur Supply) wraps its `<paypal-button>` in `<worth-check mode="swipe">`. PayPal's button stays PayPal's, untouched and uncovered at rest; Worth's outline W tab sits flush on its right edge with a "Swipe left for Worth" hint. Dragging the tab left past half the row (or tapping it, or Enter/Space) opens the same signed `/check` link in the same tab. Reduced motion stills the arrows and leaves the tab a plain link; while PayPal's button is hidden the tab becomes the full-width outline link.
- **The element.** The store's Vite build bundles `shared/worthCheck.ts` into `dist-merchant/assets/worth-check.js`, which product pages load beside the PayPal button; the store's checkout module hands it the page's SDK v6 instance. PayPal names Pay in 4 `PAY_LATER_SHORT_TERM` (US); `PAYLATER` or an unknown code leaves the quote's `payLater` unset rather than false (`shared/payLater.ts`, also used by Worth's own checkout).
- **Claude.** Store text never reaches Claude from the hand-off; an item name reaches it only if the shopper asks about it, through the same quoted path as anything typed.

## Similar items from other stores (Channel3)

Under the Spend less option, and in Ask answers to requests for something cheaper, Worth lists up to four real products from other stores, found through Channel3. It is discovery only: rows open the store's page in a new tab, and Worth never sells them or offers PayPal checkout for them.

- **What is sent.** Only a phrase built from an allowlist of product kinds (camera, headphones, chair, desk, laptop, jacket, …) with at most one listed modifier ("office chair"), or a catalog item's fixed description. Names, brands, models and anything else typed never leave the server; with no listed kind, nothing is searched. The price band is the room today rounded down to $25, with a floor at a quarter of it. Settings and privacy names Channel3 and says this applies with the assistant off.
- **Endpoints.** `POST /v1/search` and `POST /v1/similar` (credits), and the free `GET /v1/products/{id}`. `GET /api/alternatives?productId|itemName|maxPriceCents|similarTo` sets the ceiling from the session's room today; `similarTo` works only for products this session was shown ("More like this"). `GET /api/alternatives/price?id&savedPriceCents` (`channel3.checkPrice`) reports whether a product's price dropped, for the Saved list: only for products the session was shown or saved (`app.locals.rememberAlternative`), at most 30 per session and 60 per IP per hour, with each product read cached for 15 minutes.
- **Freshness.** Rows found within 15 minutes are shown as found. Older cached rows and recorded example rows are re-read with `GET /v1/products/{id}` before display: a current price and link replace the stored ones, a product that no longer fits is dropped, and a row that cannot be re-read is listed without a price or link ("Price not checked").
- **Parsing.** Each product keeps its cheapest in-stock offer marked `new`, in USD, inside the band, linking to `buy.trychannel3.com` or the offer's own domain. Mispriced listings (another offer over three times higher) and repeats of the same model are dropped. Images are kept only on `cdn.trychannel3.com`, the one host added to `img-src`; a failed image falls back to a store icon.
- **Credits.** Results are cached 6 h per query and $25 bucket, with one request in flight per key. Live searches are capped per day (`CHANNEL3_DAILY_LIMIT`) and per client IP per hour (`CHANNEL3_IP_HOURLY_LIMIT`); cached answers do not count. After a failure, searches pause (6 h on 401/402/403, 60 s on 429, 30 s otherwise) and the recorded results in `server/fixtures/channel3.json` are served, labelled "Example results". `npm run channel3:record` refreshes them.
- **Health.** `/api/health` and `state.config.alternatives` report `channel3: ok | fixture | off`. Without a key the panel stays hidden; no error is shown.
- **Routing.** A product search runs only for a request for a cheaper or similar *product*. Questions where "cheaper" is about how or when to pay, which of Worth's options to pick, or a service plan ("Is Pay in 4 cheaper than paying now?", "Is it cheaper to wait?", "Which option is cheapest?", "a cheaper phone plan", "the cheapest way to pay") never search, while "cheaper options for headphones" and "something cheaper than the camera" do: the server refuses Claude's `find_alternatives` call for them, local mode answers them as before, and the server's fallback override applies only when Claude asked a question or summarised the plan. A priced item asked with "or something cheaper" is assessed first, then the search follows.
- **AI.** `find_alternatives` takes a kind of item and an optional ceiling the user wrote (checked against their words). The server searches and writes the answer; only the outcome (found, none found, needs an item) returns to the model, never product names, stores or prices. Without a kind of item, the answer names the limit and offers one-tap searches ("Find headphones under $300").
- **Capture.** `?capture=1` blurs product photos, titles and store names for recordings.

## Paste a product link (Channel3 lookup)

For a store that has no "Analyse with Worth" button, the shopper pastes the product link into either composer (Home or Ask Worth). Worth reads it through Channel3 and asks "Is $X right?" before it checks anything.

- **Routing.** The browser checks every composer message first (`linkIn` in `shared/link.ts`). It finds links with a scheme, links starting `www.`, and a domain followed by a path (`shop.com/p/123`), but not words such as "e.g." or "$1.5k". A message holding a link never goes to `/api/chat`: one link opens the confirm card (given `https://` when it had no scheme), and several get "Paste one product link at a time". Link turns are also left out of the history later chat messages send. As a second guard, `/api/chat` replaces links and website names in the message and history with "[website]" before Claude (`withoutWebsites` in `server/labels.ts`, the rules `merchantLabel` uses).
- **Validation.** `checkProductLink` accepts only https on the default port, at most 2,048 characters, with no user name or password, on a public domain name. IP literals (v4 and v6), `localhost`, single-label hosts and private suffixes (`.local`, `.internal`, `.lan`, `home.arpa`, …) are refused, and the fragment is dropped. The browser and the server both run it.
- **No fetch by Worth.** `POST /api/lookup { url }` calls Channel3 `POST /v1/lookup { url }` (header `x-api-key`; response `{ product }`, the same Product model as `GET /v1/products/{id}`; 404 and 422 for no product page, 500 and 504 when the page could not be read). Worth's server never requests the pasted URL itself, so there is no server-side request forgery surface.
- **Mapping.** `parseLookup` returns `{ name, priceCents?, currency?, merchantName, merchantDomain, imageUrl?, sourceUrl, status }`. Only an offer on the pasted link's exact host (ignoring a leading `www.`) is used, preferring an in-stock USD one, so `co.uk` can never stand for every UK store; another store's price is never shown as this one's. The title is made plain text (control and bidirectional characters removed) and cut to 80 characters. Images are kept only on `cdn.trychannel3.com`. `sourceUrl` is the link as pasted, never Channel3's affiliate redirect.
- **Confirmation.** The price is never used until the shopper confirms or edits it, along with the name. With no price for this store, a price in another currency, an invalid link, Channel3 off, a failed lookup or a used-up allowance, the card asks for the price with name and price fields: "We found it, but not its price" when Channel3 knew the product, "We couldn't read that page" when it did not, and the US dollar price (showing the listed price for reference) for another currency.
- **Decision.** The confirmed name and price open the usual decision, carrying `sourceUrl` and `priceSource` (`channel3` when the read price was kept, `user` otherwise). The `#decision?…&link=` URL carries only the link: a price source read from a URL is always `user`, and `channel3` holds only for the item this tab just confirmed, kept in memory (`decisionRequestFrom` in `src/contract.ts`). `/api/compare` echoes `source { sourceUrl, merchantName, priceSource }`, naming the store from the link's domain. It does not ask PayPal about Pay in 4, since that check answers for Worth's demo merchant: the panel reads "If this store offers PayPal Pay in 4", shown for $10 to $2,000, without PayPal's message. "Save for <date>" keeps the link with the saved item (C6, below).
- **Limits.** Lookups share the search budget: the daily cap (`CHANNEL3_DAILY_LIMIT`), the per-client hourly share (`CHANNEL3_IP_HOURLY_LIMIT`) and the back-off on 401/402/403/429. A found product is cached for 15 minutes and a miss for an hour (500 and 504 for 15 minutes), with one request in flight per link. Lookups wait up to 10 seconds. A slow or unreadable page does not pause other calls.
- **Modes.** `off` answers `LOOKUP_OFF` and goes straight to the manual card. `fixture` serves the recorded lookups in `server/fixtures/channel3.json` (fictional store links on `shop.larkspur.example`: one USD price, one GBP price, one priced only at another store) and "not found" for any other link.
- **No page text to Claude.** Nothing Channel3 reads from the page is sent to Claude. If the shopper then asks a follow-up in Ask, only the confirmed item name and price travel, as the purchase under discussion, which `requestContext` passes as a quoted, minimised JSON string like any typed item name.

## Payment state and concurrency

The demo catalog is server-owned. `/api/checkout/create` accepts a product ID, not a client-provided total. It reassesses the actual current date even if the user previously explored waiting. Missing information blocks checkout; a low-cushion result requires explicit acknowledgement.

Before the remote call, the server persists one purchase reservation inside `BEGIN IMMEDIATE`. A SQLite partial unique index allows at most one active (`created`, `pending`, or `unknown`) checkout per session. A per-purchase in-process lock serializes remote reconciliation. Profile edits, imports, and reset are blocked while the active checkout needs resolution.

```mermaid
stateDiagram-v2
  [*] --> created: Current-date assessment and reservation
  created --> pending: Buyer approved, explicit capture requested
  created --> cancelled: Cancel after remote state check
  created --> unknown: Remote creation uncertain
  pending --> completed: Validated completed capture
  pending --> unknown: Capture response uncertain
  pending --> failed: Authoritative failure
  unknown --> created: Order lookup confirms uncaptured order
  unknown --> pending: Lookup confirms pending capture
  unknown --> completed: Lookup confirms completed capture
  completed --> completed: Duplicate response or late event
```

PayPal create/capture request IDs derive from the persisted purchase ID and are reused on retry. The gateway (`server/paypal.ts`) refreshes the OAuth token once after a 401 and retries a 429 or 5xx at most twice, with jittered exponential backoff from 300 ms (or PayPal's longer `Retry-After`), each wait capped at 2 s, and the same `PayPal-Request-Id`. Other 4xx answers are final. A timeout, network failure or body that fails to arrive is retried only for a GET or a request with a request ID. Each call has one 20 s budget for its attempts, token fetch and waits, and no retry starts with less than 3 s left, so a capture (lookup, then capture) ends within 40 s and a checkout start (eligibility, then order) within 25 s. The eligibility check is advisory: one attempt within 5 s, then the range-only fallback. Each retry is logged with PayPal's debug ID, never a body or token. Returned order identity, purchase reference, merchant, currency, amount, and capture count must match. A completed capture writes one expense and updates the profile version atomically. Order and capture IDs also have database uniqueness constraints.

`src/paypalSdk.ts` loads the sandbox JavaScript SDK v6 with bounded initialization, retryable failures, and an instance cache keyed by public client ID. The checkout dialog (`src/Checkout.tsx`) checks PayPal eligibility and creates a one-time payment session with `commit: false`. It starts in the user's click handler and passes the server order promise to preserve browser popup permission. SDK approval updates the UI; it does not capture. If SDK loading or eligibility is unavailable, the server-provided approval URL remains a redirect fallback.

After buyer approval, the user performs a distinct confirmation action in Worth. Capture revalidates the current date/profile and excludes its own reservation when recalculating affordability. If a transport failure makes the result uncertain, the allocation remains reserved. A retry fetches PayPal's order status before attempting capture again. The frontend refreshes state after uncertain creation so the outstanding checkout remains visible and recoverable after closing its dialog.

The webhook route verifies the signature through PayPal, resolves the related order, retrieves the authoritative order, and uses the same reconciliation path. Event IDs are deduplicated. Late approval events cannot downgrade a completed purchase. `PAYMENT.CAPTURE.REFUNDED` and `REVERSED` events are re-read from PayPal (`GET /v2/payments/refunds/:id`), matched to the purchase through the capture, and recorded as a review item; spending room changes only when the user confirms what came back.

## Saved items, wait plans and the demo clock

Saved items live in the session on the server (`server/saved.ts`): a catalog item (name and price from the server catalog) or a custom item from an Ask Worth assessment or a Channel3 "Similar items" row, which is labelled "Assessment only — no checkout in Worth" and never checked out. A session keeps at most 20 (the Phase 5 spec's limit, which replaces the earlier scope's "at most 5" for `save_wait_plan`). A wait plan whose date has come is reported as `ready`; there is no scheduler, email or push. On return the user confirms today's funds (`POST /api/funds/confirm`), the plan is assessed again, and only then can `POST /api/saved/:id/prepare` create the order, through `checkoutGuards` in `server/checkoutGuards.ts`. A saved Channel3 row keeps its product ID (`channel3Id`) only when the session was shown that product; saving registers it with `app.locals.rememberAlternative`, and Saved checks its price once per page load through `GET /api/alternatives/price`, showing "Price dropped to $X" when it fell and nothing on any failure.

**Saved with the store link (C6).** A custom item can carry the store page it came from: `sourceUrl`, `merchantName` and `priceSource` (`component` when the store's own Worth button sent the price, `channel3` when Channel3 read it and the shopper kept it, `user` when they typed or changed it). `POST /api/saved` takes the link and price source together, and from the browser only `channel3` or `user`, as `/api/compare` does; `component` is set by the server alone, from a store's verified hand-off. The link goes through `checkProductLink` (https on the default port, at most 2,048 characters, no user name or password, a public domain name, fragment dropped). The store is named by the link's domain, as `/api/compare` names it; a store name the browser sends is ignored. Saving the same link again updates that item's name, price and source rather than adding another. Items saved before C6, the test fixture persona's seed among them, have none of these fields and are returned unchanged; a stored link that no longer passes the checks is dropped with its store details, a missing price source reads as `user`, and only a `component` item keeps a stored store name (`withSource` in `server/saved.ts`). Worth never fetches the link. On the ready day the plan shows **"Back to <store>"**, a plain link to `sourceUrl` (a new tab, unlike /check's same-tab return; `rel="noopener noreferrer"`, no token), and never an in-Worth checkout; items without a link keep the demo-store path above. For a `channel3` price only, opening Saved on or after the plan's day calls `POST /api/saved/:id/recheck` once (never on a timer). It is the paste-a-link lookup itself, `channel3.lookup` with this client's `liveSearches` share, so it shares the 15-minute cache, the daily budget and the hourly per-client limit. A live US dollar price for that store answers `same` or `changed`, and the plan is checked again at the price now ("Price now $X (was $Y)"); a failure, the limit, a missing or non-USD price or a recorded fixture answer `unavailable`, and Saved keeps the saved price with "Couldn't re-check the price". The saved price itself never changes without the shopper.

Sessions expire 24 hours after creation unless the user opts in to 30-day retention (`POST /api/retention`), which moves both the session row's expiry and the cookie's.

The demo clock (`server/demoClock.ts`) sets the session's today for the synthetic persona only: `sessionToday()` in `server/app.ts` reads it, and importing data removes it. A new session starts as Alex pinned to Fri, Nov 13, 2026 (preset `demo`), because `SAMPLE_PERSONA` defaults to `alex`; his dates are absolute, so the UI offers no "Back to today" for him, and `today` restarts him on the demo day. The presets (`/?replay=demo`, `demo-dec15`, `video`, or `POST /api/demo-clock`) restart a fresh persona on their day: `demo-dec15` is Alex's return visit, opening on the balance the Nov 13 plan projects for that morning with the Halden X5 saved as a wait plan for that day (and its store page, when the hand-off is on); `video` is the test fixture persona on Sat, Oct 3, 2026, the day the first video was recorded. A store link carries the preset in `?replay=` and in the signed quote, so both origins show the same day. Moving the clock to a later day leaves the funds snapshot behind, so today's funds need confirming, exactly as for real data; for the untouched persona the confirmation offers the sample plan's own projected balance, and only there are the past one-time payments and completed purchases pre-ticked as already in that amount. Hand-typed numbers are the user's own, so they stay off the clock: while it runs the plan editor is locked (`PATCH /api/profile` returns `DEMO_CLOCK_RUNNING`), a plan edited before it starts cannot be moved to a later day (`DEMO_CLOCK_SAMPLE_ONLY`; a preset restarts the untouched sample), and an edited plan gets no projection. A purchase completed under the clock records the clock's day as `completedOn`, which "bought on" shows.

Ask Worth reads a catalog item's store price only when the message names the item as a whole phrase ("the camera", "the MacBook Pro"); "a camera bag", "a Sony camera" or "a MacBook Air" get a question about the price instead. A conversation can return to an item it assessed earlier: each reply carries that item with an HMAC tag bound to the session (`server/remember.ts`, key held in memory), the browser sends the tagged items back, and the server drops any item whose tag does not verify, so an edited or invented remembered item is never used. The tag proves Worth assessed the item, not that its price was grounded: the current-purchase `context` the browser sends is the user's own claim, like a typed price, and an item assessed from it is signed like any other.

## Session and data boundary

- Opaque random cookie: HttpOnly, SameSite=Lax, and Secure in production mode.
- `/api/state` exposes a hash-derived `sessionKey` for detecting a replaced browser session; it is not the authentication cookie. The client clears its conversation on reset, import, or detected session replacement.
- Browser chat requests include that `sessionKey`. A mismatch returns `409 SESSION_CHANGED` before calling the AI provider; the assistant clears history/context and refreshes the current plan rather than replaying old personal messages into a replacement session.
- State refreshes when the page becomes visible, on window focus, and every 60 seconds while visible, keeping dates and checkout status current. Old assessments are labelled after a profile/date change.
- Session-scoped reads and writes; possession of a different session cannot access an order through its route ID.
- Mutations require JSON and `X-Worth-Client: web`, reject cross-site fetches, and enforce the configured origin when supplied.
- Zod bounds incoming fields, amounts, dates, CSV size, history length, and scheduled flows. Per-IP requests are limited; one AI request per session can be active.
- Raw CSV is not retained. Imported normalized records remain in SQLite until reset or absolute 24-hour session expiry. Cleanup occurs before session use and on a one-minute timer.
- The database is local, single-instance storage. There is no user account recovery, encryption-at-rest layer, distributed payment lock, or production operational system.

AI consent applies to edited or imported personal context. Model tools receive relevant summaries and commitment names rather than the raw CSV. User chat and editable names can still contain personal information. Reset cannot remove data already held by PayPal, Anthropic, or operating-system backups.

## Verification

`npm run check` (lint, TypeScript, the Vitest suite and the production build) runs in GitHub
Actions on every push to `main` and every pull request. The suite covers the engine's chronology
and boundaries, CSV import rules, server ownership and reservations, capture and webhook
reconciliation with a fake gateway, the checkout guards, the sentence check as table tests, the
chart, the MCP contract and the client flows. The AI path is also replayed from recorded model
responses on every run, and run live against the real model on demand; see
[EVALUATION.md](EVALUATION.md).

Provider behaviour verified against the real sandbox, outside the suite: SDK v6 popup approval
with exactly one capture and one activity row; cancellation and recovery; a US sandbox buyer
completing Pay in 4 for $1,199 inside PayPal's checkout; PayPal Messages rendering on the US
sandbox merchant; these were checked by hand in October, before the Alex sample.

Not covered: production payments, automatic access to personal PayPal history, goods
fulfilment, more than one server instance, and encryption at rest.
