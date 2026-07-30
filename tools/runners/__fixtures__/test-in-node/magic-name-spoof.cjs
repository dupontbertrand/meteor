// A user test that happens to collide with the bridge's magic parent name
// (BRIDGE_PARENT_NAME), but registered through the PATCHED `test` binding,
// not rawTest — the way any accidental (or malicious) name collision would
// actually show up. Its failure must still surface: the magic-name
// exclusion in driver.js is not a blank check just because the name matches.
require(process.env.TIN_DRIVER_PATH);
const { test } = require('node:test');
const assert = require('node:assert/strict');

setInterval(() => {}, 1000); // keepalive — never cleared on purpose

test('tinytest (bridged)', () => { assert.fail('boom'); });
test('t0', () => {});
