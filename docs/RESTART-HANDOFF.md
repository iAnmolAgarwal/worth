# Worth handoff

The working app is in `/Users/anmolagarwal/paypal` and the private repository is [iAnmolAgarwal/worth](https://github.com/iAnmolAgarwal/worth). Use [README](../README.md) to run it and [BUILD](BUILD.md) for verified evidence. Continue from the implementation; do not scaffold again.

## Delivered

- Minimal responsive overview, AI purchase conversation, activity/category review, recurring commitments, wishlist, and sandbox checkout.
- Four-step financial picture: Funds → Income → Bills & subscriptions → Review. Back preserves drafts; only final confirmation saves.
- Integer-cent cash-flow forecasts with income timing, future purchase dates, cushion preservation, and a higher-spending stress case.
- Real Claude purchase answers and category proposals; consent-off local calculations and request-bound session privacy.
- Real PayPal redirect and SDK v6 approval/capture, exactly-once activity/forecast effects, and real cancellation/recovery.
- Production-browser synthetic CSV import and confirmation, category correction, mobile/tablet/desktop and keyboard checks.
- Automated checks and GitHub CI. Exact final count/revision is recorded in BUILD.

## Keep intact

Preserve the selected `claude-sonnet-5-5` model and ignored `.env`. Never expose provider keys or sandbox buyer credentials. Node 24+ and built-in SQLite keep the app light; run one server and one test worker on the 8 GB Mac. No Docker or local model is required.

The main local demo contains two verified sandbox purchases ($349 headphones and $249 weekend), leaving $252.52 purchase capacity. A later test checkout was cancelled and does not reduce that capacity. The imported production QA session used a separate local origin/database and generated sample records.

No real money moved and no goods are fulfilled. Consumer history is CSV/synthetic, not automatic access to all personal PayPal activity. External webhook delivery remains unperformed. Public deployment, making the repository public, video publication and contest submission are future steps.

[Demo script](DEMO.md) · [Architecture](ARCHITECTURE.md) · [Design credits](DESIGN-SOURCES.md)
