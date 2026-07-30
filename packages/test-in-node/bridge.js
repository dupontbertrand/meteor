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
      const shard = g.shard;
      const mine = shard
        ? cases.filter((_, i) => i % shard.total === shard.index)
        : cases;

      for (const c of mine) {
        await t.test(c.name, () => runCase(c));
      }
    });
  }
}

// Promisifies Tinytest's dual callback/promise calling convention
// (tinytest.js TestCase#run: `this.func(results, resolve)`, optionally
// returning a thenable — see Tinytest.add vs addAsync).
function runCase(c) {
  return new Promise((resolve, reject) => {
    const r = c.func(makeTestProxy(), resolve);
    if (r && typeof r.then === 'function') {
      r.then(resolve, reject);
    }
  });
}
