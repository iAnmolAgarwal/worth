# Project scope — PayPal purchase affordability assistant

Date: October 2, 2026
Status: Proposed MVP; one independent scope review completed and findings incorporated. No application has been built or API access tested.
Working name: Purchase Compass (placeholder, not a final branding decision).
Deliverable: A working, independently branded web application for the PayPal AI Hackathon.

## 1. Product thesis

Help a frequent PayPal user answer: **“What happens to my finances over the next 30 days if I buy this?”**

The assistant combines spending history with user-confirmed available funds, expected income, upcoming obligations, and a chosen cash cushion. It explains whether a proposed purchase fits that plan, shows the consequences, and compares buying now with waiting or choosing a cheaper item. A user can then explicitly approve a PayPal sandbox purchase and see the plan update.

This is a conditional cash-flow estimate. It must not present incomplete data as a complete view of someone's finances, promise future affordability, or treat credit availability as income.

### Initial audience and problem

- Start with adults who use PayPal frequently, have reasonably predictable income, and are considering an occasional discretionary purchase such as electronics or hobby equipment.
- Initial prototype: one person, USD, English, desktop-first responsive web interface. This is a scope choice, not a claim about geographic availability or entrant eligibility.
- The problem hypothesis: users can see past transactions but struggle to translate them into a purchase decision that preserves money for upcoming commitments.
- “Mainstream PayPal users transact almost entirely through PayPal” is **unvalidated**. The product must accommodate missing non-PayPal expenses rather than depend on that assumption.
- The intended differentiator is a purchase-specific explanation, timing comparison, and completed payment feedback loop. Novelty and demand still need validation against budgeting and shopping products.

### Example experience

User: “Can I buy this $900 camera?”

Illustrative response: “With the income and bills you confirmed, buying now would bring your estimated lowest balance to $250. Your chosen cushion is $500. A $650 purchase would leave $500 under the same assumptions. We can also check a later purchase date.”

These are example values, not a prediction about an actual user. Every displayed number must come from the calculation engine and link back to its inputs.

## 2. Verified boundaries and open assumptions

| Topic | Evidence or current status | Scope consequence |
| --- | --- | --- |
| Consumer transaction-history access | PayPal's Transaction Search collection says access on behalf of third parties requires participation in its partner network. Personal-account eligibility for this use case has not been confirmed. [S1] | Do not depend on unrestricted consumer account syncing. Direct history access is a separate feasibility investigation. |
| PayPal login | Published login scopes cover identity and account attributes; transaction history is not listed. [S2] | Do not label a login button as permission to import all spending. PayPal login is not required for MVP app authentication. |
| History export | PayPal documents downloadable activity reports including CSV. [S3] | Support a documented CSV format and a mapping/validation screen; do not promise every regional export variant. |
| Consumer app embedding | No native PayPal consumer-app extension access has been established. | Build our own app. A native PayPal feature remains a future partnership concept. |
| Payment processing | Orders v2 provides order creation and buyer-approved capture; SDK v6 is documented. [S4, S5] | Use a single demo merchant with actual sandbox API calls and test buyer approval. |
| Payment notifications | Webhooks are scoped to their registered app, and must be verified. [S6] | Observe purchases created through our app, not a user's entire PayPal activity. |
| Reporting freshness | Transaction Search can lag an executed payment by up to three hours. [S7] | Update our purchase record from verified capture results/events rather than waiting for reporting. |
| Hackathon fit | Meaningful PayPal and AI use and a functioning application are required. [S9] | Historical CSV analysis alone is insufficient for the intended submission. The payment loop is mandatory. |

Sources establish documented capabilities, not successful account provisioning or completed integration tests. Sandbox access, event delivery, and the exact CSV schema must be verified during the first implementation slice.

## 3. MVP scope

### A. Financial picture

1. Begin with either a labelled synthetic persona or a user-provided PayPal CSV. Never mix demo history silently with personal data.
2. Show import coverage, date range, rejected rows, and duplicate handling. Target 90 days of history; shorter histories require user-confirmed spending estimates.
3. Propose spending categories and likely recurring expenses. Show the supporting transactions and let the user correct them.
4. Ask for available liquid funds as of a specific date/time, income amounts and dates, upcoming bills/debt repayments, and a minimum cash cushion. Ask explicitly about commitments outside PayPal.
5. Have the user confirm which recurring items and spending estimates belong in the forecast. Account transfers, refunds, reimbursements, and incoming payments are not automatically salary or ordinary spending.

