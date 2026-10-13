// Playwright check of BRP HQ (backend/hq/) in local demo mode, at 390 px (phone) and 1280 px (desktop).
// Run: bash backend/hq/test/run.sh [screenshot dir]
// Serves the repository root on a local port (read only) so the page sees the same relative paths as on GitHub Pages.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SHOTS = process.argv[2] || null;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = join(ROOT, p);
    if (!f.startsWith(ROOT + '/')) throw new Error('outside');
    res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' }); res.end(await readFile(f));
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}/backend/hq/`;

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('ok  ' + m); };
const launch = { executablePath: process.env.PW_CHROMIUM || undefined };
const browser = await chromium.launch(launch.executablePath ? launch : {});
const SECTIONS = { home: 'Needs you', tasks: 'Tasks', decisions: 'Decisions', agents: 'Agents', erp: 'Purchasing', rooms: 'Rooms', systems: 'Systems', docs: 'Documents', ask: 'Claude' };

try {
  for (const vp of [{ name: 'phone', width: 390, height: 844 }, { name: 'desktop', width: 1280, height: 900 }]) {
    const phone = vp.name === 'phone';
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: phone ? 3 : 1, isMobile: phone, hasTouch: phone });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());   // offline: fonts fall back
    const page = await ctx.newPage();
    const errors = [];
    const watch = (p) => {
      p.on('pageerror', (e) => errors.push(e.message));
      p.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_FAILED|net::/.test(m.text())) errors.push(m.text()); });
    };
    watch(page);
    page.on('frameattached', () => {});
    const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    const shot = async (name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `hq-${name}-${vp.name}.png`), fullPage: !/chat|more/.test(name) }); };
    const goto = async (id) => {
      if (phone) {
        if (['home', 'tasks', 'decisions', 'agents'].includes(id)) await page.click(`#bnav button[data-go="${id}"]`);
        else { await page.click('#more-btn'); await page.waitForSelector('#more-sheet:not([hidden])'); await page.click(`#more-list button[data-go="${id}"]`); }
      } else await page.click(`#side button[data-go="${id}"]`);
      await page.waitForFunction((t) => { const h = document.querySelector('#main .head h1'); return h && h.textContent.trim() === t; }, SECTIONS[id]);
    };

    await page.goto(base);
    ok(await page.isVisible('#gate') && /BRPdemo2026!/.test(await page.textContent('#g-accts')), `${vp.name}: sign-in screen shows the demo accounts and the demo password`);
    ok(/owner@brp\.demo/.test(await page.textContent('#g-list')), `${vp.name}: owner@brp.demo is on the demo list`);
    ok(await noSideScroll(), `${vp.name}: sign-in screen has no sideways scroll`);
    await shot('gate');

    // A BRP One role without HQ access is refused.
    await page.fill('#g-email', 'buyer@brp.demo'); await page.fill('#g-pw', 'BRPdemo2026!'); await page.click('#g-submit');
    await page.waitForSelector('#g-err:not(:empty)');
    ok(/Refused/.test(await page.textContent('#g-err')) && await page.isHidden('#app'), `${vp.name}: a Buyer is refused`);
    await page.fill('#g-pw', 'wrong'); await page.fill('#g-email', 'owner@brp.demo'); await page.click('#g-submit');
    await page.waitForFunction(() => /do not match/.test(document.querySelector('#g-err').textContent));
    ok(true, `${vp.name}: a wrong password is refused`);

    // Owner signs in.
    await page.click('button[data-email="owner@brp.demo"]');
    await page.waitForSelector('#app:not([hidden])');
    await page.waitForSelector('#main .stats');
    ok(/Needs you/.test(await page.textContent('#main h1')) && /Demo mode/.test(await page.textContent('#mode-chip')), `${vp.name}: owner lands on Home in demo mode`);
    ok(/Should Claude write the xTech white paper/.test(await page.textContent('#main')), `${vp.name}: Home shows an open decision from the Command Center`);
    ok(/Agent proposals waiting/.test(await page.textContent('#main .stats')), `${vp.name}: Home shows key numbers`);
    ok(await page.isVisible('#fab') && (phone ? await page.isVisible('#bnav') : await page.isVisible('#side')), `${vp.name}: ${phone ? 'bottom bar' : 'side bar'} and the Claude button are visible`);
    ok(await noSideScroll(), `${vp.name}: Home has no sideways scroll`);
    await shot('home');

    // Every section renders without sideways scroll.
    for (const id of Object.keys(SECTIONS)) {
      await goto(id);
      if (id === 'erp' || id === 'rooms') await page.waitForSelector('iframe.frame');
      ok(await noSideScroll(), `${vp.name}: ${SECTIONS[id]} renders, no sideways scroll`);
      await shot(id);
    }

    // Purchasing embeds the admin console's own view, already signed in, without the console header.
    await goto('erp');
    const fr = page.frameLocator('iframe.frame');
    await fr.locator('[data-panel="po"]').waitFor({ timeout: 15000 });
    ok(await fr.locator('#gate').isHidden() && await fr.locator('.top-in').isHidden(), `${vp.name}: Purchasing shows the admin purchase orders, signed in, no console header`);
    ok((await fr.locator('#tabs button').allTextContents()).join('|') === 'Purchase orders|Purchase list|Stock|Parts and catalog|Work orders', `${vp.name}: only the purchasing tabs are shown`);
    await goto('rooms');
    await page.frameLocator('iframe.frame').locator('[data-panel="rooms"]').waitFor({ timeout: 15000 });
    ok(true, `${vp.name}: Rooms shows the admin rooms table`);

    // Decide a decision with one tap.
    await goto('decisions');
    await page.click('[data-decision="d1"] button[data-i="0"]');
    await page.waitForFunction(() => /Answered: Yes, start now/.test(document.querySelector('#toast').textContent));
    await page.waitForFunction(() => /Answered: Yes, start now/.test(document.querySelector('[data-decision="d1"]').textContent));
    ok(/Answered/.test(await page.textContent('#h-done').then(() => page.textContent('#main'))), `${vp.name}: d1 answered with one tap and moved to Answered`);
    ok(await page.locator('[data-decision="d3"] button.rec small').count() === 1, `${vp.name}: the recommended answer is marked`);

    // Mark a task done.
    await goto('tasks');
    await page.click('[data-task="t01"] button[data-act="done"]');
    await page.waitForFunction(() => /Done: Connect the Supabase connector/.test(document.querySelector('#toast').textContent));
    ok(await page.locator('[data-task="t01"]').count() === 0, `${vp.name}: t01 marked done and leaves the open list`);
    await page.click('button[data-act="showdone"]');
    ok(await page.locator('[data-task="t01"].done').count() === 1, `${vp.name}: Show done lists it as done`);
    // Notes
    await page.click('[data-task="t02"] button[data-act="open"]');
    await page.fill('#tt-t02', 'Sent by text on Oct 13.');
    await page.click('[data-taskform="t02"] button[type="submit"]');
    await page.waitForFunction(() => /Note: Sent by text on Oct 13\./.test(document.querySelector('[data-task="t02"]').textContent));
    ok(true, `${vp.name}: a note is saved on a task`);
    await page.click('button[data-owner="Rynoc"]');
    ok((await page.locator('#main .task').count()) === 5, `${vp.name}: the Rynoc filter shows Rynoc's 5 tasks (4 from the Command Center, 1 demo row)`);

    // Approve and reject agent proposals.
    await goto('agents');
    ok(/Approve means you agree\. Nothing is executed\./.test(await page.textContent('#main .head')), `${vp.name}: Agents says approval executes nothing`);
    ok((await page.locator('#main .ladder').count()) === 7, `${vp.name}: the readiness ladder shows 7 agents`);
    await page.click('[data-decision="HD-AP-S0001"] button[data-i="0"]');
    await page.waitForFunction(() => /AP-S0001 approved\. Nothing was executed\./.test(document.querySelector('#toast').textContent));
    ok(/Approved/.test(await page.textContent('[data-decision="HD-AP-S0001"]')), `${vp.name}: AP-S0001 approved from HQ`);
    await page.click('[data-decision="HD-AP-S0004"] button[data-i="1"]');
    await page.waitForSelector('dialog[open]');
    await page.click('#dlg-save');
    ok(/Say why/.test(await page.textContent('#dlg-err')), `${vp.name}: rejecting without a reason is refused`);
    await page.fill('#f-why', 'Check the humidity history first.');
    await page.click('#dlg-save');
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    ok(/Rejected/.test(await page.textContent('[data-decision="HD-AP-S0004"]')), `${vp.name}: AP-S0004 rejected with a reason`);
    const shared = await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('brp-admin-demo-v1')); return s.t.agent_proposals.filter((p) => ['AP-S0001', 'AP-S0004'].includes(p.id)).map((p) => p.status).join(','); });
    ok(shared === 'approved,rejected', `${vp.name}: the decisions are in the admin console's data too`);

    // Claude panel from the floating button: SAMPLE history, the thread route by default, the quick answer as the fast path.
    await page.click('#fab');
    await page.waitForSelector('#chat-sheet:not([hidden]) #chat-in');
    ok(/Claude \(BRP Command thread\)/.test(await page.textContent('#chat-title')), `${vp.name}: the panel is labeled Claude (BRP Command thread)`);
    ok(/SAMPLE/.test(await page.textContent('#chat-log')) && /Demo mode/.test(await page.textContent('#chat-mode')), `${vp.name}: chat shows SAMPLE history and the demo notice`);
    ok(/The checker removed 1 sentence/.test(await page.textContent('#chat-log')), `${vp.name}: the sample shows a sentence the reply checker removed`);
    await page.fill('#chat-in', 'Write the teaming agreement outline.');
    await page.click('#chat-send');
    await page.waitForFunction(() => /Demo mode: saved as RQ-0001\. Nothing was sent\./.test(document.querySelector('#toast').textContent));
    await page.waitForFunction(() => /Demo mode: Claude replies once the portal is connected/.test(document.querySelector('#chat-log').textContent));
    ok(/Write the teaming agreement outline\./.test(await page.textContent('#chat-log')), `${vp.name}: Send to Claude writes the message and RQ-0001 (demo: nothing sent, demo notice shown)`);
    await page.fill('#chat-in', 'What is at risk this week?');
    await page.click('#chat-quick');
    await page.waitForFunction(() => /What is at risk this week\?/.test(document.querySelector('#chat-log').textContent) && /Quick answers start then too/.test(document.querySelector('#chat-log').textContent));
    ok(true, `${vp.name}: Quick answer replies with the demo notice`);
    ok(await page.evaluate(() => { const s = document.querySelector('#chat-sheet'); return s.scrollWidth <= s.clientWidth + 1; }), `${vp.name}: chat drawer fits the screen`);
    await shot('chat');
    // Save the sample draft task.
    await page.click('#chat-log button[data-draft]');
    await page.waitForFunction(() => /Saved/.test(document.querySelector('#chat-log .draft').textContent));
    ok(true, `${vp.name}: a draft task from the chat is saved with one tap`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#chat-sheet', { state: 'hidden' });
    await goto('ask');
    ok(/RQ-0001/.test(await page.textContent('#main')) && /Write the teaming agreement outline/.test(await page.textContent('#main')), `${vp.name}: the Claude page lists RQ-0001 under Sent to Claude`);
    ok(await page.isHidden('#fab') && await page.isVisible('#ask-host #chat'), `${vp.name}: the chat sits on the Claude page; the floating button hides there`);
    await goto('tasks');
    await page.click('button[data-owner="Rynoc"]');
    ok(/Send Andrew the Rynoc legal name, UEI and CAGE/.test(await page.textContent('#main')), `${vp.name}: the saved draft is a Rynoc task`);

    // Tap targets and inputs.
    const small = await page.evaluate(() => Array.from(document.querySelectorAll('#app button, #app a.doc, #app .chip')).filter((b) => b.offsetParent && b.getBoundingClientRect().height < 43.5).map((b) => b.textContent.trim().slice(0, 30)));
    ok(small.length === 0, `${vp.name}: every button is at least 44 px tall (${small.join(', ') || 'none smaller'})`);
    await goto('ask');
    ok(await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#chat-in')).fontSize) >= 16), `${vp.name}: inputs use 16 px text (no iPhone zoom)`);

    // Dark theme.
    await page.click(phone ? '#theme' : '#theme');   // Auto -> Light
    await page.click('#theme');                      // Light -> Dark
    const dark = await page.evaluate(() => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.documentElement).getPropertyValue('--sig').trim()]);
    ok(dark[0] === 'rgb(15, 15, 15)' && dark[1] === '#FF5A1F', `${vp.name}: dark theme uses Ink and #FF5A1F`);
    await shot('ask-dark');
    await page.click('#theme');                      // back to Auto
    const light = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--sig').trim());
    ok(light === '#D9431A', `${vp.name}: light theme uses #D9431A`);

    // PWA: manifest and a service worker scoped to HQ only.
    const man = await page.evaluate(async () => { const l = document.querySelector('link[rel=manifest]'); const r = await fetch(l.href); return { url: r.url, j: await r.json() }; });
    ok(man.j.scope === './' && man.j.start_url === './' && man.j.name === 'BRP Command' && man.j.icons.length >= 2, `${vp.name}: manifest names BRP Command with its own scope`);
    const scope = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return r ? r.scope : null; });
    ok(scope && scope.endsWith('/backend/hq/'), `${vp.name}: service worker scope is /backend/hq/ (${scope})`);

    // Partner and site lead views.
    await page.evaluate(() => document.querySelector('#signout').click());
    await page.waitForSelector('#gate:not([hidden])');
    await page.click('button[data-email="partner@brp.demo"]');
    await page.waitForSelector('#app:not([hidden]) #main .head');
    await goto('home');
    await goto('tasks');
    const owners = await page.locator('#main .owner-h h3').allTextContents();
    ok(owners.join() === 'Rynoc', `${vp.name}: the partner sees Rynoc tasks only`);
    const nav = phone ? await page.evaluate(() => document.querySelector('#more-list').textContent) : await page.textContent('#side');
    ok(!/Purchasing/.test(nav) && !/Rooms/.test(nav), `${vp.name}: the partner has no Purchasing or Rooms`);
    await page.evaluate(() => document.querySelector('#signout').click());
    await page.waitForSelector('#gate:not([hidden])');
    await page.click('button[data-email="sitelead@brp.demo"]');
    await page.waitForSelector('#app:not([hidden]) #main .head');
    await goto('home');
    ok(/Walk Fort Stewart Bldg 412/.test(await page.textContent('#main')), `${vp.name}: the site lead sees the Fort Stewart task`);
    await goto('rooms');
    const roomsTxt = await page.textContent('#main table');
    ok(/412 Rm/.test(roomsTxt) && await page.locator('iframe').count() === 0, `${vp.name}: the site lead sees Fort Stewart rooms (own list, no admin console)`);
    ok(await noSideScroll(), `${vp.name}: site lead Rooms has no sideways scroll`);

    // One login with BRP One: BRP One's tab session ('brp-one:user') carries over with no second sign-in.
    await page.evaluate(() => document.querySelector('#signout').click());
    await page.waitForSelector('#gate:not([hidden])');
    ok(await page.evaluate(() => sessionStorage.getItem('brp-one:user')) === null, `${vp.name}: signing out of Command clears the shared session`);
    await page.evaluate(() => sessionStorage.setItem('brp-one:user', 'owner@brp.demo'));
    await page.reload();
    await page.waitForSelector('#app:not([hidden]) #main .head');
    ok(/Owner/.test(await page.textContent('#who')), `${vp.name}: signed in to BRP One as owner@brp.demo means signed in to Command`);

    ok(errors.length === 0, `${vp.name}: no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`ALL HQ UI TESTS PASSED (${n})`);
