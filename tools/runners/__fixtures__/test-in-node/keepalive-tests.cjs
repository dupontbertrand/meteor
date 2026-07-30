// Simulates a Meteor server process: loads the driver first (as the bundle
// does, dependency-ordered), registers tests, and keeps the event loop alive
// (stand-in for HTTP + Mongo) so ONLY the driver's forced exit can end us.
require(process.env.TIN_DRIVER_PATH);
const { test, it, describe } = require('node:test');
const assert = require('node:assert/strict');

setInterval(() => {}, 1000); // keepalive — never cleared on purpose

test('t0', () => {});
test('t1', () => { if (process.env.FIXTURE_FAIL) assert.fail('boom'); });
it('t2', () => {});
describe('suite-a', () => {
  it('nested-1', () => {});
  it('nested-2', () => {});
});
