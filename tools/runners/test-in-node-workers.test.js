const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPORTER = path.resolve(__dirname, 'test-in-node-reporter.mjs');
const DRIVER = path.resolve(__dirname, '../../packages/test-in-node/driver.js');

function runFixture(name, extraEnv = {}) {
  const res = spawnSync(
    process.execPath,
    [`--test-reporter=${REPORTER}`,
     path.resolve(__dirname, '__fixtures__', 'test-in-node', name)],
    {
      env: { ...process.env, TIN_DRIVER_PATH: DRIVER, ...extraEnv },
      encoding: 'utf8',
      timeout: 8000,
    },
  );
  const m = res.stdout.match(/^TEST_IN_NODE_RESULT (.*)$/m);
  const t = res.stdout.match(/^TEST_IN_NODE_TIMINGS (.*)$/m);
  return { status: res.status, stdout: res.stdout, result: m ? JSON.parse(m[1]) : null,
           timings: t ? JSON.parse(t[1]) : null };
}

describe('test-in-node driver contract', () => {
  test('passing run emits machine result and exits 0', () => {
    const r = runFixture('keepalive-tests.cjs');
    expect(r.status).toBe(0);
    expect(r.result).toMatchObject({ tests: 5, passed: 5, failed: 0, skipped: 0, todo: 0 });
  });

  test('failing run exits 1 and counts the failure', () => {
    const r = runFixture('keepalive-tests.cjs', { FIXTURE_FAIL: '1' });
    expect(r.status).toBe(1);
    expect(r.result).toMatchObject({ tests: 5, passed: 4, failed: 1 });
  });
});

const shardEnv = (index, total) =>
  ({ TEST_METADATA: JSON.stringify({ shard: { index, total } }) });

describe('shard filter', () => {
  test('round-robin splits top-level units across two shards', () => {
    // top-level units in keepalive-tests.cjs: t0, t1, t2, suite-a (4 units)
    const w0 = runFixture('keepalive-tests.cjs', shardEnv(0, 2)); // t0 + t2
    const w1 = runFixture('keepalive-tests.cjs', shardEnv(1, 2)); // t1 + suite-a
    expect(w0.status).toBe(0);
    expect(w1.status).toBe(0);
    expect(w0.result).toMatchObject({ tests: 2, passed: 2, shard: { index: 0, total: 2 } });
    expect(w1.result).toMatchObject({ tests: 3, passed: 3, shard: { index: 1, total: 2 } });
    expect(w0.result.tests + w1.result.tests).toBe(5); // union = full suite
  });

  test('a failure lands only on its own shard', () => {
    const w0 = runFixture('keepalive-tests.cjs', { ...shardEnv(0, 2), FIXTURE_FAIL: '1' });
    const w1 = runFixture('keepalive-tests.cjs', { ...shardEnv(1, 2), FIXTURE_FAIL: '1' });
    expect(w0.status).toBe(0);           // t1 (the failing test) is unit #1 → shard 1
    expect(w1.status).toBe(1);
    expect(w1.result).toMatchObject({ failed: 1 });
  });

  test('an empty shard exits 0 instead of hanging (sentinel)', () => {
    const r = runFixture('single-test.cjs', shardEnv(1, 2)); // unit #0 → shard 0; shard 1 empty
    expect(r.status).toBe(0);            // would TIMEOUT without the sentinel
    expect(r.result).toMatchObject({ tests: 0, passed: 0, failed: 0 });
  });

  test('unsharded runs carry no shard key', () => {
    const r = runFixture('single-test.cjs');
    expect(r.result.shard).toBeUndefined();
    expect(r.result.tests).toBe(1);
  });

  test('malformed TEST_METADATA falls back to unsharded', () => {
    const r = runFixture('single-test.cjs', { TEST_METADATA: '{not-json' });
    expect(r.status).toBe(0);
    expect(r.result).toMatchObject({ tests: 1, passed: 1 });
    expect(r.result.shard).toBeUndefined();
  });

  test('skip/todo/only work under sharding (wrapped properties)', () => {
    // skip-todo.cjs has 4 top-level units: t0, s0 (skip), td0 (todo), t1
    const w0 = runFixture('skip-todo.cjs', shardEnv(0, 2)); // t0 + td0
    const w1 = runFixture('skip-todo.cjs', shardEnv(1, 2)); // s0 + t1
    expect(w0.status).toBe(0);
    expect(w1.status).toBe(0);
    // Union: 2 passed (t0, t1) + 1 skipped (s0) + 1 todo (td0)
    expect(w0.result.tests + w1.result.tests).toBe(4);
    expect(w0.result.passed + w1.result.passed).toBe(2);
    expect(w0.result.skipped + w1.result.skipped).toBe(1);
    expect(w0.result.todo + w1.result.todo).toBe(1);
  });

  test('unsharded runs of skip/todo work', () => {
    const r = runFixture('skip-todo.cjs');
    expect(r.status).toBe(0);
    expect(r.result).toMatchObject({ tests: 4, passed: 2, skipped: 1, todo: 1 });
  });

  test('out-of-range shard index falls back to unsharded', () => {
    // shard index >= total should be rejected and run unsharded
    const r = runFixture('keepalive-tests.cjs', shardEnv(2, 2));
    expect(r.status).toBe(0);
    expect(r.result.shard).toBeUndefined();
    expect(r.result).toMatchObject({ tests: 5, passed: 5 });
  });
});

