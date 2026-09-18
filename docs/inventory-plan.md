# Sunshine Gadgets POS — Inventory & Analytics Upgrade

Continues the app built from `build-plan.md`. Same rhythm: paste one prompt at
a time into the same Claude Code session/repo, review, test, commit, then move
to the next.

**Backend: Firebase Firestore** (project `sunshine-8f335`). This was settled
before Prompt 2 was run — the schema section below is the Firestore version,
not the Supabase one the first draft assumed. Schemaless, so there are no
tables, foreign keys or checked columns to declare; the only backend artifact
is a rules block.

Decisions already made, so Claude Code doesn't have to guess:
- Staff add/restock inventory from the **Sales screen** — no admin password
  needed for that.
- Overselling is **blocked outright** on the device taking the sale — see the
  honesty caveat in Prompt 5 about what that can and can't guarantee across
  devices.
- The analytics upgrade adds **revenue/stock-value by category** and a
  **this-period-vs-last-period comparison** on the existing KPIs.

---

## Prompt 1 — Feature brief (paste first, on its own)

```
We're adding inventory tracking to the existing Sunshine Gadgets POS
app. Read this, confirm your understanding of the existing codebase
first (open js/db.js, js/app.js, js/analytics.js, js/sync.js,
firebase/firestore.rules), then confirm this plan before writing
code.

REQUIREMENTS
- Staff can record how many units of a product they've received
  ("restock"), from the Sales screen, no admin password required.
- The system auto-tracks how many units are available and reflects
  that on the Sales screen as staff sell.
- Attempting to sell more than what's in stock is blocked outright,
  with a clear inline message — never a silent oversell, never a
  browser alert().
- Analytics gets more comprehensive: a revenue/stock-value breakdown
  by category, and a this-period-vs-last-period comparison on the
  existing KPIs.

ARCHITECTURE DECISION — an append-only stock ledger, not a mutable
counter. This directly avoids a class of bug we already hit once
with seed data in this project: two offline devices independently
overwriting the same "absolute number" field and one device's change
silently winning over the other's when they sync. A stock count is
exactly this kind of field, and it matters far more here than it did
for the earlier seed-data bug, so:

- New store/collection: stock_movements — id, product_id, type
  ('initial' | 'restock' | 'sale' | 'adjustment'), quantity_delta
  (positive for initial/restock, negative for sale/some
  adjustments), note (optional text), related_sale_id (nullable,
  set when type is 'sale'), created_at, updated_at (same value as
  created_at — these rows are never edited after creation), synced,
  device_id.
- A product's stock on hand is ALWAYS derived — never stored as a
  mutable field — by summing quantity_delta across every
  stock_movements row for that product_id. This sum is correct
  regardless of sync order, offline duration, or how many devices
  wrote movements before anyone synced, because summation doesn't
  care about ordering and every row is upserted idempotently by its
  own id.
- Backward compatibility: a product with zero stock_movements rows
  ever is "untracked" — no stock badge, no oversell blocking, sells
  exactly like it does today. A product becomes "tracked" the moment
  any movement exists for it (its first restock, or a starting-stock
  value entered at creation). This matters because every product
  that already exists in production today has no stock history —
  without this distinction, shipping this feature would instantly
  block every sale in the shop until someone manually stocked every
  existing product.
- Recording a sale writes a normal sales row exactly as it does
  today, AND (only for tracked products) a stock_movements row with
  type 'sale', quantity_delta = -quantity, related_sale_id = the new
  sale's id — so the ledger is the single source of truth for both
  restocks and consumption.

Also flag, while you have the sync engine open: check whether either
screen re-renders when a background sync PULLS new data from another
device. If a pull-complete callback already exists, check whether it
fires on every tick regardless of whether anything changed — a
subscriber that rebuilds the DOM on a timer is a cosmetic annoyance
today but a real one once stock badges are live. Either way this
feature wants a callback that fires only when a pull actually wrote
rows.

Confirm you're aligned with the ledger-over-counter reasoning
specifically — that's the one decision in this brief I don't want
quietly reinterpreted — then stop and wait for my go-ahead.
```

---

## Prompt 2 — Data layer: the stock ledger

