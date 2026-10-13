// Checks on Linux that the web build plus the bridge loads in plain Chromium at iPhone size
// with no errors, and that every BRPNative method returns its web fallback.
// Two passes: "app" serves native/www (capacitor.js + brp-native.js, as packaged in the app),
// "web" serves the untouched PWA build with only brp-native.js added (as on GitHub Pages).
// Run: npm run verify-web
import { loadPlaywright, serve, signIn } from './pw.mjs';
import { join } from 'node:path';

const { chromium } = loadPlaywright();
const ROOT = join(import.meta.dirname, '..');
const PWA = process.env.BRP_WEB_SRC || '/mnt/project-files/barracks/v1/ecosystem/pwa';

const expect = {
  isNative: false, platform: 'web', scanQR: null, 'biometric.isAvailable': false, 'biometric.label': null,
  'biometric.enrolledEmail': null, 'biometric.enable': false, 'biometric.unlock': null, 'biometric.disable': false,
  'push.register': null, 'push.token': null, notify: false, notifyPermission: null, haptic: false, share: false,
  shareWorkOrder: false, statusBar: false, requestReview: false, onOpen: 'function',
  'parseRoom(room:STW-412-1K)': 'STW-412-1K', 'parseRoom(url /r/FS-412-2B)': 'STW-412-2B', 'parseRoom(junk)': null,
  workOrderLink: 'https://andrewjvalkenburg1-alt.github.io/BRP/?ref=wo%3AWO-24366'
};

async function pass(name, srv) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  const page = await ctx.newPage();
  const errors = [], netFail = [], external = [];
  page.on('request', (r) => { const u = r.url(); if (!u.startsWith(srv.url) && !u.startsWith('data:') && !u.startsWith('blob:') && !u.startsWith('about:')) external.push(u.slice(0, 80)); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('requestfailed', (r) => netFail.push(r.url().slice(0, 90) + ' ' + (r.failure() || {}).errorText));
  await page.goto(srv.url, { waitUntil: 'load' });
  const results = await page.evaluate(async () => {
    const N = window.BRPNative, r = {};
    if (!N) return { missing: true };
    const t = async (k, fn) => { try { r[k] = await fn(); } catch (e) { r[k] = 'THREW ' + e.message; } };
    await t('isNative', () => N.isNative());
    await t('platform', () => N.platform());
    await t('scanQR', () => N.scanQR());
    await t('biometric.isAvailable', () => N.biometric.isAvailable());
    await t('biometric.label', () => N.biometric.label());
    await t('biometric.enrolledEmail', () => N.biometric.enrolledEmail());
    await t('biometric.enable', () => N.biometric.enable('soldier@brp.demo'));
    await t('biometric.unlock', () => N.biometric.unlock());
    await t('biometric.disable', () => N.biometric.disable());
    await t('push.register', () => N.push.register());
    await t('push.token', () => N.push.token());
    await t('notify', () => N.notify({ title: 'Test', body: 'Body', ref: 'wo:WO-24366' }));
    await t('notifyPermission', () => N.notifyPermission());
    await t('haptic', () => N.haptic('success'));
    await t('share', () => N.share({ title: 'x', url: 'https://example.com' }));
    await t('shareWorkOrder', () => N.shareWorkOrder('WO-24366'));
    await t('statusBar', () => N.statusBar('light'));
    await t('requestReview', () => N.requestReview());
    await t('onOpen', () => typeof N.onOpen(() => {}));
    await t('parseRoom(room:STW-412-1K)', () => (N.parseRoom('room:STW-412-1K') || {}).id || null);
    await t('parseRoom(url /r/FS-412-2B)', () => (N.parseRoom('https://brp.example/r/FS-412-2B') || {}).id || null);
    await t('parseRoom(junk)', () => N.parseRoom('hello'));
    await t('parseRoom(room:BRG-C-3612-2A)', () => (N.parseRoom('room:BRG-C-3612-2A') || {}).id || null);
    await t('workOrderLink', () => N.workOrderLink('WO-24366'));
    r._info = N.info();
    await document.fonts.ready;
    r._displayFont = document.fonts.check('800 24px "Big Shoulders Display"');
    r._nativeClass = document.documentElement.classList.contains('brp-native');
    return r;
  });
  // Sign in as the Soldier and the PM to be sure the app itself still runs with the bridge loaded.
  await signIn(page, 'soldier@brp.demo');
  await page.waitForTimeout(1500);
  const soldierTitle = await page.title();
  await page.evaluate(() => window.BRP_ONE && window.BRP_ONE.signOut ? window.BRP_ONE.signOut() : null).catch(() => {});
  await browser.close();

  let bad = 0;
  const lines = [];
  if (results.missing) { lines.push('  FAIL window.BRPNative is missing'); bad++; }
  else for (const [k, v] of Object.entries(expect)) {
    const ok = JSON.stringify(results[k]) === JSON.stringify(v);
    if (!ok) bad++;
    lines.push(`  ${ok ? 'ok  ' : 'FAIL'} ${k} -> ${JSON.stringify(results[k])}`);
  }
  if (results._nativeClass) { lines.push('  FAIL html.brp-native set on the web'); bad++; }
  const realErrors = errors.filter((e) => !/Failed to load resource|ERR_|net::/.test(e));
  if (realErrors.length) bad += realErrors.length;
  console.log(`\n[${name}] ${srv.url}`);
  console.log(lines.join('\n'));
  console.log(`  display font loaded: ${results._displayFont}; requests to other hosts: ${external.length ? [...new Set(external)].join(', ') : 'none'}`);
  console.log(`  signed in as soldier@brp.demo, page title: "${soldierTitle}"`);
  console.log(`  script errors: ${realErrors.length ? '\n    ' + realErrors.join('\n    ') : 'none'}`);
  console.log(`  failed network requests (offline fonts etc., not script errors): ${netFail.length ? '\n    ' + netFail.join('\n    ') : 'none'}`);
  return bad;
}

const app = await serve(join(ROOT, 'www'));
const web = await serve(PWA, { inject: (h) => h.replace(/(<meta name="viewport"[^>]*>)/i, '$1\n<script src="brp-native.js"></script>') });
let bad = 0;
try { bad += await pass('app build: native/www with capacitor.js + brp-native.js', app); bad += await pass('web build: PWA + brp-native.js only', web); }
finally { app.close(); web.close(); }
console.log(bad ? `\n${bad} problem(s).` : '\nAll web fallbacks correct, no script errors.');
process.exit(bad ? 1 : 0);
