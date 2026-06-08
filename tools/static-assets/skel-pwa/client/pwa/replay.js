import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';
import { listPending, removeMutation } from './mutationLog.js';
import { hydrateCollection } from './hydrate.js';

let draining = false;

export function installReplay(collectionsByName) {
  let wasConnected = false;
  Tracker.autorun(() => {
    const connected = Meteor.status().connected;
    if (connected && !wasConnected) drain(collectionsByName);
    wasConnected = connected;
  });
}

async function drain(collectionsByName) {
  if (draining) return;
  draining = true;
  try {
    // The reconnect reset (beginUpdate reset → _collection.remove({})) cleared
    // minimongo; re-hydrate pending docs so they stay visible until confirmed.
    for (const [name, collection] of Object.entries(collectionsByName)) {
      await hydrateCollection(collection, name);
    }

    const pending = await listPending(); // queuedAt order
    for (const m of pending) {
      try {
        // stub-less: todos.insert is server-only. On success, the publication's
        // 'added' for this _id is converted to 'changed' (doc already present).
        await Meteor.callAsync(m.name, ...m.args);
        await removeMutation(m.mutationId);
      } catch (e) {
        console.warn('[pwa] replay failed', m.name, m.mutationId, e.message || e);
        break; // stop; retry on next reconnect (idempotent + still in log)
      }
    }
  } finally {
    draining = false;
  }
}
