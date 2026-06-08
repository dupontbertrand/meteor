import { Meteor } from 'meteor/meteor';
import { hydrateCollection } from './hydrate.js';
import { idbPut, idbDelete } from './idb.js';

export async function boot(collectionsByName) {
  Meteor.disconnect();                       // stop auto-connect before hydration
  for (const [name, collection] of Object.entries(collectionsByName)) {
    await hydrateCollection(collection, name);
    startMirror(collection, name);
  }
  Meteor.reconnect();
}

function startMirror(collection, collectionName) {
  const key = (id) => `${collectionName}:${id}`;
  collection.find().observe({
    added(doc) { idbPut('documents', { key: key(doc._id), collectionName, _id: doc._id, doc }); },
    changed(doc) { idbPut('documents', { key: key(doc._id), collectionName, _id: doc._id, doc }); },
    removed(doc) {
      // Derived-state rule: pending inserts survive in the mutations log, so
      // deleting the documents mirror row here is safe (re-derived on next boot).
      idbDelete('documents', key(doc._id));
    },
  });
}
