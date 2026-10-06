// Service worker — l'app si apre anche offline.
// File dell'app: prima la rete (così gli aggiornamenti arrivano subito), poi la cache.
// Librerie e font da CDN: cache, aggiornata in background.
// API, Firestore e meteo non passano mai di qui.
const CACHE = 'heat-ledger-v1';
const SHELL = [
    './', 'index.html', 'styles.css', 'app.js', 'analytics.js', 'charts.js', 'data.js',
    'firebase-service.js', 'firebase-config.js', 'manifest.webmanifest',
    'icons/icon.svg', 'icons/icon-192.png', 'icons/apple-touch-icon.png'
];
const CDN = /^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|www\.gstatic\.com\/firebasejs|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => { }).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
    e.waitUntil(caches.keys()
        .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
        .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);

    if (url.origin === self.location.origin) {
        if (url.pathname.includes('/api/')) return;
        e.respondWith(fetch(req).then(res => {
            if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
            return res;
        }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
        return;
    }

    if (CDN.test(req.url)) {
        e.respondWith(caches.match(req).then(cached => {
            const network = fetch(req).then(res => {
                if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
                return res;
            }).catch(() => cached);
            return cached || network;
        }));
    }
});
