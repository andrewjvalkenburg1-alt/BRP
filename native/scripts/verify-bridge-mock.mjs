// Exercises the bridge's native code path on Linux. A fake Capacitor native runtime (the same
// hooks the iOS runtime injects: webkit.messageHandlers.bridge, PluginHeaders, nativePromise,
// nativeCallback) records every plugin call, so we can check the bridge sends the right calls
// and reads the answers correctly. Real devices are still needed for the plugins themselves.
// Run: node scripts/verify-bridge-mock.mjs
import { loadPlaywright, serve } from './pw.mjs';
import { join } from 'node:path';

const { chromium } = loadPlaywright();
const ROOT = join(import.meta.dirname, '..');

const MOCK = `<script>
(function(){
  window.webkit = { messageHandlers: { bridge: { postMessage: function(){} } } };
  var calls = [], store = {}, listeners = {};
  function H(name, ms, ev){ var m = ms.map(function(n){ return { name: n, rtype: 'promise' }; }); if (ev) m.push({ name: 'addListener', rtype: 'callback' }, { name: 'removeListener', rtype: 'promise' }); return { name: name, methods: m }; }
  function fire(p, ev, d){ (listeners[p + ':' + ev] || []).forEach(function(f){ f(d); }); }
  var impl = {
    'CapacitorBarcodeScanner.scanBarcode': function(){ return { ScanResult: 'https://andrewjvalkenburg1-alt.github.io/BRP/?room=STW-412-1K', format: 0 }; },
    'BiometricAuthNative.checkBiometry': function(){ return { isAvailable: true, biometryType: 2, biometryTypes: [2], deviceIsSecure: true, reason: '', code: '' }; },
    'BiometricAuthNative.internalAuthenticate': function(){ return undefined; },
    'Preferences.get': function(o){ return { value: o.key in store ? store[o.key] : null }; },
    'Preferences.set': function(o){ store[o.key] = o.value; },
    'Preferences.remove': function(o){ delete store[o.key]; },
    'PushNotifications.checkPermissions': function(){ return { receive: 'prompt' }; },
    'PushNotifications.requestPermissions': function(){ return { receive: 'granted' }; },
    'PushNotifications.register': function(){ setTimeout(function(){ fire('PushNotifications', 'registration', { value: 'apns-token-abc123' }); }, 30); },
    'LocalNotifications.checkPermissions': function(){ return { display: 'prompt' }; },
    'LocalNotifications.requestPermissions': function(){ return { display: 'granted' }; },
    'LocalNotifications.schedule': function(o){ return { notifications: o.notifications.map(function(n){ return { id: n.id }; }) }; },
    'Share.share': function(){ return { activityType: 'com.apple.UIKit.activity.CopyToPasteboard' }; },
    'AppReview.requestReview': function(){ return undefined; }
  };
  /* What native-bridge.js sets up before any page script runs. */
  window.Capacitor = {
    Plugins: {}, isNativePlatform: function(){ return true; }, getPlatform: function(){ return 'ios'; },
    isPluginAvailable: function(n){ return Object.prototype.hasOwnProperty.call(window.Capacitor.Plugins, n); },
    PluginHeaders: [
      H('CapacitorBarcodeScanner', ['scanBarcode']),
      H('BiometricAuthNative', ['checkBiometry', 'internalAuthenticate']),
      H('Preferences', ['get', 'set', 'remove', 'keys', 'clear']),
      H('PushNotifications', ['register', 'unregister', 'checkPermissions', 'requestPermissions', 'getDeliveredNotifications'], true),
      H('LocalNotifications', ['schedule', 'checkPermissions', 'requestPermissions', 'cancel'], true),
      H('Haptics', ['impact', 'notification', 'vibrate', 'selectionStart', 'selectionChanged', 'selectionEnd']),
      H('Share', ['share', 'canShare']),
      H('StatusBar', ['setStyle', 'setBackgroundColor', 'setOverlaysWebView', 'show', 'hide']),
      H('App', ['exitApp', 'getInfo', 'getState', 'minimizeApp'], true),
      H('AppReview', ['requestReview', 'openAppStore'])
    ],
    nativePromise: function(p, m, o){ calls.push(p + '.' + m + ' ' + JSON.stringify(o || {})); var f = impl[p + '.' + m]; return Promise.resolve(f ? f(o || {}) : undefined); },
    nativeCallback: function(p, m, o, cb){ calls.push(p + '.' + m + ' ' + JSON.stringify(o || {})); if (m === 'addListener') (listeners[p + ':' + o.eventName] = listeners[p + ':' + o.eventName] || []).push(cb); return 'cb' + calls.length; }
  };
  window.__mock = { calls: calls, store: store, fire: fire };
})();
</script>`;

