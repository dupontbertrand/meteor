// Methods related to links.
//
// SERVER-ONLY (no client stub) so the offline engine can replay them stub-less
// (no `_serverDocuments` tracking → no "Server sent add for existing id"). The
// method is idempotent: it takes a client-generated `_id` + `mutationId`, so a
// replay after reconnect can't create a duplicate.

import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';
import { Links } from './links.js';

if (Meteor.isServer) {
  Meteor.methods({
    async 'links.insert'({ _id, title, url, mutationId }) {
      check(_id, String);
      check(title, String);
      check(url, String);
      check(mutationId, String);
      try {
        await Links.insertAsync({ _id, title, url, createdAt: new Date() });
      } catch (e) {
        const msg = String(e?.message || e);
        if (e?.code === 11000 || /duplicate key|already exists/i.test(msg)) {
          return _id; // idempotent replay
        }
        throw e;
      }
      return _id;
    },
  });
}
