# Cache Operations

Last updated: 2026-07-10

## Purpose

This project now uses Next.js Cache Components for DB-backed read surfaces that
do not require per-request freshness. The goal is to keep first-load latency
down while still invalidating cached pages immediately after successful writes.

## Operating model (2026-07-10 event-driven shift)

Every write path invalidates tags: the CRUD API routes/services always did, and
the data-mutating crons now do too (`naver-order-sync`, `naver-settlement-sync`,
`collect-instagram`, `collect-youtube`, `rehost-seller-media`,
`enrich-references`). Freshness therefore comes from **tag invalidation**, and
TTLs are a safety net only. Short TTLs were burning Vercel ISR Write units
(billed per 8 KB written) without improving observable freshness, so all tiers
were lengthened accordingly.

## Current cache policy

`src/lib/cache-policy.ts` is the source of truth for page-level cache surfaces
and TTL profiles.

- `hot`: `stale=30s`, `revalidate=5m`, `expire=1h`
  Used for `/` (home dashboard — hot since before this doc's 2026-05-24
  revision; documented wrong as warm until 2026-07-10) and the mobile home
  settlement-card data layer (`getCachedMobileSettlementCampaigns`, 2026-07-15
  — a narrow two-status/select query that replaced the mobile branch's
  `getCachedDashboardData("pipeline")` kitchen-sink read after the #149 review;
  tagged `pipeline`+`settlement` only, `dashboard` intentionally omitted to cut
  unrelated-write fan-in — deal/seller renames converge within the hot window.
  `/schedule`'s pipeline read fed only unreachable fallbacks after #149 moved
  the funds chips home, so it was removed outright rather than replaced).
  `/pipeline` was hot
  until 2026-07-12, when it moved to a dynamic (uncached) surface — see below.
- `warm`: `stale=5m`, `revalidate=1h`, `expire=24h`
  Used for `/settlement` (demoted from hot — month-level freshness; writes and
  the nightly settlement cron invalidate immediately), `/assets/archive`,
  `/partners`, `/sellers`, `/deals`, and the per-seller portal data layer
- `report`: `stale=15m`, `revalidate=1h`, `expire=24h`
  Used for `/reports/pnl`, `/admin/integrations/meta/review-checklist`,
  and the default-settlement-month helper
- `static`: `stale=5m`, `revalidate=30d`, `expire=1y`
  Used for `/admin/channel-fees` (low-churn config; writes invalidate the tag)

### Hybrid surfaces (dynamic shell + cached data layer)

`src/lib/cached-portal-data.ts` caches cross-campaign repurchase
(full-history snapshot aggregation), shared by `/p/[token]`, `/[slug]`,
performance-card routes, and `/sellers/[id]`. Past-campaign/settlement history
is disabled on the seller-facing report because seller-facing sales bases can
differ from internal settlement bases. The order-campaigns payload
(`fetchAndSyncCampaigns`) stays live because it uses `after()` internally,
which is forbidden inside `use cache`; splitting a read-only variant is the
next lever if portal traffic grows.

Dynamic exceptions are also declared there.

- `/pipeline` and `/pipeline/tasks` (dynamic since 2026-07-12)
  Demoted from the `hot` cached surface to a dynamic (uncached) surface after
  observability showed the page was overwhelmingly write churn — it accounted
  for the majority of ISR writes with an inverted write:read ratio. The cause is
  structural, not TTL (time-based revalidations were a small minority; the churn
  was tag-driven): `/pipeline` is the operator's live execution board, so every
  card drag is a `campaign` write that invalidates `crm:pipeline`, regenerating
  the page the operator is actively viewing — the cache never amortizes a read
  before the next mutation. The pages now call `getDashboardData({ workspace:
  "pipeline" })` directly (no `use cache`); `loading.tsx` provides the Suspense
  boundary so the route is PPR (static loading shell + per-request streamed
  board). ISR writes for this surface drop to zero; freshness is carried by the
  client `useCampaigns` (TanStack Query) layer. The `crm:pipeline` tag was also
  removed from the `masterData`/`assets`/`outreach` invalidation groups
  (fan-out trim) — the remaining consumers of that tag (home `/`, `/sellers`)
  refresh via their `dashboard`/`sellers` tags, so no freshness is lost. The
  `campaign` and `orderSync` groups keep `crm:pipeline` for those surfaces.

