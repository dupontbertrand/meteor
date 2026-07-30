# test-in-node

Run Meteor package tests with the Node.js native test runner (`node:test`).
Server-side, zero dependencies, opt-in. Tinytest is untouched.

```bash
meteor test-packages my-package --driver-package test-in-node --once
```

Write tests as standard Node tests, in **server-only** files:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Random } from 'meteor/random';

describe('my-package', () => {
  it('generates unique ids', () => {
    assert.notStrictEqual(Random.id(), Random.id());
  });
});
```

```js
// package.js
Package.onTest(function (api) {
  api.use(['my-package', 'ecmascript'], 'server');
  api.addFiles('my-package-tests.js', 'server'); // server-only — see note below
});
```

The driver's `node:test` reporter is **wired automatically** by the Meteor tool when
you pass `--driver-package test-in-node`. No `SERVER_NODE_OPTIONS` needed.

> **Server-only:** test files using `node:test` must be added with the `'server'`
> arch (`api.addFiles('tests.js', 'server')`). `node:test` is a Node API, and isobuild
> only passes `node:` imports through on the server architecture.

## What you get

Standard `node:test`: `describe`/`it`, `node:assert/strict`, async tests, `it.skip`,
`it.todo`, nested suites — all from Node core, zero extra dependencies. The runner
reports a compact pass/fail/skip/todo summary and exits non-zero if any test fails.

## Filtering tests (`--filter` / `-f`)

    meteor test-packages my-package --driver-package test-in-node --once --filter 'my-package'

`--filter <pattern>` (`-f`) works with this driver, at the same **top-level**
`test()`/`describe()` granularity as sharding: a non-matching top-level unit
(and everything nested inside it) is dropped wholesale at registration time.
`<pattern>` is used as a regular expression when it compiles, and falls back
to a literal substring match otherwise. It composes with `--parallel-workers`:
the round-robin shard assignment runs over the already-filtered set of units.

> Note: the same named-exports caveat as sharding applies to filtering — tests
> registered through the callable default export (`const test = require('node:test')`)
> or chained aliases (`test.describe(...)`) bypass the filter and still execute.

> Note: this differs from tinytest's own `--filter`, which matches the
> pattern as a literal substring only (no regex).

## Parallel workers (experimental)

Build once, run the suite across N isolated worker processes — each with its
own port and its own Mongo database (`meteor_w<i>` on the shared dev mongod):

    meteor test-packages my-package --driver-package test-in-node --once --parallel-workers 4

`--parallel-workers` takes a number >= 2 or `auto` (machine parallelism, floored at 2).

- Sharding is assigned round-robin over **top-level** `test()`/`describe()`
  registrations (a top-level `describe` moves wholesale with its nested tests).
  `node:test`'s own `--test-shard` does not apply here: test files are
  pre-loaded by the Meteor bundle, so the runner never discovers files.
- Register tests through the **named** exports (`test`, `it`, `describe`,
  `suite`). The callable default export (`const test = require('node:test')`)
  and chained aliases (`test.describe(...)`) bypass the shard filter: the run
  stays correct, but those tests execute on every worker instead of one.
- Requires `--once` (no watch/rebuild while workers run). The exit code is 0
  only if every worker passed.
- Worker databases are dropped before each run. Set
  `METEOR_TEST_WORKER_TIMEOUT_SECS` (default 900) to bound a hung worker.
- `METEOR_TEST_MONGO_PER_WORKER=1` (experimental) gives each worker its own
  dedicated mongod instead of a database on the shared dev mongod.
- **Duration-aware sharding:** when a previous run's per-unit timings are
  available, units are distributed by measured duration (longest-first, to the
  least-loaded worker) instead of round-robin. Timings persist in
  `.meteor/local/test-in-node-timings.json` — so `meteor test`, or
  `meteor test-packages` with `--test-app-path`, get balanced shards from the
  second run on. The first run always uses round-robin.

## Tinytest compatibility (bridge)

If the package under test still uses `Tinytest.add` / `Tinytest.addAsync`
(the normal `api.use('tinytest', ...)` `onTest` setup), those suites run
**unmodified** under this driver — nothing in the tested package changes.
The driver detects `tinytest` in the test bundle and bridges its registered
cases into `node:test`, so they get the driver's parallelism and
aggregation, with sharding at case granularity (see below — bridged cases
don't feed the duration-aware LPT sharding):

    meteor test-packages ejson --driver-package test-in-node --once

- **Sharding is opt-in** (`METEOR_TEST_SHARD_TINYTEST=1`) — by default,
  under `--parallel-workers`, ALL bridged cases run sequentially on worker 0
  only; every other worker skips the bridge parent entirely and contributes
  nothing to this suite. Legacy Tinytest suites routinely depend on cases in
  a group running in registration order against shared fixtures (a Mongo
  collection, a DDP connection) — splitting cases across workers can
  silently break that assumption instead of failing loudly. Per-case
  sharding is only safe when cases are independent, which isn't a safe
  default for suites the bridge didn't author:

      METEOR_TEST_SHARD_TINYTEST=1 meteor test-packages my-package --driver-package test-in-node --once --parallel-workers 4

  With the opt-in set, each worker runs its own slice of Tinytest's
  `ordered_tests`, roughly `N / workers` cases each (case-granularity, not
  top-level-unit granularity like native `node:test` registrations above).
- **Cases run sequentially** within a worker's slice, one at a time —
  matching Tinytest's historical semantics of cases in a group sharing
  fixtures (e.g. a Mongo collection) without racing each other.
- **`-f` / `--filter`** on bridged cases uses **Tinytest's own** substring
  filter (applied where Tinytest registers cases, before the bridge ever
  sees them), not this driver's regex-or-substring top-level-unit filter
  described above.
- **`expect_fail()`** is supported with one-shot semantics: it arms a flag
  that the next failing assertion consumes (swallowing that one failure);
  any assertion that succeeds first disarms it again.

Limits:
- **Server-only** — same as every other test file under this driver;
  Tinytest suites that only ran client-side are out of scope for the
  bridge.
- **No per-case LPT** — the bridge's own parent test (an implementation
  detail, not a real test) is excluded from both the pass/fail tally and
  `TEST_IN_NODE_TIMINGS`, so bridged cases currently don't feed the
  duration-aware sharding described above at all (not even as one lumped
  unit). Per-case LPT for bridged suites is a documented follow-up.
- **`test.exception()` throws synchronously** — attribution for exceptions
  raised from a detached callback (outside the case's own call stack)
  differs from Tinytest's own `onException` routing.
- **A failing assertion stops the bridged case at that point** — Tinytest
  records a failure and keeps running the rest of the case; the bridge's
  assertions throw (via `guarded()`/`guardedAsync()`), so anything after the
  first failure — including case-local cleanup — is skipped. Outcome-
  equivalent for pass/fail reporting, but cleanup written after a
  possibly-failing assertion won't run.
  **Exception: `test.fail()` itself does not throw** — it records the
  failure and returns, matching Tinytest semantics, precisely because
  `test.fail(msg); <more code>` (timeout/defensive branches) is a common
  Tinytest idiom; a throwing `fail()` would turn that idiom into an
  uncaught exception instead of a clean recorded failure. Recorded failures
  fail the bridged case once it completes.

## Node version note

The driver relies on `node:test`'s `test:complete` event (Node ≥ 20.13). Inside
Meteor this is always satisfied — the server runs on the release's dev-bundle
Node (24.x on devel, 22.x on the 3.5 line). The floor only matters if you load
`driver.js` in plain Node during development.
