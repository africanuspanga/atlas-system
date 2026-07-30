# ATLAS Design System

ATLAS reads like an institutional platform that happens to run schools — quiet,
white-canvas, editorially spaced, almost monochromatic. The single brand voltage
is **Atlas Blue** (`#0052ff`), used scarcely: primary CTA pills, the wordmark,
and inline emphasis links. Beyond that one blue, the system is white canvas +
ink + soft gray elevation bands + a deep near-black canvas (`#0a0b0d`) for
full-bleed dark bands.

This document is the source of truth for the web app's visual language. The
tokens below are implemented as CSS variables in
`apps/web/src/app/globals.css` (shadcn/ui + Tailwind v4 `@theme`).

**Key characteristics**

- Single accent color: Atlas Blue `#0052ff` carries every primary CTA, the
  wordmark, and inline brand links. Used scarcely — one or two blue moments per
  band.
- Modest display weights — headlines at weight 400, never 700+. Signals calm
  institutional trust, not dashboard urgency.
- Pill geometry: every CTA is fully rounded (pill), every avatar/icon plate is
  a circle, cards are 24px radius, inputs 12px. Sharp corners absent.
- Financial semantics: gain `#05b169` and loss `#cf202f` — **text color only,
  never background fills, never buttons**.
- Generous editorial pacing — 96px between major bands on marketing surfaces;
  density lives behind the login wall.

## Colors

### Brand & accent

| Token | Hex | CSS var | Use |
|---|---|---|---|
| Atlas Blue | `#0052ff` | `--primary` | Primary CTA pills, wordmark, inline brand links |
| Atlas Blue Active | `#003ecc` | — (press-state darken) | Pressed primary pill |
| Atlas Blue Disabled | `#a8b8cc` | — (or `--primary` @ 50%) | Disabled CTAs |
| Accent Yellow | `#f4b000` | `--chart-3` | Illustrative-only glyph fills; never an action color |

### Surfaces

| Token | Hex | CSS var | Use |
|---|---|---|---|
| Canvas | `#ffffff` | `--background`, `--card` | Default page floor and cards |
| Surface Soft | `#f7f7f7` | `--muted` | Subtle alternating bands, table stripes |
| Surface Strong | `#eef0f3` | `--secondary`, `--accent` | Secondary buttons, search pills, icon plates |
| Surface Dark | `#0a0b0d` | `--background` (dark mode) | Full-bleed dark bands; same hex as ink |
| Surface Dark Elevated | `#16181c` | `--card` (dark mode) | Floating cards inside dark bands |

### Hairlines

| Token | Hex | CSS var |
|---|---|---|
| Hairline | `#dee1e6` | `--border`, `--input` |
| Hairline Soft | `#eef0f3` | — (same hex as Surface Strong) |

### Text

| Token | Hex | CSS var | Use |
|---|---|---|---|
| Ink | `#0a0b0d` | `--foreground` | Headings, primary nav, body emphasis |
| Body | `#5b616e` | `--muted-foreground` | Default running text — slightly cool gray |
| Muted | `#7c828a` | — | Sub-titles, breadcrumbs, footer secondary |
| Muted Soft | `#a8acb3` | `--muted-foreground` (dark mode) | Disabled links; secondary text on dark |
| On Primary / On Dark | `#ffffff` | `--primary-foreground` | Text on Atlas Blue and dark canvases |

### Financial semantics

| Token | Hex | CSS var | Use |
|---|---|---|---|
| Gain | `#05b169` | `--up` (`text-up`) | Paid, credit, positive change — text only |
| Loss | `#cf202f` | `--down` (`text-down`), `--destructive` | Overdue, debit, negative change — text only |

Never use gain/loss as a button or badge background fill.

## Typography

### Families

- **Sans (display + body): Inter** — display headlines at weight 400 with
  negative tracking; body at 400/600.
- **Mono (numbers): JetBrains Mono** at weight 500 — every tabular numerical
  value (amounts, balances, percentages, admission numbers in tables) renders
  in mono via `font-mono`.

Loaded through `next/font` in `apps/web/src/app/layout.tsx`; mapped to
`--font-sans` / `--font-mono` in `globals.css`.

### Hierarchy

| Token | Size | Weight | Line height | Tracking | Use |
|---|---|---|---|---|---|
| display-mega | 80px | 400 | 1.0 | -2px | Marketing hero h1 |
| display-xl | 64px | 400 | 1.0 | -1.6px | Subsidiary heroes |
| display-lg | 52px | 400 | 1.0 | -1.3px | Section heads |
| display-md | 44px | 400 | 1.09 | -1px | CTA-band headlines |
| display-sm | 36px | 400 | 1.11 | -0.5px | Sub-section heads |
| title-lg | 32px | 400 | 1.13 | -0.4px | Card group titles |
| title-md | 18px | 600 | 1.33 | 0 | Component titles, row primary |
| title-sm | 16px | 600 | 1.25 | 0 | List labels |
| body-md | 16px | 400 | 1.5 | 0 | Default body |
| body-strong | 16px | 700 | 1.5 | 0 | Emphasized body |
| body-sm | 14px | 400 | 1.5 | 0 | Secondary body, footer |
| caption | 13px | 400 | 1.5 | 0 | Captions |
| caption-strong | 12px | 600 | 1.5 | 0 | Badge pill labels |
| number-display | 18px | 500 | 1.4 | 0 | Amounts, changes — JetBrains Mono |
| button | 16px | 600 | 1.15 | 0 | CTA pill label |
| nav-link | 14px | 500 | 1.4 | 0 | Nav menu items |