describe('name filter', () => {
  test('TINYTEST_FILTER keeps only matching top-level units', () => {
    const r = runFixture('keepalive-tests.cjs', { TINYTEST_FILTER: 't[01]' });
    expect(r.status).toBe(0);
    expect(r.result).toMatchObject({ tests: 2, passed: 2 }); // t0, t1 ; suite-a and t2 excluded
  });

  test('filter drops a whole non-matching suite with its nested tests', () => {
    const r = runFixture('keepalive-tests.cjs', { TINYTEST_FILTER: 'suite-a' });
    expect(r.result).toMatchObject({ tests: 2, passed: 2 }); // nested-1 + nested-2
  });

  test('filter composes with sharding (round-robin over KEPT units only)', () => {
    const env = { TINYTEST_FILTER: '^t' }; // t0, t1, t2 (3 units)
    const w0 = runFixture('keepalive-tests.cjs', { ...env, ...shardEnv(0, 2) }); // t0, t2
    const w1 = runFixture('keepalive-tests.cjs', { ...env, ...shardEnv(1, 2) }); // t1
    expect(w0.result.tests + w1.result.tests).toBe(3);
    expect(w0.result).toMatchObject({ tests: 2 });
    expect(w1.result).toMatchObject({ tests: 1 });
  });

  test('an invalid regex falls back to literal substring matching', () => {
    const r = runFixture('keepalive-tests.cjs', { TINYTEST_FILTER: '(' });
    expect(r.status).toBe(0); // does not crash; '(' matches nothing → sentinel → 0 tests
    expect(r.result).toMatchObject({ tests: 0 });
  });
});

describe('unit timings', () => {
  test('sequential runs do not emit timings', () => {
    const r = runFixture('keepalive-tests.cjs');
    expect(r.status).toBe(0);
    expect(r.timings).toBeNull();
  });

  test('sharded runs emit per-top-level-unit timings, sentinel excluded (union across shards)', () => {
    const w0 = runFixture('keepalive-tests.cjs', shardEnv(0, 2)); // t0 + t2
    const w1 = runFixture('keepalive-tests.cjs', shardEnv(1, 2)); // t1 + suite-a
    const merged = { ...w0.timings, ...w1.timings };
    expect(Object.keys(merged).sort()).toEqual(['suite-a', 't0', 't1', 't2']);
    for (const v of Object.values(merged)) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  test('sharded workers emit timings for their own units only', () => {
    const r = runFixture('keepalive-tests.cjs', shardEnv(0, 2)); // t0 + t2
    expect(Object.keys(r.timings).sort()).toEqual(['t0', 't2']);
  });
});

describe('duration-aware sharding (LPT)', () => {
  const timings = { 't0': 1000, 't1': 10, 't2': 10, 'suite-a': 900 };
  const lptEnv = (index, total) => ({
    TEST_METADATA: JSON.stringify({ shard: { index, total }, timings }),
  });

  test('LPT separates the two slow units across two shards', () => {
    // LPT trace: t0(1000)→b0; suite-a(900)→b1; t1(10)→b1 (900<1000); t2(10)→b1 (910<1000).
    // Buckets: b0={t0}, b1={suite-a,t1,t2}.
    const w0 = runFixture('keepalive-tests.cjs', lptEnv(0, 2));
    const w1 = runFixture('keepalive-tests.cjs', lptEnv(1, 2));
    expect(w0.result).toMatchObject({ tests: 1 });            // t0
    expect(w1.result).toMatchObject({ tests: 4 });            // suite-a(2) + t1 + t2
    expect(w0.result.tests + w1.result.tests).toBe(5);
  });

  test('unknown units fall back to round-robin without disturbing LPT picks', () => {
    const partial = { 't0': 1000, 'suite-a': 900 };           // t1, t2 unknown to the timings map
    const env = (i) => ({ TEST_METADATA: JSON.stringify({ shard: { index: i, total: 2 }, timings: partial }) });
    const w0 = runFixture('keepalive-tests.cjs', env(0));
    const w1 = runFixture('keepalive-tests.cjs', env(1));
    // LPT: t0→b0, suite-a→b1; unknowns t1, t2 round-robin: t1→b0, t2→b1
    expect(w0.result).toMatchObject({ tests: 2 });            // t0 + t1
    expect(w1.result).toMatchObject({ tests: 3 });            // suite-a(2) + t2
  });

  test('timings without shard change nothing', () => {
    const r = runFixture('keepalive-tests.cjs',
      { TEST_METADATA: JSON.stringify({ timings }) });
    expect(r.result).toMatchObject({ tests: 5, passed: 5 });
  });
});
