# ShopCore - identity usage

> Production commerce engine with integer-money accounting, atomic inventory reservation and idempotent payments.
> Audience: Full-stack developers, B2C/B2B commerce operators

## Concept
A carrier bag with a die-cut handle and a circular core aperture - the transactional core at the centre of the store.

The compact mark carries the identity alone; the primary lockup pairs it with the
'ShopCore' wordmark (Space Grotesk SemiBold, converted to outlines - no font
required to render the production files).

## Colour
| Role | Light backgrounds | Dark backgrounds |
|---|---|---|
| Structure / ink | `#0B1220` | `#F8FAFC` |
| Accent | `#2E5BFF` | `#7C9BFF` |

Single-colour reproduction: use `*-mono.svg` (all geometry set to
`currentColor`); set any colour ≥ 4.5:1 contrast against the background.
Negative space (needle, slashes, core, route) must always show the background -
never fill it with a second colour.

## Typography
Wordmark: **Space Grotesk SemiBold (600)**, SIL Open Font License 1.1
(see `../FONT-LICENSE.txt`). In delivered SVGs the letterforms are outlined
vector paths, so no font installation is ever required. Do not re-typeset the
name in another face or alter casing/spelling ('ShopCore').

## Size & clear space
- Compact mark: minimum **16 px**; verified legible at 16/32/64 px.
- Primary lockup: minimum **24 px** height (≈ 9 mm print).
- Clear space: **¼ of the mark height** on all sides of any lockup or mark.
- App icon / avatar: use `shopcore-appicon.svg` (tile `#0B1220`, radius 56/256).

## Misuse
Do not rotate, skew, add gradients/shadows/outlines, recolor outside the
palette, place the light variant on mid-tone backgrounds, or reconstruct the
mark from live text.

## Files
- `svg/shopcore-primary.svg` · `-primary-dark.svg` · `-primary-mono.svg`
- `svg/shopcore-mark.svg` · `-mark-dark.svg` · `-mark-mono.svg` · `-appicon.svg`
- `png/shopcore-mark-1024|512|256|64|32|16.png`, `shopcore-mark-dark-1024.png`,
  `shopcore-primary-light-1600.png`, `shopcore-primary-dark-1600.png`,
  `shopcore-appicon-512.png`
