/* ==========================================================================
   sync.js - optional Firebase Firestore push/pull sync engine.

   Every function here no-ops cleanly when FIREBASE_CONFIG is blank, and
   every entry point catches its own errors - this module must never throw
   past its boundary or take down either screen. Sync is an enhancement
   layer on top of a fully-functional offline app, never a dependency.

   Public API is deliberately provider-agnostic (init/runSync/currentState/
   lastSyncedAt/onStateChange/onPullComplete) so app.js and analytics.js
   don't know or care that this talks to Firestore rather than anything
   else - swapping backends again later only means rewriting this file.
   ========================================================================== */

(function (global) {
  'use strict';

  var SYNC_INTERVAL_MS = 25000;
  var BATCH_LIMIT = 450; // Firestore's hard cap is 500 writes per batch
  var TABLES = (global.DB && global.DB.SYNCED_STORES) || ['products', 'sales', 'payments'];

  var listeners = [];
  var pullListeners = [];
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

    authReadyPromise = new Promise(function (resolve) {
      var unsubscribe = auth.onAuthStateChanged(function (user) {
        if (!user) return;
        unsubscribe();
        resolve();
      });
      auth.signInAnonymously().catch(function (err) {
        console.error('[sync] anonymous sign-in failed', err);
        unsubscribe();
        resolve(); // let the Firestore calls fail loudly downstream instead of hanging forever
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

  function pushTable(table) {
    return global.DB.getUnsynced(table).then(function (rows) {
      if (!rows.length) return;
      var db = getFirestore();

      return chunk(rows, BATCH_LIMIT).reduce(function (chainPromise, rowChunk) {
        return chainPromise.then(function () {
          var batch = db.batch();
          rowChunk.forEach(function (row) {
            batch.set(db.collection(table).doc(row.id), toRemoteRow(row), { merge: true });
          });

          return batch.commit().then(function () {
            // Only flip the local flag once the server has confirmed the write.
            return Promise.all(rowChunk.map(function (row) {
              return global.DB.put(table, Object.assign({}, row, { synced: true }));
            }));
          });
        });
      }, Promise.resolve());
    });
  }

  function pushAll() {
    // Sequential and in the same order as before - products, then sales,
    // then payments. Firestore has no foreign keys to violate, but keeping
    // the order means a sale a device sees remotely always has its product
    // context available too, and payments never arrive detached from sales.
    return TABLES.reduce(function (chainPromise, table) {
      return chainPromise.then(function () { return pushTable(table); });
    }, Promise.resolve());
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
        if (snapshot.empty) return;

        var rows = snapshot.docs.map(function (doc) {
          var data = doc.data();
          data.id = doc.id; // authoritative regardless of what's inside the document
          return data;
        });

        return Promise.all(rows.map(function (remote) {
          return global.DB.get(table, remote.id).then(function (local) {
            // Never let an incoming remote record clobber a local edit that
            // hasn't been pushed yet - local wins until it's synced.
            if (local && local.synced === false) return;

            // Otherwise, last-write-wins by updated_at.
            if (local && new Date(local.updated_at) >= new Date(remote.updated_at)) return;

            var merged = Object.assign({}, remote, { synced: true });
            return global.DB.put(table, merged);
          });
        })).then(function () {
          var latest = rows[rows.length - 1].updated_at;
          return global.DB.setSetting(pullSinceKey(table), latest);
        });
      });
    });
  }

  function pullAll() {
    return TABLES.reduce(function (chainPromise, table) {
      return chainPromise.then(function () { return pullTable(table); });
    }, Promise.resolve());
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
      ensureAuth().then(pushAll).then(pullAll),
      SYNC_TIMEOUT_MS
    )
      .then(function () {
        lastSyncedAt = new Date();
        setState('online-synced');
        notifyPullComplete();
      })
      .catch(function (err) {
        console.error('[sync] sync pass failed', err);
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
    onPullComplete: onPullComplete
  };
})(window);
