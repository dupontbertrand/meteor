// MeteorPWA configuration.
//   collections: collections to mirror + hydrate for offline READS.
//   methods:     offline-capable WRITES, declared per Method name as
//                { collection, optimistic(arg) -> doc }. `arg` is the call's
//                first argument; the builder returns the optimistic doc
//                (must include a client-generated `_id`).
const state = { collections: [], methods: new Map() };

export function configure({ collections = [], methods = {} } = {}) {
  state.collections = collections;
  state.methods = new Map(Object.entries(methods));
}

export const getCollections = () => state.collections;
export const isAllowed = (name) => state.methods.has(name);
export const methodConfig = (name) => state.methods.get(name);
