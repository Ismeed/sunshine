# Building Sunshine Gadgets POS with Claude Code

**Backend note.** This project launched on Supabase and later moved to
Firebase Firestore, after a Supabase free-tier cap (2 active projects per
account) blocked provisioning. **This document has been rewritten for
Firestore throughout** — Prompts 0, 5, 6 and 7 originally named Supabase and
now describe the live backend, so the plan is internally consistent and can be
re-run end to end. Prompts 1–4 were always backend-agnostic and are unchanged.

Prompt 5 in particular is a full rewrite rather than a find-and-replace: the
two backends differ in ways that change the instructions (Firestore is
schemaless, has no foreign keys, and the npm package can't be vendored the
same way). The gotchas that cost real time during the migration are called
out inline rather than left to be rediscovered.

The live project is `sunshine-8f335`. Follow-on work beyond this plan (a
modern redesign with dark mode, a persistent PWA install prompt, Vercel
deployment config, and the inventory/stock-ledger feature) added files not
listed in Prompt 0's tree — see `inventory-plan.md` and the README.

A build plan broken into 8 prompts. Paste them **one at a time**, in order,
into the same Claude Code session (same repo, so context and files carry
over). Let each phase finish and actually run before pasting the next one —
every phase is designed to leave you with something testable, not a
half-built app.

Suggested rhythm per phase: paste the prompt → review the diff → run/test it
→ `git commit` → move to the next prompt.

---

## Prompt 0 — Project brief (paste first, on its own)

```
We're building "Sunshine Gadgets POS" — a sales-recording and
analytics tool for a small electronics retailer (phones, laptops,
chargers, screen guards, Bluetooth speakers, phone cases, and other
products staff add themselves). Read this whole brief and confirm
your understanding before writing any code — ask me anything that's
genuinely ambiguous, then wait for my go-ahead.

BUSINESS REQUIREMENTS
- Two distinct areas of the app:
  1. A Sales screen for counter staff: browse/search products,
     create new products on the fly, and record a sale (product,
     quantity, price, optional short note).
  2. An Analytics screen for the owner, behind its own password,
     separate from the sales screen. Revenue, best sellers, and
     outstanding credit.
- Some customers pay later — bulk or small, no minimum. Every sale
  needs a Paid now / Pay later choice; Pay later captures a customer
  name (required) and phone (optional) and tracks a running balance
  that can later be paid off in full or in part.
- Staff create products themselves: name, category (existing or new,
  freeform), a default price, a simple icon. No fixed product
  catalog — assume they'll add dozens of SKUs over time.
- Must work completely offline, and sync automatically to a shared
  cloud database when the connection returns, so every device
  (counter tablet, owner's phone, back-office PC) converges on the
  same data.

TECH STACK — decided, please follow exactly
- Plain HTML/CSS/JavaScript. No framework, no bundler, no build
  step. Multiple static pages (index.html for Sales, analytics.html
  for Analytics) rather than a client-side router — this keeps "two
  separate logins" simple and the whole thing trivially hostable
  anywhere static files work.
- Local persistence: IndexedDB, via a small hand-written wrapper. Do
  NOT use localStorage or sessionStorage anywhere in this app, for
  anything, including "just a flag" — IndexedDB only, or an in-memory
  JS variable if something genuinely doesn't need to survive a
  reload (e.g. see the Analytics unlock state in a later phase).
- Cloud sync: Firebase Firestore. The app must remain 100% functional
  with Firebase unconfigured — sync is an enhancement layer, never a
  dependency for core use.
- The Firebase client must be self-hosted, not loaded from a CDN
  <script> tag at runtime — the app should never have a hard network
  dependency just to load its own shell. Note that the npm `firebase`
  package ships only ES modules with bare specifiers (e.g.
  `export * from '@firebase/firestore'`), which a browser cannot
  resolve without a bundler or import map, so there is no UMD build
  inside the package to copy. The vendorable artifacts are Firebase's
  "compat" builds — self-contained UMD bundles that define
  window.firebase — fetched once from Firebase's own pinned-version
  distribution and committed as static files. Fetching once at build
  time is fine; what must not happen is the deployed app reaching out
  to a CDN to load itself.
- IDs: `crypto.randomUUID()`. Timestamps: ISO strings. Every synced
  record carries `id`, `created_at`, `updated_at`, and a local-only
  `synced` boolean that never gets sent to the server.

DESIGN BRIEF
Avoid generic "AI app" defaults (cream-and-terracotta, near-black
with neon accent, identical rounded SaaS cards everywhere, ALL-CAPS
eyebrow labels, arrow-suffixed buttons). This is a fast, dense,
trustworthy business tool, not a marketing page.
- Palette: cool light neutral background `#F5F6F8`, white surfaces
  `#FFFFFF`, ink `#1B1F27` / soft `#5B6270` / faint `#8B92A0` text,
  hairline borders `#E1E4EA`. One accent, spent deliberately: a
  genuine sunshine gold `#E9A227` (dark variant `#B87F17`) for the
  brand mark and primary actions only. Status colors carry their own
  meaning, not the brand color: paid/success green `#2F9E6E`,
  pay-later/credit warm rust `#C6572E`.