- `/outreach`
  Intentionally remains client-fetched instead of using a server cache surface.
  It still participates in cache invalidation tags because related writes affect
  other cached pages such as `/`.

- `/order-converter`
  Also intentionally client-fetched only — added in B1-3/B1-4. This is the Naver
  order/campaign dashboard (`useCampaigns` hook). It reads
  `/order-converter/api/dashboard-stats`, which returns three sync-status
  headers (`X-Naver-Last-Sync`, `X-Naver-Syncing`, `X-Naver-Sync-Type`) that the
  client parses into `syncMeta`. Because freshness here is driven by that
  header-based sync metadata (and a manual `refreshNow` action) rather than by
  Next.js cache tags, it is registered only in `CRM_DYNAMIC_SURFACES`, not in
  `CRM_CACHE_SURFACES` — adding it to `CRM_CACHE_SURFACES` fails
  `verify:cache-policy` because no mutation group in `cache-tags.ts` covers a
  page-specific `order-converter` tag. It is tagged with
  `dashboard`/`pipeline`/`settlement` only for documentation/traceability of
  which shared invalidation groups are adjacent, not because it is itself
  server-cached.

### ✅ RESOLVED 2026-08-28 — the cookie read is gone, document caching is back

The section below describes a state that **no longer holds**. It is kept because it
is the record of how the trade was made, measured, and undone — and because its
closing sentence turned out to be the exact fix.

**What happened.** Ticket T-052 raised the trade-off to the owner (keep sidebar
persistence and lose document-level caching, or drop the feature). The owner chose
neither: the sidebar became a **permanent icon rail that expands over the content on
hover**, so there is no state left to persist. `SidebarStateBoundary`,
`SidebarPrepaintScript` and `src/lib/sidebar-state.ts` were deleted outright.

**Measured, same command on both sides (`npm run build:demo`, sqlite mock — ⛔ never
`npm run build` locally, the repo `.env` points at the production DB):**

| | before | after |
| --- | --- | --- |
| `○` fully static | 4 | **24** |
| `◐` partial prerender | 40 | **20** |
| `ƒ` dynamic | 201 | 201 (unchanged) |

The 20 flipped routes are exactly the app pages that lost it in 2026-08-25 —
`/deals`, `/sellers`, `/partners`, `/settlement`, `/assets*`, `/outreach`,
`/order-converter`, `/assistant`, `/reports/pnl`, `/settings*`, `/admin/*`. Before
the change the only `○` entries were `/icon.svg`, `/apple-icon.png`,
`/manifest.webmanifest` and `/robots.txt`.

⛔ **Do not reintroduce a persisted sidebar state.** Any `cookies()` read in the root
layout tree costs this again, and the cost is not visible on screen — it only shows
up in the route table. `crm-sidebar-row-shape.contract.test.ts` scans for it.
Design of record: `docs/private/specs/2026-08-28-sidebar-hover-overlay-design.md`.

---

### Document-level caching: every app page route is PPR (2026-08-25 — SUPERSEDED, see above)

The root layout reads the sidebar collapse/expand cookie inside its `<Suspense>`
boundary (`SidebarStateBoundary` → `cookies()`), so **every app page route is
`◐` (Partial Prerender)**; the only remaining `○` (fully static) entries are
`/icon.svg`, `/apple-icon.png`, `/manifest.webmanifest` and `/robots.txt`.

Measured on two production builds of adjacent commits, plus a third isolation
build in which only that `cookies()` call was replaced by a constant (the third
build reproduces the earlier route table exactly, so the cookie read is the sole
cause):

- Route table: `○ 24 · ◐ 19` → `○ 4 · ◐ 39` (20 page routes flipped). `ƒ`
  (dynamic) count unchanged at 201.
- Prerender artifacts: the flipped routes lost their `.rsc` payload and gained a
  `postponed` key in `.meta` (`.rsc` file count 220 → 200).
- Runtime document response, e.g. `/deals`, `/sellers`, `/settlement`:
  `x-nextjs-cache: HIT` + `Cache-Control: s-maxage=3600,
  stale-while-revalidate=82800` → `x-nextjs-postponed: 1` + `Cache-Control:
  private, no-cache, no-store`.

