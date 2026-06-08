import { EJSON } from 'meteor/ejson';
import { idbPut, idbGetAll, idbDelete } from './idb.js';

export async function appendMutation({ mutationId, name, args, collectionName, doc }) {
  await idbPut('mutations', {
    mutationId,
    name,
    collectionName,
    args: EJSON.stringify(args),
    doc: doc ? EJSON.stringify(doc) : null,
    status: 'pending',
    queuedAt: Date.now(),
  });
}

export async function listPending() {
  const all = await idbGetAll('mutations');
  return all
    .filter((m) => m.status === 'pending')
    .sort((a, b) => a.queuedAt - b.queuedAt)
    .map((m) => ({
      ...m,
      args: EJSON.parse(m.args),
      doc: m.doc ? EJSON.parse(m.doc) : null,
    }));
}

export const removeMutation = (mutationId) => idbDelete('mutations', mutationId);