- Typography: a refined system-font stack only (`-apple-system,
  "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`) — no web
  fonts, so typography never depends on the network. Distinctiveness
  comes from a deliberate type scale, weight, and tabular numerals
  for money, not from an exotic typeface.
- Layout: left-aligned, dense, functional. Vary the visual treatment
  by content type instead of using one rounded-card style everywhere
  — product tiles, KPI cards, and ledger tables should each look
  like themselves, not identical siblings. Numbers are the content:
  right-align them in tables, give KPIs real size, use tabular-nums.
- Currency: Nigerian Naira (₦), formatted with thousands separators.

FILE TREE (target)
sunshine-pos/
  index.html                Sales screen
  analytics.html            Analytics screen
  manifest.json             PWA manifest
  sw.js                     Service worker (offline app-shell cache)
  css/styles.css
  js/db.js                  IndexedDB wrapper
  js/app.js                 Sales screen logic
  js/analytics.js           Analytics screen logic
  js/sync.js                Firestore push/pull sync engine
  js/firebase-config.js     Editable Firebase web config
  js/vendor/firebase/       Self-hosted Firebase compat builds
    firebase-app-compat.js
    firebase-auth-compat.js
    firebase-firestore-compat.js
  icons/icon-192.png, icon-512.png
  firebase/firestore.rules  Security rules (paste into console)
  README.md

Confirm you've got all of this, then stop — the next messages will
walk through it phase by phase, starting with scaffolding and the
design system.
```

---

## Prompt 1 — Scaffolding and design system

*(Backend-agnostic — unchanged from the original plan.)*

```
Phase 1: project scaffolding and the shared design system.

1. Create the folder structure from the brief.
2. Write css/styles.css: CSS custom properties for the whole palette
   and type scale from the brief, a sensible reset, and reusable
   component classes we'll need across both screens — topbar, a
   "sync status" pill (states: no-config / offline / syncing /
   synced), buttons (primary / quiet / danger), form fields, a
   slide-over panel, a modal, badges, a data table, KPI cards, and a
   simple bar-chart primitive (plain divs, no charting library).
   Visible focus states on every interactive element. Respect
   prefers-reduced-motion.
3. Write index.html and analytics.html as static shells only — real
   markup and correct class names, topbar with a brand mark + a link
   between the two screens + the sync pill, but no JavaScript
   behavior yet and placeholder/empty content areas. They should
   already look right when opened directly in a browser, just inert.

Don't write any JS logic in this phase. Confirm the two pages render
correctly (no console errors) before we move on.
```

---

## Prompt 2 — Local data layer

*(Backend-agnostic — unchanged from the original plan.)*

```
Phase 2: the offline data layer, js/db.js. This is the foundation
every other screen writes through — get it right before touching UI.

Build a small Promise-based wrapper around IndexedDB (database name
sunshine_pos_db) with these object stores:
- products: keyPath id. Fields: id, name, category, icon,
  default_price, deleted, created_at, updated_at, synced. Indexes on
  category, updated_at, synced.
- sales: keyPath id. Fields: id, product_id, product_name, category,
  quantity, unit_price, total, description, payment_status
  ('paid'|'credit'), customer_name, customer_phone, amount_paid,
  balance, sold_at, created_at, updated_at, synced, device_id.
  Indexes on sold_at, payment_status, updated_at, synced.