```
Phase 1: the stock ledger, end to end through sync — no UI yet.

js/db.js
- Add the stock_movements object store (keyPath id; indexes on
  product_id, synced, created_at).
- Add a shared helper, used by both screens so the logic never
  drifts between them:
  getStockLevels() → async, returns a Map keyed by product_id, each
  entry { tracked: boolean, onHand: number }. tracked is true iff at
  least one movement exists for that product; onHand is the signed
  sum of quantity_delta (don't clamp it here — clamp only for
  display, later).
- Add recordStockMovement({ product_id, type, quantity_delta, note,
  related_sale_id }) that fills in id/created_at/updated_at/synced/
  device_id and writes the row.
- Bump the database's version number and add the new store inside
  the version-upgrade handler, not just in the handler's general
  logic. This matters more than it looks: without the bump, any
  device that already has the local database — including every
  device already in the shop's hands — will silently never receive
  the new store, and every stock call on those devices will throw.

Products
- No new mutable stock field on products — deliberately. Add
  low_stock_threshold (nullable number) to the product record; a
  blank value means "use the app-wide default" (hardcode a constant,
  e.g. 5, don't build settings UI for this yet). Firestore is
  schemaless and the sync engine copies every field on the record,
  so this needs no migration on the backend.

firebase/firestore.rules
- Add a stock_movements match block alongside the existing three,
  same anonymous-auth gate as the others:
      match /stock_movements/{movementId} {
        allow read, write: if request.auth != null;
      }
  Nothing else is needed — no table to declare, no foreign keys, no
  checked type column, and no index to create (single-field indexes
  are automatic, and the where('updated_at','>',x) +
  orderBy('updated_at') pattern queries one field).
- IMPORTANT: publish these rules in the Firebase console BEFORE
  deploying the code. The rules file denies by omission, so until
  stock_movements is allowed, that collection is denied.

js/sync.js
- Add stock_movements to the push/pull cycle. Push order matters:
  products → sales → payments → stock_movements (movements can
  reference either a product or a sale, so they go last).
- Isolate per-table failures across ALL tables, not just the new
  one. If one collection throws, the tables after it in the pass
  must still be attempted — otherwise a single collection whose
  rules aren't published yet takes down sync for everything. A pass
  with any failing table should report as unhealthy rather than
  claiming "Synced".
- After a pull that brought in ANY changes (not just on every tick),
  call a new callback — something like Sync.onDataChanged(fn) — so
  each screen can reload its view of the data. Count rows actually
  written to IndexedDB, not rows returned by the query, since the
  merge logic skips rows that are locally newer or locally unsynced.
  Wire this now even though nothing listens yet; the next two phases
  will subscribe to it.

No visible UI changes in this phase. Verify it by walking me through
inserting a couple of stock_movements rows via the browser console
against `DB` and confirming getStockLevels() sums them correctly,
including a case with an 'initial' and a 'sale' row for the same
product. Also verify the version upgrade against a database that
already exists with data in it — that's the path every device
already in the shop will take.
```

---

## Prompt 3 — Sales screen: restock and stock-aware selling

```
Phase 2: bring the ledger into the Sales screen.

Product cards
- For a tracked product, show a stock badge: "N in stock" normally,
  "Low stock: N" in the credit/rust color when N is at or below its
  threshold (or the app-wide default), "Out of stock" in the danger
  color when N <= 0 (clamp display at 0; the underlying sum can stay
  negative if it ever happens, don't hide that from yourself in the
  data, just don't show a negative number to staff).
- For an untracked product, no stock badge at all — it should look
  exactly like it does today.
- Add a small, separate "+ Stock" control on each card. If the
  product tile is itself a <button> (check the existing markup), a
  second interactive control can't be nested inside it — that's
  invalid HTML and browsers handle the inner click inconsistently no
  matter what event-handling tricks you apply. Restructure the tile
  into a non-interactive container with two sibling buttons (the
  main tap target for a sale, and the stock control) rather than
  trying to rescue the nested version. Opens a small modal: quantity
  received (required, positive integer), an optional note (e.g.
  supplier or batch), Save writes a stock_movements row via
  recordStockMovement with type 'restock' (or 'initial' if this is
  the product's very first movement — you decide the cleanest way to
  detect that, doesn't need to be a separate code path from restock
  if it's simpler not to be), toasts a confirmation, and refreshes
  the grid.

New Product modal
- Add an optional "Starting stock" field. Left blank or zero → the
  product is created untracked, exactly like every existing product
  today. A positive value → write one stock_movements row (type
  'initial') right after the product is created, so it's tracked
  from day one.
- Add an optional "Low stock alert below" number field, saved as the
  product's low_stock_threshold.

Record Sale panel
- For a tracked product, show current stock near the quantity field
  ("7 in stock" as a hint), and validate on submit: if the requested
  quantity exceeds current stock, block submission with the same
  inline error-text pattern already used elsewhere in this panel
  ("Only 7 in stock — reduce the quantity or restock first."). For
  an untracked product, behave exactly as it does today, no stock
  check at all.
- Re-derive stock at submit time rather than trusting a value
  captured when the panel opened — a background sync can change it
  while the panel sits open.
- On successful submit for a tracked product, write the sale exactly
  as today, then also write a stock_movements row (type 'sale',
  quantity_delta = -quantity, related_sale_id = the sale's id).

Live refresh
- Subscribe to the Sync.onDataChanged callback from phase 1 and
  reload the product grid (and rail) when it fires, so stock levels
  update on screen when another device's sale or restock syncs in,
  without needing a manual page reload.

Verify: create a product with starting stock 5, sell 3 (stock badge
should read "2 in stock" — or "Low stock: 2" if that's at/under the
threshold), then try to sell 3 more and confirm it's blocked with
the exact remaining number in the message, not sold at all.
```

