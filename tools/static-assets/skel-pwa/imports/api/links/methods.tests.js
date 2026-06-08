// Tests for links methods
//
// https://guide.meteor.com/testing.html

import { Meteor } from 'meteor/meteor';
import { assert } from 'chai';
import { Links } from './links.js';
import './methods.js';

if (Meteor.isServer) {
  describe('links methods', function () {
    beforeEach(async function () {
      await Links.removeAsync({});
    });

    it('can add a new link', async function () {
      const addLink = Meteor.server.method_handlers['links.insert'];

      await addLink.apply({}, [{
        _id: 'link1',
        title: 'meteor.com',
        url: 'https://www.meteor.com',
        mutationId: 'm1',
      }]);

      assert.equal(await Links.find().countAsync(), 1);
    });

    it('replays idempotently (same _id twice inserts once)', async function () {
      const addLink = Meteor.server.method_handlers['links.insert'];
      const args = {
        _id: 'link1',
        title: 'meteor.com',
        url: 'https://www.meteor.com',
        mutationId: 'm1',
      };

      await addLink.apply({}, [args]);
      await addLink.apply({}, [args]); // replay of the same offline mutation on reconnect

      assert.equal(await Links.find().countAsync(), 1);
    });
  });
}
