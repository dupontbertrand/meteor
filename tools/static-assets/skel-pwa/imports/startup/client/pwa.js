// PWA wiring: offline engine (S1) + service worker registration.

import { Meteor } from 'meteor/meteor';
import { Links } from '/imports/api/links/links.js';
import { MeteorPWA } from '/client/pwa/index.js';

// Mirror Links for offline reads, and make links.insert replay when the app
// reconnects after an offline write. Add your own collections / methods here.
MeteorPWA.configure({
  collections: [Links],
  methods: {
    'links.insert': {
      collection: Links,
      optimistic: ({ _id, title, url }) => ({ _id, title, url, createdAt: new Date() }),
    },
  },
});
MeteorPWA.start();

// Installable PWA service worker. Dev-safe: registered as `/sw.js?dev=1` in dev
// (no bundle caching → no autoupdate reload loop, still installable for device
// testing via a tunnel); `/sw.js` (full offline caching) in production.
Meteor.startup(() => {
  if (!('serviceWorker' in navigator)) return;
  const swUrl = Meteor.isProduction ? '/sw.js' : '/sw.js?dev=1';
  navigator.serviceWorker
    .register(swUrl, { scope: '/' })
    .then((reg) => console.log('[PWA] Service worker registered:', reg.scope))
    .catch((err) => console.error('[PWA] Service worker registration failed', err));
});
