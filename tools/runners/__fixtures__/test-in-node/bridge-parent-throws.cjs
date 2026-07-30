// A bridge parent whose OWN body throws (e.g. tinytest internals drifted),
// as opposed to a subtest failing underneath it. The magic-name exclusion in
// driver.js must still count this as a failure — it only protects a HEALTHY
// bridge parent's zero-info completion (or one that failed solely because a
// subtest failed), not one that failed outright.
require(process.env.TIN_DRIVER_PATH);
const { test } = require('node:test');

setInterval(() => {}, 1000); // keepalive — never cleared on purpose

globalThis.__meteorTestInNode.rawTest('tinytest (bridged)', () => {
  throw new Error('drift');
});
test('t0', () => {});
