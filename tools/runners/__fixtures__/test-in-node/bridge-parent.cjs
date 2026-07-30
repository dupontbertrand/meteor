// Simulates the shape bridge.js registers: a rawTest-registered parent named
// exactly the bridge's BRIDGE_PARENT_NAME, with real subtests underneath it —
// without needing a real Meteor/tinytest bundle. Guards driver.js's tally
// (and unitTimings) against counting/timing the parent itself.
require(process.env.TIN_DRIVER_PATH);

setInterval(() => {}, 1000); // keepalive — never cleared on purpose

globalThis.__meteorTestInNode.rawTest('tinytest (bridged)', async (t) => {
  await t.test('bridged-case-1', () => {});
  await t.test('bridged-case-2', () => {});
});