- Re-verified on `main` after the `AppShellFrame` change (#460): route table and
  prerender artifacts are unchanged, so that fix did not move this boundary.

**What this does and does not change.** The static shell is still prerendered,
so first paint is unaffected, and the `use cache` data layer above is untouched
(the `cacheLife` columns in the route table are identical across the two
builds) — DB load does not increase. What is gone is the *document-level* HTTP
cache: the HTML is now rendered per request instead of being served from the
ISR/CDN cache. ISR write pressure for these routes correspondingly drops to
zero, which is the opposite trade from the `/pipeline` demotion above.

This is inherent, not incidental: a prerendered artifact cannot see a
per-request cookie (`cookies()` "will opt a route into dynamic rendering", Next
16 `cookies.md`). The only alternatives split the sidebar state between CSS and
React, which `src/lib/sidebar-state.ts` documents as rejected. If document-level
caching for these routes ever has to come back, the cookie read — not the cache
policy — is the thing to remove.

⚠️ An earlier code comment claimed this read cost "0" because `usePathname`
supposedly already created the same hole. That was wrong (`usePathname` is a
client hook and does not block build-time prerendering) and has been corrected
in `sidebar-state-boundary.tsx`. Do not re-derive the cost from that comment's
history.

## Client-side caching (B1-3)

Several client hooks (`useNotifications`, `useSellers`, `usePartners`,
`useDeals`, `useCampaigns`, plus the inline fetch in `/outreach`) were migrated
from plain `fetch` + `useState` to TanStack Query (`@tanstack/react-query`) so
that navigating away and back shows the last-known data immediately while a
background refetch runs (stale-while-revalidate), instead of a blank/loading
screen on every visit.

- Query client setup lives in `src/app/providers.tsx` (`'use client'`), mounted
  once in `src/app/layout.tsx` around the existing provider tree.
- Query keys are centralized in `src/lib/query-keys.ts`.
- **No `localStorage` persistence (2026-07-05 privacy decision).** An earlier
  revision persisted master-data list queries (`sellers`, `partners`, `deals`
  list) to `localStorage` (key `wagcrm-rq`, 24h max age) via
  `PersistQueryClientProvider` + a `WHITELIST_KEYS` dehydrate filter. This was
  removed because it left customer/partner PII (names, deal terms) sitting in
  plaintext in the browser for up to 24h — unacceptable for a CRM. Caching is
  now purely in-memory: `providers.tsx` uses a plain `QueryClientProvider`
  with `gcTime: 24h`, so "navigate away and back" within the same session/tab
  still shows last-known data instantly (the QueryClient instance and its
  cache survive component unmount/remount). Only "instant data after a full
  page reload" is given up, in exchange for no PII at rest in `localStorage`.
- This is purely a client concern and does not change server cache surfaces or
  invalidation tags above — `verify:cache-policy` does not inspect client hooks.

## Invalidation policy

`src/lib/cache-tags.ts` is the source of truth for shared invalidation groups.

- `CAMPAIGN_INVALIDATION_TAGS`
  Covers campaign create/update/delete and actual-sales writes.
- `MASTER_DATA_INVALIDATION_TAGS`
  Covers partner/seller/deal CRUD plus partner business-info updates.
- `ASSET_INVALIDATION_TAGS`
  Covers asset create/archive/delete.
- `OUTREACH_INVALIDATION_TAGS`
  Covers `SalesTask` create/update flows.
- `CHANNEL_FEE_INVALIDATION_TAGS`
  Covers admin channel-fee updates.
- `ORDER_SYNC_INVALIDATION_TAGS` (2026-07-10)
  Fired by the `naver-order-sync` cron when snapshots actually changed —
  refreshes pipeline/settlement surfaces and the cached portal data layer.
- `SELLER_METRICS_INVALIDATION_TAGS` (2026-07-10)
  Fired by `collect-instagram` / `collect-youtube` / `rehost-seller-media` —
  refreshes seller directory/detail and dashboard momentum cards.

### Assistant WRITE lane is a writer too (2026-08-27)

The agent lane executes WRITE actions through `executeWriteAction`
(`src/lib/agent/write-executor.ts`) from two routes: the approval button
(`POST /api/action-proposals/[id]/approve`) and the auto-approve path inside
`POST /api/assistant`. Those routes originally committed the database write
without invalidating any tag, so an approved write stayed invisible on cached
surfaces until the next expiry.

Invalidation for this lane is declared per action as a **required** `effects`
field on each `WRITE_ACTIONS` entry, and executed after commit by
`applyWriteActionEffects` (`src/lib/agent/write-action-effects.ts`):

- `confirm_settlement` → `CAMPAIGN_INVALIDATION_TAGS` **plus** a Google Calendar
  resync via `after()`, matching the canonical toggle route
  (`PATCH /api/campaigns/[id]/settlement-status`). Settlement flags are the
  source of the calendar deposit/payout events, so doing only one of the two
  leaves the ledger and the calendar disagreeing.
- `change_deal_status` → `MASTER_DATA_INVALIDATION_TAGS`, matching
  `PATCH /api/deals/[id]`.
- `add_entity_memo` → **nothing, deliberately.** It writes only an
  `ActivityLog(type=MEMO)` row, and no `use cache` surface reads that table
  (the memo readers — `/api/activity-log` and the tax-filing board route — are
  both dynamic). An empty tag list here is a decision, not a gap; filling it in
  would buy no freshness and only add ISR writes.

The declaration is registered in `scripts/verify-cache-policy.ts` under the
`campaigns` and `masterData` groups, so dropping a tag group from the `effects`
spec fails `npm run verify:cache-policy`.

### `dashboard` tag scope (2026-07-10 fan-out reduction)

The `dashboard` tag now means **"the home dashboard aggregate surface"** and is
carried only by surfaces that actually render cross-workspace aggregates: the
home desktop/mobile snapshots, the shared `getCachedDashboardData` workspace
data (also feeding `/assets/archive`), and the Meta review checklist (which is
literally dashboard-derived). It was removed from the `/partners`, `/sellers`,
`/deals`, and `/reports/pnl` cached surfaces and the default-settlement-month
helper, because those do not display dashboard aggregates and were being
regenerated on every campaign/asset/outreach/fee/goal write via the blanket
tag. Each keeps precise tags so the *right* writes still refresh it:

- `/partners` → `partners`, `deals` (master-data writes only)
- `/sellers` → `sellers`, `pipeline` (keeps campaign-write refresh — the recent
  campaign snapshot is real decision value)
- `/deals` → `deals`, `partners` (the campaign-count badge is low decision
  value; it converges within the warm window instead of on every campaign write)
- `/reports/pnl` → `reportsPnl` (campaign-derived)

This mainly reduces **Fluid CPU** from redundant regenerations (Vercel dedupes
byte-identical regenerations so over-invalidation was already near-free for ISR
*write* units, but still spent CPU regenerating).

### Cached payload hygiene (2026-07-10)

`getCachedMobileTodayData` no longer includes the seller `agency` relation. The
mobile briefing components read none of the `sellerCompany*` fields (bank
account, CEO, business number, address), so caching that agency PII only bloated
a high-frequency warm payload (ISR write units) and left PII at rest in the
durable cache — the same concern that removed `localStorage` list persistence in
B1-3. When adding fields to a cached read, include only what the surface renders.

## Verification

Run:

```bash
npm run verify:cache-policy
```

This script does not touch the database. It reads the shared cache policy and
reports:

- cached surfaces and their TTL profiles
- intentionally dynamic surfaces that are excluded from server cache surfaces
- which mutation groups invalidate each surface
- whether each write route still contains the expected invalidation helper or shared tag constant
- tags that are invalidated by writes but are not attached to any cached page
- configuration errors, such as unknown tags or cached surfaces with no matching
  invalidation group

## Recommended operating cadence

- After cache policy changes: run `npm run verify:cache-policy` and `npm run build`
- Before release: include `npm run verify:cache-policy` in the release checklist
- After adding a new cached page: register it in `src/lib/cache-policy.ts`
- After adding a new write route: wire it to an existing invalidation group or
  add a new one in `src/lib/cache-tags.ts`

## Practical tuning guidance

- Keep `hot` only for execution views where same-hour edits are common.
- Use `warm` for master data pages when the write path already invalidates tags.
- Use `report` only for derived analytics where a slower rebuild is acceptable.
- If users report stale data after a write, inspect whether the write route
  invalidates the exact tags used by that page surface before shortening TTLs.
