/* ==========================================================================
   db.js - the offline data layer for Sunshine Gadgets POS.
   Every screen writes through here. IndexedDB only: this app deliberately
   never touches localStorage or sessionStorage, for anything.
   Exposed as window.DB.
   ========================================================================== */

(function (global) {
  'use strict';

  var DB_NAME = 'sunshine_pos_db';
  var DB_VERSION = 1;

  /* Store definitions. Note on the `synced` indexes: IndexedDB keys may not
     be booleans, so an index over a boolean field indexes nothing. We still
     declare it because the schema calls for it (and it costs nothing), but
     getUnsynced() deliberately cursors the store and filters in JS instead of
     trusting that index. If `synced` ever becomes 0/1, the index starts
     working and getUnsynced() can be switched over. */
  var STORES = {
    products: {
      keyPath: 'id',
      indexes: ['category', 'updated_at', 'synced']
    },
    sales: {
      keyPath: 'id',
      indexes: ['sold_at', 'payment_status', 'updated_at', 'synced']
    },
    payments: {
      keyPath: 'id',
      indexes: ['sale_id', 'synced']
    },
    settings: {
      keyPath: 'key',
      indexes: []
    }
  };

  /* Tables that participate in cloud sync, in foreign-key-safe push order. */
  var SYNCED_STORES = ['products', 'sales', 'payments'];

  var dbPromise = null;

  /* ---------------------------------------------------------------- open */

  function open() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise(function (resolve, reject) {
      if (!global.indexedDB) {
        reject(new Error('IndexedDB is not available in this browser.'));
        return;
      }

      var req = global.indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = function (event) {
        var db = req.result;
        var tx = event.target.transaction;

        Object.keys(STORES).forEach(function (name) {
          var def = STORES[name];
          var store = db.objectStoreNames.contains(name)
            ? tx.objectStore(name)
            : db.createObjectStore(name, { keyPath: def.keyPath });

          def.indexes.forEach(function (field) {
            if (!store.indexNames.contains(field)) {
              store.createIndex(field, field, { unique: false });
            }
          });
        });
      };

      req.onsuccess = function () {
        var db = req.result;
        db.onversionchange = function () { db.close(); dbPromise = null; };
        resolve(db);
      };

      req.onerror = function () { reject(req.error); };
      req.onblocked = function () {
        reject(new Error('IndexedDB upgrade blocked - close other tabs of this app.'));
      };
    });

    return dbPromise;
  }

  /* ------------------------------------------------------------ plumbing */

  /* Runs `work(store)` inside one transaction and resolves with whatever
     `work` hands back, but only once the transaction actually commits. */
  function transact(storeName, mode, work) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeName, mode);
        var result;
        var failed = false;

        tx.oncomplete = function () { if (!failed) resolve(result); };
        tx.onerror = function () { failed = true; reject(tx.error); };
        tx.onabort = function () { failed = true; reject(tx.error || new Error('Transaction aborted')); };

        try {
          result = work(tx.objectStore(storeName), tx);
        } catch (err) {
          failed = true;
          try { tx.abort(); } catch (e) { /* already dead */ }
          reject(err);
        }
      });
    });
  }

  function assertStore(name) {
    if (!Object.prototype.hasOwnProperty.call(STORES, name)) {
      throw new Error('Unknown object store: ' + name);
    }
  }

  /* --------------------------------------------------------------- CRUD */

  function getAll(storeName) {
    assertStore(storeName);
    var out = [];
    return transact(storeName, 'readonly', function (store) {
      store.getAll().onsuccess = function (event) { out = event.target.result || []; };
    }).then(function () { return out; });
  }

  function get(storeName, id) {
    assertStore(storeName);
    var out;
    return transact(storeName, 'readonly', function (store) {
      store.get(id).onsuccess = function (event) { out = event.target.result; };
    }).then(function () { return out; });
  }

  function put(storeName, record) {
    assertStore(storeName);
    return transact(storeName, 'readwrite', function (store) {
      store.put(record);
    }).then(function () { return record; });
  }

  function bulkPut(storeName, records) {
    assertStore(storeName);
    if (!records || !records.length) return Promise.resolve([]);
    return transact(storeName, 'readwrite', function (store) {
      records.forEach(function (record) { store.put(record); });
    }).then(function () { return records; });
  }

  function remove(storeName, id) {
    assertStore(storeName);
    return transact(storeName, 'readwrite', function (store) {
      store.delete(id);
    }).then(function () { return id; });
  }

  /* Records that still need pushing to the cloud. Cursor-scanned rather than
     index-ranged - see the note on boolean keys at the top of this file. */
  function getUnsynced(storeName) {
    assertStore(storeName);
    var out = [];
    return transact(storeName, 'readonly', function (store) {
      store.openCursor().onsuccess = function (event) {
        var cursor = event.target.result;
        if (!cursor) return;
        if (cursor.value && cursor.value.synced === false) out.push(cursor.value);
        cursor.continue();
      };
    }).then(function () { return out; });
  }

  /* ------------------------------------------------------------ settings */

  function getSetting(key) {
    return get('settings', key).then(function (row) {
      return row ? row.value : undefined;
    });
  }

  function setSetting(key, value) {
    return put('settings', { key: key, value: value }).then(function () { return value; });
  }

  /* ------------------------------------------------------------- helpers */

  function newId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    // Fallback for older/insecure-context browsers: RFC 4122 v4 shape,
    // seeded from crypto.getRandomValues when available.
    var bytes = new Uint8Array(16);
    if (global.crypto && global.crypto.getRandomValues) {
      global.crypto.getRandomValues(bytes);
    } else {
      for (var i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var hex = [];
    for (var j = 0; j < 16; j++) hex.push((bytes[j] + 0x100).toString(16).slice(1));
    return hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-' +
           hex.slice(6, 8).join('') + '-' + hex.slice(8, 10).join('') + '-' +
           hex.slice(10, 16).join('');
  }

  function nowISO() {
    return new Date().toISOString();
  }

  var deviceIdPromise = null;

  function getDeviceId() {
    if (deviceIdPromise) return deviceIdPromise;
    deviceIdPromise = getSetting('device_id').then(function (existing) {
      if (existing) return existing;
      var id = newId();
      return setSetting('device_id', id).then(function () { return id; });
    }).catch(function (err) {
      deviceIdPromise = null;
      throw err;
    });
    return deviceIdPromise;
  }

  /* ----------------------------------------------------------- seed data */

  /* default_price 0 is the app-wide convention for "not set - ask at sale
     time". Every screen that renders or prefills a price honours it. */
  var SEEDS = [
    { name: 'Smartphone',        category: 'Phones',        icon: '📱' },
    { name: 'Laptop',            category: 'Laptops',       icon: '💻' },
    { name: 'Phone charger',     category: 'Chargers',      icon: '🔌' },
    { name: 'Screen guard',      category: 'Screen Guards', icon: '🛡️' },
    { name: 'Bluetooth speaker', category: 'Speakers',      icon: '🔊' },
    { name: 'Phone case',        category: 'Cases',         icon: '📦' }
  ];

  function ensureSeedData() {
    var existing = 0;
    return transact('products', 'readonly', function (store) {
      store.count().onsuccess = function (event) { existing = event.target.result; };
    }).then(function () {
      if (existing > 0) return { seeded: false, count: existing };

      var ts = nowISO();
      var rows = SEEDS.map(function (seed) {
        return {
          id: newId(),
          name: seed.name,
          category: seed.category,
          icon: seed.icon,
          default_price: 0,
          deleted: false,
          created_at: ts,
          updated_at: ts,
          synced: false
        };
      });

      return bulkPut('products', rows).then(function () {
        return { seeded: true, count: rows.length };
      });
    });
  }

  /* ---------------------------------------------------------------- API */

  global.DB = {
    NAME: DB_NAME,
    VERSION: DB_VERSION,
    SYNCED_STORES: SYNCED_STORES,

    open: open,
    getAll: getAll,
    get: get,
    put: put,
    bulkPut: bulkPut,
    delete: remove,
    getUnsynced: getUnsynced,
    getSetting: getSetting,
    setSetting: setSetting,

    newId: newId,
    nowISO: nowISO,
    getDeviceId: getDeviceId,
    ensureSeedData: ensureSeedData
  };
})(window);
