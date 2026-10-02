// Service worker: permite instalar o app e abrir sem internet.
// Estratégia "rede primeiro": sempre busca a versão nova e usa o cache só se estiver offline.

const CACHE = 'rotina-v2';
const SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/store.js',
  './js/utils.js',
  './js/icons.js',
  './js/firebase-config.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === location.origin;
  const cacheable =
    sameOrigin ||
    url.href.startsWith('https://www.gstatic.com/firebasejs/') ||
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com';
  if (!cacheable) return;

  // Arquivos do próprio site: sempre confere com o servidor se há versão nova.
  const network = sameOrigin ? fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }) : fetch(req);

  e.respondWith(
    network
      .then((res) => {
        if (res.ok || res.type === 'opaque') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('./index.html'))),
  );
});

// Aviso enviado pelo GitHub Actions (Firebase Cloud Messaging) com o app fechado.
self.addEventListener('push', (e) => {
  let payload = {};
  try {
    payload = e.data ? e.data.json() : {};
  } catch {
    payload = { data: { title: 'Rotina', body: e.data ? e.data.text() : '' } };
  }
  const n = payload.data || payload.notification || payload;
  e.waitUntil(
    self.registration.showNotification(n.title || 'Rotina', {
      body: n.body || '',
      tag: n.tag || undefined,
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      data: { url: n.url || './#/hoje' },
    }),
  );
});

// Tocar no aviso abre o app (ou traz para a frente se já estiver aberto).
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './#/hoje', self.registration.scope).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => c.url.startsWith(self.registration.scope));
      if (open) return open.focus().then((c) => c.navigate(url).catch(() => c));
      return self.clients.openWindow(url);
    }),
  );
});
