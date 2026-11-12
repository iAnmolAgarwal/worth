# Security

Worth is a hackathon project that runs against the **PayPal sandbox only**. It moves no real
money, ships no goods and has no user accounts. The hosted demo at https://worth.onrender.com
stores each anonymous session's plan in SQLite for 24 hours (30 days if the user opts in).

## Reporting a vulnerability

Please report privately through GitHub: **Security → Report a vulnerability** on this
repository. If that is not available, open an issue that asks for a contact without describing
the problem. Expect an answer within a few days; this is a small team, not a staffed security
programme.

In scope: the code in this repository and the hosted demo. Please do not run load or
denial-of-service tests against the hosted demo, and do not try to access other visitors'
sessions beyond what is needed to show the problem.

## What the code protects

- **Secrets** stay on the server. The browser gets only the public PayPal client ID; `.env` is
  gitignored and nothing is a `VITE_` variable.
- **Sessions** use an opaque random cookie (HttpOnly, SameSite=Lax, `__Host-` and Secure in
  production). Every read and write is scoped to the session.
- **State-changing requests** must be JSON, carry `X-Worth-Client: web`, and come from the app's
  own origin; cross-site fetches are refused. Requests, new sessions, Claude calls, Channel3
  searches and webhooks are rate-limited per client IP.
- **Payments**: prices come from the server catalog, every PayPal order is bound to its purchase
  ID and validated before use, at most one checkout is active per session, and capture needs the
  user's own confirmation in Worth. Webhooks are verified against PayPal with the raw body before
  they are read.
- **The model** has no tool that pays, captures, cancels or edits the plan. Its one action,
  preparing a checkout, runs behind the same server guards as the Buy button.
- **Connect PayPal** logs in with OAuth code + PKCE (S256) against PayPal's MCP server. The
  `state` and verifier are single-use, expire in 10 minutes and are bound to the Worth session
  that started the login; a callback from any other session is refused. The callback always
  redirects to a fixed path, so no request chooses where the browser goes. To stay connected,
  Worth keeps PayPal's refresh token for that session only: sealed with AES-256-GCM under
  `PAYPAL_TOKEN_KEY` (a fresh IV each time, the session ID as associated data) in the session
  database, which deletes it with the session; with no key it is kept in memory only and cleared
  when the session expires. Access
  tokens stay in memory for under an hour. Refreshes run one at a time and keep only the newest
  refresh token (PayPal rotates them, and does not revoke the older one, so an old one must never
  be stored). No token is written in the clear, logged, sent to the browser, exported or given to
  Claude. Disconnect PayPal (Settings), Delete my data, an expired session, or PayPal refusing the
  refresh token removes it; a refresh or read already in flight then keeps nothing and applies
  nothing. Disconnecting deletes Worth's only copy and asks PayPal to revoke it (RFC 7009, best
  effort); Worth can't guarantee PayPal honours that, and earlier tokens PayPal issued may stay
  valid there until they expire. To be sure, remove the connection in the PayPal account's
  settings. PayPal's MCP server ignores narrower scopes, so the same token could create and send
  invoices: the server calls only `list_transactions` (a hard allow-list, tested, also with
  refreshed tokens) and refuses every other tool before any request is made. Background syncs
  only add rows and plans, and drop payments PayPal shows as made and that are already due; they
  never change bills, paydays, the cushion, money available or everyday spending. Logins and reads are rate-limited per session and per IP.
- **Agent tokens** for `/mcp` are stored as SHA-256 fingerprints, bound to one plan, revocable,
  rate-limited, and grant no capture. See [docs/MCP.md](docs/MCP.md).
- **Production** sends a Content-Security-Policy that allows only the app and PayPal's SDK
  hosts (plus Channel3's image CDN), HSTS, and `frame-ancestors 'none'`.

## Known limits

- Stored data is not encrypted at rest beyond what the host provides.
- There is no account recovery; losing the cookie loses access to the plan.
- With AI sharing on, the question and a minimised plan summary are sent to Anthropic, and a
  generic product phrase and price limit are sent to Channel3; Settings lists exactly what.
