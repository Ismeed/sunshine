# Sunshine Gadgets POS

A sales-recording and analytics tool for a small electronics retailer.
Plain HTML/CSS/JavaScript, no framework, no build step. Works completely
offline and syncs automatically to a shared Supabase database when the
connection is available — but Supabase is entirely optional; the app is
100% functional without it.

## The two screens

- **Sales** ([index.html](index.html)) — counter staff. Browse and search
  products, add new products on the fly, and record a sale as *Paid now*
  or *Pay later*. Pay-later sales capture a customer name (required) and
  phone (optional) and track a running balance.
- **Analytics** ([analytics.html](analytics.html)) — the owner, behind
  its own password, completely separate from the sales screen. Revenue
  and transaction counts by date range, a 30-day sales trend, top products,
  and a pay-later ledger with a "record payment" action for partial or
  full settlement.

Data lives in IndexedDB on each device (`sunshine_pos_db`). Nothing in
this app ever touches `localStorage` or `sessionStorage`, including the
analytics unlock state — see "Admin password" below.

## Hosting it

This is a static site: any static host works. Two free options:

- **GitHub Pages** — push this folder to a repo, enable Pages on the
  `main` branch, done.
- **Netlify / Vercel / Cloudflare Pages** — drag-and-drop the folder or
  connect the repo; no build command needed (leave the build command
  blank, publish directory is the project root).

No server-side code, no environment variables required to run — those
only come into play if you turn on cloud sync (next section).

## Setting up cloud sync (optional)

Sync keeps every device — counter tablet, owner's phone, back-office PC
— converged on the same data. Skip this section entirely if a single
device is enough; the app works fully without it.

1. Create a free project at [supabase.com](https://supabase.com).
2. Open **SQL Editor** in the Supabase dashboard, paste the contents of
   [supabase/schema.sql](supabase/schema.sql), and run it. This creates
   the `products`, `sales`, and `payments` tables with row-level security
   enabled and a permissive "any request with the anon key" policy —
   appropriate for a small trusted-staff tool (see the comment in the
   schema file for what to tighten later).
3. In **Project Settings → API**, copy the **Project URL** and the
   **anon public** key. Never use the `service_role` key here — it must
   never appear in client-side code.
4. Open [js/supabase-config.js](js/supabase-config.js) and fill in both
   fields:
   ```js
   window.SUPABASE_CONFIG = {
     url: "https://xxxxxxxx.supabase.co",
     anonKey: "eyJ..."
   };
   ```
5. Reload the app on every device that should sync. The sync pill in the
   top bar shows the current state: *Offline only* (not configured),
   *Offline — will sync* (configured but no connection right now),
   *Syncing…*, or *Synced*.

Sync pushes unsynced records (products, then sales, then payments — that
order matters, so a payment's `sale_id` never references a sale the
server hasn't seen yet) roughly every 25 seconds, whenever the browser
comes back online, and right after every local write. Conflicts are
resolved last-write-wins by `updated_at`, except a local edit that
hasn't been pushed yet is never overwritten by an incoming remote
record.

The Supabase JS client is vendored into [js/vendor/supabase.js](js/vendor/supabase.js)
(copied from the npm package's UMD build) rather than loaded from a CDN,
so the app shell never has a hard network dependency just to load itself.

## Admin password

The Analytics screen is gated by a password that's set on first use and
stored only as a SHA-256 hash in IndexedDB (`settings` store, key
`admin_password_hash`) — never the plaintext.

- **First time**: visiting analytics.html with no password set shows a
  "set a password" form instead of a login prompt.
- **Every reload re-prompts.** The unlocked state is held in a plain
  in-memory JavaScript variable, deliberately not persisted anywhere —
  this is intentional (see the comment at the top of
  [js/analytics.js](js/analytics.js)), not a bug to "fix". Closing the
  tab or refreshing the page locks it again.
- **To reset a forgotten password**, open the browser console on
  analytics.html and run:
  ```js
  DB.setSetting('admin_password_hash', null).then(() => location.reload());
  ```
  This clears the stored hash and brings back the "set a password" form
  on reload. It does not touch sales, product, or payment data.

## Installing as an app (PWA)

Sunshine Gadgets POS is installable. Open index.html in a browser that
supports PWAs (Chrome, Edge, most Android browsers), and use the
browser's "Install app" / "Add to Home Screen" option. Once installed,
[sw.js](sw.js) caches the app shell (`css/`, `js/`, both HTML pages, the
manifest, and the icons) so it loads instantly offline. Supabase network
requests are never intercepted or cached by the service worker — they
pass straight through, since they're inherently online-only.

## What this version doesn't do yet

Being upfront about the current limits:

- **No product photos** — icons are a curated emoji set, not uploaded
  images.
- **Simple last-write-wins conflict handling** — good enough for a small
  shop with a handful of devices, but two staff editing the very same
  record at the very same moment can still have one edit quietly lose.
  There's no merge UI.
- **Shop-wide cloud access, not per-staff** — every device shares one
  Supabase `anon` key with full read/write access to all tables. There's
  no login-per-staff-member, no audit trail of who recorded what beyond
  the `device_id` field already on every sale/payment. Tightening this
  into real per-staff Supabase Auth policies is a natural next step if
  the shop grows past "everyone here is trusted."
- **One admin password per device** — the hash is stored locally on
  each device's IndexedDB, not synced. Setting the analytics password on
  the counter tablet doesn't set it on the owner's phone; each device
  that has its own analytics.html needs its own password set once.
- **No receipt printing or barcode scanning.**
