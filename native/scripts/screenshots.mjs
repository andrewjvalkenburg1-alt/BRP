// App Store screenshots from the live app, at the two sizes App Store Connect requires (2026):
//   iPhone 6.9" display: 1320 x 2868 portrait (440 x 956 points at 3x)
//   iPad 13" display:    2064 x 2752 portrait (1032 x 1376 points at 2x)
// Output: native/store/screenshots/<device>/<nn>-<view>.png
// Run: npm run screenshots   (BRP_URL overrides the live URL, for example a local server)
import { loadPlaywright, signIn } from './pw.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const { chromium } = loadPlaywright();
const URL_ = process.env.BRP_URL || 'https://andrewjvalkenburg1-alt.github.io/BRP/';
const OUT = join(import.meta.dirname, '..', 'store', 'screenshots');

const DEVICES = [
  { id: 'iphone-6.9', viewport: { width: 440, height: 956 }, scale: 3, mobile: true,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' },
  { id: 'ipad-13', viewport: { width: 1032, height: 1376 }, scale: 2, mobile: true,
    ua: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' }
];
const SHOTS = [
  { n: '01', name: 'soldier-portal', email: 'soldier@brp.demo', hash: '#/portal' },
  { n: '02', name: 'field-tablet', email: 'tech@brp.demo', hash: '#/field' },
  { n: '03', name: 'commander-dashboard', email: 'commander@brp.demo', hash: '#/dashboard' },
  { n: '04', name: 'erp', email: 'pm@brp.demo', hash: '#/erp' },
  { n: '05', name: 'satisfaction', email: 'pm@brp.demo', hash: '#/satisfaction' }
];

function proxy() {
  const p = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!p || process.env.BRP_URL) return undefined;
  const u = new URL(p);
  return { server: `${u.protocol}//${u.host}`, username: decodeURIComponent(u.username) || undefined, password: decodeURIComponent(u.password) || undefined };
}

const browser = await chromium.launch({ proxy: proxy() });
let made = 0;
for (const d of DEVICES) {
  mkdirSync(join(OUT, d.id), { recursive: true });
  for (const s of SHOTS) {
    const ctx = await browser.newContext({ viewport: d.viewport, deviceScaleFactor: d.scale, isMobile: d.mobile, hasTouch: true, userAgent: d.ua, colorScheme: 'light', reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto(URL_, { waitUntil: 'networkidle', timeout: 60000 });
    await signIn(page, s.email);
    await page.evaluate((h) => { location.hash = h; }, s.hash);
    await page.waitForTimeout(3500);
    // Close the notification card and the sign-in toast if they are up.
    await page.evaluate(() => {
      const later = document.querySelector('#ncard:not([hidden]) [data-notif-later]'); if (later) later.click();
      const t = document.getElementById('toast'); if (t) t.hidden = true;
    });
    await page.waitForTimeout(600);
    const file = join(OUT, d.id, `${s.n}-${s.name}.png`);
    await page.screenshot({ path: file, fullPage: false });
    console.log('  ' + file.replace(join(import.meta.dirname, '..') + '/', ''));
    made++;
    await ctx.close();
  }
}
await browser.close();
console.log(made + ' screenshots from ' + URL_);
