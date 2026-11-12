Firebase JavaScript SDK 13.3.0 (browser ESM bundles), copied from the `firebase` npm package.
License: Apache-2.0 — https://github.com/firebase/firebase-js-sdk/blob/main/LICENSE

The only change: the `firebase-app.js` import inside `firebase-auth.js` and `firebase-firestore.js`
points to `./firebase-app.js` instead of the gstatic CDN, so the app is self-contained and works offline.
