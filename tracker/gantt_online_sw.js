'use strict';

const CACHE_PREFIX = 'project-tracker-online:' + self.registration.scope + ':';
const BUNDLE_SHA256 = '19528fc961229c3e08416e6cba435d450a9541822bc3f3108cc9c2c11ef13dac';
const CACHE_NAME = CACHE_PREFIX + BUNDLE_SHA256;
const APP_ROOT = new URL('./', self.location.href);
const INDEX_URL = new URL('index.html', APP_ROOT).href;
const PAGE_URLS = [APP_ROOT.href, INDEX_URL, new URL('gantt_online.html', APP_ROOT).href];

async function cacheBundle(cache) {
    const response = await fetch(new Request(INDEX_URL, {
        cache: 'reload', credentials: 'omit', redirect: 'error'
    }));
    if (!response.ok) throw new Error('The offline application could not be downloaded: HTTP ' + response.status);
    const digest = await crypto.subtle.digest('SHA-256', await response.clone().arrayBuffer());
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== BUNDLE_SHA256) throw new Error('The application and offline worker versions do not match. Deploy both files together.');
    await cache.put(INDEX_URL, response);
}

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE_NAME).then(cacheBundle));
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
    // Both entry URLs use the same public document; API responses and data are never cached.
    const url = new URL(event.request.url);
    url.search = ''; url.hash = '';
    if (event.request.method !== 'GET' || !PAGE_URLS.includes(url.href)) return;
    event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        const saved = await cache.match(INDEX_URL);
        if (saved) return saved;
        await cacheBundle(cache);
        return cache.match(INDEX_URL);
    })());
});