### Principles

- **Display weight stays at 400.** The most distinctive typographic choice —
  don't bold headlines.
- **Negative letter-spacing on display only** (-1px to -2px); body stays at 0.
- **Mono on every number.** Anything tabular renders in JetBrains Mono.

## Layout

- **Base unit:** 4px. Scale: 4 / 8 / 12 / 16 / 20 / 24 / 32 / 48 / 96.
- **Section padding:** 96px vertical for major editorial bands (marketing);
  in-app pages use 24–32px.
- **Card internal padding:** 32px on feature/marketing cards; in-app cards may
  compress to 16–24px.
- **Max content width:** ~1200px centered; heroes full-bleed.
- **Grids:** 2-up for hero splits, 3-up for benefit grids, 6-column footer.

Whitespace philosophy: closer to a financial-newspaper editorial page than a
dashboard. Density lives behind login walls, not on marketing surfaces.

## Elevation & depth

| Level | Treatment | Use |
|---|---|---|
| Flat | No shadow, no border | 80% of surfaces |
| Hairline border | 1px `#dee1e6` | Card outlines on white |
| Soft drop | `0 4px 12px rgba(0,0,0,0.04)` | Single shadow tier — hovered cards only |

One shadow tier. Do not add more. Layered dark UI-mockup cards (a `#16181c`
card floating on `#0a0b0d`, sometimes a second card overlapping at a slight
angle) are the signature decorative depth pattern for dark hero bands.

## Shapes

| Token | Value | Tailwind | Use |
|---|---|---|---|
| xs | 4px | `rounded-xs` | Inline tags |
| sm | 8px | `rounded-sm` | Compact rows |
| md | 12px | `rounded-lg` (`--radius`) | Form inputs |
| xl | 24px | `rounded-xl` | Cards, mockups, pricing tiers |
| pill | 100px | `rounded-full` | **All buttons**, search pills, badges |
| full | 9999px | `rounded-full` | Avatars, icon circles |

Pill for interactive, 24px for containers, circle for icons. Sharp corners
absent.

## Components

- **Primary button** — Atlas Blue pill: `bg-primary text-primary-foreground`,
  16px/600 label, 44px height (56px for hero CTAs), fully rounded. Press state
  darkens toward `#003ecc`.
- **Secondary button** — soft-gray pill: `bg-secondary text-secondary-foreground`
  (`#eef0f3` / ink). On dark bands: `#16181c` fill or transparent with a 1px
  white outline.
- **Tertiary/link** — transparent, Atlas Blue text.
- **Cards** — white, 24px radius, 1px hairline or flat; 32px padding on
  feature cards. Dark variant `#16181c` on `#0a0b0d`.
- **Inputs** — white, 12px radius, 48px height, 1px hairline; focus = 2px Atlas
  Blue border (implemented as `ring` in blue).
- **Search pill** — `#eef0f3` fill, fully rounded, 44px height.
- **Badges** — small uppercase pills, `#eef0f3` fill, ink text, 12px/600.
- **Data rows** (fees, ledgers, results) — transparent rows with 1px hairline
  dividers; 32px circular icon plate (`#eef0f3`) left; amounts right-aligned in
  mono; gain/loss as text color only.
- **Dark CTA band** — pre-footer `#0a0b0d` band, centered headline + two CTAs,
  96px vertical padding.
- **Featured pricing tier** — dark inversion (`#0a0b0d` card, white text)
  instead of colored ribbons.

## Do

- Reserve Atlas Blue for primary CTAs, wordmark, and inline accent links.
- Make every CTA a pill; every avatar/icon plate a circle; cards 24px.
- Keep display headlines at weight 400 with tight tracking.
- Rotate white → soft-gray → dark bands as page rhythm on marketing pages.
- Render every numerical value in mono.

## Don't

- Don't introduce a second brand color. Blue is the only action color;
  gain/loss green/red are semantic text colors only.
- Don't bold display copy.
- Don't add shadow tiers — there is exactly one.
- Don't use sharp corners on CTAs.
- Don't use gain green or loss red as a button/background fill.

## Responsive

| Breakpoint | Width | Key changes |
|---|---|---|
| Mobile | < 640px | Hero h1 80→40px; grids 1-up; nav → hamburger; layered mockups collapse to one card |
| Tablet | 640–1024px | Hero h1 64px; grids 2-up |
| Desktop | 1024–1280px | Full type scale; grids 3-up |
| Wide | > 1280px | Content caps at 1200px; heroes full-bleed |

Touch targets: standard pill 44px (WCAG AAA), hero pill 56px; 32px icon
circles sit in padded rows for an effective 48px tap zone.

## Iteration guide

1. Change tokens in `globals.css`, not inline hex. New UI must reference
   semantic vars (`bg-primary`, `text-muted-foreground`, `border-border`,
   `text-up` / `text-down`).
2. New CTAs default to pill; new icon plates to circles; new cards to
   `rounded-xl` (24px).
3. Blue stays scarce — one or two blue moments per view.
4. Numbers always in `font-mono`.
5. Both light and dark palettes live in `globals.css` (`:root` / `.dark`).

## Known gaps

- The original reference typefaces are licensed; Inter and JetBrains Mono are
  the canonical substitutes and what we ship.
- Animation timings are out of scope for now.
- New user-facing strings still require EN + SW keys in
  `apps/web/src/i18n/index.ts` (see CLAUDE.md).
