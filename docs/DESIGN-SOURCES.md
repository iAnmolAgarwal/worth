# Design sources and asset credits

Verified on 2026-10-03. No gallery screenshot, third-party application interface or proprietary template is bundled.

## Direction

Worth borrows the frame of PayPal's logged-in web and iOS app so it reads as a familiar extension of PayPal: the navy top bar, the warm canvas with a white right rail, one solid blue balance tile, flat white tiles with hairline borders, navy icon discs, pill buttons, and the floating pill tab bar on mobile. Colour, spacing, radius and motion values are PayPal's own, measured from logged-in captures or taken from PPUI tokens.

Worth keeps its own wordmark and a "Sample data" pill on every screen, so it is never mistaken for PayPal itself.

## Local image assets

The four original product photographs come from Unsplash under the [Unsplash License](https://unsplash.com/license). It permits download, modification, distribution and commercial use, without permission or attribution (attribution is given anyway). Photos may not be sold unmodified or compiled into a competing image service; neither applies here.

Each image was checked at 2–6× zoom for brand marks before inclusion, cropped square and resized to 1000 × 1000. No other edits were made.

| Local file | Product (demo store) | Photographer | Source page | Brand-mark check |
| --- | --- | --- | --- | --- |
| `public/images/camera.jpg` | Camera | Cemrecan Yurtman (@cmrcn_) | [Unsplash](https://unsplash.com/photos/a-camera-on-a-yellow-background-with-a-black-lens-u67GBtLNt2k) | Top-down view; only control labels are visible. The maker's name is out of view. |
| `public/images/headphones.jpg` | Headphones | Andrey Matveev (@zelebb) | [Unsplash](https://unsplash.com/photos/white-headphones-with-l-and-r-indicators-on-yellow-SQrWmIvBaQQ) | Only "L" and "R" markings; plain band. |
| `public/images/chair.jpg` | Desk chair | EFFYDESK (@effydesk) | [Unsplash](https://unsplash.com/photos/an-office-chair-sitting-on-top-of-a-wooden-desk-TIOGOV5ZQzA) | No visible text or logos in the frame. |
| `public/images/weekend.jpg` | Backpack | Marina Zaharkina (@minton) | [Unsplash](https://unsplash.com/photos/a-black-leather-backpack-on-a-yellow-background-iFelMiWMuO4) | Plain leather, decorative chain clasp, no text. |

The files keep the paths the catalog in `shared/seed.ts` already uses, so the server needs no change. `weekend.jpg` now holds the backpack photo; the earlier coastline placeholder is gone.

### Real-brand catalog items

The demo store lists two real products under its own name, Larkspur Supply (demo store); it never presents itself as the brand, and their photos show no brand mark. Both photos come from Unsplash under the [Unsplash License](https://unsplash.com/license) (free photos, not Unsplash+), were viewed in full before inclusion, and were downloaded on 2026-10-04.

| Local file | Product (demo store) | Photographer | Source page | Edits | Brand-mark check |
| --- | --- | --- | --- | --- | --- |
| `public/images/laptop.jpg` | MacBook Pro 14-inch | Fer Troulik (@fertroulik) | [Unsplash](https://unsplash.com/photos/closed-silver-laptop-on-a-yellow-background-R5z9feBGJ3g) | Resized to 1000 wide; padded to 1000 × 1000 by mirroring and blurring the plain yellow background above and below | Closed lid seen edge-on from the front: no Apple mark, no text. A candidate showing an "intel" sticker was rejected. |
| `public/images/earbuds.jpg` | AirPods 4 | Khoa Nguyen (@mkhoa0201) | [Unsplash](https://unsplash.com/photos/white-apple-airpods-charging-case-GuDLzQ7UoF0) | Resized to 1000 × 1000 | Plain white case and earbuds; the case carries no logo or text in this view. |

Product names ("MacBook Pro 14-inch", "AirPods 4") are used only to name the item, as a retailer would. They appear in text, never as a logo.

## Fonts and icons

- **Figtree** (`@fontsource-variable/figtree`), SIL Open Font License 1.1. It stands in for PayPal Open, which is licensed only to PayPal and is not self-hosted.
- **Lucide** (`lucide-react`), ISC License.

## PayPal marks

PayPal marks appear only inside PayPal's official SDK v6 components (the PayPal button and PayPal Messages). Worth never draws a PayPal button or logo of its own.