async function run(label, injectCore) {
  const srv = await serve(join(ROOT, 'www'), {
    inject: (h) => {
      h = h.replace(/(<meta name="viewport"[^>]*>)/i, '$1\n' + MOCK);
      return injectCore ? h : h.replace('<script src="capacitor.js"></script>', '');
    }
  });
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(srv.url, { waitUntil: 'load' });
  const r = await page.evaluate(async () => {
    const N = window.BRPNative, M = window.__mock, out = {};
    out.isNative = N.isNative(); out.platform = N.platform();
    out.htmlClass = document.documentElement.className.includes('brp-native');
    out.scan = await N.scanQR();
    out.scanRoom = (N.parseRoom(out.scan) || {}).id;
    out.bioAvail = await N.biometric.isAvailable();
    out.bioLabel = await N.biometric.label();
    out.enable = await N.biometric.enable('Soldier@BRP.demo');
    out.enrolled = await N.biometric.enrolledEmail();
    out.unlock = await N.biometric.unlock();
    out.storedKeys = Object.keys(M.store).sort();
    out.noPassword = !JSON.stringify(M.store).includes('BRPdemo');
    out.token = await N.push.register();
    let opened = [];
    N.onOpen((ref, src) => opened.push(src + ' ' + ref));
    out.notify = await N.notify({ title: 'Emergency: no heat', body: 'Bldg 412 Rm 1K', ref: 'wo:WO-24366' });
    M.fire('LocalNotifications', 'localNotificationActionPerformed', { actionId: 'tap', notification: { id: 1, extra: { ref: 'wo:WO-24366' } } });
    M.fire('PushNotifications', 'pushNotificationActionPerformed', { actionId: 'tap', notification: { data: { ref: 'room:STW-412-1K' } } });
    await new Promise((res) => setTimeout(res, 50));
    out.opened = opened;
    out.haptic = await N.haptic('success');
    out.share = await N.shareWorkOrder({ id: 'WO-24366', title: 'No heat', place: 'Fort Stewart Bldg 412 Rm 1K' });
    M.store['brp.firstRun'] = String(Date.now() - 10 * 86400000);
    out.review = [await N.requestReview(), await N.requestReview(), await N.requestReview(), await N.requestReview()];
    out.disable = await N.biometric.disable();
    out.enrolledAfter = await N.biometric.enrolledEmail();
    out.calls = M.calls;
    return out;
  });
  await browser.close(); srv.close();

  const want = {
    isNative: true, platform: 'ios', htmlClass: true, scan: 'https://andrewjvalkenburg1-alt.github.io/BRP/?room=STW-412-1K', scanRoom: 'STW-412-1K',
    bioAvail: true, bioLabel: 'Face ID', enable: true, enrolled: 'soldier@brp.demo', unlock: 'soldier@brp.demo', noPassword: true,
    token: 'apns-token-abc123', notify: true, opened: ['local wo:WO-24366', 'push room:STW-412-1K'], haptic: true, share: true,
    review: [false, false, true, false], disable: true, enrolledAfter: null
  };
  let bad = 0; const lines = [];
  for (const [k, v] of Object.entries(want)) {
    const ok = JSON.stringify(r[k]) === JSON.stringify(v); if (!ok) bad++;
    lines.push(`  ${ok ? 'ok  ' : 'FAIL'} ${k} -> ${JSON.stringify(r[k])}`);
  }
  const has = (s) => r.calls.some((c) => c.startsWith(s));
  for (const s of ['StatusBar.setStyle {"style":"DARK"}', 'App.addListener {"eventName":"backButton"}', 'CapacitorBarcodeScanner.scanBarcode {"hint":0', 'BiometricAuthNative.internalAuthenticate', 'Preferences.set {"key":"brp.bio.email","value":"soldier@brp.demo"}', 'PushNotifications.register', 'LocalNotifications.schedule', 'Haptics.notification {"type":"SUCCESS"}', 'Share.share', 'AppReview.requestReview']) {
    const ok = has(s); if (!ok) bad++; lines.push(`  ${ok ? 'ok  ' : 'FAIL'} call ${s}`);
  }
  bad += errors.length;
  console.log(`\n[mock native, ${label}]`);
  console.log(lines.join('\n'));
  console.log('  stored in Preferences: ' + r.storedKeys.join(', '));
  console.log('  script errors: ' + (errors.length ? errors.join(' | ') : 'none'));
  return bad;
}

let bad = 0;
bad += await run('with capacitor.js (registerPlugin path)', true);
bad += await run('runtime only, no capacitor.js (nativePromise path)', false);
console.log(bad ? `\n${bad} problem(s).` : '\nBridge native path correct in both modes.');
process.exit(bad ? 1 : 0);
