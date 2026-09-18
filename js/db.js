/* ==========================================================================
   db.js - the offline data layer for Sunshine Gadgets POS.
   Every screen writes through here. IndexedDB only: this app deliberately
   never touches localStorage or sessionStorage, for anything.
   Exposed as window.DB.
   ========================================================================== */

(function (global) {
  'use strict';

  var DB_NAME = 'sunshine_pos_db';

  /* Bump this whenever STORES gains a store or an index. onupgradeneeded
     only fires when the requested version exceeds the one already stored on
     the device, so shipping a new store without bumping means every device
     that already has this database - i.e. every device already in the shop's
     hands - silently never receives it, and every call against it throws.
     v2 added: stock_movements. */
  var DB_VERSION = 2;

  /* Fallback low-stock threshold for products that don't set their own
     (product.low_stock_threshold is nullable and means "use this"). */
  var LOW_STOCK_DEFAULT = 5;

  var MOVEMENT_TYPES = ['initial', 'restock', 'sale', 'adjustment'];

  /* Seed rows are stamped with this instead of the current time, and it does
     two jobs.

     1. It makes any real row beat a seed on last-write-wins, so a fresh
        device's placeholder copy is always corrected by the shop's actual
        data on the next pull rather than winning because it was written
        seconds ago.
     2. It doubles as the "never been edited" marker - see isPristineSeed()
        below - with no extra flag to keep in sync.

     A seed is a local default, not an event that happened at a point in
     time, so an epoch timestamp is honest rather than a hack. */
  var SEED_TIMESTAMP = '1970-01-01T00:00:00.000Z';

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
    /* Append-only stock ledger. Rows are never edited after creation, so
       updated_at always equals created_at. Stock on hand is derived by
       summing quantity_delta - deliberately never stored as a mutable
       counter on the product, because a counter is last-write-wins state
       and two offline devices would silently overwrite each other's count.
       Summation is order-independent and every row upserts idempotently by
       its own id, so the total is correct no matter what order rows sync
       in or how long a device stayed offline. */
    stock_movements: {
      keyPath: 'id',
      indexes: ['product_id', 'synced', 'created_at']
    },
    settings: {
      keyPath: 'key',
      indexes: []
    }
  };

  /* Tables that participate in cloud sync, in dependency-safe push order:
     movements can reference both a product and a sale, so they go last. */
  var SYNCED_STORES = ['products', 'sales', 'payments', 'stock_movements'];

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

  /* --------------------------------------------------------- stock ledger */

  /* Derives stock on hand for every product that has any movement history.
     Returns a Map keyed by product_id: { tracked: true, onHand: <signed> }.

     A product with NO movements is deliberately absent from the map rather
     than present with tracked:false - absence is what "untracked" means, and
     this helper only reads the movements store, so it has no product list to
     enumerate. Callers should treat a missing entry as untracked:

       var level = levels.get(product.id);
       var tracked = !!level;             // untracked -> sells as it always has
       var onHand = tracked ? level.onHand : null;

     onHand is NOT clamped at zero. A negative total is real information - it
     means more units were sold than were ever stocked, which genuinely can
     happen when two offline devices both sell the last unit before either
     syncs. Clamp for display only; never hide it in the data. */
  function getStockLevels() {
    var levels = new Map();
    return transact('stock_movements', 'readonly', function (store) {
      store.openCursor().onsuccess = function (event) {
        var cursor = event.target.result;
        if (!cursor) return;
        var row = cursor.value;
        if (row && row.product_id) {
          var entry = levels.get(row.product_id);
          if (!entry) {
            entry = { tracked: true, onHand: 0 };
            levels.set(row.product_id, entry);
          }
          entry.onHand += Number(row.quantity_delta) || 0;
        }
        cursor.continue();
      };
    }).then(function () { return levels; });
  }

  /* Appends one movement row. Never updates an existing row - that's the
     whole point of the ledger. */
  function recordStockMovement(input) {
    if (!input || !input.product_id) {
      return Promise.reject(new Error('recordStockMovement: product_id is required'));
    }
    if (MOVEMENT_TYPES.indexOf(input.type) === -1) {
      return Promise.reject(new Error(
        'recordStockMovement: type must be one of ' + MOVEMENT_TYPES.join(', ')
      ));
    }
    var delta = Number(input.quantity_delta);
    if (!isFinite(delta) || delta === 0) {
      return Promise.reject(new Error('recordStockMovement: quantity_delta must be a non-zero number'));
    }

    return getDeviceId().then(function (deviceId) {
      var ts = nowISO();
      var row = {
        id: newId(),
        product_id: input.product_id,
        type: input.type,
        quantity_delta: delta,
        note: input.note || '',
        related_sale_id: input.related_sale_id || null,
        created_at: ts,
        updated_at: ts, // never edited after creation - always equals created_at
        synced: false,
        device_id: deviceId
      };
      return put('stock_movements', row).then(function () { return row; });
    });
  }

  /* ----------------------------------------------------------- seed data */

  /* default_price 0 is the app-wide convention for "not set - ask at sale
     time". Every screen that renders or prefills a price honours it.

     Seed ids are stable/deterministic ('seed-phones', not a random UUID) on
     purpose: two devices that both happen to be configured for the first
     time before either has ever synced would otherwise each generate their
     own random UUID for "Laptop", "Phone case", etc., and once cloud sync
     connects both, the shared database ends up with duplicate starter
     products. A fixed id per category means every device's first-run seed
     converges on the same document instead of creating a sibling. */
  var SEEDS = [
    { id: 'seed-phones',        name: 'Smartphone',        category: 'Phones',        icon: '📱' },
    { id: 'seed-laptops',       name: 'Laptop',            category: 'Laptops',       icon: '💻' },
    { id: 'seed-chargers',      name: 'Phone charger',     category: 'Chargers',      icon: '🔌' },
    { id: 'seed-screen-guards', name: 'Screen guard',      category: 'Screen Guards', icon: '🛡️' },
    { id: 'seed-speakers',      name: 'Bluetooth speaker', category: 'Speakers',      icon: '🔊' },
    { id: 'seed-cases',         name: 'Phone case',        category: 'Cases',         icon: '📦' }
  ];

  var SEED_IDS = SEEDS.map(function (s) { return s.id; });

  /* True while a seed row is still exactly as ensureSeedData() wrote it.
     Any genuine edit stamps a real updated_at, which both ends this and
     makes the row push normally. Nothing to remember to clear, so no future
     write path can forget to. */
  function isPristineSeed(row) {
    return !!row &&
           SEED_IDS.indexOf(row.id) !== -1 &&
           row.updated_at === SEED_TIMESTAMP;
  }

  function ensureSeedData() {
    var existing = 0;
    return transact('products', 'readonly', function (store) {
      store.count().onsuccess = function (event) { existing = event.target.result; };
    }).then(function () {
      if (existing > 0) return { seeded: false, count: existing };

      var rows = SEEDS.map(function (seed) {
        return {
          id: seed.id,
          name: seed.name,
          category: seed.category,
          icon: seed.icon,
          default_price: 0,
          low_stock_threshold: null, // null = fall back to LOW_STOCK_DEFAULT
          deleted: false,
          created_at: SEED_TIMESTAMP,
          updated_at: SEED_TIMESTAMP,
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
    LOW_STOCK_DEFAULT: LOW_STOCK_DEFAULT,
    MOVEMENT_TYPES: MOVEMENT_TYPES,
    SEED_TIMESTAMP: SEED_TIMESTAMP,
    isPristineSeed: isPristineSeed,

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
    ensureSeedData: ensureSeedData,

    getStockLevels: getStockLevels,
    recordStockMovement: recordStockMovement
  };
})(window);
