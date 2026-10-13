// Fills native/www from the BRP One web build (ecosystem/pwa) and adds the native bridge.
// The source build is read only. Run: npm run copy-web   (or: npm run sync)
// Override the source with BRP_WEB_SRC=/path/to/pwa.
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
// Source: BRP_WEB_SRC, else the build folder used on the build machine, else the repo root
// (this repo's root is the published PWA build, which is what the Mac and CI use).
const candidates = [process.env.BRP_WEB_SRC, '/mnt/project-files/barracks/v1/ecosystem/pwa', resolve(root, '..')].filter(Boolean);
const src = resolve(candidates.find((c) => existsSync(join(c, 'index.html'))) || candidates[0]);
const out = join(root, 'www');

if (!existsSync(join(src, 'index.html'))) {
  console.error('No index.html in ' + src + '. Set BRP_WEB_SRC to the BRP One web build folder.');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const item of ['index.html', 'manifest.webmanifest', 'icons', 'splash']) {
  const p = join(src, item);
  if (existsSync(p)) cpSync(p, join(out, item), { recursive: true });
}
// The web sw.js caches pages for offline use. Inside the app the files are already on the device and a
// cache would only keep old copies after an update, so the app gets a worker that caches nothing.
// (iOS WKWebView does not run service workers on capacitor:// at all; Android does on https://localhost.)
writeFileSync(join(out, 'sw.js'), "/* BRP One native shell: no offline cache, the app files ship inside the app. */\n" +
  "self.addEventListener('install',function(){self.skipWaiting();});\n" +
  "self.addEventListener('activate',function(e){e.waitUntil(caches.keys().then(function(ks){return Promise.all(ks.map(function(k){return caches.delete(k);}));}).then(function(){return self.clients.claim();}));});\n");

// Capacitor runtime (gives window.Capacitor.registerPlugin in a no-bundler page) and the bridge.
cpSync(join(root, 'node_modules/@capacitor/core/dist/capacitor.js'), join(out, 'capacitor.js'));
cpSync(join(root, 'www-bridge/brp-native.js'), join(out, 'brp-native.js'));

// Fonts and GSAP from native/vendor (scripts/vendor-assets.py), so the app runs offline and makes
// no third-party requests. Without vendor/ the page keeps its CDN links.
let html0 = readFileSync(join(out, 'index.html'), 'utf8'), vendored = 0;
if (existsSync(join(root, 'vendor', 'fonts.css'))) {
  cpSync(join(root, 'vendor'), join(out, 'vendor'), { recursive: true });
  const swaps = [
    [/https:\/\/fonts\.googleapis\.com\/css2\?family=Big\+Shoulders\+Display:wght@800&(?:amp;)?family=Archivo:wght@400;600&(?:amp;)?family=Archivo\+Narrow:wght@600&(?:amp;)?display=swap/g, 'vendor/fonts.css'],
    [/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/gsap\/3\.15\.0\/gsap\.min\.js/g, 'vendor/gsap.min.js'],
    [/<link rel="preconnect" href="https:\/\/fonts\.(?:googleapis|gstatic)\.com"(?: crossorigin)?>/g, '']
  ];
  for (const [re, to] of swaps) html0 = html0.replace(re, (m) => { vendored++; return to; });
  writeFileSync(join(out, 'index.html'), html0);
}

// Load both before any app script, unless the web build already includes the bridge.
let html = readFileSync(join(out, 'index.html'), 'utf8');
const tags = [];
if (!/src=["'][^"']*capacitor\.js["']/.test(html)) tags.push('<script src="capacitor.js"></script>');
if (!/src=["'][^"']*brp-native\.js["']/.test(html)) tags.push('<script src="brp-native.js"></script>');
if (tags.length) {
  // After the charset and viewport metas (they must stay first), before the app's own scripts.
  const m = html.match(/<meta name="viewport"[^>]*>/i) || html.match(/<meta charset[^>]*>/i) || html.match(/<head[^>]*>/i);
  if (!m) { console.error('index.html has no <head>.'); process.exit(1); }
  html = html.replace(m[0], m[0] + '\n' + tags.join('\n'));
}
// Mark the native shell so CSS can tell (html.brp-native) before the bridge runs.
html = html.replace(/<html([^>]*)>/i, (all, attrs) => /data-brp-shell/.test(attrs) ? all : '<html' + attrs + ' data-brp-shell="native">');
writeFileSync(join(out, 'index.html'), html);
console.log('www filled from ' + src + ' (' + Math.round(html.length / 1024) + ' KB index.html, bridge added, ' + vendored + ' CDN links pointed at vendor/).');