### B. Purchase decision

1. Choose from a small, server-owned demo catalog or enter an item's name and total price for analysis only.
2. Include known tax and shipping in the total. If the all-in price is unknown, request it or show an incomplete estimate.
3. Display the baseline forecast and the forecast with the purchase, the lowest projected balance and date, the cushion, and material missing information.
4. Return one of three clearly defined outcomes: **Fits this plan**, **Would dip below your cushion**, or **More information needed**.
5. Compare a later purchase date and lower prices. Recommend a date only when the available forecast covers the required period. Otherwise say that no supported date was found within the planning window.
6. Show which inputs were imported, entered by the user, or estimated, and when they were last confirmed.
7. Future-date scenarios are planning only. Choosing checkout always evaluates buying now; it cannot reuse a positive result based on a future paycheck.

### C. Bounded AI assistant

- Interpret a purchase request, suggest categories/recurring items, identify missing inputs, call the forecast tool, and explain its result.
- Answer focused follow-ups such as “What changes if I wait two weeks?” or “What price stays above my cushion?”
- Suggest profile changes as editable drafts; require explicit user confirmation before changing amounts, dates, obligations, or the cushion.
- Keep numeric calculation, outcome classification, and payment execution outside the language model.
- Do not automatically purchase, borrow, open credit, cancel subscriptions, move savings, or contact anyone.

### D. PayPal payment loop

- Checkout is available only for our demo catalog, fulfilled by a clearly labelled sandbox demo merchant. A product URL or price typed into chat does not authorize purchasing from an arbitrary retailer.
- The user deliberately chooses to proceed, reviews the total, and approves the payment in PayPal's sandbox UI.
- Our server creates and captures the order. A completed capture records the purchase and recalculates the plan exactly once.
- Cancellations and failures do not become completed spending. Pending or uncertain outcomes remain visible until reconciled.
- A low-cushion outcome is guidance, not a claim that PayPal will decline a payment. If the user continues in the demo, preserve the explanation and require an explicit proceed action.

### E. Main screens

1. Start/import and financial assumptions review.
2. Purchase decision workspace: item card, outcome, 30-day chart, evidence, and focused chat.
3. Buy-now/wait/cheaper scenario comparison.
4. PayPal approval, payment status, and updated plan.

Keep implementation details in developer documentation. Product copy should explain the data, assumptions, and decisions that matter to the user.

## 4. Calculation contract

### Inputs and accounting boundaries

- Store monetary values as integer USD cents and use a specified user timezone for dates. Reject unsupported currencies instead of silently converting them.
- Start from a **user-confirmed current available-funds snapshot**. Historical CSV rows estimate future patterns; they must not be replayed as debits against an already-current balance.
- When refreshing that snapshot, reconcile each existing app purchase, paid obligation, income receipt, and outstanding allocation: mark whether its effect is already included in the new funds amount. Exclude reflected amounts from subsequent adjustments, carry unreflected commitments forward once, and preserve unresolved reservations. Timestamps alone cannot establish inclusion, particularly for card-funded purchases. Ambiguous inclusion produces **More information needed**. Keep the inclusion links with the snapshot version.
- Money moved between the user's own included accounts is not income or consumption. A PayPal top-up paired with a purchase must not count as two purchases.
- Separate income, spending, transfers, refunds, and unresolved transactions. Income and obligations enter the forecast only after confirmation.
- Track bills separately from variable living expenses. Historical payments represented by a scheduled bill are excluded from the variable-expense estimate.
- For MVP, reserve the full proposed purchase price at purchase time. Treat this as a planning allocation, even if PayPal's chosen funding instrument settles differently. Do not claim to know the funding instrument's bank balance or offer a credit repayment model.
- Existing card/debt repayments are entered as separate obligations. User review must resolve overlaps with already-reserved spending; ambiguous overlaps produce **More information needed**.
- Pending commitments count once as reserved amounts until resolved. Completed purchases replace their reservation rather than add another debit.

### Forecast behavior

For each point in the forecast:

`projected available funds = current snapshot + confirmed expected income - scheduled obligations - estimated variable spending - new purchase/reservations`

