/* ==========================================================================
   sync.js - optional Firebase Firestore push/pull sync engine.

   Every function here no-ops cleanly when FIREBASE_CONFIG is blank, and
   every entry point catches its own errors - this module must never throw
   past its boundary or take down either screen. Sync is an enhancement
   layer on top of a fully-functional offline app, never a dependency.

   Public API is deliberately provider-agnostic (init/runSync/currentState/
   lastSyncedAt/onStateChange/onPullComplete/onDataChanged) so app.js and
   analytics.js don't know or care that this talks to Firestore rather than
   anything else - swapping backends again later only means rewriting this
   file. (It has already been swapped once, from Supabase.)
   ========================================================================== */

(function (global) {
  'use strict';

  var SYNC_INTERVAL_MS = 25000;
  var BATCH_LIMIT = 450; // Firestore's hard cap is 500 writes per batch
  var TABLES = (global.DB && global.DB.SYNCED_STORES) || ['products', 'sales', 'payments'];

  var listeners = [];
  var pullListeners = [];
  var dataChangedListeners = [];
  var currentState = 'no-config';
  var firebaseApp = null;
  var firestore = null;
  var authReadyPromise = null;
  var initialized = false;
  var syncing = false;
  var intervalHandle = null;
  var lastSyncedAt = null;

  /* ------------------------------------------------------------- state */

  function setState(next) {
    if (next === currentState) return;
    currentState = next;
    listeners.forEach(function (fn) {
      try { fn(currentState); } catch (err) { console.error('[sync] state listener failed', err); }
    });
  }

  function onStateChange(fn) {
    if (typeof fn !== 'function') return;
    listeners.push(fn);
    fn(currentState);
  }

  function onPullComplete(fn) {
    if (typeof fn === 'function') pullListeners.push(fn);
  }

  function notifyPullComplete() {
    pullListeners.forEach(function (fn) {
      try { fn(); } catch (err) { console.error('[sync] pull listener failed', err); }
    });
  }

  /* Fires only when a pull actually wrote rows into IndexedDB - not on every
     tick. onPullComplete above fires after every successful pass, which means
     a subscriber that rebuilds the DOM does so every 25 seconds forever even
     when nothing changed. Screens should prefer this one. */
  function onDataChanged(fn) {
    if (typeof fn === 'function') dataChangedListeners.push(fn);
  }

  function notifyDataChanged(counts) {
    dataChangedListeners.forEach(function (fn) {
      try { fn(counts); } catch (err) { console.error('[sync] data-changed listener failed', err); }
    });
  }

  /* Runs `fn` for every table, isolating failures: one table going wrong no
     longer abandons the tables after it in the chain. That matters most for
     a collection the Firestore rules haven't been updated for yet - without
     isolation, a single denied collection takes down sync for everything.
     Resolves with the list of failures so the caller can still report an
     unhealthy pass. */
  function forEachTable(fn) {
    var failures = [];
    return TABLES.reduce(function (chainPromise, table) {
      return chainPromise.then(function () {
        return Promise.resolve()
          .then(function () { return fn(table); })
          .catch(function (err) {
            console.error('[sync] ' + table + ' failed; continuing with other tables', err);
            failures.push({ table: table, error: err });
          });
      });
    }, Promise.resolve()).then(function () { return failures; });
  }

  /* ----------------------------------------------------------- config */

  function isConfigured() {
    var cfg = global.FIREBASE_CONFIG;
    return !!(cfg && cfg.apiKey && cfg.projectId);
  }

  function getFirestore() {
    if (firestore) return firestore;
    if (!isConfigured()) return null;
    if (!global.firebase || typeof global.firebase.initializeApp !== 'function') {
      console.warn('[sync] Firebase client library not loaded; sync disabled.');
      return null;
    }
    firebaseApp = global.firebase.apps && global.firebase.apps.length
      ? global.firebase.apps[0]
      : global.firebase.initializeApp(global.FIREBASE_CONFIG);
    firestore = global.firebase.firestore(firebaseApp);
    return firestore;
  }

  /* Every device signs in anonymously so Firestore rules can require
     request.auth != null - see firebase/firestore.rules. Not real
     per-user identity, just a floor above fully public access. */
  function ensureAuth() {
    if (authReadyPromise) return authReadyPromise;

    if (!global.firebase || typeof global.firebase.auth !== 'function') {
      authReadyPromise = Promise.resolve();
      return authReadyPromise;
    }

    var auth = global.firebase.auth(firebaseApp);
    if (auth.currentUser) {
      authReadyPromise = Promise.resolve();
      return authReadyPromise;
    }

    authReadyPromise = new Promise(function (resolve, reject) {
      var unsubscribe = auth.onAuthStateChanged(function (user) {
        if (!user) return;
        unsubscribe();
        resolve();
      });
      auth.signInAnonymously().catch(function (err) {
        unsubscribe();

        // Drop the cached promise. Without this, one failed sign-in is
        // remembered for the life of the page: a device opened on a flaky
        // connection would never attempt to authenticate again, so it
        // would never sync again either - while the pill kept promising
        // it would retry. Clearing it lets the next pass try afresh.
        authReadyPromise = null;

        var code = (err && err.code) || '';
        if (/network|timeout|internal-error/i.test(code)) {
          // Transient and self-healing: warn, don't shout. On mobile data
          // this is routine.
          console.warn('[sync] anonymous sign-in failed (' + code + '); will retry');
        } else {
          // Anything else - provider disabled, bad API key, project
          // misconfigured - will never fix itself and needs a human.
          console.error('[sync] anonymous sign-in failed', err);
        }

        // Reject rather than resolve: proceeding unauthenticated would
        // just produce permission-denied noise on every collection. The
        // pass aborts, the pill drops to offline, the next tick retries.
        reject(err);
      });
    });
    return authReadyPromise;
  }

  /* -------------------------------------------------------------- push */

  /* Strips the local-only `synced` flag before sending upstream, and swaps
     any `undefined` for `null` - Firestore rejects undefined field values
     outright, whereas every local IndexedDB record is expected to have
     every field populated (undefined would only show up from a future bug
     upstream, so this is a defensive guard, not a normal path). */
  function toRemoteRow(record) {
    var copy = {};
    Object.keys(record).forEach(function (key) {
      if (key === 'synced') return;
      copy[key] = record[key] === undefined ? null : record[key];
    });
    return copy;
  }

  function chunk(list, size) {
    var out = [];
    for (var i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  }

  function markSynced(table, rows) {
    return Promise.all(rows.map(function (row) {
      return global.DB.put(table, Object.assign({}, row, { synced: true }));
    }));
  }

  /* Seed products are written locally by every fresh device at price 0, so
     pushing them with set(merge:true) would reset whatever prices the shop
     has actually configured - once per new device or cleared browser
     profile. They go up create-if-absent instead: if the cloud already has
     the row, leave it completely alone.

     Note this can't use DocumentReference.create(), which exists in the
     Node Admin SDK but not the web client SDK - hence the transaction.

     This is only half the fix. The other half is DB.SEED_TIMESTAMP: because
     a seed's updated_at is epoch, the pull that follows always considers
     the cloud row newer and corrects this device's price-0 placeholder.
     Without that, the local copy would win last-write-wins and the device
     would sit on the wrong price forever. */
  function pushSeedRows(db, table, rows) {
    return rows.reduce(function (chainPromise, row) {
      return chainPromise.then(function () {
        var ref = db.collection(table).doc(row.id);
        return db.runTransaction(function (tx) {
          return tx.get(ref).then(function (snap) {
            if (snap.exists) return; // shop's data wins, untouched
            tx.set(ref, toRemoteRow(row));
          });
        });
      });
    }, Promise.resolve()).then(function () {
      // Either we created it or the cloud already had it. Both mean this
      // device has nothing left to push; the pull will reconcile the values.
      return markSynced(table, rows);
    });
  }

  function pushTable(table) {
    return global.DB.getUnsynced(table).then(function (allRows) {
      if (!allRows.length) return;
      var db = getFirestore();

      var seedRows = [];
      var rows = [];
      allRows.forEach(function (row) {
        if (table === 'products' && global.DB.isPristineSeed(row)) seedRows.push(row);
        else rows.push(row);
      });

      return pushSeedRows(db, table, seedRows).then(function () {
        if (!rows.length) return;

        return chunk(rows, BATCH_LIMIT).reduce(function (chainPromise, rowChunk) {
          return chainPromise.then(function () {
            var batch = db.batch();
            rowChunk.forEach(function (row) {
              batch.set(db.collection(table).doc(row.id), toRemoteRow(row), { merge: true });
            });

            // Only flip the local flag once the server has confirmed the write.
            return batch.commit().then(function () {
              return markSynced(table, rowChunk);
            });
          });
        }, Promise.resolve());
      });
    });
  }

  function pushAll() {
    // Sequential and in dependency order - products, sales, payments, then
    // stock_movements. Firestore has no foreign keys to violate, but keeping
    // the order means a sale a device sees remotely always has its product
    // context available too, payments never arrive detached from sales, and
    // a movement never arrives before the product or sale it points at.
    return forEachTable(pushTable);
  }

  /* -------------------------------------------------------------- pull */

  function pullSinceKey(table) {
    return 'sync_pulled_since_' + table;
  }

  function pullTable(table) {
    return global.DB.getSetting(pullSinceKey(table)).then(function (since) {
      var db = getFirestore();
      var query = db.collection(table).orderBy('updated_at', 'asc');
      if (since) query = query.where('updated_at', '>', since);

      return query.get().then(function (snapshot) {
        if (snapshot.empty) return 0;

        var rows = snapshot.docs.map(function (doc) {
          var data = doc.data();
          data.id = doc.id; // authoritative regardless of what's inside the document
          return data;
        });

        // Resolves 1 per row actually written, 0 per row skipped, so the
        // caller can tell "the server had newer data" from "we re-read rows
        // we already had". Only the former should wake up the screens.
        return Promise.all(rows.map(function (remote) {
          return global.DB.get(table, remote.id).then(function (local) {
            // Never let an incoming remote record clobber a local edit that
            // hasn't been pushed yet - local wins until it's synced.
            if (local && local.synced === false) return 0;

            // Otherwise, last-write-wins by updated_at.
            if (local && new Date(local.updated_at) >= new Date(remote.updated_at)) return 0;

            var merged = Object.assign({}, remote, { synced: true });
            return global.DB.put(table, merged).then(function () { return 1; });
          });
        })).then(function (written) {
          var changed = written.reduce(function (sum, n) { return sum + n; }, 0);
          var latest = rows[rows.length - 1].updated_at;
          return global.DB.setSetting(pullSinceKey(table), latest).then(function () {
            return changed;
          });
        });
      });
    });
  }

  /* Resolves { failures, changed } - changed being the number of rows this
     pull actually wrote locally, across all tables. */
  function pullAll() {
    var changed = 0;
    return forEachTable(function (table) {
      return pullTable(table).then(function (n) { changed += (n || 0); });
    }).then(function (failures) {
      return { failures: failures, changed: changed };
    });
  }

  /* A stuck network call (bad authDomain, a captive portal, a transient
     Google-side hang) must never wedge the sync engine permanently - the
     `syncing` guard below would otherwise block every future attempt
     forever. Racing every sync pass against a hard ceiling guarantees a
     rejection (caught below, falling back to 'offline') within bounded
     time no matter what the network does. */
  var SYNC_TIMEOUT_MS = 20000;

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var timer = global.setTimeout(function () {
        reject(new Error('sync timed out after ' + ms + 'ms'));
      }, ms);
      promise.then(
        function (value) { global.clearTimeout(timer); resolve(value); },
        function (err) { global.clearTimeout(timer); reject(err); }
      );
    });
  }

  /* ------------------------------------------------------------- cycle */

  function runSync() {
    if (!isConfigured()) { setState('no-config'); return Promise.resolve(); }
    if (!getFirestore()) { setState('no-config'); return Promise.resolve(); }

    if (global.navigator && global.navigator.onLine === false) {
      setState('offline');
      return Promise.resolve();
    }

    if (syncing) return Promise.resolve();
    syncing = true;
    setState('online-syncing');

    return withTimeout(
      ensureAuth()
        .then(pushAll)
        .then(function (pushFailures) {
          return pullAll().then(function (pull) {
            return { failures: pushFailures.concat(pull.failures), changed: pull.changed };
          });
        }),
      SYNC_TIMEOUT_MS
    )
      .then(function (result) {
        if (result.changed > 0) notifyDataChanged(result.changed);

        if (result.failures.length) {
          // Some tables synced, some didn't. There's no "partially synced"
          // pill state, and claiming "Synced" while a collection is silently
          // failing would be the more harmful lie - so report the pass as
          // unhealthy. The isolation above still did its job: every other
          // table's data got through instead of being abandoned mid-chain.
          console.warn('[sync] pass completed with ' + result.failures.length +
            ' failing table(s): ' + result.failures.map(function (f) { return f.table; }).join(', '));
          setState('offline');
          return;
        }

        lastSyncedAt = new Date();
        setState('online-synced');
        notifyPullComplete();
      })
      .catch(function (err) {
        // warn, not error: this path is expected and self-healing. The
        // network dropped or a pass exceeded its ceiling; the pill drops to
        // "Offline - will sync" and the next tick retries. On mobile data
        // this is routine, and logging it as an error would fill the
        // console with red during normal operation - which is exactly how
        // a genuine error gets missed later.
        console.warn('[sync] sync pass failed; will retry', err);
        // No dedicated "error" state in the pill - fall back to "offline"
        // rather than getting stuck on "syncing" forever.
        setState('offline');
      })
      .then(function () {
        syncing = false;
      });
  }

  /* --------------------------------------------------------------- init */

  function init() {
    if (initialized) return;
    initialized = true;

    if (!isConfigured()) {
      setState('no-config');
      return;
    }

    setState(global.navigator && global.navigator.onLine === false ? 'offline' : 'online-syncing');

    global.addEventListener('online', function () { runSync(); });
    global.addEventListener('offline', function () { setState('offline'); });

    // Reconnecting the network is one trigger; coming back to a backgrounded
    // tab/PWA is another - a counter tablet often sleeps and wakes rather
    // than losing connectivity outright, and this catches that case too.
    if (global.document) {
      global.document.addEventListener('visibilitychange', function () {
        if (global.document.visibilityState === 'visible') runSync();
      });
    }

    if (intervalHandle) global.clearInterval(intervalHandle);
    intervalHandle = global.setInterval(runSync, SYNC_INTERVAL_MS);

    runSync();
  }

  /* ---------------------------------------------------------------- API */

  global.Sync = {
    init: init,
    runSync: runSync,
    currentState: function () { return currentState; },
    lastSyncedAt: function () { return lastSyncedAt; },
    onStateChange: onStateChange,
    onPullComplete: onPullComplete,
    onDataChanged: onDataChanged
  };
})(window);