- payments: keyPath id. Fields: id, sale_id, amount, paid_at,
  updated_at, synced, device_id. Indexes on sale_id, synced.
- settings: keyPath key, plain key/value (used for things like the
  device id, the admin password hash, and sync bookmarks — never for
  UI session state).

Note: IndexedDB keys may not be booleans, so an index over a boolean
field like `synced` indexes nothing. Declare it if you like for
schema symmetry, but implement getUnsynced() with a cursor scan that
filters in JS rather than an index range, or it will silently return
nothing.

Expose: getAll(store), get(store, id), put(store, record),
bulkPut(store, records), delete(store, id),
getUnsynced(store) (records with synced === false),
getSetting(key) / setSetting(key, value).

Also add: a newId() helper (crypto.randomUUID(), with a fallback),
a nowISO() helper, a getDeviceId() that generates and persists one
uuid in settings the first time it's called, and an ensureSeedData()
that — only on a genuinely empty products store — seeds starter
products for these categories: Phones, Laptops, Chargers, Screen
Guards, Speakers, Cases, each with a sensible emoji icon and
default_price 0 (0 means "not set — ask at sale time", handle that
convention consistently in later phases).

Give the seeded products STABLE, deterministic ids ('seed-phones',
'seed-laptops', ...) rather than crypto.randomUUID(). Two devices
that are each set up for the first time before either has synced
would otherwise generate different ids for the same six starter
products, and once cloud sync connects both, the shared database
ends up with visible duplicate "Laptop" and "Phone case" tiles. A
fixed id per category makes every device's first-run seed converge
on the same document instead of creating a sibling.

This phase has no visible UI. Verify it by having me open the
browser console on index.html and run a few calls against `DB`
directly — walk me through that quick manual check.
```

---

## Prompt 3 — Sales screen (local-only)

*(Backend-agnostic — unchanged from the original plan.)*

```
Phase 3: make the Sales screen (index.html + js/app.js) fully
functional against the local IndexedDB layer only — no cloud sync
yet, that's a later phase. By the end of this phase the app should
be a complete, useful offline POS on a single device.

Build:
- A "Today" summary in the side rail: today's revenue and sale
  count, computed from local sales.
- Category chips (derived from existing products, plus "All") and a
  search box, both filtering a responsive product grid.
- Product cards: icon, name, price (or "Set price at sale" when
  default_price is 0), category.
- "+ New product" opens a modal: name, category (existing ones in a
  dropdown, plus "+ Add new category" revealing a text input), an
  optional default price, and a small icon picker (a curated emoji
  set is fine). Validate required fields inline, no alert() popups.
- Tapping a product opens a slide-over "Record sale" panel: quantity
  stepper (+/-, min 1), price (prefilled from default_price, always
  editable), an optional short description, and a Paid now / Pay
  later toggle. Selecting Pay later reveals customer name (required)
  and phone (optional) fields and visually reads as a distinct state
  from Paid now (use the credit color, not the accent color). Show a
  live running total. On submit, validate, write the sale record
  (payment_status/amount_paid/balance set correctly for each mode),
  close the panel, toast a confirmation, and refresh the rail and
  grid.
- A toast helper for brief confirmations.

Everything must persist across a page reload with the browser
offline (DevTools → Network → Offline) — verify that explicitly and
tell me the steps you used to check it.
```

---

## Prompt 4 — Analytics screen (local-only)

*(Backend-agnostic — unchanged from the original plan.)*

```
Phase 4: make the Analytics screen (analytics.html + js/analytics.js)
functional, still against local data only.

