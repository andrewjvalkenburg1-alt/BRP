// Shared helpers for the Playwright scripts: find Playwright, serve a folder, sign in to BRP One.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

process.env.PLAYWRIGHT_BROWSERS_PATH ||= '/opt/pw-browsers';

export function loadPlaywright() {
  const req = createRequire(import.meta.url);
  try { return req('playwright'); } catch {}
  const g = execSync('npm root -g').toString().trim();
  return req(join(g, 'playwright'));
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css' };

// Static server. inject(html) can rewrite index.html on the way out.
export function serve(dir, { inject } = {}) {
  return new Promise((resolve) => {
    const srv = createServer(async (req, res) => {
      try {
        let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        if (p.endsWith('/')) p += 'index.html';
        const extra = { '/brp-native.js': join(import.meta.dirname, '..', 'www-bridge', 'brp-native.js') };
        const file = extra[p] && !(await stat(join(dir, p)).catch(() => null)) ? extra[p] : join(dir, normalize(p));
        let body = await readFile(file);
        if (inject && p.endsWith('index.html')) body = Buffer.from(inject(body.toString()));
        res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
        res.end(body);
      } catch { res.writeHead(404); res.end('not found'); }
    });
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}/`, close: () => srv.close() }));
  });
}

// Signs in with a demo account through the real sign-in form.
export async function signIn(page, email, password = 'BRPdemo2026!') {
  await page.fill('#bg-email', email);
  await page.fill('#bg-pw', password);
  await page.click('#bg-submit');
  await page.waitForFunction(() => document.documentElement.classList.contains('one-in'), null, { timeout: 15000 });
}
