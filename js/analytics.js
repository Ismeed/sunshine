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
    kpiCount:       doc.getElementById('kpiCount'),
    kpiCountNote:   doc.getElementById('kpiCountNote'),
    kpiUnits:       doc.getElementById('kpiUnits'),
    kpiUnitsNote:   doc.getElementById('kpiUnitsNote'),
    kpiOutstanding: doc.getElementById('kpiOutstanding'),

    trendChart: doc.getElementById('trendChart'),
    trendStart: doc.getElementById('trendStart'),
    trendPeak:  doc.getElementById('trendPeak'),
    trendEnd:   doc.getElementById('trendEnd'),

    topNote:     doc.getElementById('topNote'),
    topProducts: doc.getElementById('topProducts'),

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

    toastStack: doc.getElementById('toastStack')
  };

  var state = {
    sales: [],
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
    clear(el.topProducts);

    if (!list.length) {
      el.topProducts.appendChild(node('div', 'empty', 'No sales in this range yet'));
      return;
    }

    var max = list[0].revenue || 1;
    list.forEach(function (p, i) {
      var row = node('div', 'rank-row');
      row.appendChild(node('span', 'rank-n', String(i + 1)));

      var mid = node('div');
      var nameLine = node('div');
      nameLine.appendChild(node('span', 'rank-name', p.name));
      mid.appendChild(nameLine);
      mid.appendChild(node('div', 'rank-meta', p.units + (p.units === 1 ? ' unit sold' : ' units sold')));
      row.appendChild(mid);

      row.appendChild(node('span', 'rank-val', money(p.revenue)));

      var track = node('div', 'rank-track');
      var fill = node('div', 'rank-fill');
      fill.style.width = Math.max((p.revenue / max) * 100, 3) + '%';
      track.appendChild(fill);
      row.appendChild(track);

      el.topProducts.appendChild(row);
    });
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
    return DB.getAll('sales').then(function (rows) {
      state.sales = rows;
      renderRangeButtons();
      renderKpis();
      renderTrend();
      renderTopProducts();
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

    var amount = Number(el.payAmount.value);
    var balance = Number(sale.balance) || 0;

    el.payAmount.classList.remove('is-invalid');
    el.payAmountError.classList.remove('is-shown');

    if (!(amount > 0) || amount > balance + 0.0001) {
      el.payAmount.classList.add('is-invalid');
      el.payAmountError.classList.add('is-shown');
      return;
    }

    var ts = DB.nowISO();
    var newBalance = Math.max(0, round2(balance - amount));
    var newAmountPaid = round2((Number(sale.amount_paid) || 0) + amount);

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
      });
  }

  function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

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
      global.Sync.onPullComplete(refresh);
    }

    bootGate();
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