Password gate, before anything else on this page:
- If no admin password is set yet (check settings), show a "set a
  password" form (password + confirm, minimum length) and store only
  a SHA-256 hash (Web Crypto's crypto.subtle.digest) in settings —
  never the plaintext.
- Otherwise show a plain password prompt and compare hashes.
- Once unlocked, hold that state in an in-memory JS variable only —
  explicitly NOT sessionStorage/localStorage and NOT anything
  persisted to IndexedDB. A page reload should re-prompt for the
  password. This is intentional: treat it as a feature, not a bug,
  and say so in a code comment so nobody "fixes" it later.
- Include a Log out button that clears the in-memory flag and
  returns to the prompt.

Once unlocked, build the dashboard:
- A date-range selector: Today / 7 days / 30 days / All time.
- KPI cards: total sales value and transaction count for the
  selected range, units sold in the range, and outstanding credit —
  note that outstanding credit is a live snapshot across ALL sales,
  not filtered by the range selector, and label it that way in the
  UI so it isn't misread as range-scoped.
- A 30-day daily sales trend as simple CSS bars (no charting
  library) — always last 30 days regardless of the range selector,
  labelled as such.
- Top products by revenue for the selected range.
- A "Pay-later customers" ledger: everyone with balance > 0, newest
  first, each row showing customer, item, sale total, balance owed,
  and a "Record payment" action that opens a small modal, accepts an
  amount up to the remaining balance, writes a payments record, and
  updates the sale's amount_paid/balance/payment_status. Balance
  reaching zero should flip payment_status to 'paid' and drop the
  row off the ledger on next render.

Confirm this all still works with the browser offline, and that a
wrong password is rejected without revealing whether an account
exists.
```

---

## Prompt 5 — Cloud sync (Firestore)

**Rewritten for Firestore.** The original Supabase version of this phase is
preserved in git history if you need it.

```
Phase 5: layer in Firebase Firestore sync without touching how either
screen behaves when it's unconfigured or offline.

1. Vendor the client. The npm `firebase` package ships only ES
   modules with bare specifiers, which a browser can't resolve
   without a bundler — there is no UMD build in the package to copy.
   Instead fetch these three self-contained "compat" bundles once,
   pinned to an exact version, and commit them as static files under
   js/vendor/firebase/:
     firebase-app-compat.js
     firebase-auth-compat.js
     firebase-firestore-compat.js
   They're UMD: in a browser they define window.firebase, and the
   app bundle must load FIRST because auth and firestore extend that
   same global in place. Do not reference any CDN from the app at
   runtime — fetching once now is a build step, not a dependency.
2. js/firebase-config.js: a tiny, well-commented file setting
   window.FIREBASE_CONFIG = { apiKey, authDomain, projectId,
   storageBucket, messagingSenderId, appId }, every field blank by
   default, meant to be hand-edited once after the shop creates its
   own Firebase project. Document in the comments that this web
   config is NOT a secret — Firebase's own docs treat it as public,
   and access control comes from the security rules, not from
   hiding it.
3. firebase/firestore.rules: a rules file with one match block per
   collection (products, sales, payments), each allowing read and
   write when request.auth != null, and nothing else — deny by
   omission. Add a comment explaining that every device signs in
   anonymously purely so the rules can require an authenticated
   request rather than allowing fully public access; this is the
   Firestore equivalent of gating behind an anon key, is fine for a
   small trusted-staff internal tool, and should be tightened into
   real per-staff Firebase Auth if the shop outgrows "everyone here
   is trusted".
   These rules are pasted into the Firebase console by hand. There
   is no schema to declare: Firestore is schemaless, so no tables,
   no foreign keys, no checked type columns, and no indexes to
   create (single-field indexes are automatic, and the
   where('updated_at','>',x) + orderBy('updated_at') pattern below
   queries one field so it needs no composite index).
4. js/sync.js: a Sync module that
   - No-ops cleanly whenever FIREBASE_CONFIG is blank — check this
     first, everywhere.
   - Exposes currentState() → 'no-config' | 'offline' |
     'online-syncing' | 'online-synced', and onStateChange(fn) so
     both screens can drive the sync pill.
   - Signs in anonymously once, before any Firestore read or write,
     and waits for that to complete — the rules reject unauthenticated
     requests, so firing a query first returns permission-denied.
   - On going online, on a ~25s interval, when a backgrounded tab
     becomes visible again, and after every local write in phases
     3–4, runs a sync pass: push every unsynced product/sale/payment
     (batched writes with set(..., {merge:true}), chunked below
     Firestore's 500-writes-per-batch cap; strip the local `synced`
     field before sending; mark each synced:true locally only after
     the server confirms), then pull anything changed server-side
     since the last successful pull per table (track a per-table
     "pulled since" timestamp in settings), merging with
     last-write-wins by updated_at — but never let an incoming
     remote record clobber a local edit that hasn't been pushed yet.
   - Maps any `undefined` field value to null before sending.
     Firestore rejects undefined outright, which would fail the
     whole batch.
   - Pushes tables in a fixed dependency order — products, then
     sales, then payments. Firestore has no foreign keys to violate,
     but the order means a sale another device pulls always has its
     product context, and payments never arrive detached from sales.
   - Isolates per-table failures: one collection failing must not
     abandon the tables after it in the pass. A denied collection
     (e.g. rules not yet published for a new one) should degrade to
     "that collection doesn't sync", never "nothing syncs".
   - Races every pass against a hard timeout (~20s) and resolves the
     in-flight guard in a finally step. Without this, a network call
     that never settles — a bad authDomain, a captive portal — leaves
     the "already syncing" flag set forever and silently blocks every
     future pass.
   - Never throws past its own boundary; log and continue.
5. Wire the sync pill in both screens to Sync.onStateChange, and call
   Sync.runSync() after any local write that should propagate.

Test with Firebase left unconfigured first (pill should read
something like "Offline only", nothing should break), then walk me
through creating a free Firebase project, enabling Firestore and the
Anonymous sign-in provider, publishing firestore.rules, and filling
in firebase-config.js myself, so we can verify a real sync round-trip
between two browser profiles.

IMPORTANT ordering: publish the rules BEFORE deploying code that
touches a collection. The rules file denies by omission, so a
collection without a match block is denied.
```

---

## Prompt 6 — Offline installability

```
Phase 6: make this a real installable, offline-first PWA.

1. Generate icons/icon-192.png and icons/icon-512.png — a simple,
   on-brand mark (the sunshine gold accent from the design brief),
   not a placeholder gray square.
2. manifest.json: name, short_name, start_url "index.html", display
   "standalone", the theme/background colors from the brief, and
   both icon sizes with "any maskable".
3. sw.js: cache-first for the app's own files only (both HTML pages,
   styles.css, every js file including all three vendored Firebase
   compat bundles, the manifest, both icons) on install,
   network-first-with-cache-fallback on subsequent fetches, and
   clean up old cache versions on activate. Any request that isn't a
   same-origin GET — Firestore and Firebase Auth API calls in
   particular — must pass straight through, untouched. Don't let the
   service worker intercept or cache those.
