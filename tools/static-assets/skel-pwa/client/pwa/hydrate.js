import { idbGetAll } from './idb.js';
import { listPending } from './mutationLog.js';

// Pure: server docs ∪ pending-insert payloads not already present (derived state).
export function deriveHydration(serverDocs, pendingInserts) {
  const ids = new Set(serverDocs.map((d) => d._id));
  const derived = pendingInserts
    .filter((m) => m.doc && !ids.has(m.doc._id))
    .map((m) => m.doc);
  return [...serverDocs, ...derived];
}

export async function loadServerDocs(collectionName) {
  const rows = await idbGetAll('documents');
  return rows.filter((r) => r.collectionName === collectionName).map((r) => r.doc);
}

// Insert documents ∪ derived-pending into the collection's LOCAL store (no DDP method).
export async function hydrateCollection(collection, collectionName) {
  const [serverDocs, pending] = await Promise.all([
    loadServerDocs(collectionName),
    listPending(),
  ]);
  const scoped = pending.filter((m) => m.collectionName === collectionName);
  const docs = deriveHydration(serverDocs, scoped);
  for (const doc of docs) {
    if (!collection.findOne(doc._id)) {
      collection._collection.insert(doc);
    }
  }
}
