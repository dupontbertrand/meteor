// A HEALTHY bridge parent whose only failure comes from a subtest, not its
// own body. node:test marks the parent itself failed too (details.error
// .failureType === 'subtestsFailed') — that must NOT double-count: the
// parent stays excluded from the tally, only the subtest failure is counted.
require(process.env.TIN_DRIVER_PATH);

setInterval(() => {}, 1000); // keepalive — never cleared on purpose

globalThis.__meteorTestInNode.rawTest('tinytest (bridged)', async (t) => {
  await t.test('sub-fail', () => { throw new Error('x'); });
});