The user's cushion is a comparison threshold, not an additional expense in this equation. Any separately earmarked savings must be excluded from the initial available funds or represented once as a dated allocation.

- Compute a baseline and purchase scenario over the next 30 days. Consider the lowest balance throughout the window, not just the final balance.
- When only calendar dates are known, apply same-day outflows before inflows. An expected paycheck later that day must not fund an earlier purchase automatically.
- Candidate purchase dates range from today through day 30. Each date must preserve the cushion from today through **30 days after that candidate date**, requiring forecasts up to day 60. Insufficient forward coverage cannot yield a positive waiting recommendation.
- An existing baseline shortfall remains visible: delaying the purchase cannot erase a cash shortage occurring before the proposed purchase date.
- Variable spending starts from validated historical category totals converted to a daily estimate, excluding scheduled bills and identified one-offs; the user must review the resulting estimate. Provide an editable manual estimate for sparse or unrepresentative history.
- Compare the base estimate with a clearly labelled scenario of 20% higher variable spending. This is a product stress assumption, not a statistically calibrated confidence interval. Explain if the base case fits but this scenario crosses the cushion.
- The earliest suggested date is conditional on the confirmed income and expense assumptions. Do not count merely hoped-for income or unconfirmed refunds as available money.

### Outcome rules

| Outcome | Rule |
| --- | --- |
| More information needed | A required input is missing, materially outdated, unsupported, or unresolved; this takes priority over a positive result. |
| Fits this plan | Required inputs are confirmed and the minimum baseline/purchase path is at least the user's cushion across the applicable window. Include stress-scenario results alongside it. |
| Would dip below your cushion | The model has sufficient inputs and the applicable minimum is below the cushion. Explain whether the baseline already has a shortfall. |

Require confirmation of the available-funds snapshot and unrecorded spending before a new checkout. Re-evaluate whenever the total, purchase date, profile, or recorded payments change. An old assessment cannot silently authorize a changed purchase. Checkout must use a fresh assessment for the actual current purchase date. If a waiting scenario fits but buying now does not, show the current shortfall and require a deliberate proceed action; the future-date result is never an authorization to pay today. If a checkout crosses a date boundary or the profile changes before capture, return to assessment and confirmation.

## 5. Proposed technical shape

Default proposal, to be finalized when implementation starts: a TypeScript web application with a React interface, server-side API routes, a relational database, and a provider-neutral language-model adapter. Next.js and PostgreSQL are reasonable starting choices; no framework, model, or hosting account is configured by this document.

Keep one application and one bounded agent loop. Separate modules for import/normalization, financial profiles, the deterministic forecast, AI orchestration, and PayPal checkout/events. No multi-agent runtime is needed for MVP.

| Record | Minimum purpose |
| --- | --- |
| Profile and snapshot | Available funds, as-of time, timezone, currency, cushion, version, confirmed assumptions, and links identifying which prior receipts/debits/allocations are already reflected. |
| Imported transaction | Source account/import, source identifiers, timestamp, signed amount, currency, event type, category, and review status. |
| Obligation/income rule | Amount, dates/recurrence, source, confirmation, and overlap links to historical estimates. |
| Assessment | Exact profile version, all-in purchase amount/date, forecast horizon, algorithm version, outcome, and evidence. |
| Purchase | User/session, catalog item, approved amount/currency, PayPal order/capture IDs, reservation, and current state. |
| Event receipt | PayPal event ID, verification/processing state, and resource identifiers for deduplication. |

The agent may read the profile, propose changes, request an assessment, and compare scenarios. Only the server's explicit checkout flow may create/capture payments. Model outputs are validated against a schema; transaction descriptions and uploaded content are untrusted data, not instructions.

### Payment correctness

