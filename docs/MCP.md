# Worth over MCP: the affordability check an agent must pass before paying

Worth runs a [Model Context Protocol](https://modelcontextprotocol.io) server. Any MCP client can ask it whether the person can afford a purchase, read their saved plans, and prepare a PayPal order that **the person approves themselves**. No agent can pay through Worth: there is no capture tool, and every payment still needs the person's approval in PayPal and their confirmation in Worth.

- **Transport:** Streamable HTTP at `/mcp` on the Worth server (stateless mode), plus a stdio relay (`server/mcpStdio.ts`) for clients that launch a local process.
- **SDK:** `@modelcontextprotocol/sdk` 1.32.0 (`McpServer`, `registerTool` with zod schemas, `StreamableHTTPServerTransport` with `sessionIdGenerator: undefined`, `StdioServerTransport`).
- **No model calls:** the MCP tools are pure engine. Worth makes no Anthropic call on this path, so there is no Claude cost to Worth (a test asserts this).

## Two use cases

**1. Bring your own AI.** Someone with a Claude Desktop subscription (or any MCP client) connects it to their Worth plan and asks "Can I afford the $1,199 camera?" in their own assistant. Their model writes the reply; Worth supplies every number. Each result carries a ready-to-quote `summary` rendered by Worth's own templates (the same wording the app uses), with `source: "Worth engine"` and the `as_of` date. The tool descriptions tell the model to quote it and never recompute or round.

**2. A guardrail for shopping agents.** An agent that shops and checks out for someone calls `check_affordability` before it buys. If the person still wants to buy, the agent calls `prepare_order`, which runs the same checkout guards as Worth's own Buy button. It returns a PayPal approval link for the human and never captures. Going ahead below the cushion needs an explicit `acknowledge_below_cushion: true`, and the person confirms that again in Worth before any payment.

## Setup

### 1. Create an agent token

In Worth, open **Settings → Connect an agent → Create agent token**. Copy the token (`wrth_…`) and the Claude Desktop config right away: Worth stores only a SHA-256 fingerprint, so it cannot show the token again.

A token ends after 30 days, when you revoke it, or when the plan is deleted, whichever comes first. A plan is deleted after 24 hours unless **Keep my plan on this device for 30 days** is on (Settings → Data), so turn that on for a link that lasts.

### 2a. Claude Desktop with the hosted app (remote HTTP)

Claude Desktop launches local commands, so a remote server is reached through the [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) bridge. Settings gives you this snippet with your token filled in:

```json
{
  "mcpServers": {
    "worth": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@0.14.3",
        "https://worth.onrender.com/mcp",
        "--transport",
        "http-only",
        "--header",
        "Authorization:${WORTH_AUTH}"
      ],
      "env": { "WORTH_AUTH": "Bearer wrth_…" }
    }
  }
}
```

1. Install Node.js 20 or later (for `npx`; mcp-remote 0.14 needs Node 20).
2. In Claude Desktop, open **Settings → Developer → Edit Config**. This opens `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS (`%APPDATA%\Claude\claude_desktop_config.json` on Windows).
3. Merge the `worth` entry into `mcpServers` (do not paste the whole snippet inside `mcpServers`; if the file is empty, use the whole snippet), save, and quit and reopen Claude Desktop.
4. In a new chat, check that **worth** and its three tools appear under the tools (hammer) menu, then ask: "Can I afford the $1,199 camera?"

Notes:

- If Claude Desktop says it cannot find `npx`, use its absolute path as `command` (run `which npx`; with Homebrew it is `/opt/homebrew/bin/npx`).
- `Authorization:${WORTH_AUTH}` has no space after the colon on purpose; mcp-remote fills it in from `env`. That works around hosts that mangle spaces in arguments.
- For a local server (`http://localhost:…/mcp`), Settings adds `--allow-http`.
- The bridge carries the token, so the snippet pins it exactly (`mcp-remote@0.14.3`).

### 2b. Claude Desktop with Worth running from source (local stdio)

The stdio relay forwards to a Worth server, local or hosted. It holds no financial data and no PayPal or Anthropic keys, only the agent token.

```json
{
  "mcpServers": {
    "worth": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/absolute/path/to/worth/server/mcpStdio.ts"],
      "env": {
        "WORTH_MCP_URL": "http://localhost:5173/mcp",
        "WORTH_MCP_TOKEN": "wrth_…"
      }
    }
  }
}
```

Node 23.6 or later runs the TypeScript file directly. Use the absolute path to `node` (`which node`). Start Worth first (`npm run dev`), create the token in that instance's Settings, and point `WORTH_MCP_URL` at it. `WORTH_MCP_URL` must be `https://` unless it points at this computer. Run it in a terminal with `npm run mcp:stdio`; launch it directly with `node` from MCP clients, because npm prints a banner to stdout.

### 2c. MCP Inspector or any other client

```bash
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP · URL: http://localhost:5173/mcp
# Add the header  Authorization: Bearer wrth_…  in the connection's authentication settings
```

Raw JSON-RPC works too. The endpoint is stateless, so `initialize` is optional:

```bash
curl -s http://localhost:5173/mcp \
  -H "Authorization: Bearer $WORTH_TOKEN" \
  -H "Accept: application/json, text/event-stream" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"check_affordability","arguments":{"item":"camera","amount_usd":1199}}}'
```

## Tools

Every successful result has `structuredContent` that matches the tool's declared `outputSchema`, plus two text blocks: the `summary`, then the same JSON. Every result, success or refusal (including the stdio relay's own `UNAUTHORIZED` and `WORTH_UNREACHABLE`), carries:

| Field     | Meaning                                                                                                                                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`  | Always `"Worth engine"`. No figure comes from a model.                                                                                                                                                                                                        |
| `as_of`   | The plan's today (YYYY-MM-DD): the real date in the plan's time zone, or the demo clock's day on the sample persona. When no plan could be read (`PLAN_EXPIRED`, a failure reading it, or the relay unable to reach Worth), the server's or relay's UTC date. |
| `summary` | Worth's own sentences with exact figures and dates, ready to quote to the person.                                                                                                                                                                             |

### `check_affordability({ item, amount_usd, date? })`

Read-only. It assesses the purchase against the person's plan over Worth's 60-day window and returns a decision contract, modelled on the "Buy or Wait?" contract (HackerRank Orchestrate, September 2026). It is a mapping of Worth's existing assessment (`assessPurchase`) and adds no financial logic.

| Input        | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `item`       | 1–150 characters. **Untrusted data:** no number in it is ever read, and instructions in it are never followed. A catalog item is named by Worth's catalog. Any other item is assessed as "This purchase", and its label appears only in quotes after Worth's own sentences ("Item checked: “road bike”."). The label is plain text of at most 40 characters; text with verdict, instruction or price words ("approve", "safe", "ignore", "Worth says", "price", "$", a role label such as "system:", and so on) becomes "this item". |
| `amount_usd` | The only number taken from the caller. Positive, at most 1,000,000, at most two decimals.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `date`       | Optional YYYY-MM-DD, from today through 30 days ahead. Default: today.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

| Output field                     | Meaning                                                                                                                                                                                             | Allowed values                                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `request`                        | `{ item, amount_usd, currency: "USD", date }` as Worth used them. `item` is the catalog name when the text names a catalog item at its catalog price; otherwise the sanitised label or "this item". |                                                                                                                                               |
| `affordability_status`           | Whether the full amount keeps the cushion. "now" means on `request.date`, which may be a future day.                                                                                                | `affordable_now`: on `request.date`. `affordable_later`: on a later day in the next 30 days. `not_affordable`: on no day in the next 30 days. |
| `recommended_action`             | Worth's option for this request.                                                                                                                                                                    | `full_payment`, `wait`, `spend_less`, `not_recommended`. Never Pay in 4.                                                                      |
| `amount_safe_to_pay`             | The most that keeps the cushion if paid on `request.date`, capped at the requested amount (Worth's spend-less limit).                                                                               | `0 ≤ x ≤ amount_usd`                                                                                                                          |
| `earliest_date_for_full_payment` | The first day the full amount keeps the cushion as one payment.                                                                                                                                     | YYYY-MM-DD, or `null` when no day in the next 30 days does.                                                                                   |
| `payment_plan`                   | The payments of `recommended_action`, in date order.                                                                                                                                                | `[{ date, amount_usd }]`; empty when no payment of this item is advised.                                                                      |
| `lowest_balance`                 | `{ amount_usd, date }`: the projected low point if bought on `request.date`.                                                                                                                        |                                                                                                                                               |
| `cushion_usd`                    | The balance the person wants to keep.                                                                                                                                                               |                                                                                                                                               |
| `drivers`                        | The bill behind the low point (`low_point_cause`) and the next payday (`next_income`), when present.                                                                                                | `[{ role, name, date, amount_usd, kind }]`                                                                                                    |
| `explanation`                    | Worth's decision sentences (template verdict, low point, cause).                                                                                                                                    |                                                                                                                                               |
| `pay_in_4_comparison`            | PayPal Pay in 4 as an illustrative comparison: payments, the bills each lands near (`collisions`), and the cushion label. **Never recommended.**                                                    | `recommended: false`; `eligibility`: `paypal`, `range-only` or `unavailable`.                                                                 |
| `facts`                          | Worth's fact sentences (the same ones Ask Worth uses).                                                                                                                                              |                                                                                                                                               |
| `catalog_item_id`                | Set when the item is in Worth's sandbox catalog, so `prepare_order` can be called.                                                                                                                  |                                                                                                                                               |
| `guards`                         | The checks behind the answer, in the app's trace vocabulary.                                                                                                                                        |                                                                                                                                               |
| `next_step`                      | What an agent may do next, without recommending.                                                                                                                                                    |                                                                                                                                               |

How Worth's outcome maps to the contract:

| Worth's assessment on `request.date`    | Status             | Action            | Earliest       | Plan                          |
| --------------------------------------- | ------------------ | ----------------- | -------------- | ----------------------------- |
| Fits                                    | `affordable_now`   | `full_payment`    | `request.date` | one payment on `request.date` |
| Tight; a later day in 30 fits           | `affordable_later` | `wait`            | that day       | one payment on that day       |
| Tight; no day fits; some amount is safe | `not_affordable`   | `spend_less`      | `null`         | empty                         |
| Tight; no day fits; nothing is safe     | `not_affordable`   | `not_recommended` | `null`         | empty                         |

`affordable_with_plan` from the original contract is never returned. Worth has no safe partial or instalment plan, and Pay in 4 never makes a purchase "fit".

**Invariants checked in code before every answer** (`checkDecision` in `server/mcpDecision.ts`). A decision that fails any of them is never sent; the tool refuses with `INCOHERENT_RESULT`.

- `0 ≤ amount_safe_to_pay ≤ amount_usd`, in whole cents.
- `affordable_now` ⇒ `full_payment`, earliest = `request.date`, one payment of the full amount on that date, safe = requested, low point ≥ cushion.
- `affordable_later` ⇒ `wait`, request.date < earliest ≤ today + 30, one payment of the full amount on the earliest date, safe < requested, low point < cushion.
- `not_affordable` ⇒ `spend_less` exactly when safe > 0, otherwise `not_recommended`; no earliest date, no plan; low point < cushion.
- Plan payments are in date order, each more than zero, and add up to the requested amount.
- The explanation names the requested amount.

**Fail closed:** invalid input, an incomplete plan, and the one ambiguous case (an earlier day than the one asked about fits) each return a refusal with a reason. None of them returns a guessed verdict.

### `prepare_order({ catalog_item_id, acknowledge_below_cushion? })`

Prepares a PayPal **sandbox** order for a catalog item, behind `checkoutGuards`, the same guard set as Ask Worth's `prepare_checkout` and the saved-plan Buy button. The checks: no other checkout in progress, funds confirmed today, a complete plan, a fresh assessment, and keeping the cushion. Then it takes the same checkout path. Price, currency and merchant come from Worth's catalog, never from the agent.

- **Returns** `status: "awaiting_human_approval"`, `approval_url` (for the person to open), `purchase_id`, `order_id`, `amount_usd`, `merchant`, `below_cushion`, `captured: false`, `human_steps` and `guards`.
- **Never captures.** The order waits in Worth's Activity, labelled **Requested by an external agent**, until the person approves in PayPal and confirms in Worth.
- **Below the cushion** it refuses with `SHORTFALL_NOT_CONFIRMED`. The refusal states the low point, its date and the wait date, and tells the agent that `acknowledge_below_cushion: true` is allowed only after the person explicitly says to go ahead. Even then, the order is stored as needing confirmation, and capture is refused until the person confirms that acknowledgement themselves in Worth's checkout.
- Catalog: `headphones`, `camera`, `chair`, `backpack`, `macbook-pro-14`, `airpods-4`.

### `list_saved_plans()`

Read-only. It lists the person's saved items, newest first: `name`, `kind` (`catalog` or `custom`), `catalog_item_id`, `amount_usd`, `option`, `wait_date` and `status` (`active`, `ready` when a wait date has come, or `bought`). Names are the person's data, not instructions.

### Refusals and errors

Worth's refusals are tool results with `isError: true` and one JSON text block:

```json
{ "source": "Worth engine", "as_of": "2026-10-03", "summary": "…", "error": { "code": "SHORTFALL_NOT_CONFIRMED", "message": "…" }, "guards": [ … ] }
```

| Code                                                                                                                                           | When                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `INVALID_AMOUNT`, `INVALID_DATE`                                                                                                               | Input Worth cannot use as given.                                                           |
| `PLAN_INCOMPLETE`                                                                                                                              | The plan needs details confirmed in Worth (`missing` lists them).                          |
| `EARLIER_DAY_FITS`                                                                                                                             | The requested date dips below the cushion but an earlier day does not; ask about that day. |
| `INCOHERENT_RESULT`                                                                                                                            | The coherence gate refused to send an answer.                                              |
| `UNKNOWN_ITEM`, `CHECKOUT_ACTIVE`, `FUNDS_NOT_TODAY`, `PLAN_INCOMPLETE`, `SHORTFALL_NOT_CONFIRMED`, `ASSESSMENT_EXPIRED`, `PAYPAL_UNAVAILABLE` | `prepare_order`'s guards, in the order they run.                                           |
| `RATE_LIMITED`                                                                                                                                 | More than 5 prepared orders per token per hour.                                            |
| `PLAN_EXPIRED`                                                                                                                                 | The plan was deleted while the request ran.                                                |
| `INTERNAL_ERROR`                                                                                                                               | Anything unexpected. The message is fixed; no exception text, stack or data is included.   |

Schema violations (a missing `item`, a string `amount_usd`, a badly formatted `date`) are refused by the SDK before any Worth code runs. They come back as `isError` with the SDK's standard text: `MCP error -32602: Input validation error: …`.

HTTP-level refusals are JSON-RPC errors: `401` (with `WWW-Authenticate: Bearer`) for a missing, unknown, revoked or expired token; `403` for a request from another website's page; `429` (with `Retry-After`) for rate limits; `405` for GET or DELETE; `413` with `-32600` and `data.code: "REQUEST_TOO_LARGE"` for a body over 32 KB; `400` with `-32700` and `data.code: "INVALID_JSON"` for a body that is not JSON.

## Security model

- **Bearer tokens only.** `/mcp` reads only the `Authorization` header. It is mounted outside `/api`, so it never reads or sets the session cookie: a cookie alone is refused, and no response sets one. Browser CSRF does not apply, because the token is never sent automatically.
- **Tokens:** `wrth_` + 32 random bytes (base64url). Only the SHA-256 hash and the last four characters are stored (`agent_tokens` table). Each token is bound to one session's plan, which is the synthetic persona or the person's imported data. Revocable in Settings, and capped at 3 active per plan. It expires at the earlier of 30 days and the plan's own expiry. Deleting the data removes its tokens (`ON DELETE CASCADE`). Creating or revoking a token goes through the app's existing CSRF checks.
- **Scope:** every tool reads only the token's own plan. Another session cannot list or revoke the token. Nothing in a result comes from another plan.
- **Origin check:** a request with an `Origin` header from another site is refused (`403`). This protects against DNS rebinding of a local server and against web pages holding a stolen token. CORS preflights get `405`.
- **Rate limits** (all keyed by `req.ip`, which honours `TRUST_PROXY`). On Render, `TRUST_PROXY=2` was verified on Oct 3: the first request after a deploy logged 2 `X-Forwarded-For` hops (fixed in PR #6), so `req.ip` is the client, not a forwarded value it chose.
  - 120 requests per IP per minute, counted before the token is read (`MCP_IP_PER_MINUTE`);
  - 20 failed token checks per IP per 15 minutes, after which that IP is refused even with a valid token;
  - 30 requests per token per minute (`MCP_TOKEN_PER_MINUTE`);
  - 5 `prepare_order` calls per token per hour (`MCP_PREPARE_HOURLY`);
  - 10 token creations per plan per hour.
- **No capture path.** No tool can pay. `prepare_order` creates an order and stops. Capture stays on the cookie-authenticated `/api/checkout/:id/capture` route, which still requires PayPal approval, a fresh plan, and the shortfall acknowledgement for below-cushion orders.
- **Untrusted input.** Item text and saved names are labels, and no figure is read from them. They never start or speak in Worth's quotable `summary`: a catalog item is named by the catalog; anything else is "This purchase", with its sanitised label only in quotes after Worth's sentences, or "this item" when the text reads like a verdict, an instruction or a price. The tool descriptions and server instructions tell agents to treat them as data.
- **Token lookup** is by its SHA-256 hash through a unique index, not a constant-time compare. With 256-bit random tokens, timing can at most reveal a prefix of a stored hash, which does not help find a token.
- **Nothing leaks.** Errors carry fixed codes and sentences written for people. Logs record the error class only. Results never include credentials, PayPal payer data or identifiers other than the purchase, order and saved-item IDs the agent needs.
- **Bodies** on `/mcp` are limited to 32 KB. Responses are `Cache-Control: no-store`, and the existing security headers and CSP apply.

## Example transcript (abridged)

The full recorded run is in `workspace/review/mcp/demo.md`. It used the sample persona on the video demo clock and the real PayPal sandbox.

> **Person:** Buy me the $1,199 camera.
>
> **Agent** → `check_affordability({"item":"camera","amount_usd":1199})`
>
> **Worth:** `affordable_later` · `wait` · earliest `2026-10-23` · safe today `$440.01` · low point `-$458.99` on **Thu, Oct 22** (paying in full). Summary: "Everyday camera at $1,199 would dip below your cushion if you buy it today. The earliest date that fits is Fri, Oct 23. The most you could spend today and keep your cushion is $440.01. … Apartment rent ($1,450) is due Fri, Oct 16, before that low point. If you compared PayPal Pay in 4 (illustrative): … payment 2 would land about 1 day after your apartment rent …"
>
> **Agent:** quotes the summary and asks whether to wait until Fri, Oct 23.
>
> (`pay_in_4_comparison.label` says "An instalment would dip below your cushion on Oct 21". That date belongs only to the Pay in 4 comparison. The full-payment low point is Thu, Oct 22. Video captions and voice-over should quote Worth's summary: "lowest −$458.99 on Thu, Oct 22 … the earliest date that fits is Fri, Oct 23". They should not say Oct 21.)
>
> **Person:** Prepare it anyway.
>
> **Agent** → `prepare_order({"catalog_item_id":"camera"})` → `SHORTFALL_NOT_CONFIRMED`: "Worth did not prepare the order. Buying the everyday camera today ($1,199) would dip below your $300 cushion …"
>
> **Agent** (the person already said "anyway") → `prepare_order({"catalog_item_id":"camera","acknowledge_below_cushion":true})`
>
> **Worth:** `awaiting_human_approval`, `captured: false`, `approval_url: https://www.sandbox.paypal.com/checkoutnow?token=…`. Summary: "Worth prepared a PayPal sandbox order for the everyday camera at $1,199 from Larkspur Supply. Nothing has been paid. … Open this link to review and approve it in PayPal … Then confirm the payment in Worth."
>
> **Person** approves in PayPal. In Worth, Activity shows the order as **Requested by an external agent**. Worth asks them to confirm going below the cushion before it captures.

## Limits

- PayPal **sandbox** only, and the six-item demo catalog. `check_affordability` works for any item; `prepare_order` works only for catalog items.
- The approval link returns to Worth in the browser that holds the plan's session. Approving from another browser works in PayPal, but the person confirms in the browser where the plan lives.
- No OAuth. Remote clients that require OAuth for custom connectors (rather than a header) need the `mcp-remote` bridge above.
- When a token is revoked mid-session, mcp-remote reacts to the `401` by trying OAuth discovery, and shows "Dynamic Client Registration rejected (HTTP 404)". The stdio relay shows Worth's own `UNAUTHORIZED` message instead.
