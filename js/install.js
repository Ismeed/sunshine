/* ==========================================================================
   install.js - a persistent, gentle nudge to install the PWA.

   Shared by both screens. Dismissal state lives in IndexedDB (settings
   store), never localStorage/sessionStorage, per this app's rule. A
   dismissal doesn't mean "never again" - it re-offers after a cooldown, so
   the app keeps quietly encouraging installation without being permanently
   silenced by one accidental tap.
   ========================================================================== */

(function (global) {
  'use strict';

  var doc = global.document;
  var DISMISS_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
  var SETTING_KEY = 'install_banner_dismissed_until';

  var deferredPrompt = null;
  var bannerEl = null;

  function isStandalone() {
    return (global.matchMedia && global.matchMedia('(display-mode: standalone)').matches) ||
           global.navigator.standalone === true; // iOS Safari
  }

  function isIOS() {
    return /iphone|ipad|ipod/i.test(global.navigator.userAgent || '');
  }

  function buildBanner(variant) {
    var bar = doc.createElement('div');
    bar.className = 'install-banner';
    bar.id = 'installBanner';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Install this app');

    var icon = doc.createElement('span');
    icon.className = 'install-banner-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '↓'; // down arrow, kept out of button copy per design brief

    var text = doc.createElement('div');
    text.className = 'install-banner-text';

    var title = doc.createElement('div');
    title.className = 'install-banner-title';
    title.textContent = 'Install Sunshine Gadgets POS';

    var sub = doc.createElement('div');
    sub.className = 'install-banner-sub';
    sub.textContent = variant === 'ios'
      ? 'Tap Share, then "Add to Home Screen" for one-tap offline access.'
      : 'Works fully offline and opens instantly from your home screen.';

    text.appendChild(title);
    text.appendChild(sub);

    var actions = doc.createElement('div');
    actions.className = 'install-banner-actions';

    if (variant !== 'ios') {
      var installBtn = doc.createElement('button');
      installBtn.type = 'button';
      installBtn.className = 'btn btn-primary btn-sm';
      installBtn.id = 'installBannerInstall';
      installBtn.textContent = 'Install';
      actions.appendChild(installBtn);
    }

    var dismissBtn = doc.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'icon-btn';
    dismissBtn.id = 'installBannerDismiss';
    dismissBtn.setAttribute('aria-label', 'Dismiss');
    dismissBtn.textContent = '×';
    actions.appendChild(dismissBtn);

    bar.appendChild(icon);
    bar.appendChild(text);
    bar.appendChild(actions);
    return bar;
  }

  function showBanner(variant) {
    if (bannerEl || isStandalone()) return;
    bannerEl = buildBanner(variant);

    var topbar = doc.querySelector('.topbar');
    if (topbar && topbar.parentNode) {
      topbar.parentNode.insertBefore(bannerEl, topbar.nextSibling);
    } else {
      doc.body.insertBefore(bannerEl, doc.body.firstChild);
    }

    var installBtn = doc.getElementById('installBannerInstall');
    if (installBtn) {
      installBtn.addEventListener('click', function () {
        if (!deferredPrompt) { dismiss(); return; }
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then(function (choice) {
          deferredPrompt = null;
          if (choice && choice.outcome === 'dismissed') {
            dismiss();
          } else {
            hideBanner();
          }
        }).catch(function () { hideBanner(); });
      });
    }

    doc.getElementById('installBannerDismiss').addEventListener('click', dismiss);
  }

  function hideBanner() {
    if (bannerEl && bannerEl.parentNode) bannerEl.parentNode.removeChild(bannerEl);
    bannerEl = null;
  }

  function dismiss() {
    hideBanner();
    if (global.DB) {
      global.DB.setSetting(SETTING_KEY, Date.now() + DISMISS_COOLDOWN_MS).catch(function () {});
    }
  }

  function maybeShow(variant) {
    if (isStandalone()) return;
    if (!global.DB) { showBanner(variant); return; }

    global.DB.getSetting(SETTING_KEY).then(function (until) {
      if (until && Date.now() < until) return;
      showBanner(variant);
    }).catch(function () { showBanner(variant); });
  }

  function init() {
    if (isStandalone()) return; // already installed - nothing to nudge about

    global.addEventListener('beforeinstallprompt', function (event) {
      event.preventDefault();
      deferredPrompt = event;
      maybeShow('android');
    });

    global.addEventListener('appinstalled', function () {
      deferredPrompt = null;
      hideBanner();
    });

    // Safari on iOS never fires beforeinstallprompt - offer the manual steps
    // instead, once the page has had a moment to settle.
    if (isIOS() && !global.navigator.standalone) {
      global.setTimeout(function () { maybeShow('ios'); }, 1500);
    }
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
