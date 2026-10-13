/* BRP Command (backend/hq/) service worker. Scope: this folder only (/BRP/backend/hq/), so it never touches the BRP One app's worker at /BRP/.
   Network first for everything, so HQ always shows the latest data and code when online; the cached copy is the
   fallback when offline. Data calls to Supabase and the Anthropic API are never cached. */
const C = 'brp-hq-v1';
const CORE = ['./', 'index.html', 'hq.css', 'hq.js', 'hq-seed.js', 'manifest.webmanifest',
  '../client/brp-config.js', '../client/brp-backend.js', '../client/agent-samples.js', '../../icons/icon-180.png', '../../icons/icon-192.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(C).then((c) => c.addAll(CORE)).catch(() => null).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('brp-hq-') && k !== C).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  const own = u.origin === self.location.origin;
  if (!own && !/fonts\.(googleapis|gstatic)\.com$/.test(u.hostname)) return;   // Supabase, Anthropic, CDNs: straight to the network
  e.respondWith(fetch(r).then((res) => {
    if (res.ok && (own || res.type === 'cors' || res.type === 'opaque')) { const cp = res.clone(); caches.open(C).then((c) => c.put(r, cp)); }
    return res;
  }).catch(() => caches.match(r, { ignoreSearch: r.mode === 'navigate' }).then((hit) => hit || (r.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
});
