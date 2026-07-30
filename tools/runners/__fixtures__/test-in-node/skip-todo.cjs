require(process.env.TIN_DRIVER_PATH);
const { test, it } = require('node:test');
setInterval(() => {}, 1000);
test('t0', () => {});
it.skip('s0', () => {});
test.todo('td0');
test('t1', () => {});
