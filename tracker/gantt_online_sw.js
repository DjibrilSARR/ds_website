'use strict';

const CACHE_PREFIX = 'project-tracker-online:' + self.registration.scope + ':';
const CACHE_NAME = CACHE_PREFIX + '2026-11-15-3';
const FILES = [
    'gantt_online.html',
    'online_assets/tracker.css',
    'online_assets/purify.min.js',
    'online_assets/html2canvas.min.js',
    'online_assets/html2pdf.bundle.min.js',
    'online_assets/online-sync.js',
    'online_assets/online-ui.js'
].map(path => new URL(path, self.location.href).href);

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE_NAME).then(cache =>
        cache.addAll(FILES.map(url => new Request(url, { cache: 'reload' })))));
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map(name => caches.delete(name)));
        await self.clients.claim();
    })());
});

self.addEventListener('message', event => {
    if (event.data && event.data.type === 'ACTIVATE_UPDATE') self.skipWaiting();
});

self.addEventListener('fetch', event => {
    // Only public app files are cached, never authenticated GitHub requests or JSON data.
    const url = new URL(event.request.url);
    url.search = ''; url.hash = '';
    if (event.request.method !== 'GET' || !FILES.includes(url.href)) return;
    event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        const saved = await cache.match(url.href);
        if (saved) return saved;
        const response = await fetch(event.request);
        if (response.ok) await cache.put(url.href, response.clone());
        return response;
    })());
});
