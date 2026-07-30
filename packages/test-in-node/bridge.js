// Tinytest → node:test bridge.
//
// Makes EXISTING Tinytest suites (Tinytest.add / addAsync, still registered
// by every tested package's onTest — nothing there changes) run as node:test
// subtests under this driver, so they get its parallelism, LPT sharding and
// aggregation for free.
//
// Three design choices, each forced by a constraint elsewhere in the driver:
//
// 1. Registered via `g.rawTest` (the pre-patch `test` binding driver.js
//    exposes on globalThis.__meteorTestInNode), NOT the shard/filter-wrapped
//    `test`. driver.js's registration filter keeps only ~1/N top-level units
//    per worker (round-robin/LPT) — if the parent went through it, it would
//    land on a single worker and every OTHER worker would silently run zero
//    Tinytest cases. The bridge does its OWN case-level slicing below, so the
//    parent itself must exist unconditionally on every worker.
//
// 2. The body `await`s a promise resolved by Meteor.startup before reading
//    ordered_tests. Tinytest.add/addAsync calls happen at package load time
//    across every tested package, same as this file — there is no ordering
//    guarantee between them and bridge.js's own top-level code. Meteor.startup
//    callbacks run after all packages have finished loading, so by then
//    TestManager.ordered_tests is guaranteed complete.
//
// 3. Each case runs as `await t.test(c.name, ...)` — a real node:test subtest,
//    not a bare function call — so the driver's completion barrier (which
//    tracks test:enqueue/test:complete events) actually sees it and the
//    process doesn't exit before it's done. Sequential (awaited one at a
//    time) because Tinytest cases have historically relied on running one at
//    a time against shared fixtures (e.g. Mongo collections) within a group.
import { Meteor } from 'meteor/meteor';
import { makeTestProxy } from './tinytest-assertions.js';

const g = globalThis.__meteorTestInNode;

// Driver not loaded (shouldn't happen — driver.js is addFiles'd before this
// file — but bail rather than throw if it ever does).
if (g && g.rawTest) {
  // Read the parent's name from the driver instead of duplicating the string
  // literal here: driver.js excludes this exact name from the tally and from
  // unitTimings (BRIDGE_PARENT_NAME, next to SENTINEL_NAME) — registration
  // here and exclusion there MUST use the identical name, and sharing it
  // through globalThis state (rather than two hand-synced literals) makes
  // that structurally impossible to drift.
  const BRIDGE_PARENT_NAME = g.bridgeParentName;

  // Weak dep: tinytest may not be in the tested package's bundle at all. In
  // that case this file must be a complete no-op — no parent registered, no
  // trace in the tally.
  if (typeof Package !== 'undefined' && Package.tinytest) {
    const started = new Promise((resolve) => Meteor.startup(resolve));

    g.rawTest(BRIDGE_PARENT_NAME, async (t) => {
      await started;

      const cases = Package.tinytest.Tinytest._TestManager.ordered_tests;
      if (!cases.length) {
        t.skip('no tinytest cases registered');
        return;
      }

      // Bridge-level sharding: TINYTEST_FILTER already thinned ordered_tests
      // at registration time (tinytest.js addCase), so nothing to do for -f.
      // Shard, however, driver.js only shards ITS OWN top-level units — this
      // parent is one such unit and got registered via rawTest specifically
      // to dodge that. So the bridge re-implements shard assignment itself,
      // at case granularity, using the same {index, total} the driver
      // already computed from TEST_METADATA.
      //
      // Sharding bridged cases is OPT-IN (METEOR_TEST_SHARD_TINYTEST=1).
      // Legacy Tinytest suites routinely depend on cases in a group running
      // in registration order against shared fixtures (a Mongo collection, a
      // DDP connection) — splitting cases across workers silently breaks
      // that assumption instead of failing loudly (see the mongo 228-vs-231
      // parallel case-count discrepancy diagnosed in the Stage 2 campaign).
      // Per-case sharding is only safe when cases are independent, which
      // isn't a safe default for suites the bridge didn't author. So by
      // default all bridged cases run sequentially on worker 0 only, exactly
      // as they would under Tinytest itself; other workers contribute
      // nothing to this suite.
      const shard = g.shard;
      let mine = cases;
      if (shard) {
        if (process.env.METEOR_TEST_SHARD_TINYTEST === '1') {
          mine = cases.filter((_, i) => i % shard.total === shard.index);
        } else if (shard.index !== 0) {
          t.skip('bridged tinytest cases run on worker 0 (sequential-safe); set METEOR_TEST_SHARD_TINYTEST=1 to shard them');
          return;
        }
      }

      for (const c of mine) {
        await t.test(c.name, () => runCase(c));
      }
    });
  }
}

// Promisifies Tinytest's dual callback/promise calling convention
// (tinytest.js TestCase#run: `this.func(results, resolve)`, optionally
// returning a thenable — see Tinytest.add vs addAsync).
//
// test.fail() (tinytest-assertions.js) records into the proxy's `_failures`
// instead of throwing, matching real Tinytest semantics — so a case that
// called fail() still resolves normally above. Check `_failures` once the
// case is done and fail the node:test subtest here if anything was
// recorded, otherwise a case that only ever calls fail() would silently
// report green.
function runCase(c) {
  const proxy = makeTestProxy();
  return new Promise((resolve, reject) => {
    const r = c.func(proxy, resolve);
    if (r && typeof r.then === 'function') {
      r.then(resolve, reject);
    }
  }).then(
    () => {
      if (proxy._failures.length) {
        throw new Error('tinytest recorded failures: ' + proxy._failures.join('; '));
      }
    },
    (err) => {
      // The case rejected on its own — don't lose fail() messages recorded
      // before the rejection.
      if (proxy._failures.length && err && typeof err.message === 'string') {
        err.message +=
          ' (also recorded: ' + proxy._failures.join('; ') + ')';
      }
      throw err;
    },
  );
}