- Use a sandbox business account as our demo merchant and separate sandbox buyer accounts. The merchant's payment records do not establish access to the buyer's other purchases.
- Use SDK v6 and Orders v2 following the single-merchant documentation; do not accidentally adopt a partner/marketplace onboarding flow. [S4, S5]
- Prices and currency come from the server catalog. Bind orders to the current session and assessment, and validate identifiers, merchant, currency, and amount before recording a payment.
- Allow one active checkout per profile in MVP. Atomically verify the latest current-date assessment, acquire that checkout slot, and persist the purchase reservation before starting the remote payment flow. Revalidate the date/profile version before capture without counting that purchase's own reservation twice. A second tab or distinct order must wait and reassess after the active checkout resolves; per-request idempotency alone cannot provide this guarantee.
- Persist a stable request ID for each create/capture operation and reuse it on retries where supported. Keep database uniqueness checks as well. [S8]
- Apply the same reconciliation path to a verified capture response and a verified webhook. Deduplicate by capture/event identifiers so their arrival order cannot cause double spending in the forecast.
- A late pending/approval event cannot downgrade a completed capture or release its allocation. Contradictory events trigger a server-side status lookup and a visible reconciliation state rather than a guessed balance.
- Reserve the amount while capture is pending or its result is unknown. Prevent another checkout from spending that reservation. Reconcile against PayPal before releasing it or retrying an uncertain operation.
- Match completed captures to the assessment: record the debit once and remove the hypothetical purchase/reservation from that updated plan.
- Re-importing a CSV that includes the same completed purchase must not create another commitment. Use stable transaction/reference identifiers where available; flag uncertain matches for review.
- Do not require Transaction Search for immediate payment feedback. An optional reporting adapter may be investigated later, but is not an MVP dependency. [S7]

## 6. Data handling and failure behavior

- Hosted sessions must isolate each user's records and enforce server-side ownership checks. Judges get synthetic personas by default; there is no public shared view of uploaded financial records.
- Ask for consent before processing a personal upload with an external AI service. Prefer minimized merchant/category/date/amount data; strip names, emails, addresses, and unnecessary identifiers from model inputs and logs.
- Discard raw CSV files after parsing. Provide a delete/reset action; normalized personal data in the demo expires after 24 hours. Implement and verify that cleanup rather than only promising it in copy.
- Keep PayPal secrets and model keys server-side and out of the public repository, screenshots, and video. Do not ask for a user's PayPal password or bank credentials.
- When the model is unavailable, keep structured inputs, calculations, and payment status usable. Show that the narrative explanation is unavailable; do not fabricate one.
- Invalid rows and unsupported currencies are visible. If excluded material could change the decision, withhold a positive outcome until corrected or covered by a user-confirmed estimate.
- No production money movement is part of this scope. Clearly mark sandbox payments and synthetic history throughout the demo.

## 7. Explicitly out of scope

- Native modification of PayPal's app or a claim of PayPal endorsement.
- Unrestricted personal-account syncing, bank aggregation, or a universal view of a user's finances.
- Autonomous checkout, scheduled purchasing, credit/BNPL recommendations, debt optimization, investment advice, or lending decisions.
- Arbitrary merchant checkout, browser extensions, scraping retailer carts, or an open marketplace.
- Multi-currency conversion, shared household accounts, irregular-income prediction, and a complete personal-finance suite.
- Live notifications, automatic money transfers, production deployment, app-store delivery, and paid monetization.
- Refund initiation and full refund/dispute management. Unexpected events must still be handled visibly without falsely presenting a settled balance.

Possible extensions after the core works: one useful sponsor integration, such as AG Grid analytics or Channel3 alternative-product discovery. Discovery links must not imply that our demo merchant can sell those products.

## 8. Implementation sequence and acceptance criteria

These are relative milestones, not a time commitment: team size and weekly availability are not yet specified.

| Milestone | Deliverable | Exit evidence |
| --- | --- | --- |
| 1. Thin working slice | One synthetic profile, deterministic buy/no-buy assessment, one catalog item, and actual sandbox checkout/capture. | Recorded sandbox order/capture and exactly one updated forecast. Verify account access before building the full UI. |
| 2. Data and forecasting | CSV import preview, corrections, confirmed obligations, 30-day charts, and later-date comparisons. | Deterministic fixtures cover missing data, duplicates, timing, and boundary cases. |
| 3. AI experience | Categorization proposals and conversational scenario explanation grounded in tool outputs. | Numeric answers agree with the engine; profile changes require confirmation; misleading transaction text cannot invoke payments. |
| 4. Integration and polish | Verified webhooks, retry recovery, isolated sessions, import reconciliation, and clear failure states. | End-to-end payment and failure checks pass; raw-file deletion and session isolation are exercised. |
| 5. Submission | Public licensed source, reproducible setup, functioning demo access, and a concise video. | A fresh setup works and the submitted flow runs end to end. |

