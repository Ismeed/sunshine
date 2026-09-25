/* ==========================================================================
   analytics.js - Analytics screen. Password-gated, local-data-only reads
   plus one write path (payments). The unlock flag lives in a plain JS
   variable only.

   INTENTIONAL: `unlocked` below is an in-memory variable, not
   sessionStorage/localStorage/IndexedDB. A page reload must re-prompt for
   the password - that's the design, not a bug. Please don't "fix" this by
   persisting it anywhere.
   ========================================================================== */

(function (global) {
  'use strict';

  var doc = global.document;
  var unlocked = false; // in-memory only, see comment above.

  /* In-flight guard for the payment write - see submitPayment(). */
  var busyPayment = false;

  /* ----------------------------------------------------------- elements */

  var el = {
    syncPill:  doc.getElementById('syncPill'),
    syncText:  doc.getElementById('syncText'),
    logoutBtn: doc.getElementById('logoutBtn'),

    gate:          doc.getElementById('gate'),
    gateTitle:     doc.getElementById('gateTitle'),
    gateSub:       doc.getElementById('gateSub'),
    gateError:     doc.getElementById('gateError'),
    gateForm:      doc.getElementById('gateForm'),
    gatePassword:  doc.getElementById('gatePassword'),
    gateConfirmField: doc.getElementById('gateConfirmField'),
    gateConfirm:   doc.getElementById('gateConfirm'),
    gateSubmit:    doc.getElementById('gateSubmit'),
    gateFoot:      doc.getElementById('gateFoot'),

    dashboard:   doc.getElementById('dashboard'),
    rangeGroup:  doc.getElementById('rangeGroup'),
    rangeLabel:  doc.getElementById('rangeLabel'),

    kpiRevenue:     doc.getElementById('kpiRevenue'),
    kpiRevenueNote: doc.getElementById('kpiRevenueNote'),
    kpiRevenueDelta:doc.getElementById('kpiRevenueDelta'),
    kpiCount:       doc.getElementById('kpiCount'),
    kpiCountNote:   doc.getElementById('kpiCountNote'),
    kpiCountDelta:  doc.getElementById('kpiCountDelta'),
    kpiUnits:       doc.getElementById('kpiUnits'),
    kpiUnitsNote:   doc.getElementById('kpiUnitsNote'),
    kpiUnitsDelta:  doc.getElementById('kpiUnitsDelta'),
    kpiOutstanding: doc.getElementById('kpiOutstanding'),

    kpiStockValue: doc.getElementById('kpiStockValue'),
    kpiLowStock:   doc.getElementById('kpiLowStock'),
    kpiOutOfStock: doc.getElementById('kpiOutOfStock'),

    trendChart: doc.getElementById('trendChart'),
    trendStart: doc.getElementById('trendStart'),
    trendPeak:  doc.getElementById('trendPeak'),
    trendEnd:   doc.getElementById('trendEnd'),

    topNote:     doc.getElementById('topNote'),
    topProducts: doc.getElementById('topProducts'),

    categoryNote:       doc.getElementById('categoryNote'),
    categoryBreakdown:  doc.getElementById('categoryBreakdown'),

    inventoryWrap:  doc.getElementById('inventoryWrap'),
    inventoryBody:  doc.getElementById('inventoryBody'),
    inventoryEmpty: doc.getElementById('inventoryEmpty'),

    ledgerWrap:  doc.getElementById('ledgerWrap'),
    ledgerBody:  doc.getElementById('ledgerBody'),
    ledgerEmpty: doc.getElementById('ledgerEmpty'),

    paymentModal:      doc.getElementById('paymentModal'),
    paymentModalClose: doc.getElementById('paymentModalClose'),
    paymentForm:       doc.getElementById('paymentForm'),
    payCustomer:       doc.getElementById('payCustomer'),
    payItem:           doc.getElementById('payItem'),
    payBalance:        doc.getElementById('payBalance'),
    payAmount:         doc.getElementById('payAmount'),
    payAmountError:    doc.getElementById('payAmountError'),
    payFull:           doc.getElementById('payFull'),
    payCancel:         doc.getElementById('payCancel'),
    paySubmit:         doc.getElementById('paySubmit'),

    toastStack: doc.getElementById('toastStack')
  };

  var state = {
    sales: [],
    products: [],
    stockLevels: new Map(), // product_id -> { tracked, onHand }, from DB.getStockLevels()
    range: 'today',
    activeSale: null,
    deviceId: null,
    lastFocus: null
  };

  /* ------------------------------------------------------------ helpers */

  var nf = new Intl.NumberFormat('en-NG', { maximumFractionDigits: 2 });
  function money(value) { return '₦' + nf.format(Number(value) || 0); }

  function node(tag, className, text) {
    var n = doc.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  function clear(parent) {
    while (parent.firstChild) parent.removeChild(parent.firstChild);
  }

  function toast(message, kind) {
    var t = node('div', 'toast' + (kind ? ' toast-' + kind : ''), message);
    el.toastStack.appendChild(t);
    global.setTimeout(function () {
      t.classList.add('is-out');
      global.setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 200);
    }, 2600);
  }

  function nudgeSync() {
    if (global.Sync && typeof global.Sync.runSync === 'function') global.Sync.runSync();
  }

  function sha256Hex(text) {
    var data = new TextEncoder().encode(text);
    return global.crypto.subtle.digest('SHA-256', data).then(function (buf) {
      var bytes = new Uint8Array(buf);
      var hex = '';
      for (var i = 0; i < bytes.length; i++) hex += (bytes[i] + 0x100).toString(16).slice(1);
      return hex;
    });
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

    if (state_ === 'online-synced' && global.Sync && global.Sync.lastSyncedAt()) {
      el.syncPill.title = 'Last synced ' + global.Sync.lastSyncedAt().toLocaleTimeString();
    } else {
      el.syncPill.title = SYNC_LABELS[state_] || state_;
    }
  }

  /* ------------------------------------------------------------- gate */

  function showGateError(message) {
    el.gateError.textContent = message;
    el.gateError.classList.add('is-shown');
  }

  function hideGateError() {
    el.gateError.classList.remove('is-shown');
    el.gateError.textContent = '';
  }

  function renderGate(mode) {
    hideGateError();
    el.gateForm.reset();
    if (mode === 'set') {
      el.gateTitle.textContent = 'Set an owner password';
      el.gateSub.textContent = 'No password has been set on this device yet. Choose one to protect analytics.';
      el.gateConfirmField.hidden = false;
      el.gateSubmit.textContent = 'Set password';
      el.gateFoot.textContent = 'This password is stored (as a one-way hash) on this device only.';
    } else {
      el.gateTitle.textContent = 'Owner access';
      el.gateSub.textContent = 'Enter the analytics password to continue.';
      el.gateConfirmField.hidden = true;
      el.gateSubmit.textContent = 'Unlock';
      el.gateFoot.textContent = 'This screen re-locks on every reload — nothing about your session is stored on the device.';
    }
    el.gate.hidden = false;
    el.dashboard.hidden = true;
    el.logoutBtn.hidden = true;
    global.setTimeout(function () { el.gatePassword.focus(); }, 0);
  }

  function unlockDashboard() {
    unlocked = true;
    el.gate.hidden = true;
    el.dashboard.hidden = false;
    el.logoutBtn.hidden = false;
    refresh();
  }

  function handleGateSubmit(event) {
    event.preventDefault();
    hideGateError();

    var pw = el.gatePassword.value;
    if (!pw || pw.length < 4) {
      showGateError('Password must be at least 4 characters.');
      return;
    }

    DB.getSetting('admin_password_hash').then(function (storedHash) {
      if (!storedHash) {
        var confirm_ = el.gateConfirm.value;
        if (pw !== confirm_) {
          showGateError('Passwords do not match.');
          return;
        }
        return sha256Hex(pw).then(function (hash) {
          return DB.setSetting('admin_password_hash', hash);
        }).then(function () {
          toast('Password set');
          unlockDashboard();
        });
      }

      return sha256Hex(pw).then(function (hash) {
        // Deliberately generic message either way - never reveal whether
        // an account/password exists, just whether this attempt worked.
        if (hash === storedHash) {
          unlockDashboard();
        } else {
          showGateError('Incorrect password.');
        }
      });
    }).catch(function (err) {
      console.error('[analytics] gate check failed', err);
      showGateError('Something went wrong checking that password.');
    });
  }

  function logout() {
    unlocked = false;
    renderGate('check');
  }

  function bootGate() {
    DB.getSetting('admin_password_hash').then(function (hash) {
      renderGate(hash ? 'check' : 'set');
    }).catch(function (err) {
      console.error('[analytics] could not read settings', err);
      showGateError('Could not read local settings.');
    });
  }

  /* --------------------------------------------------------------- data */

  function rangeStart(range) {
    var d = new Date();
    if (range === 'today') { d.setHours(0, 0, 0, 0); return d; }
    if (range === '7')  { d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 6); return d; }
    if (range === '30') { d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 29); return d; }
    return null; // all time
  }

  function salesInRange(range) {
    var from = rangeStart(range);
    if (!from) return state.sales.slice();
    var fromTime = from.getTime();
    return state.sales.filter(function (s) { return new Date(s.sold_at).getTime() >= fromTime; });
  }

  var RANGE_NOTE = { today: 'Today', '7': 'Last 7 days', '30': 'Last 30 days', all: 'All time' };

  /* The window immediately before the current range - yesterday for
     "Today", the 7 days before the current 7-day window, etc. - as a
     [start, end) pair. null for "All time", which has no prior period to
     compare against. */
  function priorRangeBounds(range) {
    if (range === 'all') return null;

    var curStart = rangeStart(range);
    var end = new Date(curStart);
    var start = new Date(curStart);

    if (range === 'today') start.setDate(start.getDate() - 1);
    else if (range === '7') start.setDate(start.getDate() - 7);
    else if (range === '30') start.setDate(start.getDate() - 30);
    else return null;

    return { start: start, end: end };
  }

  function salesInBounds(bounds) {
    if (!bounds) return [];
    var startTime = bounds.start.getTime();
    var endTime = bounds.end.getTime();
    return state.sales.filter(function (s) {
      var t = new Date(s.sold_at).getTime();
      return t >= startTime && t < endTime;
    });
  }

  /* previous === 0 has no meaningful percentage (division by zero), so it
     gets a "New" label instead of a nonsensical +Infinity% - and if both
     periods are zero there's nothing worth saying at all. */
  function formatDelta(current, previous) {
    if (previous === 0) {
      if (current === 0) return null;
      return { text: 'New — none in the previous period', dir: 'up' };
    }
    var pct = Math.round(((current - previous) / previous) * 100);
    if (pct === 0) return { text: 'No change vs previous period', dir: null };
    return { text: (pct > 0 ? '+' : '') + pct + '% vs previous period', dir: pct > 0 ? 'up' : 'down' };
  }

  function applyDelta(el_, current, previous) {
    var info = formatDelta(current, previous);
    el_.classList.remove('is-up', 'is-down');
    if (!info) { el_.hidden = true; return; }
    el_.hidden = false;
    el_.textContent = info.text;
    if (info.dir === 'up') el_.classList.add('is-up');
    else if (info.dir === 'down') el_.classList.add('is-down');
  }

  /* ------------------------------------------------------------- render */

  function renderKpis() {
    var rows = salesInRange(state.range);
    var revenue = 0, units = 0;
    rows.forEach(function (s) {
      revenue += Number(s.total) || 0;
      units += Number(s.quantity) || 0;
    });

    var outstanding = state.sales.reduce(function (sum, s) {
      return sum + (s.payment_status === 'credit' ? (Number(s.balance) || 0) : 0);
    }, 0);

    el.kpiRevenue.textContent = money(revenue);
    el.kpiCount.textContent = String(rows.length);
    el.kpiUnits.textContent = String(units);
    el.kpiOutstanding.textContent = money(outstanding);

    var note = RANGE_NOTE[state.range];
    el.kpiRevenueNote.textContent = note;
    el.kpiCountNote.textContent = note;
    el.kpiUnitsNote.textContent = note;
    el.rangeLabel.textContent = 'Showing: ' + note;

    // Period-over-period, range-scoped KPIs only. Outstanding credit is a
    // live snapshot across all sales with no "period" to compare against,
    // so it never gets one of these.
    var deltaEls = [el.kpiRevenueDelta, el.kpiCountDelta, el.kpiUnitsDelta];
    var bounds = priorRangeBounds(state.range);

    if (!bounds) {
      // "All time" has no prior period at all - distinct from a prior
      // period that existed but had zero sales, which legitimately shows
      // "New" below. Collapsing the two (e.g. by treating a null bounds as
      // "previous = 0") would make All time show a false "New" label
      // instead of hiding the delta, since All time's own total is
      // essentially never zero.
      deltaEls.forEach(function (el_) { el_.hidden = true; });
    } else {
      var priorRows = salesInBounds(bounds);
      var priorRevenue = 0, priorUnits = 0;
      priorRows.forEach(function (s) {
        priorRevenue += Number(s.total) || 0;
        priorUnits += Number(s.quantity) || 0;
      });
      applyDelta(el.kpiRevenueDelta, revenue, priorRevenue);
      applyDelta(el.kpiCountDelta, rows.length, priorRows.length);
      applyDelta(el.kpiUnitsDelta, units, priorUnits);
    }
  }

  /* Live snapshot, not scoped to the date-range selector - same convention
     as outstanding credit above. Untracked products (no stock_movements
     history) have nothing to report and are excluded entirely, not shown
     with a zero. */
  function renderInventorySummary() {
    var tracked = [];
    state.products.forEach(function (p) {
      if (p.deleted) return;
      var level = state.stockLevels.get(p.id);
      if (level) tracked.push({ product: p, onHand: level.onHand });
    });

    var stockValue = 0, lowCount = 0, outCount = 0;
    var rows = tracked.map(function (row) {
      var price = Number(row.product.default_price) || 0;
      var threshold = (row.product.low_stock_threshold != null)
        ? row.product.low_stock_threshold
        : DB.LOW_STOCK_DEFAULT;

      // Unclamped - an oversold product's negative onHand genuinely
      // reduces the value of stock actually on hand, same reasoning as
      // never clamping the ledger sum itself.
      stockValue += row.onHand * price;

      var status = row.onHand <= 0 ? 'out' : (row.onHand <= threshold ? 'low' : 'ok');
      if (status === 'out') outCount++;
      else if (status === 'low') lowCount++;

      return { product: row.product, onHand: row.onHand, status: status };
    });

    el.kpiStockValue.textContent = money(stockValue);
    el.kpiLowStock.textContent = String(lowCount);
    el.kpiOutOfStock.textContent = String(outCount);

    renderInventoryTable(rows);
  }

  var STATUS_BADGE = {
    out: ['badge-danger', 'Out'],
    low: ['badge-credit', 'Low'],
    ok:  ['badge-paid', 'OK']
  };
  var STATUS_SEVERITY = { out: 0, low: 1, ok: 2 };

  function renderInventoryTable(rows) {
    var sorted = rows.slice().sort(function (a, b) {
      if (STATUS_SEVERITY[a.status] !== STATUS_SEVERITY[b.status]) {
        return STATUS_SEVERITY[a.status] - STATUS_SEVERITY[b.status];
      }
      return (a.product.name || '').localeCompare(b.product.name || '');
    });

    clear(el.inventoryBody);
    el.inventoryWrap.hidden = sorted.length === 0;
    el.inventoryEmpty.hidden = sorted.length > 0;

    sorted.forEach(function (row) {
      var tr = doc.createElement('tr');

      var nameTd = doc.createElement('td');
      nameTd.className = 'cell-strong';
      nameTd.textContent = row.product.name;
      tr.appendChild(nameTd);

      var catTd = doc.createElement('td');
      catTd.textContent = row.product.category || 'Uncategorised';
      tr.appendChild(catTd);

      var onHandTd = doc.createElement('td');
      onHandTd.className = 'num';
      onHandTd.textContent = String(Math.max(0, row.onHand));
      tr.appendChild(onHandTd);

      var statusTd = doc.createElement('td');
      var badgeInfo = STATUS_BADGE[row.status];
      statusTd.appendChild(node('span', 'badge ' + badgeInfo[0], badgeInfo[1]));
      tr.appendChild(statusTd);

      el.inventoryBody.appendChild(tr);
    });
  }

  function renderTrend() {
    var days = 30;
    var buckets = [];
    var today = new Date();
    today.setHours(0, 0, 0, 0);

    for (var i = days - 1; i >= 0; i--) {
      var d = new Date(today);
      d.setDate(d.getDate() - i);
      buckets.push({ date: d, total: 0 });
    }

    var startTime = buckets[0].date.getTime();
    state.sales.forEach(function (s) {
      var t = new Date(s.sold_at);
      t.setHours(0, 0, 0, 0);
      var time = t.getTime();
      if (time < startTime) return;
      var idx = Math.round((time - startTime) / 86400000);
      if (buckets[idx]) buckets[idx].total += Number(s.total) || 0;
    });

    var max = buckets.reduce(function (m, b) { return Math.max(m, b.total); }, 0);

    clear(el.trendChart);
    buckets.forEach(function (b) {
      var col = node('div', 'chart-col');
      var bar = node('div', 'chart-bar' + (b.total === 0 ? ' is-zero' : ''));
      var pct = max > 0 ? Math.max((b.total / max) * 100, b.total > 0 ? 4 : 0) : 0;
      bar.style.height = pct + '%';
      bar.title = b.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ': ' + money(b.total);
      col.appendChild(bar);
      el.trendChart.appendChild(col);
    });

    var fmt = { month: 'short', day: 'numeric' };
    el.trendStart.textContent = buckets[0].date.toLocaleDateString(undefined, fmt);
    el.trendEnd.textContent = buckets[buckets.length - 1].date.toLocaleDateString(undefined, fmt);
    var peak = buckets.reduce(function (best, b) { return b.total > best.total ? b : best; }, buckets[0]);
    el.trendPeak.textContent = peak.total > 0
      ? 'Peak ' + peak.date.toLocaleDateString(undefined, fmt) + ': ' + money(peak.total)
      : '';
  }

  /* Shared by Top products and Revenue by category - both are a
     revenue-sorted bar list of { name, revenue, units } rows, differing
     only in the source of `name` and the container they render into. */
  function renderRankList(container, items, emptyMessage) {
    clear(container);

    if (!items.length) {
      container.appendChild(node('div', 'empty', emptyMessage));
      return;
    }

    var max = items[0].revenue || 1;
    items.forEach(function (item, i) {
      var row = node('div', 'rank-row');
      row.appendChild(node('span', 'rank-n', String(i + 1)));

      var mid = node('div');
      var nameLine = node('div');
      nameLine.appendChild(node('span', 'rank-name', item.name));
      mid.appendChild(nameLine);
      mid.appendChild(node('div', 'rank-meta', item.units + (item.units === 1 ? ' unit sold' : ' units sold')));
      row.appendChild(mid);

      row.appendChild(node('span', 'rank-val', money(item.revenue)));

      var track = node('div', 'rank-track');
      var fill = node('div', 'rank-fill');
      fill.style.width = Math.max((item.revenue / max) * 100, 3) + '%';
      track.appendChild(fill);
      row.appendChild(track);

      container.appendChild(row);
    });
  }

  function renderTopProducts() {
    var rows = salesInRange(state.range);
    var byProduct = {};

    rows.forEach(function (s) {
      var key = s.product_id || s.product_name;
      if (!byProduct[key]) byProduct[key] = { name: s.product_name, revenue: 0, units: 0 };
      byProduct[key].revenue += Number(s.total) || 0;
      byProduct[key].units += Number(s.quantity) || 0;
    });

    var list = Object.keys(byProduct).map(function (k) { return byProduct[k]; })
      .sort(function (a, b) { return b.revenue - a.revenue; })
      .slice(0, 8);

    el.topNote.textContent = 'By revenue — ' + RANGE_NOTE[state.range];
    renderRankList(el.topProducts, list, 'No sales in this range yet');
  }

  function renderCategoryBreakdown() {
    var rows = salesInRange(state.range);
    var byCategory = {};

    rows.forEach(function (s) {
      var key = s.category || 'Uncategorised';
      if (!byCategory[key]) byCategory[key] = { name: key, revenue: 0, units: 0 };
      byCategory[key].revenue += Number(s.total) || 0;
      byCategory[key].units += Number(s.quantity) || 0;
    });

    var list = Object.keys(byCategory).map(function (k) { return byCategory[k]; })
      .sort(function (a, b) { return b.revenue - a.revenue; });

    el.categoryNote.textContent = RANGE_NOTE[state.range];
    renderRankList(el.categoryBreakdown, list, 'No sales in this range yet');
  }

  function renderLedger() {
    var owed = state.sales
      .filter(function (s) { return s.payment_status === 'credit' && Number(s.balance) > 0; })
      .sort(function (a, b) { return new Date(b.sold_at) - new Date(a.sold_at); });

    clear(el.ledgerBody);
    el.ledgerWrap.hidden = owed.length === 0;
    el.ledgerEmpty.hidden = owed.length > 0;

    owed.forEach(function (sale) {
      var tr = doc.createElement('tr');

      var custTd = doc.createElement('td');
      custTd.appendChild(node('span', 'cell-strong', sale.customer_name || 'Unnamed customer'));
      if (sale.customer_phone) custTd.appendChild(node('span', 'cell-meta', sale.customer_phone));
      tr.appendChild(custTd);

      var itemTd = doc.createElement('td');
      itemTd.textContent = sale.quantity > 1 ? sale.product_name + ' ×' + sale.quantity : sale.product_name;
      tr.appendChild(itemTd);

      var soldTd = doc.createElement('td');
      soldTd.textContent = new Date(sale.sold_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      tr.appendChild(soldTd);

      var totalTd = doc.createElement('td');
      totalTd.className = 'num';
      totalTd.textContent = money(sale.total);
      tr.appendChild(totalTd);

      var balTd = doc.createElement('td');
      balTd.className = 'num cell-owed';
      balTd.textContent = money(sale.balance);
      tr.appendChild(balTd);

      var actionTd = doc.createElement('td');
      var btn = node('button', 'btn btn-quiet btn-sm', 'Record payment');
      btn.type = 'button';
      btn.addEventListener('click', function () { openPaymentModal(sale); });
      actionTd.appendChild(btn);
      tr.appendChild(actionTd);

      el.ledgerBody.appendChild(tr);
    });
  }

  function renderRangeButtons() {
    var buttons = el.rangeGroup.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute('aria-pressed', String(buttons[i].getAttribute('data-range') === state.range));
    }
  }

  function refresh() {
    if (!unlocked) return Promise.resolve();
    return Promise.all([DB.getAll('sales'), DB.getAll('products'), DB.getStockLevels()])
      .then(function (results) {
        state.sales = results[0];
        state.products = results[1];
        state.stockLevels = results[2];
        renderRangeButtons();
        renderKpis();
        renderTrend();
        renderTopProducts();
        renderCategoryBreakdown();
        renderInventorySummary();
        renderLedger();
      });
  }

  /* --------------------------------------------------------- payments */

  function openPaymentModal(sale) {
    state.activeSale = sale;
    state.lastFocus = doc.activeElement;

    el.paymentForm.reset();
    el.payAmount.classList.remove('is-invalid');
    el.payAmountError.classList.remove('is-shown');

    el.payCustomer.textContent = sale.customer_name || 'Unnamed customer';
    el.payItem.textContent = sale.quantity > 1 ? sale.product_name + ' ×' + sale.quantity : sale.product_name;
    el.payBalance.textContent = money(sale.balance);
    el.payAmount.max = String(sale.balance);
    el.payAmount.placeholder = String(sale.balance);

    el.paymentModal.hidden = false;
    el.payAmount.focus();
  }

  function closePaymentModal() {
    el.paymentModal.hidden = true;
    state.activeSale = null;
    if (state.lastFocus && state.lastFocus.focus) state.lastFocus.focus();
  }

  function submitPayment(event) {
    event.preventDefault();
    var sale = state.activeSale;
    if (!sale) return;

    // Round the entered amount too, so the stored payment rows always add
    // up to the sale's amount_paid rather than differing by float dust.
    var amount = DB.round2(el.payAmount.value);
    var balance = Number(sale.balance) || 0;

    el.payAmount.classList.remove('is-invalid');
    el.payAmountError.classList.remove('is-shown');

    if (!(amount > 0) || amount > balance + 0.0001) {
      el.payAmount.classList.add('is-invalid');
      el.payAmountError.classList.add('is-shown');
      return;
    }

    // Lock before any async work. This is the highest-consequence handler
    // in the app: without the guard a double-tap records the customer's
    // payment twice and wipes a balance they still owe, so the shop simply
    // loses that money with no trace that it was one payment.
    if (busyPayment) return;
    busyPayment = true;
    el.paySubmit.disabled = true;

    var ts = DB.nowISO();
    var newBalance = Math.max(0, DB.round2(balance - amount));
    var newAmountPaid = DB.round2((Number(sale.amount_paid) || 0) + amount);

    var payment = {
      id: DB.newId(),
      sale_id: sale.id,
      amount: amount,
      paid_at: ts,
      updated_at: ts,
      synced: false,
      device_id: state.deviceId
    };

    var updatedSale = Object.assign({}, sale, {
      amount_paid: newAmountPaid,
      balance: newBalance,
      payment_status: newBalance <= 0 ? 'paid' : 'credit',
      updated_at: ts,
      synced: false
    });

    Promise.all([DB.put('payments', payment), DB.put('sales', updatedSale)])
      .then(function () {
        closePaymentModal();
        toast(newBalance <= 0
          ? 'Paid off — ' + money(amount) + ' recorded'
          : money(amount) + ' recorded, ' + money(newBalance) + ' remaining');
        nudgeSync();
        return refresh();
      })
      .catch(function (err) {
        console.error('[analytics] could not record payment', err);
        toast('Could not record that payment', 'error');
      })
      .then(function () {
        busyPayment = false;
        el.paySubmit.disabled = false;
      });
  }


  /* --------------------------------------------------------------- wire */

  function wire() {
    el.gateForm.addEventListener('submit', handleGateSubmit);
    el.logoutBtn.addEventListener('click', logout);

    var buttons = el.rangeGroup.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function (e) {
        state.range = e.currentTarget.getAttribute('data-range');
        renderRangeButtons();
        renderKpis();
        renderTopProducts();
        renderCategoryBreakdown();
        // Inventory is a live snapshot, not range-scoped - no re-render here.
      });
    }

    el.paymentModalClose.addEventListener('click', closePaymentModal);
    el.payCancel.addEventListener('click', closePaymentModal);
    el.paymentForm.addEventListener('submit', submitPayment);
    el.paymentModal.addEventListener('mousedown', function (e) {
      if (e.target === el.paymentModal) closePaymentModal();
    });
    el.payFull.addEventListener('click', function () {
      if (state.activeSale) el.payAmount.value = String(state.activeSale.balance);
    });

    doc.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !el.paymentModal.hidden) closePaymentModal();
    });
  }

  /* --------------------------------------------------------------- boot */

  function init() {
    wire();
    renderSyncPill('no-config');

    DB.getDeviceId().then(function (id) {
      state.deviceId = id;
    }).catch(function () {});

    if (global.Sync) {
      global.Sync.onStateChange(renderSyncPill);
      global.Sync.init();
      // onDataChanged, not onPullComplete: only re-render when a pull
      // actually wrote something, not on every ~25s tick regardless -
      // same reasoning as the Sales screen.
      global.Sync.onDataChanged(refresh);
    }

    bootGate();
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