---

## Prompt 4 — Analytics: inventory summary and the comparison upgrade

```
Phase 3: the analytics upgrade — inventory visibility, category
breakdown, and period-over-period comparison. This is read-only;
restocking stays on the Sales screen per the brief.

Note: analytics.js currently loads only the sales store. It will
need products and stock levels too.

Inventory summary (new section)
- Three figures: total stock value (sum of onHand × default_price
  across tracked products only), count of tracked products at or
  below their low-stock threshold, count of tracked products at
  zero. These are live snapshots, not scoped to the date-range
  selector — label them that way, consistent with how "Outstanding
  credit" is already labelled on this dashboard.
- A table of tracked products only (untracked products don't appear
  here — this view is specifically about stock, and an untracked
  product has nothing to report): name, category, stock on hand,
  status badge (OK / Low / Out, same colors as the Sales-screen
  badges for consistency).

Revenue by category (new panel)
- For the selected date range, group sales by category: total
  revenue and units sold per category, sorted by revenue descending.
  Render as a simple horizontal bar list (a colored fill proportional
  to the top category's revenue, figure at the end of each row) —
  reuse the visual language already established by the top-products
  panel rather than introducing a new chart style.

Period-over-period comparison
- For the three range-scoped KPI cards that already exist (sales
  value, units sold, transactions — NOT outstanding credit, which is
  a snapshot and has no "period" to compare against), compute the
  equivalent prior period (yesterday for "Today", the previous 7
  days for "7 days", previous 30 for "30 days") and show a small
  delta underneath each figure, e.g. "+12% vs previous period",
  colored using the existing success/credit colors for
  positive/negative. For "All time", there's no prior period — hide
  the delta rather than showing something misleading.

Live refresh
- Subscribe to Sync.onDataChanged here too, and reload the dashboard
  when it fires, same reasoning as the Sales screen.

Verify with a small hand-checkable dataset: a couple of sales across
two categories, one restock, and confirm the category breakdown
figures and the total stock value both match what you'd get doing
the arithmetic by hand.
```

---

## Prompt 5 — QA pass and README update

```
Phase 4: hardening, with particular attention to the reason we chose
a ledger over a counter in the first place.

1. Simulate the scenario the architecture is meant to prevent:
   two "devices" (two browser profiles or two IndexedDB instances)
   both offline, both restocking the SAME product before either has
   synced — device A adds 10 units, device B adds 5 units — then
   bring both online. Confirm the synced result is 15, not 10 or 5.
   This is the one test in this whole phase I actually care about
   most; don't skip or shortcut it.
2. Confirm an existing (pre-feature) product with no stock history
   still sells with zero friction — no badge, no blocking, unchanged
   from before this feature shipped.
3. Confirm the exact oversell scenario from phase 2's own check still
   holds after all later changes.
4. Confirm a product that starts untracked, then gets its first
   restock mid-session, correctly flips to showing a stock badge
   without a page reload.
5. Confirm the category breakdown and period-comparison figures
   recompute correctly when switching the date-range selector back
   and forth.
6. Update README.md: document the stock ledger concept in plain
   language (staff-facing: "products only show a stock count once
   you've added stock to them at least once"), how restocking works,
   what the badges mean, and add the new analytics sections to the
   feature list. Keep the existing "what this version doesn't do
   yet" section and add to it: no manual stock corrections/write-offs
   UI yet (the data model supports it — an 'adjustment' movement type
   — but there's no screen for it), no per-product cost price (stock
   value uses default_price as a proxy), and — important to state
   plainly, not bury — the sold-out block is enforced per device,
   not as a real-time global guarantee: two devices both offline can
   still both sell the last unit before either syncs. No
   client-side check can prevent that without a server-side
   transaction, which offline-first rules out. The ledger doesn't
   prevent it; it makes sure the true history (including the
   resulting negative count) is visible afterward instead of one
   sale silently disappearing.

Summarize what you tested and its outcome, and flag anything you
think needs a decision from me before this ships.
```
