# Worth demo guide

Target: **2 minutes 45 seconds**. Show one purchase decision, one alternative, and one completed sandbox payment. Use the minimal interface and synthetic data; the financial-picture wizard supplies context without turning the demo into form entry.

## Prepare

- Run the final checks and rehearse the exact final UI. Start a fresh synthetic session with no unresolved checkout. Dates are relative to session creation; use the current on-screen values.
- Confirm Claude and PayPal modes. A local fallback must be described as local; simulated checkout is not a PayPal capture.
- Review the financial picture in four steps: **Funds → Income → Bills & subscriptions → Review**. Confirm active items, snapshot inclusion for any past app purchases, the AI-sharing choice, and the final financial picture. Back preserves drafts; Save applies the plan.
- Have a separate sandbox buyer ready. Keep credentials, `.env`, personal records, and developer dashboards out of the recording. Any authentication-time edit should be a clear transition between genuine steps.
- Use the verified **SDK v6 popup path** and show the approval notice before clicking Worth's separate capture confirmation. Approval alone must not appear as completed payment. Rehearse once in the exact recording session.

## 2:45 script

| Time | Action | Narration |
| --- | --- | --- |
| 0:00–0:15 | Open Worth with the synthetic-data label visible. | “Your balance does not tell you what is already spoken for. Worth helps you see what a purchase means for the rest of your month.” |
| 0:15–0:38 | Briefly show the four financial-picture steps and confirmed summary. | “Alex confirms available funds, everyday spending, income, subscriptions, and a cash cushion—including commitments outside PayPal. History reveals patterns; it cannot supply the whole financial picture.” |
| 0:38–1:05 | Ask: “Can I afford a $1,199 camera today?” Show its low point and date. | “Claude understands the question and calls a deterministic cash-flow tool. This camera would cross Alex's cushion before payday. Worth shows the amount, the timing, and the assumptions.” |
| 1:05–1:25 | Compare the later date; briefly reveal the stress case. | “Waiting changes the plan. We forecast a full month after the proposed purchase, so the next round of bills stays in view. We also show the effect of higher everyday spending.” |
| 1:25–1:43 | Assess the $349 Studio headphones and review buying today. | “A smaller purchase fits these confirmed inputs. Checkout checks today again, even if the previous scenario used a future date.” |
| 1:43–2:20 | Continue to PayPal sandbox, approve as buyer, then explicitly confirm payment in Worth. | “Alex controls the payment. The agent cannot spend. PayPal handles buyer approval; Worth captures only after this separate confirmation.” |
| 2:20–2:35 | Show the single activity entry and changed purchase capacity. | “The completed payment is accounted for once. There is now less room for another purchase, and the plan immediately reflects that.” |
| 2:35–2:45 | Return to the question/overview. | “Worth turns spending history and upcoming commitments into a decision you can understand. This is independent software using CSV history, Claude, and PayPal sandbox.” |

A recommendation to wait is a successful result. Keep the cushion and commitments intact rather than adjusting them to make a purchase fit.

## Evidence and numbers

A real UI session exercised the Claude Sonnet 5.5 camera answer and both PayPal paths. The **$349 headphones** used the approval redirect; one captured expense changed purchase capacity from **$850.52 to $501.52**. The **$249 “A weekend away”** used the SDK v6 popup. After buyer approval the UI showed its approval notice while the purchase remained `CREATED` with no capture. Explicit confirmation changed it to `COMPLETED`; Activity showed exactly one matching row and capacity became **$252.52**. External webhook delivery and real cancellation were not part of those checks.

The four-step editor was checked on desktop and at 390 px mobile width. A draft funds change survived Continue/Back, Enter did not submit the plan, and completed purchases stayed unchecked when their costs were not already deducted from the $4,200 snapshot. Saving the restored financial picture preserved the $252.52 capacity. Keep those inclusion semantics in the recording.

The fixed October 3, 2026 synthetic fixture starts with **$4,200**, a **$1,000 cushion**, and **$39/day** spending. Headphones reach **$1,501.52**; the camera reaches **$651.52** and first fits **October 16**. These are fixture values, not real-user predictions. Check the actual recording session before narrating any number.

## Final recording/submission checks

- [ ] Final minimal UI, four-step editor, and SDK path rehearsed on the final build.
- [ ] Real AI and payment modes visible; buyer approval and explicit capture shown.
- [ ] Single completed expense and updated forecast verified in the recorded session.
- [ ] No credentials or personal records in the footage; runtime under three minutes.
- [ ] Repository visibility, hosted demo access, and public video meet current contest requirements before submission.

The app is not deployed and a public hackathon submission has not been published. A private source push does not satisfy the public-source/video requirements by itself. Keep external publication separate from local verification.
