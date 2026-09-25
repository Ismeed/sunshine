/* ==========================================================================
   app.js - Sales screen. Reads and writes exclusively through DB (IndexedDB);
   Sync, when configured, is fire-and-forget on top of a completed local write.
   ========================================================================== */

(function (global) {
  'use strict';

  var doc = global.document;

  /* ----------------------------------------------------------- elements */

  var el = {
    syncPill:      doc.getElementById('syncPill'),
    syncText:      doc.getElementById('syncText'),

    todayDate:     doc.getElementById('todayDate'),
    todayRevenue:  doc.getElementById('todayRevenue'),
    todayCount:    doc.getElementById('todayCount'),
    todayCredit:   doc.getElementById('todayCredit'),
    recentList:    doc.getElementById('recentList'),

    productCount:  doc.getElementById('productCount'),
    searchInput:   doc.getElementById('searchInput'),
    newProductBtn: doc.getElementById('newProductBtn'),
    categoryChips: doc.getElementById('categoryChips'),
    productGrid:   doc.getElementById('productGrid'),
    productEmpty:  doc.getElementById('productEmpty'),

    productModal:      doc.getElementById('productModal'),
    productModalClose: doc.getElementById('productModalClose'),
    productForm:       doc.getElementById('productForm'),
    pmName:            doc.getElementById('pmName'),
    pmNameError:       doc.getElementById('pmNameError'),
    pmCategory:        doc.getElementById('pmCategory'),
    pmNewCategoryWrap: doc.getElementById('pmNewCategoryWrap'),
    pmNewCategory:     doc.getElementById('pmNewCategory'),
    pmCategoryError:   doc.getElementById('pmCategoryError'),
    pmPrice:           doc.getElementById('pmPrice'),
    pmPriceError:      doc.getElementById('pmPriceError'),
    pmStartingStock:      doc.getElementById('pmStartingStock'),
    pmStartingStockError: doc.getElementById('pmStartingStockError'),
    pmLowStockThreshold:      doc.getElementById('pmLowStockThreshold'),
    pmLowStockThresholdError: doc.getElementById('pmLowStockThresholdError'),
    pmIconPicker:      doc.getElementById('pmIconPicker'),
    pmCancel:          doc.getElementById('pmCancel'),
    pmSubmit:          doc.getElementById('pmSubmit'),

    salePanel:      doc.getElementById('salePanel'),
    salePanelClose: doc.getElementById('salePanelClose'),
    saleForm:       doc.getElementById('saleForm'),
    spIcon:         doc.getElementById('spIcon'),
    spName:         doc.getElementById('spName'),
    spCat:          doc.getElementById('spCat'),
    saleQty:        doc.getElementById('saleQty'),
    qtyMinus:       doc.getElementById('qtyMinus'),
    qtyPlus:        doc.getElementById('qtyPlus'),
    saleQtyHint:    doc.getElementById('saleQtyHint'),
    saleQtyError:   doc.getElementById('saleQtyError'),
    salePrice:      doc.getElementById('salePrice'),
    salePriceError: doc.getElementById('salePriceError'),
    saleNote:       doc.getElementById('saleNote'),
    modePaid:       doc.getElementById('modePaid'),
    modeCredit:     doc.getElementById('modeCredit'),
    creditFields:   doc.getElementById('creditFields'),
    custName:       doc.getElementById('custName'),
    custNameError:  doc.getElementById('custNameError'),
    custPhone:      doc.getElementById('custPhone'),
    saleTotal:      doc.getElementById('saleTotal'),
    saleSubmit:     doc.getElementById('saleSubmit'),

    stockModal:      doc.getElementById('stockModal'),
    stockModalClose: doc.getElementById('stockModalClose'),
    stockForm:       doc.getElementById('stockForm'),
    smIcon:          doc.getElementById('smIcon'),
    smName:          doc.getElementById('smName'),
    smCat:           doc.getElementById('smCat'),
    smQty:           doc.getElementById('smQty'),
    smQtyError:      doc.getElementById('smQtyError'),
    smNote:          doc.getElementById('smNote'),
    smCancel:        doc.getElementById('smCancel'),
    smSubmit:        doc.getElementById('smSubmit'),

    toastStack:     doc.getElementById('toastStack')
  };

  /* -------------------------------------------------------------- state */

  var state = {
    products: [],
    sales: [],
    stockLevels: new Map(), // product_id -> { tracked, onHand }, from DB.getStockLevels()
    category: 'All',
    search: '',
    activeProduct: null,
    stockProduct: null,
    paymentMode: 'paid',
    selectedIcon: '📦',
    deviceId: null,
    lastFocus: null
  };

  /* In-flight guards. Every write handler locks synchronously before its
     first await, so a double-tap (easy on a touch screen) can't run the
     same write twice. The disabled attribute gives the user feedback; this
     flag is what actually makes it safe, since it also covers Enter-key
     submits and any path that doesn't go through the button. */
  var busy = { product: false, sale: false, stock: false };

  var ICONS = [
    '📱', '💻', '🖥️', '⌚', '🎧', '🔊', '🔌', '🔋', '🪫',
    '🛡️', '📦', '⌨️', '🖱️', '📷', '💾', '📶', '🔦', '🧰'
  ];

  var NEW_CATEGORY = '__new__';

  /* ------------------------------------------------------------ helpers */

  var nf = new Intl.NumberFormat('en-NG', { maximumFractionDigits: 2 });

  function money(value) {
    var n = Number(value) || 0;
    return '₦' + nf.format(n);
  }

  function node(tag, className, text) {
    var n = doc.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  function clear(parent) {
    while (parent.firstChild) parent.removeChild(parent.firstChild);
  }

  function startOfToday() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function toast(message, kind) {
    var t = node('div', 'toast' + (kind ? ' toast-' + kind : ''), message);
    el.toastStack.appendChild(t);
    global.setTimeout(function () {
      t.classList.add('is-out');
      global.setTimeout(function () {
        if (t.parentNode) t.parentNode.removeChild(t);
      }, 200);
    }, 2600);
  }

  function setError(input, errorEl, shown) {
    if (input) input.classList.toggle('is-invalid', !!shown);
    if (errorEl) errorEl.classList.toggle('is-shown', !!shown);
  }

  function clearErrors(scope) {
    var i;
    var invalid = scope.querySelectorAll('.is-invalid');
    for (i = 0; i < invalid.length; i++) invalid[i].classList.remove('is-invalid');
    var errors = scope.querySelectorAll('.field-error.is-shown');
    for (i = 0; i < errors.length; i++) errors[i].classList.remove('is-shown');
  }

  /* Ask Sync to push, if it exists and is configured. Never blocks the UI and
     never surfaces an error - the local write already succeeded. */
  function nudgeSync() {
    if (global.Sync && typeof global.Sync.runSync === 'function') {
      global.Sync.runSync();
    }
  }

  /* --------------------------------------------------------- sync pill */

  var SYNC_LABELS = {
    'no-config':      'Offline only',
    'offline':        'Offline — will sync',
    'online-syncing': 'Syncing…',
    'online-synced':  'Synced'
  };

  function renderSyncPill(state_) {
    if (!el.syncPill) return;
    el.syncPill.setAttribute('data-state', state_);
    el.syncText.textContent = SYNC_LABELS[state_] || state_;

    if (state_ === 'no-config') {
      el.syncPill.title = 'Cloud sync is not configured. Everything is saved on this device.';
      return;
    }
    if (state_ === 'online-synced' && global.Sync && global.Sync.lastSyncedAt()) {
      el.syncPill.title = 'Last synced ' + global.Sync.lastSyncedAt().toLocaleTimeString();
      return;
    }
    el.syncPill.title = SYNC_LABELS[state_];
  }

  /* ------------------------------------------------------------- render */

  function todaysSales() {
    var from = startOfToday().getTime();
    return state.sales.filter(function (s) {
      return new Date(s.sold_at).getTime() >= from;
    });
  }

  function renderRail() {
    var today = todaysSales();
    var revenue = 0;
    var credit = 0;

    today.forEach(function (s) {
      revenue += Number(s.total) || 0;
      if (s.payment_status === 'credit') credit += Number(s.balance) || 0;
    });

    el.todayDate.textContent = new Date().toLocaleDateString(undefined, {
      weekday: 'long', day: 'numeric', month: 'long'
    });
    el.todayRevenue.textContent = money(revenue);
    el.todayCount.textContent = String(today.length);
    el.todayCredit.textContent = money(credit);

    clear(el.recentList);
    var recent = state.sales.slice()
      .sort(function (a, b) { return new Date(b.sold_at) - new Date(a.sold_at); })
      .slice(0, 6);

    if (!recent.length) {
      var li = node('li');
      li.appendChild(node('span', 'rl-name', 'No sales recorded yet'));
      el.recentList.appendChild(li);
      return;
    }

    recent.forEach(function (s) {
      var row = node('li');
      var name = node('span', 'rl-name', s.quantity > 1
        ? s.product_name + ' ×' + s.quantity
        : s.product_name);
      var val = node('span', 'rl-val', money(s.total));
      if (s.payment_status === 'credit') val.style.color = 'var(--credit)';
      row.appendChild(name);
      row.appendChild(val);
      el.recentList.appendChild(row);
    });
  }

  function categories() {
    var seen = {};
    var out = [];
    state.products.forEach(function (p) {
      if (p.deleted) return;
      if (p.category && !seen[p.category]) {
        seen[p.category] = true;
        out.push(p.category);
      }
    });
    out.sort(function (a, b) { return a.localeCompare(b); });
    return out;
  }

  function renderChips() {
    var list = ['All'].concat(categories());
    if (list.indexOf(state.category) === -1) state.category = 'All';

    clear(el.categoryChips);
    list.forEach(function (name) {
      var chip = node('button', 'chip', name);
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(name === state.category));
      chip.addEventListener('click', function () {
        state.category = name;
        renderChips();
        renderGrid();
      });
      el.categoryChips.appendChild(chip);
    });
  }

  function visibleProducts() {
    var term = state.search.trim().toLowerCase();
    return state.products.filter(function (p) {
      if (p.deleted) return false;
      if (state.category !== 'All' && p.category !== state.category) return false;
      if (!term) return true;
      return (p.name || '').toLowerCase().indexOf(term) !== -1 ||
             (p.category || '').toLowerCase().indexOf(term) !== -1;
    }).sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
  }

  function renderGrid() {
    var list = visibleProducts();
    var total = state.products.filter(function (p) { return !p.deleted; }).length;

    el.productCount.textContent = list.length === total
      ? total + (total === 1 ? ' product' : ' products')
      : list.length + ' of ' + total;

    clear(el.productGrid);
    el.productEmpty.hidden = list.length > 0;

    list.forEach(function (p) {
      var container = node('div', 'product-tile');

      var main = node('button', 'tile-main');
      main.type = 'button';

      var icon = node('span', 'tile-icon', p.icon || '📦');
      icon.setAttribute('aria-hidden', 'true');
      main.appendChild(icon);
      main.appendChild(node('span', 'tile-name', p.name));
      main.appendChild(node('span', 'tile-cat', p.category || 'Uncategorised'));

      var price = Number(p.default_price) || 0;
      main.appendChild(price > 0
        ? node('span', 'tile-price', money(price))
        : node('span', 'tile-price is-unset', 'Set price at sale'));

      var badge = stockBadge(p);
      if (badge) main.appendChild(badge);

      main.addEventListener('click', function () { openSalePanel(p, main); });
      container.appendChild(main);

      // A second, sibling button - not nested inside `main` - since a
      // <button> can't contain another <button>.
      var stockBtn = node('button', 'tile-stock-btn', '+ Stock');
      stockBtn.type = 'button';
      stockBtn.setAttribute('aria-label', 'Add stock to ' + p.name);
      stockBtn.addEventListener('click', function () { openStockModal(p, stockBtn); });
      container.appendChild(stockBtn);

      el.productGrid.appendChild(container);
    });
  }

  /* Returns a badge element for a tracked product's stock level, or null
     for an untracked one - untracked products show nothing, unchanged from
     before this feature shipped. Display is clamped at 0; the underlying
     sum can go negative (two offline devices both selling the last unit)
     and that stays true in the data, it just isn't shown as a negative
     number to staff. */
  function stockBadge(product) {
    var level = state.stockLevels.get(product.id);
    if (!level) return null;

    var threshold = (product.low_stock_threshold != null)
      ? product.low_stock_threshold
      : DB.LOW_STOCK_DEFAULT;
    var display = Math.max(0, level.onHand);

    var cls, text;
    if (level.onHand <= 0) {
      cls = 'badge-danger'; text = 'Out of stock';
    } else if (level.onHand <= threshold) {
      cls = 'badge-credit'; text = 'Low stock: ' + display;
    } else {
      cls = 'badge-paid'; text = display + ' in stock';
    }

    return node('span', 'badge tile-stock-badge ' + cls, text);
  }

  function refresh() {
    return Promise.all([DB.getAll('products'), DB.getAll('sales'), DB.getStockLevels()])
      .then(function (results) {
        state.products = results[0];
        state.sales = results[1];
        state.stockLevels = results[2];
        renderRail();
        renderChips();
        renderGrid();
      });
  }

  /* -------------------------------------------------- new product modal */

  function renderIconPicker() {
    clear(el.pmIconPicker);
    ICONS.forEach(function (icon) {
      var btn = node('button', 'icon-choice', icon);
      btn.type = 'button';
      btn.setAttribute('aria-pressed', String(icon === state.selectedIcon));
      btn.setAttribute('aria-label', 'Icon ' + icon);
      btn.addEventListener('click', function () {
        state.selectedIcon = icon;
        renderIconPicker();
      });
      el.pmIconPicker.appendChild(btn);
    });
  }

  function renderCategorySelect() {
    clear(el.pmCategory);
    var cats = categories();

    if (!cats.length) {
      var placeholder = node('option', null, 'No categories yet');
      placeholder.value = '';
      placeholder.disabled = true;
      el.pmCategory.appendChild(placeholder);
    }

    cats.forEach(function (name) {
      var opt = node('option', null, name);
      opt.value = name;
      el.pmCategory.appendChild(opt);
    });

    var addNew = node('option', null, '+ Add new category');
    addNew.value = NEW_CATEGORY;
    el.pmCategory.appendChild(addNew);

    if (!cats.length) el.pmCategory.value = NEW_CATEGORY;
    onCategoryChange();
  }

  function onCategoryChange() {
    var isNew = el.pmCategory.value === NEW_CATEGORY;
    el.pmNewCategoryWrap.hidden = !isNew;
    if (isNew) el.pmNewCategory.focus();
  }

  function openProductModal() {
    state.lastFocus = doc.activeElement;
    state.selectedIcon = '📦';
    el.productForm.reset();
    clearErrors(el.productModal);
    renderCategorySelect();
    renderIconPicker();
    el.productModal.hidden = false;
    el.pmName.focus();
  }

  function closeProductModal() {
    el.productModal.hidden = true;
    if (state.lastFocus && state.lastFocus.focus) state.lastFocus.focus();
  }

  function submitProduct(event) {
    event.preventDefault();
    clearErrors(el.productModal);

    var name = el.pmName.value.trim();
    var isNewCat = el.pmCategory.value === NEW_CATEGORY;
    var category = isNewCat ? el.pmNewCategory.value.trim() : el.pmCategory.value;
    var priceRaw = el.pmPrice.value.trim();
    var price = priceRaw === '' ? 0 : Number(priceRaw);
    var stockRaw = el.pmStartingStock.value.trim();
    var startingStock = stockRaw === '' ? 0 : Number(stockRaw);
    var thresholdRaw = el.pmLowStockThreshold.value.trim();
    var threshold = thresholdRaw === '' ? null : Number(thresholdRaw);
    var ok = true;

    if (!name) {
      setError(el.pmName, el.pmNameError, true);
      ok = false;
    }
    if (!category) {
      setError(isNewCat ? el.pmNewCategory : el.pmCategory, el.pmCategoryError, true);
      ok = false;
    }
    if (isNaN(price) || price < 0) {
      setError(el.pmPrice, el.pmPriceError, true);
      ok = false;
    }
    if (isNaN(startingStock) || startingStock < 0 || !Number.isInteger(startingStock)) {
      setError(el.pmStartingStock, el.pmStartingStockError, true);
      ok = false;
    }
    if (threshold !== null && (isNaN(threshold) || threshold < 0 || !Number.isInteger(threshold))) {
      setError(el.pmLowStockThreshold, el.pmLowStockThresholdError, true);
      ok = false;
    }
    if (!ok) return;

    var ts = DB.nowISO();
    var product = {
      id: DB.newId(),
      name: name,
      category: category,
      icon: state.selectedIcon,
      default_price: price,
      low_stock_threshold: threshold,
      deleted: false,
      created_at: ts,
      updated_at: ts,
      synced: false
    };

    // Lock before any async work - a double-tap would otherwise create two
    // separate products with the same name and two separate stock ledgers.
    if (busy.product) return;
    busy.product = true;
    el.pmSubmit.disabled = true;

    // A positive starting stock is what makes the product tracked from day
    // one - left blank or zero, it stays untracked exactly like every
    // product that predates this feature.
    DB.put('products', product).then(function () {
      return startingStock > 0
        ? DB.recordStockMovement({
            product_id: product.id,
            type: 'initial',
            quantity_delta: startingStock
          })
        : null;
    }).then(function () {
      closeProductModal();
      toast('Added ' + product.name);
      nudgeSync();
      return refresh();
    }).catch(function (err) {
      console.error('[app] could not save product', err);
      toast('Could not save that product', 'error');
    }).then(function () {
      busy.product = false;
      el.pmSubmit.disabled = false;
    });
  }

  /* ------------------------------------------------------- record sale */

  function currentQty() {
    var q = parseInt(el.saleQty.value, 10);
    if (isNaN(q) || q < 1) q = 1;
    return q;
  }

  function currentPrice() {
    var p = Number(el.salePrice.value);
    return isNaN(p) ? 0 : p;
  }

  function updateTotal() {
    var total = currentQty() * currentPrice();
    el.saleTotal.textContent = money(total);
    el.saleTotal.classList.toggle('is-credit', state.paymentMode === 'credit');
    el.qtyMinus.disabled = currentQty() <= 1;
    el.saleSubmit.textContent = state.paymentMode === 'credit'
      ? 'Record as pay later'
      : 'Record sale';
    // Any change to quantity clears a stale oversell error - it'll be
    // re-checked for real against live stock on the next submit anyway.
    setError(el.saleQty, el.saleQtyError, false);
  }

  function setPaymentMode(mode) {
    state.paymentMode = mode;
    el.modePaid.setAttribute('aria-pressed', String(mode === 'paid'));
    el.modeCredit.setAttribute('aria-pressed', String(mode === 'credit'));
    el.creditFields.hidden = mode !== 'credit';
    if (mode !== 'credit') setError(el.custName, el.custNameError, false);
    updateTotal();
    if (mode === 'credit') el.custName.focus();
  }

  function openSalePanel(product, sourceEl) {
    state.activeProduct = product;
    state.lastFocus = sourceEl || doc.activeElement;

    el.saleForm.reset();
    clearErrors(el.salePanel);

    el.spIcon.textContent = product.icon || '📦';
    el.spName.textContent = product.name;
    el.spCat.textContent = product.category || 'Uncategorised';

    el.saleQty.value = '1';
    var price = Number(product.default_price) || 0;
    el.salePrice.value = price > 0 ? String(price) : '';

    // Informational only - the real, live check happens at submit time in
    // submitSale(), since a background sync can change stock while this
    // panel sits open.
    var level = state.stockLevels.get(product.id);
    if (level) {
      el.saleQtyHint.hidden = false;
      el.saleQtyHint.textContent = Math.max(0, level.onHand) + ' in stock';
    } else {
      el.saleQtyHint.hidden = true;
    }

    setPaymentMode('paid');
    el.salePanel.hidden = false;

    // No default price means the counter has to type one - start them there.
    if (price > 0) el.saleQty.focus(); else el.salePrice.focus();
  }

  function closeSalePanel() {
    el.salePanel.hidden = true;
    state.activeProduct = null;
    if (state.lastFocus && state.lastFocus.focus) state.lastFocus.focus();
  }

  function submitSale(event) {
    event.preventDefault();
    if (!state.activeProduct) return;
    clearErrors(el.salePanel);

    var qty = currentQty();
    var price = currentPrice();
    var isCredit = state.paymentMode === 'credit';
    var customer = el.custName.value.trim();
    var ok = true;

    if (!(price > 0)) {
      setError(el.salePrice, el.salePriceError, true);
      ok = false;
    }
    if (isCredit && !customer) {
      setError(el.custName, el.custNameError, true);
      ok = false;
    }
    if (!ok) return;

    var product = state.activeProduct;
    if (busy.sale) return;
    busy.sale = true;
    el.saleSubmit.disabled = true;

    // Re-derive stock from scratch right now, rather than trusting
    // state.stockLevels as it stood when the panel opened - a background
    // sync can change it while the panel sits open, and this is the one
    // check that actually blocks the sale, so it has to be current.
    DB.getStockLevels().then(function (levels) {
      var level = levels.get(product.id);
      var tracked = !!level;
      var available = tracked ? Math.max(0, level.onHand) : null;

      if (tracked && qty > available) {
        setError(el.saleQty, el.saleQtyError, true);
        el.saleQtyError.textContent = 'Only ' + available +
          ' in stock — reduce the quantity or restock first.';
        return; // blocked - nothing written
      }

      // Round at the point of storage. qty * price is binary floating
      // point, so 999.99 x 3 is 2999.9700000000003 - and that lands in the
      // database and gets summed into revenue reports.
      var total = DB.round2(qty * price);
      var ts = DB.nowISO();

      var sale = {
        id: DB.newId(),
        product_id: product.id,
        product_name: product.name,
        category: product.category || '',
        quantity: qty,
        unit_price: price,
        total: total,
        description: el.saleNote.value.trim(),
        payment_status: isCredit ? 'credit' : 'paid',
        customer_name: isCredit ? customer : '',
        customer_phone: isCredit ? el.custPhone.value.trim() : '',
        amount_paid: isCredit ? 0 : total,
        balance: isCredit ? total : 0,
        sold_at: ts,
        created_at: ts,
        updated_at: ts,
        synced: false,
        device_id: state.deviceId
      };

      return DB.put('sales', sale).then(function () {
        // Untracked products sell exactly as they always have - no
        // movement row, no stock check, unchanged from before this
        // feature shipped.
        return tracked
          ? DB.recordStockMovement({
              product_id: product.id,
              type: 'sale',
              quantity_delta: -qty,
              related_sale_id: sale.id
            })
          : null;
      }).then(function () {
        closeSalePanel();
        toast(isCredit
          ? money(total) + ' owed by ' + customer
          : money(total) + ' recorded',
          isCredit ? 'credit' : 'paid');
        nudgeSync();
        return refresh();
      });
    }).catch(function (err) {
      console.error('[app] could not save sale', err);
      toast('Could not save that sale', 'error');
    }).then(function () {
      busy.sale = false;
      el.saleSubmit.disabled = false;
    });
  }

  /* ------------------------------------------------------------ restock */

  function openStockModal(product, sourceEl) {
    state.stockProduct = product;
    state.lastFocus = sourceEl || doc.activeElement;

    el.stockForm.reset();
    clearErrors(el.stockModal);

    el.smIcon.textContent = product.icon || '📦';
    el.smName.textContent = product.name;
    el.smCat.textContent = product.category || 'Uncategorised';

    el.stockModal.hidden = false;
    el.smQty.focus();
  }

  function closeStockModal() {
    el.stockModal.hidden = true;
    state.stockProduct = null;
    if (state.lastFocus && state.lastFocus.focus) state.lastFocus.focus();
  }

  function submitStock(event) {
    event.preventDefault();
    if (!state.stockProduct) return;
    clearErrors(el.stockModal);

    var product = state.stockProduct;
    var qtyRaw = el.smQty.value.trim();
    var qty = Number(qtyRaw);

    if (qtyRaw === '' || isNaN(qty) || qty < 1 || !Number.isInteger(qty)) {
      setError(el.smQty, el.smQtyError, true);
      return;
    }

    // Lock before any async work. Without this a double-tap runs the whole
    // handler twice and writes two movement rows, adding the stock twice -
    // the ledger has no idea they were meant to be one action.
    if (busy.stock) return;
    busy.stock = true;
    el.smSubmit.disabled = true;

    var note = el.smNote.value.trim();

    // 'initial' vs 'restock' is decided by whether the product already has
    // any movement history - its very first stock entry is what makes it
    // tracked at all, so that one is 'initial' and every one after is a
    // plain 'restock'. Not a separate code path, just a different label.
    DB.getStockLevels().then(function (levels) {
      var alreadyTracked = levels.has(product.id);
      return DB.recordStockMovement({
        product_id: product.id,
        type: alreadyTracked ? 'restock' : 'initial',
        quantity_delta: qty,
        note: note
      });
    }).then(function () {
      closeStockModal();
      toast('Added ' + qty + ' to ' + product.name);
      nudgeSync();
      return refresh();
    }).catch(function (err) {
      console.error('[app] could not save stock movement', err);
      toast('Could not save that stock update', 'error');
    }).then(function () {
      busy.stock = false;
      el.smSubmit.disabled = false;
    });
  }

  /* --------------------------------------------------------------- wire */

  function wire() {
    el.searchInput.addEventListener('input', function () {
      state.search = el.searchInput.value;
      renderGrid();
    });

    el.newProductBtn.addEventListener('click', openProductModal);
    el.productModalClose.addEventListener('click', closeProductModal);
    el.pmCancel.addEventListener('click', closeProductModal);
    el.pmCategory.addEventListener('change', onCategoryChange);
    el.productForm.addEventListener('submit', submitProduct);
    el.productModal.addEventListener('mousedown', function (e) {
      if (e.target === el.productModal) closeProductModal();
    });

    el.salePanelClose.addEventListener('click', closeSalePanel);
    el.saleForm.addEventListener('submit', submitSale);
    el.salePanel.addEventListener('mousedown', function (e) {
      if (e.target === el.salePanel) closeSalePanel();
    });

    el.qtyMinus.addEventListener('click', function () {
      el.saleQty.value = String(Math.max(1, currentQty() - 1));
      updateTotal();
    });
    el.qtyPlus.addEventListener('click', function () {
      el.saleQty.value = String(currentQty() + 1);
      updateTotal();
    });
    el.saleQty.addEventListener('input', updateTotal);
    el.salePrice.addEventListener('input', function () {
      setError(el.salePrice, el.salePriceError, false);
      updateTotal();
    });

    el.modePaid.addEventListener('click', function () { setPaymentMode('paid'); });
    el.modeCredit.addEventListener('click', function () { setPaymentMode('credit'); });
    el.custName.addEventListener('input', function () {
      setError(el.custName, el.custNameError, false);
    });

    el.stockModalClose.addEventListener('click', closeStockModal);
    el.smCancel.addEventListener('click', closeStockModal);
    el.stockForm.addEventListener('submit', submitStock);
    el.stockModal.addEventListener('mousedown', function (e) {
      if (e.target === el.stockModal) closeStockModal();
    });
    el.smQty.addEventListener('input', function () {
      setError(el.smQty, el.smQtyError, false);
    });

    doc.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!el.stockModal.hidden) closeStockModal();
      else if (!el.salePanel.hidden) closeSalePanel();
      else if (!el.productModal.hidden) closeProductModal();
    });
  }

  /* --------------------------------------------------------------- boot */

  function init() {
    wire();
    renderSyncPill('no-config');

    DB.ensureSeedData()
      .then(function () { return DB.getDeviceId(); })
      .then(function (id) { state.deviceId = id; })
      .then(refresh)
      .then(function () {
        if (global.Sync) {
          global.Sync.onStateChange(renderSyncPill);
          global.Sync.init();
          // Records pulled from the cloud should appear without a manual
          // reload - stock levels in particular, since another device's
          // sale or restock changes what's actually safe to sell here.
          // onDataChanged (not onPullComplete) so this only re-renders when
          // a pull actually wrote something, not on every ~25s tick.
          global.Sync.onDataChanged(refresh);
        }
      })
      .catch(function (err) {
        console.error('[app] startup failed', err);
        toast('Could not open the local database', 'error');
      });
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