Minimum acceptance cases:

1. A baseline minimum of $1,150 and an immediate $900 purchase yield a $250 minimum; with a $500 cushion, the result flags a shortfall. A $650 purchase reaches the $500 boundary and fits the base case.
2. A large future paycheck cannot hide an earlier shortfall; unknown same-day timing treats expenses before income.
3. Moving a purchase later extends the forecast coverage requirement; a date at the edge of the original 30-day window cannot bypass subsequent bills.
4. Missing current funds, an unconfirmed material bill, or unsupported material import rows yields **More information needed**, even if known transactions suggest the purchase fits.
5. Historical purchases, funding transfers, scheduled bills, refunds, repeated imports, and new captured purchases are not double counted.
6. Duplicate/out-of-order webhook delivery, a repeated capture request, and a capture-response/webhook race produce at most one completed purchase entry.
7. Cancellation creates no completed debit; pending/unknown capture keeps one reservation and is recoverable after a reload.
8. Editing a price, cushion, obligation, or purchase date invalidates the affected assessment. Server checks reject client price tampering and another session's order ID.
9. Every amount in the assistant's explanation matches the assessment; unknown figures trigger questions rather than invented numbers.
10. Users can inspect and correct assumptions. Another session cannot access their imports, and deletion/expiry removes their retained personal data.
11. A future purchase fits after payday but the same purchase today breaches the cushion. Clicking checkout shows a fresh current-date result and cannot carry over the future-date positive outcome. Crossing midnight or changing inputs before capture requires reassessment.
12. Starting from $2,000, a settled $600 purchase leaves $1,400. Refreshing funds to $1,400 and confirming that the purchase is included leaves $1,400, not $800. If the $600 is an unsettled allocation not reflected in a $2,000 snapshot, it remains reserved and leaves $1,400. Uncertain inclusion withholds a positive outcome.
13. Two tabs initiate distinct $600 orders against $1,000 with a $300 cushion. Only one becomes an active checkout; the other is reassessed after resolution and cannot display the first order's pre-purchase result as current. This check is separate from retrying the same order.

Verification is planned, not completed. This document does not claim financial-model calibration, production readiness, user demand, or successful payment tests.

## 9. Hackathon fit and demo

Proposed demo, under three minutes:

- 0:00–0:20: Introduce a synthetic shopper and the purchase question.
- 0:20–0:50: Show history coverage and confirm income, bills, and the cushion.
- 0:50–1:25: Evaluate the camera; show the lowest-balance date and the specific obligation causing the shortfall.
- 1:25–1:55: Compare waiting with a cheaper demo-catalog option; explain the assumptions.
- 1:55–2:35: Choose an option, approve actual sandbox checkout, and show payment confirmation plus the updated plan.
- 2:35–2:55: State what was implemented, which data is synthetic, and the consumer-sync limitation.

Target strengths are implementation, coherent design, a specific user problem, and clear presentation. Agentic-commerce award eligibility is not guaranteed by having a chat interface; the demonstrated tool use and payment journey must support the claim.

Submission requirements to preserve: meaningful PayPal sandbox and AI integration, public GitHub source with an open-source license, a runnable application with setup instructions or demo URL, and a public YouTube video under three minutes. Keep testing access available through judging. Submission deadline: November 12, 2026 at 12:00 PM PST, equivalent to November 13 at 1:30 AM IST. Judging is December 1–15. [S9, S10]

Choose sponsor tools only when useful. AG Grid, Bryntum, or other time-limited trials must not disable the app before judging ends. The scope does not require paid sponsor dependencies.

## 10. Feasibility audit and decisions

### Current assessment

**Proceed with a sandbox prototype based on imports and user-confirmed financial context. Consumer auto-sync and native PayPal embedding remain unverified future capabilities.**

