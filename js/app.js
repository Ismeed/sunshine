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
    pmIconPicker:      doc.getElementById('pmIconPicker'),
    pmCancel:          doc.getElementById('pmCancel'),

    salePanel:      doc.getElementById('salePanel'),
    salePanelClose: doc.getElementById('salePanelClose'),
    saleForm:       doc.getElementById('saleForm'),
    spIcon:         doc.getElementById('spIcon'),
    spName:         doc.getElementById('spName'),
    spCat:          doc.getElementById('spCat'),
    saleQty:        doc.getElementById('saleQty'),
    qtyMinus:       doc.getElementById('qtyMinus'),
    qtyPlus:        doc.getElementById('qtyPlus'),
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

    toastStack:     doc.getElementById('toastStack')
  };

  /* -------------------------------------------------------------- state */

  var state = {
    products: [],
    sales: [],
    category: 'All',
    search: '',
    activeProduct: null,
    paymentMode: 'paid',
    selectedIcon: '📦',
    deviceId: null,
    lastFocus: null
  };

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
      var tile = node('button', 'product-tile');
      tile.type = 'button';
      tile.appendChild(node('span', 'tile-icon', p.icon || '📦'));
      tile.appendChild(node('span', 'tile-name', p.name));
      tile.appendChild(node('span', 'tile-cat', p.category || 'Uncategorised'));

      var price = Number(p.default_price) || 0;
      tile.appendChild(price > 0
        ? node('span', 'tile-price', money(price))
        : node('span', 'tile-price is-unset', 'Set price at sale'));

      tile.addEventListener('click', function () { openSalePanel(p, tile); });
      el.productGrid.appendChild(tile);
    });
  }

  function refresh() {
    return Promise.all([DB.getAll('products'), DB.getAll('sales')])
      .then(function (results) {
        state.products = results[0];
        state.sales = results[1];
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
    if (!ok) return;

    var ts = DB.nowISO();
    var product = {
      id: DB.newId(),
      name: name,
      category: category,
      icon: state.selectedIcon,
      default_price: price,
      deleted: false,
      created_at: ts,
      updated_at: ts,
      synced: false
    };

    DB.put('products', product).then(function () {
      closeProductModal();
      toast('Added ' + product.name);
      nudgeSync();
      return refresh();
    }).catch(function (err) {
      console.error('[app] could not save product', err);
      toast('Could not save that product', 'error');
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

    var total = qty * price;
    var ts = DB.nowISO();
    var product = state.activeProduct;

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

    el.saleSubmit.disabled = true;

    DB.put('sales', sale).then(function () {
      closeSalePanel();
      toast(isCredit
        ? money(total) + ' owed by ' + customer
        : money(total) + ' recorded',
        isCredit ? 'credit' : 'paid');
      nudgeSync();
      return refresh();
    }).catch(function (err) {
      console.error('[app] could not save sale', err);
      toast('Could not save that sale', 'error');
    }).then(function () {
      el.saleSubmit.disabled = false;
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

    doc.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!el.salePanel.hidden) closeSalePanel();
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
          // Records pulled from the cloud should appear without a manual reload.
          global.Sync.onPullComplete(refresh);
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
