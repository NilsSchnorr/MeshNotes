// sw.js — MeshNotes offline service worker (Progressive Web App)
//
// Makes the hosted app fully usable offline and installable to the home
// screen. Strategy is cache-first, so an offline launch never touches the
// network and the browser never tries to "refresh the connection". The share
// backend (/api/*) and any cross-origin loads stay network-only.
//
// IMPORTANT: bump CACHE on every release — alongside APP_VERSION in
// js/state.js, CITATION.cff, and CHANGELOG.md — so existing clients pick up
// newly deployed assets.
const CACHE = 'meshnotes-v1.3.1';

// Precache the full app shell so a SINGLE online visit makes the app
// offline-ready (no need to exercise every feature first). Paths are RELATIVE
// to this script so they resolve correctly both at meshnotes.org/ (root) and
// nilsschnorr.github.io/MeshNotes/ (project subpath).
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',

  // App modules
  './js/main.js',
  './js/state.js',
  './js/core/camera.js',
  './js/core/lighting.js',
  './js/core/model-loader.js',
  './js/core/scene.js',
  './js/core/url-params.js',
  './js/core/session-persistence.js',
  './js/annotation-tools/annotation-viewer.js',
  './js/annotation-tools/box-edit.js',
  './js/annotation-tools/cutting-plane.js',
  './js/annotation-tools/data.js',
  './js/annotation-tools/drawing.js',
  './js/annotation-tools/editing.js',
  './js/annotation-tools/groups.js',
  './js/annotation-tools/measure.js',
  './js/annotation-tools/projection.js',
  './js/annotation-tools/render.js',
  './js/annotation-tools/surface-paint.js',
  './js/export/export-json.js',
  './js/export/import-json.js',
  './js/export/pdf-manual.js',
  './js/export/pdf-report.js',
  './js/export/screenshot.js',
  './js/export/share.js',
  './js/export/view-state.js',
  './js/export/w3c-format.js',
  './js/input/pointer-manager.js',
  './js/metadata/metadata-io.js',
  './js/metadata/metadata-ui.js',
  './js/metadata/templates.js',
  './js/ui/event-listeners.js',
  './js/ui/icons.js',
  './js/ui/tool-help.js',
  './js/utils/helpers.js',
  './js/utils/label-occlusion.js',

  // Vendored libraries (classic scripts loaded directly in index.html)
  './vendor/jspdf/jspdf.umd.min.js',
  './vendor/pdf-lib/pdf-lib.min.js',

  // Three.js core + the vendored addons (resolved via the importmap)
  './vendor/three/build/three.module.js',
  './vendor/three-mesh-bvh/index.module.js',
  './vendor/three/examples/jsm/controls/OrbitControls.js',
  './vendor/three/examples/jsm/helpers/ViewHelper.js',
  './vendor/three/examples/jsm/utils/BufferGeometryUtils.js',
  './vendor/three/examples/jsm/libs/meshopt_decoder.module.js',
  './vendor/three/examples/jsm/lines/Line2.js',
  './vendor/three/examples/jsm/lines/LineGeometry.js',
  './vendor/three/examples/jsm/lines/LineMaterial.js',
  './vendor/three/examples/jsm/lines/LineSegments2.js',
  './vendor/three/examples/jsm/lines/LineSegmentsGeometry.js',
  './vendor/three/examples/jsm/loaders/GLTFLoader.js',
  './vendor/three/examples/jsm/loaders/DRACOLoader.js',
  './vendor/three/examples/jsm/loaders/OBJLoader.js',
  './vendor/three/examples/jsm/loaders/MTLLoader.js',
  './vendor/three/examples/jsm/loaders/PLYLoader.js',
  './vendor/three/examples/jsm/loaders/STLLoader.js',

  // Draco decoder — DRACOLoader fetches these at runtime from vendor/draco/
  './vendor/draco/draco_decoder.js',
  './vendor/draco/draco_decoder.wasm',
  './vendor/draco/draco_wasm_wrapper.js',

  // PWA icons (added to the repo as PNGs; skipped silently if not yet present)
  './icons/apple-touch-icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',

  // UI icons
  './icons/logo1.svg',
  './icons/texture-v1.svg',
  './icons/texture-v2.svg',
  './icons/texture-v3.svg',
  './icons/surface-v1.svg',
  './icons/surface-v2.svg',
  './icons/polygon.svg',
  './icons/point.svg',
  './icons/line.svg',
  './icons/box.svg',
  './icons/measure.svg',
  './icons/color.svg',
  './icons/mesh.svg',
  './icons/wireframe.svg',
  './icons/pen.svg',
  './icons/share.svg',
  './icons/settings.svg',
  './icons/upload.svg',
  './icons/download.svg',
  './icons/screnshot.svg',
  './icons/model-info.svg',
  './icons/model-info-v2.svg',
  './icons/load-model-import.svg',
  './icons/eye-open.svg',
  './icons/eye-closed.svg',
  './icons/pdf-download.svg',
  './icons/json-download.svg',
  './icons/json-upload.svg',
  './icons/json-ship.svg',
  './icons/json-ship-download.svg',
  './icons/json-ship-upload.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Tolerant precache: a single missing or renamed asset must NOT fail the
    // whole install (that would silently break offline use). Misses are logged
    // and picked up later by the runtime write-back below.
    await Promise.allSettled(PRECACHE.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res.ok) await cache.put(url, res);
        else console.warn('[sw] precache skip', url, res.status);
      } catch (e) {
        console.warn('[sw] precache fail', url, e);
      }
    }));
    // Deliberately NO skipWaiting(): a freshly installed version waits and goes
    // live on the next full launch (or when the user accepts the update
    // prompt), so a deploy never reloads someone mid-session and drops their
    // in-memory annotations.
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