| Risk | Severity | Required response / evidence |
| --- | --- | --- |
| Consumer history API access is unavailable | High | MVP has no dependency on it. Obtain an explicit capability answer before promising automated personal-account syncing. |
| Incomplete financial picture produces a misleading positive answer | High | Require the financial-context review, surface missing coverage, and verify conservative outcome rules. |
| Funding transfers, card spending, or payment events are double counted | High | Implement the accounting boundaries and reconciliation tests in sections 4–8. |
| Waiting appears affordable only because bills fall outside the window | High | Require 30 days after each candidate date and test horizon boundaries. |
| PayPal integration feels incidental | High | Demonstrate the full purchase/approval/payment/update journey. Validate audience value; do not substitute a checkout button unrelated to the recommendation. |
| Users will not import CSVs or disclose missing context | High | Before expanding, test the flow with 3–5 target users using redacted or synthetic data; measure setup friction and whether the result changes a decision. |
| The feature duplicates existing budgeting/shopping tools | Medium | Compare 3–5 current products for purchase timing, evidence, and payment integration. No uniqueness claim until that comparison is complete. |
| AI explanations overstate certainty or contradict arithmetic | High | Give the model structured engine results, validate output amounts, and use deterministic outcome labels. |
| Prototype becomes an entire finance platform | Medium | Retain one currency, one persona type, one merchant, and the stated decision flow; cut extensions first. |

### Independent review

One independent read-only review of the initial draft was completed on October 2, 2026. It found a credible hackathon concept with three material specification gaps. The primary author checked each finding against concrete scenarios and incorporated these corrections:

| Finding | Priority | Resolution in this scope |
| --- | --- | --- |
| A future-date assessment could be reused for an immediate payment. | High | Planning results cannot authorize checkout; assess the actual purchase date again and require confirmation. Acceptance case 11. |
| A refreshed funds snapshot could double-subtract a settled payment or drop an unsettled allocation. | High | Record inclusion/exclusion per snapshot, preserve unreflected commitments, and treat ambiguity as missing information. Acceptance case 12. |
| Two distinct checkouts could both rely on the same funds despite request-level idempotency. | Medium | One active checkout per profile, with atomic assessment validation and reservation. Acceptance case 13. |

The reviewer also checked primary PayPal documentation and hackathon rules and found no contradiction in the stated SDK, webhook, access, or date constraints. This was a scope audit, not a code, security, legal, or financial-model certification. Corrections were integrated and locally checked after that single review; no second independent review was performed.

Open validation work remains: target-user interviews, competitor comparison, sandbox provisioning, CSV-format coverage, and running the acceptance cases once implementation exists. If capacity is limited, narrow automatic recurring-expense discovery to manual confirmation before cutting calculation or payment correctness.

Remaining user decisions: final name, target-user access for interviews, team/time budget, model provider, and demo hosting destination. These do not block writing the scope. Infrastructure provisioning, public publication, and implementation are not performed by this document.

## 11. Source register

Reviewed October 2, 2026. Product requirements above are proposed design decisions unless explicitly described as documented PayPal or hackathon behavior. Documentation may change; verify relevant API contracts during implementation.

- **S1 — Transaction Search access:** [PayPal's public Postman collection](https://www.postman.com/paypal/paypal-public-api-workspace/folder/ubpvppa/transaction-search).
- **S2 — Identity permissions:** [Log in with PayPal reference](https://developer.paypal.com/log-in/references).
- **S3 — User-provided history:** [PayPal activity export help](https://www.paypal.com/us/cshelp/article/how-do-i-view-and-download-statements-and-reports-help145).
- **S4 — Checkout SDK:** [Set up JavaScript SDK v6](https://developer.paypal.com/sdk/js/set-up).
- **S5 — Buyer approval and capture:** [Orders v2 capture API](https://developer.paypal.com/api/orders/v2/orders-capture).
- **S6 — App-scoped payment events and verification:** [Webhooks overview](https://developer.paypal.com/api/rest/webhooks/).
- **S7 — Reporting latency and history:** [List transactions](https://developer.paypal.com/api/transaction-search/v1/search-get).
- **S8 — Retry semantics:** [PayPal idempotency](https://developer.paypal.com/api/rest/reference/idempotency/).
- **S9 — Submission and judging requirements:** [Hackathon official rules](https://paypalaihackathon.devpost.com/rules).
- **S10 — Schedule:** [Hackathon dates](https://paypalaihackathon.devpost.com/details/dates).
- **S11 — Existing shopping direction:** [PayPal AI shopping overview](https://www.paypal.com/us/money-hub/article/how-paypal-powers-ai-shopping). This establishes adjacent functionality, not a comprehensive competitor audit.
