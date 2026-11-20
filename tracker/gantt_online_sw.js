'use strict';

const CACHE_PREFIX = 'project-tracker-online:' + self.registration.scope + ':';
const CACHE_NAME = CACHE_PREFIX + 'network-first-v1';
const APP_ROOT = new URL('./', self.location.href);
const INDEX_URL = new URL('index.html', APP_ROOT).href;
const PAGE_URLS = [APP_ROOT.href, INDEX_URL, new URL('gantt_online.html', APP_ROOT).href];

let cacheWriteError = '';

async function downloadPage() {
    const response = await fetch(new Request(INDEX_URL, {
        cache: 'no-store', credentials: 'omit', redirect: 'error'
    }));
    if (!response.ok) throw new Error('The offline application could not be downloaded: HTTP ' + response.status);
    if (!(response.headers.get('content-type') || '').toLowerCase().includes('text/html')) {
        throw new Error('The application URL did not return an HTML page.');
    }
    return response;
}

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const response = await downloadPage();
        const cache = await caches.open(CACHE_NAME);
        await cache.put(INDEX_URL, response);
    })());
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
    if (event.data && event.data.type === 'CHECK_OFFLINE_CACHE' && event.source) {
        event.waitUntil((async () => {
            try {
                const cache = await caches.open(CACHE_NAME);
                event.source.postMessage({ type: 'OFFLINE_CACHE_STATUS', available: !!await cache.match(INDEX_URL), error: cacheWriteError });
            } catch (error) {
                console.error('Tracker offline cache:', error);
                event.source.postMessage({ type: 'OFFLINE_CACHE_STATUS', available: false, error: 'The browser could not access its offline application cache.' });
            }
        })());
    }
});

self.addEventListener('fetch', event => {
    // Both entry URLs use the same public document; API responses and data are never cached.
    const url = new URL(event.request.url);
    url.search = ''; url.hash = '';
    if (event.request.method !== 'GET' || !PAGE_URLS.includes(url.href)) return;
    event.respondWith((async () => {
        let response;
        try {
            response = await downloadPage();
        } catch (error) {
            console.warn('Tracker page could not be refreshed; trying its last offline copy.', error);
            const cache = await caches.open(CACHE_NAME);
            const saved = await cache.match(INDEX_URL);
            if (saved) return saved;
            throw error;
        }
        try {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(INDEX_URL, response.clone());
            cacheWriteError = '';
        } catch (error) {
            cacheWriteError = 'This page is available online, but its latest offline copy could not be saved. Check browser storage and reopen while online.';
            console.error('Tracker offline cache:', error);
        }
        return response;
    })());
});
