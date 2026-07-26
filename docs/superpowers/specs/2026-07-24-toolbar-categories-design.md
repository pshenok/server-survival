# Toolbar categories — design

**Date:** 2026-07-24
**Status:** approved

## Problem

The bottom toolbar is one flat row of 30 buttons — 7 controls plus 23 service
types — roughly 2000px wide. On any normal screen the right end is off-screen
and the player has to scroll sideways to reach half the palette. Two aggravating
details:

- the container carries `overflow-y-auto` (vertical) while the overflow is
  horizontal, which is why the scrolling feels broken rather than merely long;
- `help`, `music` and `sfx` occupy the three leftmost slots — the most valuable
  real estate on the bar — despite being settings, not gameplay.

The palette grew from 13 to 23 services across Wave 1 (#193) and Wave 2 will add
more, so "scroll further" is not a fix.

## Approach

Group the services into five category tabs. Only the active category's buttons
are rendered, so the bar never scrolls.

The categories are not an arbitrary bucketing — they are the cloud-domain map
from the Wave 1 epic (#193). A player absorbs the taxonomy (front door →
compute → data → async → ops) simply by using the toolbar, which serves the
project's education north star. Two rejected alternatives, for the record:

- **pinned favourites + an "all services" pop-up grid** — fixes the mechanics
  but teaches nothing and introduces a two-tier mental model;
- **a vertical side rail** — no horizontal scrolling ever, but it eats canvas
  width and the left and right edges already hold four panels.

## Categories

| Tab | Services | Count |
|---|---|---|
| Front door | dns, cdn, waf, auth, apigw, alb | 6 |
| Compute | compute, serverless, container | 3 |
| Data | db, nosql, cache, s3, search, replica, warehouse | 7 |
| Async | sqs, pubsub, stream, dlq, scheduler, notify | 6 |
| Ops | monitor | 1 |

The widest tab is 7 buttons (~480px), which fits comfortably on a laptop. Ops
holds a single service today; it stays its own category because it is a real
domain and the multi-region and chaos work will fill it.

## Components

**`src/ui/toolbar.js`** owns the palette:

- `SERVICE_CATEGORIES` — plain data, one entry per tab with its `labelKey` and
  its list of service types. Adding a service in a later wave means adding its
  type to one array, matching the "one file plus one registry line" property the
  handler registry already has (#155 PR 9).
- `renderToolbar()` — draws the tab strip and the active category's buttons.
- `setToolbarCategory(id)` — switches tab, re-renders, re-applies campaign
  gating.

**The button markup stays byte-identical to today** — same classes, same
`id="tool-<type>"`, same cost badge, same `data-i18n` attributes. Campaign
gating, hover tooltips and locale switching all find their elements exactly as
before and need no changes.

`index.html` keeps only the shell: the bar, the always-visible tool cluster, the
tab strip and an empty `<div id="service-palette">` that the module fills.

The four build tools (select, link, demolish, unlink) stay visible in every tab.
They are modes, not services; hiding them behind a tab would make every build
action a two-click affair.

## Campaign interaction

`applyCampaignToolbarGating` looks buttons up by id and disables the ones a
level forbids. Tabs introduce a failure mode that does not exist today: level 2
allows only Storage, so a player sitting on the Front door tab sees nothing but
greyed-out buttons and reasonably concludes the game is broken.

Two mitigations, both required:

1. After gating, switch automatically to the first tab that contains an allowed
   service.
2. Show a small count of allowed services on each tab (`Data · 1`) so the
   player can see where the level's tools actually are.

Gating must also be re-applied on every tab switch — freshly rendered buttons
would otherwise come up enabled regardless of the level's rules.

## Smaller fixes carried in the same change

- `help`, `music` and `sfx` move into a compact settings cluster (icon-only,
  smaller) at the far edge of the bar.
- `overflow-y-auto` becomes the correct horizontal handling.
- The active tab is remembered in `localStorage`.
- Keys `1`–`5` switch tabs. The existing `Esc`/`H`/`R`/`T` shortcuts are
  untouched.

## Testing

The load-bearing test is a **completeness invariant**: every placeable type in
`CONFIG.services` belongs to exactly one category. This catches the future
service that someone forgets to categorise and which would silently become
unreachable — the same class of protection the locale-parity test provides.

Also covered:

- switching tabs preserves campaign gating;
- a campaign level auto-selects a tab that holds one of its allowed services;
- the settings cluster still drives `toggleMusic` / `toggleSfx`;
- rendering is idempotent (re-rendering does not duplicate buttons).

## i18n

Five category labels across all nine locales. The i18n-usage test will fail on
any key referenced but not defined, so a missed translation cannot ship.

## Constraints

No build step; native ESM; no new runtime dependencies. Vector SVG icons only.
The game must remain directly hostable on GitHub Pages, served raw.
