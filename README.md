# Sunshine Gadgets POS

A sales-recording and analytics tool for a small electronics retailer.
Plain HTML/CSS/JavaScript, no framework, no build step. Works completely
offline and syncs automatically to a shared Firebase Firestore database
when the connection is available — but Firebase is entirely optional;
the app is 100% functional without it.

The interface uses one shared design system (`css/styles.css`) with full
automatic dark mode — it follows the OS/browser `prefers-color-scheme`
setting on both screens, no toggle needed.

## How this was built

The phase-by-phase build plans live in [docs/](docs/) and are kept in sync
with the code:

- [docs/build-plan.md](docs/build-plan.md) — the original eight-phase build
  (scaffolding, data layer, both screens, cloud sync, PWA, QA).
- [docs/inventory-plan.md](docs/inventory-plan.md) — the inventory/stock
  ledger and analytics upgrade.

Both are written for the live backend (Firebase Firestore). The project
launched on Supabase and moved after a free-tier project cap blocked
provisioning; the plans were rewritten rather than left carrying
substitute-this-yourself caveats, since a doc that contradicts itself
halfway through can't be re-run.

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

This is a static site: any static host works. No server-side code, no
environment variables, no build step required to run — those only come
into play if you turn on cloud sync (next section).

### Vercel (recommended)

```
npm i -g vercel   # if you don't already have it
vercel login
vercel --prod
```

Run that from the project root — there's no `package.json`, so Vercel
auto-detects it as a static site and deploys the files as-is. The
included [vercel.json](vercel.json) sets the right cache headers so
`sw.js` and `manifest.json` always revalidate (so PWA updates actually
reach devices) while `css/`, `js/`, and icons get a short, safe cache
lifetime. Or connect the GitHub repo in the Vercel dashboard for
deploy-on-push — same result, no config to fill in.

### Other free options

- **GitHub Pages** — push this folder to a repo, enable Pages on the
  `main` branch, done.
- **Netlify / Cloudflare Pages** — drag-and-drop the folder or connect
  the repo; leave the build command blank, publish directory is the
  project root.

## Setting up cloud sync (optional)

Sync keeps every device — counter tablet, owner's phone, back-office PC
— converged on the same data. Skip this section entirely if a single
device is enough; the app works fully without it.

