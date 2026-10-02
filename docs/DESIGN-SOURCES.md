# Design sources and asset credits

Verified on 2026-10-03. Worth uses established component libraries and reference-led visual patterns. Public galleries are inspiration sources; they are not assumed to be open-source asset collections. No gallery screenshot, third-party application interface, or proprietary template is bundled.

## Direction and reference audit

- [Supahero](https://supahero.io/) and its [Wise hero reference](https://supahero.io/hero/wise): inspected the published reference image. Useful patterns are oversized confident typography, generous white space, a restrained dark-green/lime palette, and a clear primary action. Worth adapts that visual hierarchy to a useful financial dashboard rather than reproducing the composition, copy, globe art, or Wise branding.
- [Kexsio animation gallery](https://kexsio.com/animations): inspected the public component listing, including “AI prompt input component,” “Floating AI Assistant Chat Widget,” “Stacked cards,” and “Animated Sliding Arrow CTA Button.” Direction: make the purchase question the obvious entry point; use short, lightweight hover/entry transitions and clear inline prompt suggestions. No component source code was copied. Respect reduced motion; avoid WebGL effects or continuous animation that distracts from financial decisions.
- [Bento Grids](https://bentogrids.com/): the public URL was checked, but its rendered gallery was not available through the text reader. Modular cards with deliberate size hierarchy remain a general layout direction, not a claim that a specific gallery design was inspected or copied.
- [Aura](https://www.aura.build/): public URL checked, with the same text-reader limitation. No Aura template or paid resource is bundled.
- Google Fonts and Iconify were user-suggested resources. Actual font and icon packages, and their respective licenses, are tracked in the project's dependency manifest and installed package metadata. This document does not imply every font or icon set uses the same license.

Product interaction should be inviting without pressuring purchases: a “wait” outcome is a successful result, saved goals are useful rather than manipulative, and checkout stays an explicit user action.

## Local image assets

The four photographs below were downloaded from Unsplash's image CDN after the corresponding photo pages explicitly identified them as free under the [Unsplash License](https://unsplash.com/license). The license permits download, modification, distribution, and commercial use; images may not be sold substantially unmodified or compiled into a competing image service. These photographs illustrate clearly labelled sample products and a sample experience. They do not establish a merchant relationship, a real offer, product specifications, destination pricing, or an endorsement by the pictured brands.

| Local file | Creator and original page | CDN source | Optimized file |
| --- | --- | --- | --- |
| `public/images/headphones.jpg` | [Petr Macháček — black headset on beige surface](https://unsplash.com/photos/black-headset-on-beige-surface-j9MV1gV0l50) | [Original photo source](https://images.unsplash.com/photo-1553775744-0bae9da7f5e7) | 800 × 519, 53,522 bytes |
| `public/images/camera.jpg` | [Indra Projects — black Canon DSLR camera on white](https://unsplash.com/photos/a-black-canon-dslr-camera-on-a-white-background-2QaZPijATks) | [Original photo source](https://images.unsplash.com/photo-1776277406354-d3e67c587d54) | 800 × 533, 29,491 bytes |
| `public/images/chair.jpg` | [Daniil Silantev — tufted white leather sofa chair](https://unsplash.com/photos/tufted-white-leather-sofa-chair-1P6AnKDw6S8) | [Original photo source](https://images.unsplash.com/photo-1567538096630-e0c55bd6374c) | 800 × 1201, 37,572 bytes |
| `public/images/weekend.jpg` | [Aleksandar Rusev — Sorrento coastline](https://unsplash.com/photos/coastal-town-with-buildings-on-cliffs-overlooking-blue-ocean-lmxPEBbYgMM) | [Original photo source](https://images.unsplash.com/photo-1768322264464-af16267f699b) | 800 × 450, 86,245 bytes |

Downloaded CDN rendition parameters: `auto=format&fit=crop&fm=jpg&q=80&w=800`. No AI alteration was applied. Combined image payload: 206,830 bytes (about 202 KiB). All assets were opened for visual inspection after download, and image type/dimensions were checked locally.

## Integration notes

- Use `/images/headphones.jpg`, `/images/camera.jpg`, `/images/chair.jpg`, and `/images/weekend.jpg` as local URLs. Local serving avoids third-party image requests during financial-data use.
- Appropriate descriptive alt text: “Black over-ear headphones,” “Black DSLR camera body,” “Ivory upholstered accent chair,” and “Coastal view of Sorrento.” The same product name is sufficient when an adjacent card already communicates the photo content.
- The headphones are wired, the camera is a DSLR body, and the chair is an accent chair. Generic catalogue copy must not describe them as wireless headphones, a mirrorless camera with a lens, or an ergonomic desk chair.
- The chair photo is portrait with its subject in the lower half. Use `object-position: 50% 70%` for a landscape card, or a contained image when the full chair matters.
- A weekend away is an illustrative savings goal. Its demo amount is not a verified cost for travel to Sorrento.