// Manual update path: the page posts SKIP_WAITING when the user accepts the
// "new version available" prompt, letting the waiting SW take over on demand.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                  // e.g. share upload POST → network

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // cross-origin (long-term share models) → network
  if (url.pathname.includes('/api/')) return;        // share backend → network-only

  // Navigations. Two cases:
  //  1. The app shell itself (the scope root or its index.html — share links
  //     vary only by query string, so the search is ignored): serve the
  //     cached shell so a deep link boots offline.
  //  2. Every other same-origin page (the /spec/ documents, legal pages, …):
  //     network-first with cache write-back, falling back to the cache when
  //     offline. Before v1.3.1 these navigations were also answered with the
  //     app shell, which hijacked the spec pages and broke their relative
  //     asset URLs.
  if (req.mode === 'navigate') {
    const scopePath = new URL(self.registration.scope).pathname; // '/' at meshnotes.org, '/MeshNotes/' on github.io
    const isAppShell = url.pathname === scopePath || url.pathname === scopePath + 'index.html';

    if (isAppShell) {
      event.respondWith((async () => {
        const cached = await caches.match('./index.html', { ignoreSearch: true });
        if (cached) return cached;
        try { return await fetch(req); }
        catch { return new Response('Offline', { status: 503, statusText: 'Offline' }); }
      })());
    } else {
      event.respondWith((async () => {
        try {
          const res = await fetch(req);
          // Write-back so the page stays readable offline. Redirected
          // responses (e.g. GitHub Pages adding a trailing slash) are not
          // cached, because serving a redirected response for a later
          // navigation is rejected by browsers.
          if (res && res.ok && res.type === 'basic' && !res.redirected) {
            const cache = await caches.open(CACHE);
            cache.put(req, res.clone());
          }
          return res;
        } catch (e) {
          const cached = await caches.match(req, { ignoreSearch: true });
          if (cached) return cached;
          return new Response('Offline', { status: 503, statusText: 'Offline' });
        }
      })());
    }
    return;
  }

  // Everything else same-origin: cache-first, then network with write-back so
  // anything the precache missed (or that is added later) is cached on first
  // online use.
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res && res.ok && res.type === 'basic') {
        const cache = await caches.open(CACHE);
        cache.put(req, res.clone());
      }
      return res;
    } catch (e) {
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    }
  })());
});
