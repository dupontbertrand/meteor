require(process.env.TIN_DRIVER_PATH);
const { test } = require('node:test');
setInterval(() => {}, 1000);
globalThis.__meteorTestInNode.rawTest('bypass', () => {});
test('t0', () => {});
test('t1', () => {});