4. Register the service worker from both index.html and
   analytics.html.

Verify: load the app once online, then go fully offline and reload
— both pages should load instantly with no network errors, and a
fresh sale/product recorded while offline should still land in
IndexedDB correctly.
```

---

## Prompt 7 — QA pass and handoff docs

```
Phase 7: final hardening pass before this goes to a real shop.

1. Cross-check every getElementById()/id lookup in js/app.js and
   js/analytics.js against actual ids in index.html/analytics.html —
   fix any mismatches.
2. Confirm nothing in the codebase touches localStorage or
   sessionStorage (grep for both, should return nothing outside of
   comments). The vendored Firebase auth bundle contains its own
   storage references — that's third-party code we don't call into
   for persistence, so note it and move on rather than "fixing" it.
3. Walk through these scenarios and fix anything that breaks:
   - First-ever load with an empty database (seed data appears,
     nothing crashes).
   - A full offline session: add a product, record a paid sale and a
     pay-later sale, reload with the network off — all three
     persist.
   - Record a partial payment against a credit sale, then a second
     payment that pays it off — it should leave the pay-later ledger
     exactly when the balance hits zero.
   - Wrong analytics password, then correct password, then reload
     (should re-prompt), then log out (should re-prompt immediately).
   - Firebase left unconfigured end-to-end — no console errors, sync
     pill reads a clear "not connected" state.
4. Write README.md: what the app is, the two screens, how to host it
   for free (a static host is enough), how to set up Firebase step by
   step (create project → enable Firestore → enable Anonymous
   sign-in → publish firebase/firestore.rules → copy the web config
   into js/firebase-config.js), how to set/reset the admin password,
   and a short, honest "what this version doesn't do yet" section
   (no product photos, simple last-write-wins conflict handling,
   shop-wide rather than per-staff cloud access).

Summarize what you fixed in this phase, and flag anything you think
still needs a decision from me before this ships to the client.
```
