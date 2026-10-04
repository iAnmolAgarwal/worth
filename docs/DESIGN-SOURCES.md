# Design sources and asset credits

Verified on 2026-10-03. No gallery screenshot, third-party application interface or proprietary template is bundled.

## Direction

Worth borrows the frame of PayPal's logged-in web and iOS app so it reads as a familiar extension of PayPal: the navy top bar, the warm canvas with a white right rail, one solid blue balance tile, flat white tiles with hairline borders, navy icon discs, pill buttons, and the floating pill tab bar on mobile. Colour, spacing, radius and motion values are PayPal's own, measured from logged-in captures or taken from PPUI tokens. The build reference is the design mock and brief in the hackathon workspace (`design/mock/index.html`, `design/brief.md`).

Worth keeps its own wordmark and a "Sample data" pill on every screen, so it is never mistaken for PayPal itself.

## Local image assets

The four product photographs come from Unsplash under the [Unsplash License](https://unsplash.com/license). It permits download, modification, distribution and commercial use, without permission or attribution (attribution is given anyway). Photos may not be sold unmodified or compiled into a competing image service; neither applies here.

Each image was checked at 2–6× zoom for brand marks before inclusion (scope C-29), cropped square and resized to 1000 × 1000. No other edits were made. The source set and its full audit, including rejected candidates, is `design/assets/LICENSES.md` in the hackathon workspace.

| Local file | Product (demo store) | Photographer | Source page | Brand-mark check |
| --- | --- | --- | --- | --- |
| `public/images/camera.jpg` | Camera | Cemrecan Yurtman (@cmrcn_) | [Unsplash](https://unsplash.com/photos/a-camera-on-a-yellow-background-with-a-black-lens-u67GBtLNt2k) | Top-down view; only control labels are visible. The maker's name is out of view. |
| `public/images/headphones.jpg` | Headphones | Andrey Matveev (@zelebb) | [Unsplash](https://unsplash.com/photos/white-headphones-with-l-and-r-indicators-on-yellow-SQrWmIvBaQQ) | Only "L" and "R" markings; plain band. |
| `public/images/chair.jpg` | Desk chair | EFFYDESK (@effydesk) | [Unsplash](https://unsplash.com/photos/an-office-chair-sitting-on-top-of-a-wooden-desk-TIOGOV5ZQzA) | No visible text or logos in the frame. |
| `public/images/weekend.jpg` | Backpack | Marina Zaharkina (@minton) | [Unsplash](https://unsplash.com/photos/a-black-leather-backpack-on-a-yellow-background-iFelMiWMuO4) | Plain leather, decorative chain clasp, no text. |

The files keep the paths the catalog in `shared/seed.ts` already uses, so the server needs no change. `weekend.jpg` now holds the backpack photo; the earlier coastline placeholder is gone.

## Fonts and icons

- **Figtree** (`@fontsource-variable/figtree`), SIL Open Font License 1.1. It stands in for PayPal Open, which is licensed only to PayPal and is not self-hosted.
- **Lucide** (`lucide-react`), ISC License.

## PayPal marks

PayPal marks appear only inside PayPal's official SDK v6 components (the PayPal button and PayPal Messages). Worth never draws a PayPal button or logo of its own.