1. Create a free project at the [Firebase console](https://console.firebase.google.com)
   (Add project → name it → you can skip Google Analytics, it's not used).
2. **Build → Firestore Database → Create database.** Start in production
   mode (the default) and pick any region.
3. **Build → Authentication → Get started**, then enable the
   **Anonymous** sign-in provider. Every device signs in anonymously on
   load purely so Firestore's security rules can require
   `request.auth != null` instead of allowing fully public access — see
   the comment in [firebase/firestore.rules](firebase/firestore.rules).
4. Open Firestore Database → **Rules**, replace the default with the
   contents of [firebase/firestore.rules](firebase/firestore.rules), and
   **Publish**.
5. **Project settings** (gear icon) → General → "Your apps" → **Add app
   → Web (`</>`)** → register it (Firebase Hosting not needed) → copy the
   `firebaseConfig` object it shows you.
6. Open [js/firebase-config.js](js/firebase-config.js) and paste the
   values in:
   ```js
   window.FIREBASE_CONFIG = {
     apiKey: "AIza...",
     authDomain: "your-project.firebaseapp.com",
     projectId: "your-project",
     storageBucket: "your-project.appspot.com",
     messagingSenderId: "1234567890",
     appId: "1:1234567890:web:..."
   };
   ```
7. Reload the app on every device that should sync. The sync pill in the
   top bar shows the current state: *Offline only* (not configured),
   *Offline — will sync* (configured but no connection right now),
   *Syncing…*, or *Synced*.

Sync pushes unsynced records (products, then sales, then payments) as
batched Firestore writes roughly every 25 seconds, whenever the browser
comes back online, whenever the tab/PWA regains focus after being
backgrounded (a counter tablet that sleeps and wakes hits this path,
not just an actual network drop), and right after every local write.
Conflicts are resolved last-write-wins by `updated_at`, except a local
edit that hasn't been pushed yet is never overwritten by an incoming
remote record. Hover the sync pill once it reads *Synced* to see the
exact last-synced time.

The Firebase client is vendored into
[js/vendor/firebase/](js/vendor/firebase/) (the three "compat" builds —
app, auth, firestore — fetched once from Firebase's own pinned-version
distribution and committed as static files) rather than loaded from a
CDN at runtime, so the app shell never has a hard network dependency
just to load itself.

## Handing a fresh system to a shop

After trialling the app you'll want to clear out test data so the shop
starts on a genuinely blank slate. Data lives in **two** places and both
need clearing — and the order matters.

**Why the order matters:** each device keeps its own full copy in
IndexedDB. If you wipe the cloud while a test device still holds records
that never successfully synced, that device's next sync pass pushes them
straight back up and re-pollutes the database you just cleaned.

**1. Clear every device you tested on.** Easiest route, per device:

- Chrome/Edge: `F12` → **Application** tab → **Storage** → **Clear site
  data**.
- Or from the browser console on either page:
  ```js
  (async () => {
    for (const store of ['products', 'sales', 'payments', 'settings']) {
      for (const row of await DB.getAll(store)) {
        await DB.delete(store, store === 'settings' ? row.key : row.id);
      }
    }
    location.reload();
  })();
  ```

This wipes that device's products, sales, payments, its device id, its
sync bookmarks, and its analytics password hash — a true factory reset
for that device. Leave the app closed afterwards until step 2 is done.

**2. Wipe the shared cloud database.** From the console on
`index.html`, once the sync pill reads *Synced*:
```js
(async () => {
  const db = firebase.firestore();
  for (const col of ['payments', 'sales', 'products']) {
    const snap = await db.collection(col).get();
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    console.log('cleared', col, snap.size);
  }
})();
```
Delete in that order (payments → sales → products), the reverse of the
push order, so nothing is left briefly referencing a row that's already
gone.

**3. Reopen the app.** The first device to launch re-seeds the six
starter products and pushes them up, and the analytics screen shows
"Set an owner password" so the shop chooses their own. That's day one.

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

Sunshine Gadgets POS is installable, and it actively encourages it
rather than waiting for someone to find the browser menu:
[js/install.js](js/install.js) shows a slim on-brand banner ("Install
Sunshine Gadgets POS") whenever the browser signals the app is
installable (Chrome/Edge/Android's `beforeinstallprompt`) or, on iOS
Safari — which never fires that event — with manual "Add to Home
Screen" steps instead. Dismissing the banner doesn't silence it
forever: the dismissal is remembered in IndexedDB (never
`localStorage`) for 3 days, then it quietly offers again. It never
reappears once the app is actually installed (detected via
`display-mode: standalone`).

Once installed, [sw.js](sw.js) caches the app shell (`css/`, `js/`,
both HTML pages, the manifest, and the icons) cache-first on install
and network-first-with-cache-fallback after, so it loads instantly
offline and a fresh deploy still reaches installed devices. Firestore
network requests are never intercepted or cached by the service
worker — they pass straight through, since they're inherently
online-only.

## What this version doesn't do yet

Being upfront about the current limits:

- **No product photos** — icons are a curated emoji set, not uploaded
  images.
- **Simple last-write-wins conflict handling** — good enough for a small
  shop with a handful of devices, but two staff editing the very same
  record at the very same moment can still have one edit quietly lose.
  There's no merge UI.
- **Shop-wide cloud access, not per-staff** — every device signs in
  anonymously and gets identical full read/write access to all three
  collections. There's no login-per-staff-member, no audit trail of who
  recorded what beyond the `device_id` field already on every
  sale/payment. Tightening this into real per-staff Firebase Auth
  (email/password or phone, rules keyed off `request.auth.uid`) is a
  natural next step if the shop grows past "everyone here is trusted."
- **One admin password per device** — the hash is stored locally on
  each device's IndexedDB, not synced. Setting the analytics password on
  the counter tablet doesn't set it on the owner's phone; each device
  that has its own analytics.html needs its own password set once.
- **No receipt printing or barcode scanning.**
- **A brand-new device joining an already-active shop could reset a seed
  product's price.** The six starter products (`seed-phones`,
  `seed-laptops`, etc.) use fixed ids specifically so two devices seeding
  independently before either has synced converge on one shared document
  instead of creating duplicates. The trade-off: if a shop has already
  customized one of those starter products' price and *then* onboards a
  new device, that new device seeds its own fresh (price-unset) copy
  locally and — if it happens to sync before it's pulled the shop's
  existing data down first — briefly pushes that unset price over the
  customized one. In practice this only bites a shop adding devices
  after already relying on the generic starter products rather than
  their own; replacing/renaming the starter products early sidesteps it
  entirely.
