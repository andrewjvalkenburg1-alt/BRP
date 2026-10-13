// Playwright check of the "Agent proposals" panel in backend/client/admin.html, local demo mode, phone and desktop.
// Run: NODE_PATH=$(npm root -g) node backend/agents/test/admin-panel-test.mjs [screenshot dir]
// Needs Playwright's Chromium (PLAYWRIGHT_BROWSERS_PATH, e.g. /opt/pw-browsers). Serves backend/client on a local port.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../client');
const SHOTS = process.argv[2] || null;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = createServer(async (req, res) => {
  try {
    const p = join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'admin.html');
    if (!p.startsWith(ROOT)) throw new Error('outside');
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(await readFile(p));
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}/admin.html`;

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('ok  ' + m); };
const browser = await chromium.launch();
try {
  for (const vp of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'phone', width: 390, height: 844 }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.name === 'phone' ? 3 : 1, isMobile: vp.name === 'phone', hasTouch: vp.name === 'phone' });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());   // offline: fonts fall back
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_FAILED|net::/.test(m.text())) errors.push(m.text()); });
    const noSideScroll = async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    await page.goto(base);

    // A non-admin is refused before any panel shows.
    await page.click('#g-accts summary');
    await page.click('button[data-email="buyer@brp.demo"]');
    await page.waitForSelector('#g-err:not(:empty)');
    ok(/Refused/.test(await page.textContent('#g-err')) && await page.isHidden('#app'), `${vp.name}: a Buyer sign-in is refused (admin only)`);

    await page.click('button[data-email="admin@brp.demo"]');
    await page.waitForSelector('#app:not([hidden])');
    await page.click('button[data-tab="agents"]');
    await page.waitForSelector('[data-panel="aprop"]');
    const head = await page.textContent('main .head');
    ok(/Agent proposals/.test(head) && /Nothing is executed/.test(head), `${vp.name}: panel opens and says approval executes nothing`);
    ok(/Sample data\./.test(await page.textContent('.sample-note')), `${vp.name}: SAMPLE DATA label is shown`);
    ok((await page.locator('[data-panel="aprop"] tbody tr').count()) === 5 && (await page.locator('[data-panel="aprop"] .tag.sample').count()) === 5, `${vp.name}: 5 waiting sample proposals, each tagged Sample`);
    ok(/Agreement rate\s*50%/.test(await page.textContent('.cards')), `${vp.name}: agreement rate 50% (1 approved, 1 rejected)`);
    ok(await noSideScroll(), `${vp.name}: no sideways page scroll`);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `agents-${vp.name}.png`), fullPage: true });

    // Review the over-limit order: reject needs a note, then approve.
    await page.click('[data-panel="aprop"] tr:has-text("AP-S0002") button[data-edit]');
    await page.waitForSelector('dialog[open]');
    ok(/Over \$500 per order/.test(await page.textContent('dialog')) && /site lead's approval task/.test(await page.textContent('dialog')), `${vp.name}: over-limit proposal shows its flag and the site lead rule`);
    ok(await page.evaluate(() => { const d = document.querySelector('dialog'); return d.scrollWidth <= d.clientWidth + 1; }), `${vp.name}: review dialog fits the screen width`);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `agents-review-${vp.name}.png`) });
    await page.check('input[name="f-dec"][value="rejected"]');
    await page.click('#dlg-save');
    ok(/Say why/.test(await page.textContent('#dlg-err')), `${vp.name}: rejecting without a reason is refused`);
    await page.check('input[name="f-dec"][value="approved"]');
    await page.click('#dlg-save');
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    ok(/approved\. Nothing was executed/.test(await page.textContent('#toast')), `${vp.name}: approval recorded, toast says nothing was executed`);
    await page.waitForFunction(() => /Agreement rate\s*67%/.test(document.querySelector('.cards').textContent));
    ok((await page.locator('[data-panel="aprop"] tbody tr').count()) === 4, `${vp.name}: waiting list drops to 4; agreement rate 67%`);
    await page.click('button[data-astatus="approved"]');
    ok(/AP-S0002/.test(await page.textContent('[data-panel="aprop"]')), `${vp.name}: AP-S0002 is under Approved`);

    // Reject with a reason.
    await page.click('button[data-astatus="proposed"]');
    await page.click('[data-panel="aprop"] tr:has-text("AP-S0004") button[data-edit]');
    await page.check('input[name="f-dec"][value="rejected"]');
    await page.fill('#f-note', 'Duration not shown; check the history first.');
    await page.click('#dlg-save');
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    await page.click('button[data-astatus="rejected"]');
    ok(/AP-S0004/.test(await page.textContent('[data-panel="aprop"]')), `${vp.name}: AP-S0004 rejected with a reason`);

    // Off switch, and the demo admin cannot set live.
    await page.click('[data-panel="amode"] tr:has-text("Sensor Watch") button[data-edit]');
    await page.selectOption('#f-mode', 'live');
    await page.click('#dlg-save');
    ok(/off or shadow only/.test(await page.textContent('#dlg-err')), `${vp.name}: demo admin cannot set an agent live`);
    await page.selectOption('#f-mode', 'off');
    await page.click('#dlg-save');
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    ok(/Sensor Watch[\s\S]*Off/.test(await page.textContent('[data-panel="amode"]')), `${vp.name}: Sensor Watch switched off`);

    // The decisions are in the audit log.
    await page.click('button[data-tab="audit"]');
    await page.waitForSelector('[data-panel="audit"]');
    const audit = await page.textContent('[data-panel="audit"]');
    ok(/agent_proposals/.test(audit) && /agent_settings/.test(audit), `${vp.name}: decisions and the mode change are in the audit log`);
    ok(await noSideScroll(), `${vp.name}: still no sideways scroll`);
    ok(errors.length === 0, `${vp.name}: no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`ALL ADMIN PANEL TESTS PASSED (${n})`);
