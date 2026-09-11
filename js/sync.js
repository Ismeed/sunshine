/* ==========================================================================
   sync.js - optional Supabase push/pull sync engine.

   Every function here no-ops cleanly when SUPABASE_CONFIG is blank, and
   every entry point catches its own errors - this module must never throw
   past its boundary or take down either screen. Sync is an enhancement
   layer on top of a fully-functional offline app, never a dependency.
   ========================================================================== */

(function (global) {
  'use strict';

  var SYNC_INTERVAL_MS = 25000;
  var TABLES = (global.DB && global.DB.SYNCED_STORES) || ['products', 'sales', 'payments'];

  var listeners = [];
  var pullListeners = [];
  var currentState = 'no-config';
  var client = null;
  var initialized = false;
  var syncing = false;
  var intervalHandle = null;

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
    var cfg = global.SUPABASE_CONFIG;
    return !!(cfg && cfg.url && cfg.anonKey);
  }

  function getClient() {
    if (client) return client;
    if (!isConfigured()) return null;
    if (!global.supabase || typeof global.supabase.createClient !== 'function') {
      console.warn('[sync] Supabase client library not loaded; sync disabled.');
      return null;
    }
    client = global.supabase.createClient(global.SUPABASE_CONFIG.url, global.SUPABASE_CONFIG.anonKey);
    return client;
  }

  /* -------------------------------------------------------------- push */

  /* Strips the local-only `synced` flag before sending upstream. */
  function toRemoteRow(record) {
    var copy = {};
    Object.keys(record).forEach(function (key) {
      if (key === 'synced') return;
      copy[key] = record[key];
    });
    return copy;
  }

  function pushTable(table) {
    return global.DB.getUnsynced(table).then(function (rows) {
      if (!rows.length) return;
      var payload = rows.map(toRemoteRow);

      return getClient().from(table).upsert(payload, { onConflict: 'id' }).then(function (res) {
        if (res.error) throw res.error;
        // Only flip the local flag once the server has confirmed the write.
        return Promise.all(rows.map(function (row) {
          var updated = Object.assign({}, row, { synced: true });
          return global.DB.put(table, updated);
        }));
      });
    });
  }

  function pushAll() {
    // Sequential and in FK-safe order: products, then sales, then payments,
    // so payments.sale_id never references a sale the server hasn't seen yet.
    return TABLES.reduce(function (chain, table) {
      return chain.then(function () { return pushTable(table); });
    }, Promise.resolve());
  }

  /* -------------------------------------------------------------- pull */

  function pullSinceKey(table) {
    return 'sync_pulled_since_' + table;
  }

  function pullTable(table) {
    return global.DB.getSetting(pullSinceKey(table)).then(function (since) {
      var query = getClient().from(table).select('*').order('updated_at', { ascending: true });
      if (since) query = query.gt('updated_at', since);

      return query.then(function (res) {
        if (res.error) throw res.error;
        var rows = res.data || [];
        if (!rows.length) return;

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
    return TABLES.reduce(function (chain, table) {
      return chain.then(function () { return pullTable(table); });
    }, Promise.resolve());
  }

  /* ------------------------------------------------------------- cycle */

  function runSync() {
    if (!isConfigured()) { setState('no-config'); return Promise.resolve(); }
    if (!getClient()) { setState('no-config'); return Promise.resolve(); }

    if (global.navigator && global.navigator.onLine === false) {
      setState('offline');
      return Promise.resolve();
    }

    if (syncing) return Promise.resolve();
    syncing = true;
    setState('online-syncing');

    return pushAll()
      .then(pullAll)
      .then(function () {
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

    if (intervalHandle) global.clearInterval(intervalHandle);
    intervalHandle = global.setInterval(runSync, SYNC_INTERVAL_MS);

    runSync();
  }

  /* ---------------------------------------------------------------- API */

  global.Sync = {
    init: init,
    runSync: runSync,
    currentState: function () { return currentState; },
    onStateChange: onStateChange,
    onPullComplete: onPullComplete
  };
})(window);
