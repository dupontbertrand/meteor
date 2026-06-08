import { Meteor } from 'meteor/meteor';
import { methodConfig } from './config.js';
import { appendMutation } from './mutationLog.js';
import { idbPut } from './idb.js';

// Generic offline capture (Option B). Intercepts an allowlisted Method call
// while offline: the per-method config gives the target collection + how to
// build the optimistic doc from the call's first argument. Works for any
// collection/Method the app configures — nothing is hardcoded.
export function installInterceptor(connection) {
  const original = connection.applyAsync.bind(connection);
  connection.applyAsync = function (name, args, options, callback) {
    const cfg = methodConfig(name);
    if (cfg && !Meteor.status().connected) {
      return captureOffline(name, args, cfg);
    }
    return original(name, args, options, callback);
  };
}

async function captureOffline(name, args, cfg) {
  const arg = args[0] || {};
  const doc = cfg.optimistic(arg);                 // app-provided builder → optimistic doc (has _id)
  const collectionName = cfg.collection._name;

  // 1. optimistic direct write (Option B: before _saveOriginals; no stub, no serverDoc)
  cfg.collection._collection.insert(doc);
  // 2. mirror + persist the mutation
  await idbPut('documents', {
    key: `${collectionName}:${doc._id}`, collectionName, _id: doc._id, doc,
  });
  await appendMutation({ mutationId: arg.mutationId, name, args, collectionName, doc });
  // 3. resolve a LOCAL-ACK (not a server result)
  return doc._id;
}
