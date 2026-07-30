// test-in-node driver — runs in the isobuild bundle (server-only).
// Sets up the shared completion state on globalThis (the reporter, loaded outside the
// bundle via --test-reporter, forwards node:test events to state.onEvent). Completion is
// structured: a root after() sets the barrier, and we finalize OUTSIDE the hook once the
// reporter has seen every enqueued item complete. No debounce, no stdout parsing, no beforeExit.
//
// CommonJS on purpose: loadable directly by Node (for pure-Node smoke tests) AND by isobuild.
const { after, test } = require('node:test');

// Guarantees the completion barrier is always reachable: with ZERO registered
// tests, node:test's root after() never fires while the server keeps the event
// loop alive (HTTP + Mongo), so a package with no node:test tests would hang
// forever. This sentinel makes every run finalize deterministically; it is
// excluded from the reported tallies (see onEvent).
const SENTINEL_NAME = 'test-in-node · completion sentinel';

const c = {
  green: s => `\x1b[32m${s}\x1b[0m`, red: s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`, gray: s => `\x1b[90m${s}\x1b[0m`, bold: s => `\x1b[1m${s}\x1b[0m`,
};

// Reuse (||) the object the reporter may have created at process start — do NOT replace
// it, or we lose its buffered pendingEvents and break the reporter's captured reference.
const state = (globalThis.__meteorTestInNode = globalThis.__meteorTestInNode || { pendingEvents: [] });
state.enqueued = state.enqueued || 0;
state.completed = state.completed || 0;
state.tests = state.tests || 0;
state.suites = state.suites || 0;
state.passed = state.passed || 0;
state.failed = state.failed || 0;
state.skipped = state.skipped || 0;
state.todo = state.todo || 0;
state.rootAfterReached = state.rootAfterReached || false;
state.finalized = state.finalized || false;
state.pendingEvents = state.pendingEvents || [];
state.unitTimings = state.unitTimings || {};

// ---- Registration filter: shard + name (Stage 1, parallel workers) ---------
// The orchestrator assigns this worker a shard {index, total} via TEST_METADATA.
// node:test's own --test-shard shards by *discovered file* and is silently
// ignored here (isobuild pre-loads every test file into the bundle; node:test
// discovers nothing — verified). So we filter at registration time instead:
// top-level test()/describe() calls are kept round-robin by registration order,
// which is deterministic because every worker evaluates the same bundle in the
// same serverJson.load order. A top-level describe is one unit (its nested
// tests follow it wholesale).
let shard = null;
let meta = {};
try {
  meta = JSON.parse(process.env.TEST_METADATA || '{}');
  if (meta.shard && meta.shard.total > 1 && meta.shard.index >= 0 && meta.shard.index < meta.shard.total) shard = meta.shard;
} catch (err) { /* no/invalid TEST_METADATA (pure Node) — run unsharded */ }

// --filter / -f: the tool exports it as TINYTEST_FILTER (same plumbing as
// tinytest). Applied at registration time, at the same top-level-unit
// granularity as sharding: a non-matching top-level unit is dropped wholesale.
// Regex when the pattern compiles, literal substring otherwise. Unnamed
// units (rare) are kept — a grep cannot judge them.
let nameFilter = null;
if (process.env.TINYTEST_FILTER) {
  const pattern = process.env.TINYTEST_FILTER;
  try { const re = new RegExp(pattern); nameFilter = (name) => re.test(name); }
  catch (err) { nameFilter = (name) => name.includes(pattern); }
}

if (shard || nameFilter) {
  if (shard) state.shard = { index: shard.index, total: shard.total };
  const nt = require('node:test');
  let topLevelSeen = 0;
  let depth = 0;

  // Duration-aware sharding (LPT): when the orchestrator supplies the previous
  // run's per-unit timings, assign known units greedily to the least-loaded
  // bucket instead of blind round-robin. Deterministic across workers: same
  // timings JSON + same tie-breaks (ms desc, then name asc) → same buckets
  // everywhere; each worker just keeps its own. Unknown units (new/renamed)
  // fall back to round-robin over the unknowns only.
  let lptBucket = null;
  if (shard && meta.timings && typeof meta.timings === 'object') {
    const entries = Object.entries(meta.timings)
      .filter(([, ms]) => typeof ms === 'number' && ms >= 0)
      .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const load = new Array(shard.total).fill(0);
    lptBucket = new Map();
    for (const [name, ms] of entries) {
      let min = 0;
      for (let b = 1; b < shard.total; b++) if (load[b] < load[min]) min = b;
      lptBucket.set(name, min);
      load[min] += ms;
    }
  }

  const wrap = (orig, isSuiteFn) => {
    const wrapped = function (...args) {
      if (depth === 0) {
        const name = typeof args[0] === 'string' ? args[0] : '';
        if (nameFilter && name && !nameFilter(name)) return;      // filtered out
        if (shard) {
          if (lptBucket && name && lptBucket.has(name)) {
            if (lptBucket.get(name) !== shard.index) return;
          } else if ((topLevelSeen++ % shard.total) !== shard.index) return;
        }
      }
      if (!isSuiteFn) return orig.apply(this, args);
      // describe/suite bodies run synchronously at registration: raise depth so
      // nested registrations are not re-filtered (the unit is the whole suite).
      const body = args[args.length - 1];
      if (typeof body === 'function') {
        args[args.length - 1] = function (...bodyArgs) {
          depth++;
          try { return body.apply(this, bodyArgs); } finally { depth--; }
        };
      }
      return orig.apply(this, args);
    };
    // Carry over all static properties (skip, only, todo, etc.) from original
    Object.assign(wrapped, orig);
    // Override registration-shaped sub-properties with filtered versions
    for (const sub of ['skip', 'todo', 'only']) {
      if (typeof orig[sub] === 'function') wrapped[sub] = wrap(orig[sub], isSuiteFn);
    }
    return wrapped;
  };
  // test/it (and describe/suite) alias one function but are SEPARATE export
  // properties — each must be patched, or files importing the alias bypass
  // the filter entirely.
  nt.test = wrap(nt.test, false);
  nt.it = wrap(nt.it, false);
  nt.describe = wrap(nt.describe, true);
  nt.suite = wrap(nt.suite, true);
  // Empty-shard anti-hang: covered by the unconditional completion sentinel
  // (registered through the binding captured BEFORE this patch installs — it
  // bypasses the filter and guarantees the barrier completes on every shard).
}

// suite vs test is in data.details.type on test:complete — reliable at every nesting depth.
function isSuite(d) { return (d && d.details && d.details.type) === 'suite'; }

state.onEvent = function (event) {
  const d = event.data || {};
  switch (event.type) {
    case 'test:enqueue':
      state.enqueued++;
      break;
    case 'test:complete':              // terminal for EVERY outcome → completed never stalls
      state.completed++;
      if (d.nesting === 0 && d.name !== SENTINEL_NAME) {
        state.unitTimings[d.name] =
          Math.max(0, Math.round((d.details && d.details.duration_ms) || 0));
      }
      if (isSuite(d)) { state.suites++; break; }  // suites carry details.passed too — exclude
      if (d.name === SENTINEL_NAME) break;        // barrier bookkeeping only — not a real test
      state.tests++;                              //   them from the pass/fail tally (no double-count)
      if (d.skip) state.skipped++;                // NB: skipped/todo also have details.passed:true,
      else if (d.todo) state.todo++;              //     so skip/todo MUST be checked before passed.
      else if (d.details && d.details.passed) state.passed++;
      else state.failed++;                        // real failure OR cancelled/interrupted
      break;
  }
  maybeFinalize();
};

after(() => { state.rootAfterReached = true; maybeFinalize(); });
test(SENTINEL_NAME, () => {});

// Drain events the reporter buffered before onEvent existed (reporter attaches at process
// start; this driver arrives later via the bundle). Synchronous — no event interleaves.
{
  const buffered = state.pendingEvents;
  state.pendingEvents = [];
  for (const e of buffered) state.onEvent(e);
}

function maybeFinalize() {
  if (state.finalized) return;
  if (!(state.rootAfterReached && state.enqueued > 0 && state.completed === state.enqueued)) return;
  state.finalized = true;
  const parts = [];
  if (state.passed)  parts.push(c.green(`${state.passed} passed`));
  if (state.failed)  parts.push(c.red(`${state.failed} failed`));
  if (state.skipped) parts.push(c.yellow(`${state.skipped} skipped`));
  if (state.todo)    parts.push(c.gray(`${state.todo} todo`));
  // Exit from the write callback so the summary is flushed before we force-exit.
  // We must force-exit (process.exitCode alone would hang: Meteor keeps the event
  // loop alive — HTTP + Mongo — so the process never drains on its own). Calling
  // process.exit() *immediately* after write() can truncate piped stdout, so we wait
  // for the write to be handled first.
  // Machine-readable line for the Stage 1 orchestrator — MUST live in the same
  // write() as the human summary: the exit fires from this write's callback,
  // so everything in it is flushed through the pipe before we force-exit, and
  // the line stays atomic when a parent multiplexes N workers' stdout.
  const machine = {
    tests: state.tests, passed: state.passed, failed: state.failed,
    skipped: state.skipped, todo: state.todo,
  };
  if (state.shard) machine.shard = state.shard;
  process.stdout.write(
    `\n${c.bold('test-in-node')} ${c.gray('· node:test')}\n  ` +
    (parts.join(', ') || c.gray('no assertions')) +
    c.gray(` (${state.tests} tests)`) + '\n' +
    `TEST_IN_NODE_RESULT ${JSON.stringify(machine)}\n` +
    `TEST_IN_NODE_TIMINGS ${JSON.stringify(state.unitTimings)}\n\n`,
    () => process.exit(state.failed > 0 ? 1 : 0),
  );
}
