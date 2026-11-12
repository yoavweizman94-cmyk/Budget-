// Service worker: מאפשר לפתוח את האפליקציה גם בלי רשת.
// קודם מנסים את הרשת (כדי לקבל תמיד את הגרסה העדכנית), ורק אם אין — מהמטמון.

const CACHE = 'budget-v1';
const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/budget.js',
  'js/firebase-config.js',
  'js/store-local.js',
  'js/store-firebase.js',
  'vendor/firebase/firebase-app.js',
  'vendor/firebase/firebase-auth.js',
  'vendor/firebase/firebase-firestore.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // רק קבצי האפליקציה עצמה; התקשורת עם Firebase לא עוברת דרך המטמון הזה
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true }).then((hit) => hit || Response.error())),
  );
});
