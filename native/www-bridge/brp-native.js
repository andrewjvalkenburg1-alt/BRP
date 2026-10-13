/* BRP One native bridge, v1.0 (Oct 2026). Defines window.BRPNative.
 *
 * One file, no imports, no build step. The same web build runs on the web and inside the
 * Capacitor app. On the web (or if a plugin is missing) every async method resolves to
 * null or false and nothing throws, so the app keeps its own web behavior.
 *
 * In the app, native/scripts/copy-web.mjs loads capacitor.js and then this file in <head>.
 * The bridge also works with only the Capacitor native runtime (no capacitor.js): it then
 * talks to plugins through Capacitor.nativePromise and Capacitor.nativeCallback.
 *
 * Frames: the shell's srcdoc frames are same-origin, so frame code calls
 * (window.BRPNative || parent.BRPNative).
 *
 * Storage: only the demo account email (for Face ID quick sign-in) and a few counters for the
 * review prompt go into Capacitor Preferences. No passwords are stored anywhere.
 */
(function (w) {
  'use strict';
  if (w.BRPNative && w.BRPNative.version) return;

  var VERSION = '1.0';
  var WEB_BASE = 'https://andrewjvalkenburg1-alt.github.io/BRP/';
  var K = { bioEmail: 'brp.bio.email', revCount: 'brp.review.count', revLast: 'brp.review.last', firstRun: 'brp.firstRun' };
  var REVIEW = { minActions: 3, minDaysInstalled: 2, minDaysBetween: 120 };
  var DAY = 86400000;

  /* ---------- feature detection ---------- */
  function C() { return w.Capacitor; }
  function isNative() {
    try { var c = C(); return !!(c && typeof c.isNativePlatform === 'function' && c.isNativePlatform()); } catch (e) { return false; }
  }
  function platform() {
    if (!isNative()) return 'web';
    try { return C().getPlatform(); } catch (e) { return 'web'; }
  }
  function hasPlugin(name) {
    if (!isNative()) return false;
    var c = C();
    try {
      if (typeof c.isPluginAvailable === 'function' && c.isPluginAvailable(name)) return true;
      return (c.PluginHeaders || []).some(function (h) { return h.name === name; });
    } catch (e) { return false; }
  }
  var cache = {};
  /* Returns a plugin proxy or null. Uses registerPlugin from capacitor.js when present,
     else a small proxy over the native runtime. */
  function plugin(name) {
    if (!hasPlugin(name)) return null;
    if (cache[name]) return cache[name];
    var c = C(), p = null;
    try {
      if (c.Plugins && c.Plugins[name]) p = c.Plugins[name];
      else if (typeof c.registerPlugin === 'function') p = c.registerPlugin(name);
    } catch (e) { p = null; }
    if (!p && typeof c.nativePromise === 'function') {
      p = new Proxy({}, {
        get: function (_, m) {
          if (m === 'then') return undefined;
          if (m === 'addListener') return function (ev, fn) {
            return new Promise(function (res) {
              var id = c.nativeCallback(name, 'addListener', { eventName: ev }, function (data) { fn(data); });
              Promise.resolve(id).then(function (cbId) {
                res({ remove: function () { return c.nativePromise(name, 'removeListener', { eventName: ev, callbackId: cbId }); } });
              });
            });
          };
          return function (opts) { return c.nativePromise(name, String(m), opts || {}); };
        }
      });
    }
    cache[name] = p;
    return p;
  }
  /* Run fn(plugin) safely. Resolves to fallback on the web, when the plugin is missing, or on error. */
  function call(name, fn, fallback) {
    var p = plugin(name);
    if (!p) return Promise.resolve(fallback);
    try {
      return Promise.resolve(fn(p)).then(function (v) { return v; }, function (err) {
        log(name + ' failed: ' + ((err && (err.message || err.code)) || err));
        return fallback;
      });
    } catch (err) { log(name + ' threw: ' + (err && err.message)); return Promise.resolve(fallback); }
  }
  function log(m) { try { console.info('[BRPNative] ' + m); } catch (e) {} }

  /* ---------- small storage over Preferences ---------- */
  function pget(key) { return call('Preferences', function (p) { return p.get({ key: key }).then(function (r) { return r && r.value != null ? r.value : null; }); }, null); }
  function pset(key, value) { return call('Preferences', function (p) { return p.set({ key: key, value: String(value) }).then(function () { return true; }); }, false); }
  function pdel(key) { return call('Preferences', function (p) { return p.remove({ key: key }).then(function () { return true; }); }, false); }

  /* ---------- open handler (push tap, local notification tap) ---------- */
  var openFns = [], pendingOpen = [];
  function deliverOpen(ref, source) {
    ref = ref == null ? '' : String(ref);
    if (!ref) return;
    if (!openFns.length) { pendingOpen.push([ref, source]); return; }
    openFns.forEach(function (fn) { try { fn(ref, source); } catch (e) { log('onOpen handler error: ' + e.message); } });
  }
  function onOpen(fn) {
    if (typeof fn !== 'function') return function () {};
    openFns.push(fn);
    var q = pendingOpen.splice(0);
    q.forEach(function (x) { try { fn(x[0], x[1]); } catch (e) {} });
    return function () { openFns = openFns.filter(function (f) { return f !== fn; }); };
  }
  function refOf(data) {
    if (!data) return '';
    return data.ref || data.brpRef || (data.data && data.data.ref) || '';
  }
  function emit(type, detail) { try { w.dispatchEvent(new CustomEvent(type, { detail: detail })); } catch (e) {} }

  /* ---------- QR scanning ---------- */
  function scanQR(opts) {
    opts = opts || {};
    var say = opts.prompt || 'Point the camera at the room QR code.';
    if (hasPlugin('CapacitorBarcodeScanner')) {
      return call('CapacitorBarcodeScanner', function (p) {
        /* hint 0 = QR code. All fields are sent because the iOS side decodes them as required. */
        return p.scanBarcode({ hint: 0, scanInstructions: say, scanButton: false, scanText: ' ', cameraDirection: 1, scanOrientation: 3,
          cancelButtonAccessibilityLabel: 'Cancel scan', torchButtonOnAccessibilityLabel: 'Turn on light', torchButtonOffAccessibilityLabel: 'Turn off light',
          android: { scanningLibrary: 'mlkit' } })
          .then(function (r) { var t = r && (r.ScanResult || r.scanResult); if (t) haptic('success'); return t ? String(t) : null; });
      }, null);
    }
    /* ML Kit plugin (only if the project is switched to CocoaPods and @capacitor-mlkit/barcode-scanning is installed). */
    if (hasPlugin('BarcodeScanner')) {
      return call('BarcodeScanner', function (p) {
        return p.requestPermissions().then(function (perm) {
          if (perm && perm.camera && perm.camera !== 'granted' && perm.camera !== 'limited') return null;
          return p.scan({ formats: ['QR_CODE'] }).then(function (r) {
            var b = r && r.barcodes && r.barcodes[0], t = b && (b.rawValue || b.displayValue);
            if (t) haptic('success');
            return t ? String(t) : null;
          });
        });
      }, null);
    }
    return Promise.resolve(null);
  }

  /* Pure helper (works everywhere): reads a room id out of a scanned text.
     Accepts "room:STW-412-1K", a BRP room URL ".../r/STW-412-1K" or "?room=STW-412-1K",
     and the field tablet door codes "FS-412-2B" (Fort Stewart). Returns null when no room is found. */
  var INST_ALIAS = { FS: 'STW', STW: 'STW', BRG: 'BRG', FB: 'BRG', BLS: 'BLS', FBL: 'BLS' };
  function parseRoom(text) {
    var s = String(text || '').trim(); if (!s) return null;
    /* building ids are digits (412, 20214) or a letter, a dash and digits (C-3612 at Fort Bragg) */
    var m = /room[:=]\s*([A-Za-z]{2,3})-((?:[A-Za-z]-)?[0-9A-Za-z]{2,6})-([0-9A-Za-z]{1,5})(?![0-9A-Za-z])/.exec(s) ||
            /\/r\/([A-Za-z]{2,3})-((?:[A-Za-z]-)?[0-9A-Za-z]{2,6})-([0-9A-Za-z]{1,5})(?![0-9A-Za-z])/.exec(s) ||
            /^([A-Za-z]{2,3})-([0-9]{2,6})-([0-9][A-Za-z0-9]{0,4})$/.exec(s);
    if (!m) return null;
    var inst = INST_ALIAS[m[1].toUpperCase()];
    if (!inst) return null;
    var bldg = m[2].toUpperCase(), room = m[3].toUpperCase();
    return { id: inst + '-' + bldg + '-' + room, inst: inst, bldg: bldg, room: room, tag: 'room:' + inst + '-' + bldg + '-' + room, raw: s };
  }

  /* ---------- biometric quick sign-in ---------- */
  var BIO_NAMES = { 1: 'Touch ID', 2: 'Face ID', 3: 'Fingerprint', 4: 'Face unlock', 5: 'Iris' };
  function bioCheck() {
    return call('BiometricAuthNative', function (p) { return p.checkBiometry(); }, null);
  }
  function bioAuth(reason) {
    return call('BiometricAuthNative', function (p) {
      var fn = p.internalAuthenticate || p.authenticate;
      return fn.call(p, { reason: reason, cancelTitle: 'Cancel', iosFallbackTitle: 'Use password', allowDeviceCredential: false,
        androidTitle: 'BRP One sign-in', androidSubtitle: reason, androidConfirmationRequired: false })
        .then(function () { return true; });
    }, false);
  }
  var biometric = {
    /* true when the device has Face ID or Touch ID (or Android biometrics) set up */
    isAvailable: function () { return bioCheck().then(function (r) { return !!(r && r.isAvailable); }); },
    /* 'Face ID', 'Touch ID', ... or null. Use it for the button label. */
    label: function () { return bioCheck().then(function (r) { return r && r.isAvailable ? (BIO_NAMES[r.biometryType] || 'Biometrics') : null; }); },
    /* The email saved for quick sign-in, or null. Does not prompt. */
    enrolledEmail: function () { return isNative() ? pget(K.bioEmail) : Promise.resolve(null); },
    /* Confirms with Face ID, then saves the email. Resolves true when saved. */
    enable: function (email) {
      email = String(email || '').trim().toLowerCase();
      if (!email || !isNative()) return Promise.resolve(false);
      return biometric.isAvailable().then(function (ok) {
        if (!ok) return false;
        return bioAuth('Turn on quick sign-in for ' + email + '.').then(function (passed) {
          return passed ? pset(K.bioEmail, email) : false;
        });
      });
    },
    /* Prompts Face ID. Resolves to the saved email on success, else null. */
    unlock: function () {
      if (!isNative()) return Promise.resolve(null);
      return pget(K.bioEmail).then(function (email) {
        if (!email) return null;
        return bioAuth('Sign in to BRP One as ' + email + '.').then(function (passed) { return passed ? email : null; });
      });
    },
    /* Forgets the saved email. */
    disable: function () { return isNative() ? pdel(K.bioEmail) : Promise.resolve(false); }
  };

  /* ---------- push (APNs on iOS, FCM on Android) ---------- */
  var pushToken = null, pushWired = false, pushWaiters = [];
  function wirePush(p) {
    if (pushWired) return; pushWired = true;
    p.addListener('registration', function (t) { pushToken = t && t.value || null; pushWaiters.splice(0).forEach(function (f) { f(pushToken); }); emit('brp-native-push-token', { token: pushToken }); });
    p.addListener('registrationError', function (e) { log('push registration error: ' + (e && e.error)); pushWaiters.splice(0).forEach(function (f) { f(null); }); });
    /* Foreground: iOS shows the banner itself (presentationOptions in capacitor.config.json). The app can also listen. */
    p.addListener('pushNotificationReceived', function (n) {
      haptic('warning');
      emit('brp-native-push', { title: n && n.title, body: n && n.body, ref: refOf(n && n.data), data: n && n.data });
    });
    p.addListener('pushNotificationActionPerformed', function (a) { deliverOpen(refOf(a && a.notification && a.notification.data), 'push'); });
  }
  var push = {
    /* Asks permission, registers with APNs/FCM and resolves the device token, or null. */
    register: function () {
      return call('PushNotifications', function (p) {
        wirePush(p);
        if (pushToken) return pushToken;
        return p.checkPermissions().then(function (s) {
          return s.receive === 'prompt' || s.receive === 'prompt-with-rationale' ? p.requestPermissions() : s;
        }).then(function (s) {
          if (!s || s.receive !== 'granted') return null;
          return new Promise(function (res) {
            var done = false, t = setTimeout(function () { if (!done) { done = true; res(null); } }, 20000);
            pushWaiters.push(function (v) { if (!done) { done = true; clearTimeout(t); res(v); } });
            p.register();
          });
        });
      }, null);
    },
    /* Last token seen in this session, or null. */
    token: function () { return Promise.resolve(pushToken); }
  };

  /* ---------- local notifications (real banners before a push server exists) ---------- */
  var localWired = false, localPerm = null, nextId = Math.floor(Date.now() / 1000) % 1000000;
  function wireLocal(p) {
    if (localWired) return; localWired = true;
    p.addListener('localNotificationActionPerformed', function (a) { deliverOpen(refOf(a && a.notification && a.notification.extra), 'local'); });
  }
  function notify(n) {
    n = n || {};
    if (!n.title) return Promise.resolve(false);
    return call('LocalNotifications', function (p) {
      wireLocal(p);
      var perm = localPerm ? Promise.resolve(localPerm) : p.checkPermissions().then(function (s) {
        return s.display === 'granted' ? s : p.requestPermissions();
      }).then(function (s) { localPerm = s; return s; });
      return perm.then(function (s) {
        if (!s || s.display !== 'granted') { localPerm = null; return false; }
        return p.schedule({ notifications: [{ id: ++nextId, title: String(n.title).slice(0, 120), body: String(n.body || '').slice(0, 240),
          extra: { ref: n.ref || '' }, threadIdentifier: n.ref ? String(n.ref).split(':')[0] : 'brp' }] }).then(function () { return true; });
      });
    }, false);
  }
  /* 'granted' | 'denied' | 'prompt' | null (web). Does not prompt. */
  function notifyPermission() {
    return call('LocalNotifications', function (p) { return p.checkPermissions().then(function (s) { return s.display === 'granted' ? 'granted' : s.display === 'denied' ? 'denied' : 'prompt'; }); }, null);
  }

  /* ---------- haptics ---------- */
  function haptic(kind) {
    kind = kind || 'light';
    return call('Haptics', function (p) {
      if (kind === 'success' || kind === 'warning' || kind === 'error') return p.notification({ type: kind.toUpperCase() }).then(function () { return true; });
      if (kind === 'select') return p.selectionStart().then(function () { return p.selectionChanged(); }).then(function () { return p.selectionEnd(); }).then(function () { return true; });
      var style = kind === 'heavy' ? 'HEAVY' : kind === 'medium' ? 'MEDIUM' : 'LIGHT';
      return p.impact({ style: style }).then(function () { return true; });
    }, false);
  }

  /* ---------- share ---------- */
  function workOrderLink(id) { return WEB_BASE + '?ref=' + encodeURIComponent('wo:' + String(id || '')); }
  function share(o) {
    o = o || {};
    return call('Share', function (p) {
      return p.share({ title: o.title || 'BRP One', text: o.text || '', url: o.url || undefined, dialogTitle: o.dialogTitle || 'Share' })
        .then(function () { return true; });
    }, false);
  }
  /* Shares a work order link. wo = 'WO-24366' or { id, title, place }. */
  function shareWorkOrder(wo) {
    var id = typeof wo === 'string' ? wo : wo && wo.id;
    if (!id) return Promise.resolve(false);
    var title = (wo && wo.title) ? id + ': ' + wo.title : 'Work order ' + id;
    var place = wo && wo.place ? ' (' + wo.place + ')' : '';
    return share({ title: title, text: title + place + '. BRP One demo, sample data.', url: workOrderLink(id), dialogTitle: 'Share work order' });
  }

  /* ---------- status bar and safe area ---------- */
  /* tone = the color of what sits under the status bar: 'dark' (ink) or 'light' (bone). */
  function statusBar(tone) {
    return call('StatusBar', function (p) {
      var jobs = [p.setStyle({ style: tone === 'light' ? 'LIGHT' : 'DARK' })];
      if (platform() === 'android') jobs.push(p.setOverlaysWebView({ overlay: true }));
      return Promise.all(jobs).then(function () { return true; });
    }, false);
  }
  function setupChrome() {
    var html = document.documentElement;
    html.classList.add('brp-native', 'brp-' + platform());
    /* CSS can use var(--brp-safe-top) and so on. env() already works in WKWebView; these give one name for both platforms. */
    var st = document.createElement('style');
    st.id = 'brp-native-css';
    st.textContent = ':root{--brp-safe-top:env(safe-area-inset-top,0px);--brp-safe-right:env(safe-area-inset-right,0px);--brp-safe-bottom:env(safe-area-inset-bottom,0px);--brp-safe-left:env(safe-area-inset-left,0px)}' +
      'html.brp-native{-webkit-tap-highlight-color:transparent}html.brp-native body{overscroll-behavior:none}';
    (document.head || html).appendChild(st);
    statusBar('dark');
    /* Android back button: go back in the app, or leave it at the first screen. */
    call('App', function (p) {
      p.addListener('backButton', function (e) { if (e && e.canGoBack) history.back(); else p.minimizeApp && p.minimizeApp(); });
      p.addListener('appUrlOpen', function (e) {
        try { var u = new URL(e.url); var r = u.searchParams.get('ref'); if (r) deliverOpen(r, 'link'); } catch (x) {}
      });
      return true;
    }, false);
    /* Wire tap listeners early so a tap that launched the app is not lost. */
    var pp = plugin('PushNotifications'); if (pp) { try { wirePush(pp); } catch (e) {} }
    var lp = plugin('LocalNotifications'); if (lp) { try { wireLocal(lp); } catch (e) {} }
  }

  /* ---------- review prompt (SKStoreReviewController on iOS, Play in-app review on Android) ---------- */
  /* Call after a completed positive action (for example a Soldier confirms a fix, or a thumbs up).
     Each call counts one action. It asks the OS only when all hold: 3 or more positive actions,
     installed 2 or more days, and no ask in the last 120 days. The OS decides whether to show it
     (Apple shows it at most 3 times a year). Resolves true when the OS was asked. */
  function requestReview() {
    if (!isNative() || !hasPlugin('AppReview')) return Promise.resolve(false);
    var now = Date.now();
    return Promise.all([pget(K.revCount), pget(K.revLast), pget(K.firstRun)]).then(function (v) {
      var count = (parseInt(v[0], 10) || 0) + 1, last = parseInt(v[1], 10) || 0, first = parseInt(v[2], 10) || now;
      return pset(K.revCount, count).then(function () {
        if (count < REVIEW.minActions) return false;
        if (now - first < REVIEW.minDaysInstalled * DAY) return false;
        if (last && now - last < REVIEW.minDaysBetween * DAY) return false;
        return pset(K.revLast, now).then(function () {
          return call('AppReview', function (p) { return p.requestReview().then(function () { return true; }); }, false);
        });
      });
    });
  }

  /* ---------- diagnostics ---------- */
  function info() {
    var names = ['CapacitorBarcodeScanner', 'BarcodeScanner', 'BiometricAuthNative', 'Preferences', 'PushNotifications', 'LocalNotifications', 'Haptics', 'Share', 'StatusBar', 'App', 'AppReview'];
    var plugins = {}; names.forEach(function (n) { plugins[n] = hasPlugin(n); });
    return { version: VERSION, native: isNative(), platform: platform(), plugins: plugins };
  }

  var api = {
    version: VERSION,
    isNative: isNative,            // sync: true inside the iOS or Android app
    platform: platform,            // sync: 'ios' | 'android' | 'web'
    info: info,                    // sync: { version, native, platform, plugins }
    scanQR: scanQR,                // Promise<string|null>
    parseRoom: parseRoom,          // sync, pure: { id, inst, bldg, room, tag, raw } | null
    biometric: biometric,          // isAvailable, label, enrolledEmail, enable(email), unlock, disable
    push: push,                    // register() -> token|null, token()
    notify: notify,                // ({ title, body, ref }) -> Promise<boolean>
    notifyPermission: notifyPermission,
    onOpen: onOpen,                // (fn(ref, source)) -> unsubscribe
    haptic: haptic,                // ('light'|'medium'|'heavy'|'success'|'warning'|'error'|'select') -> Promise<boolean>
    share: share,                  // ({ title, text, url }) -> Promise<boolean>
    shareWorkOrder: shareWorkOrder,// ('WO-24366' | { id, title, place }) -> Promise<boolean>
    workOrderLink: workOrderLink,  // sync, pure: web link with ?ref=wo:ID
    statusBar: statusBar,          // ('dark'|'light') -> Promise<boolean>
    requestReview: requestReview   // rate-limited -> Promise<boolean>
  };
  w.BRPNative = api;

  if (isNative()) {
    pget(K.firstRun).then(function (v) { if (!v) pset(K.firstRun, Date.now()); });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupChrome); else setupChrome();
  }
})(window);
