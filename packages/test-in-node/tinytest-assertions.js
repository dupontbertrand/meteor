// Tinytest -> node:assert assertion compatibility layer.
//
// Tinytest passes a `test` object with methods like test.equal(),
// test.isTrue(), etc. makeTestProxy() builds an object that delegates to
// node:assert, so existing Tinytest-authored tests work unmodified when run
// through the test-in-node bridge.
//
// CommonJS on purpose (see driver.js): loadable directly by plain Node (for
// unit tests, no Meteor globals required) AND by isobuild.
const assert = require('node:assert/strict');

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Best-effort stringification for default failure messages. JSON.stringify
// throws on circular structures ("Converting circular structure to JSON");
// callers must only invoke this once an assertion has actually FAILED (see
// the guarded()-wrapped methods below) so the cost — and the fallback below
// — never lands on the passing path.
function safeShow(v) {
  try {
    return JSON.stringify(v);
  } catch (err) {
    try {
      return String(v);
    } catch (err2) {
      return '[unprintable]';
    }
  }
}

function makeTestProxy() {
  // Stable per-test-run id, generated ONCE per proxy (== once per bridged
  // Tinytest case). Mirrors real Tinytest's TestCaseResults: `this.id =
  // Random.id()` set once in the constructor (packages/tinytest/tinytest.js:15)
  // and `runId()` returning that same value (:110-111). Tinytest-authored
  // tests widely assume this stability — some read `test.id` directly to
  // build a unique fixture (e.g. packages/accounts-password/password_tests.js:1490),
  // others call `test.runId()` more than once expecting the SAME value back
  // (e.g. packages/mongo/tests/mongo_livedata_tests.js). A fresh random value
  // per call broke both patterns under the bridge.
  const id = 'bridge-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);

  // One-shot "expect the next assertion to fail" flag, set by expect_fail().
  // Every assertion-throwing method below is wrapped through guarded()/
  // guardedAsync(): on success the flag is disarmed; on throw, an armed flag
  // consumes itself and swallows the failure instead of propagating it.
  let expectingFail = false;

  // Failures recorded by fail() (see below) — bridge-internal, read by
  // bridge.js's runCase() after the case completes to fail the subtest.
  const failures = [];

  function guarded(fn) {
    return (...args) => {
      try {
        const result = fn(...args);
        expectingFail = false;
        return result;
      } catch (e) {
        if (expectingFail) {
          expectingFail = false;
          return;
        }
        throw e;
      }
    };
  }

  function guardedAsync(fn) {
    return async (...args) => {
      try {
        const result = await fn(...args);
        expectingFail = false;
        return result;
      } catch (e) {
        if (expectingFail) {
          expectingFail = false;
          return;
        }
        throw e;
      }
    };
  }

  const proxy = {
    // Stable per-test-run id — see comment above. Real Tinytest exposes this
    // as a plain property (this.id), not just through runId().
    id,

    // No-op sleep for compat (returns a promise)
    sleep(ms = 0) {
      return new Promise(resolve => setTimeout(resolve, ms));
    },

    ok() { /* success — no-op in assert style */ },

    // Mirrors real Tinytest's fail() (packages/tinytest/tinytest.js:39-91):
    // it does NOT throw, it records the failure and returns normally so the
    // rest of the test case keeps running. This matters because `test.fail(msg);
    // <more code>` is a common Tinytest idiom (timeout/defensive branches) —
    // a throwing fail() turns that idiom into an uncaught exception instead
    // of a clean recorded failure (see bridge.js's runCase(), which fails the
    // subtest at the end if `_failures` is non-empty). Same expect_fail()
    // interplay as every other assertion: an armed flag consumes itself and
    // the failure is swallowed (not recorded).
    fail(doc) {
      if (expectingFail) {
        expectingFail = false;
        return;
      }
      const msg = typeof doc === 'string'
        ? doc
        : (doc && doc.message) || safeShow(doc);
      failures.push(msg);
    },

    // Bridge-internal: failures recorded by fail() above. Not part of the
    // Tinytest API surface — read by bridge.js after a case completes.
    _failures: failures,

    exception: guarded((err) => {
      throw err;
    }),

    equal: guarded((actual, expected, message) => {
      // Tinytest uses EJSON.equals for deep comparison which ignores
      // prototype differences. Use EJSON.equals when available, fall
      // back to assert.deepStrictEqual for primitives/plain objects.
      const EJSON = typeof Package !== 'undefined' && Package.ejson && Package.ejson.EJSON;
      if (typeof actual === 'string' && typeof expected === 'string') {
        assert.strictEqual(actual, expected, message);
      } else if (EJSON) {
        // Lazy + safe: only build (and only stringify) the default message
        // once the assertion has actually failed. Building it eagerly as an
        // assert.ok() argument ran JSON.stringify on every PASSING call too
        // — and JSON.stringify throws on circular structures.
        if (!EJSON.equals(actual, expected)) {
          assert.fail(message || `expected ${safeShow(expected)}, got ${safeShow(actual)}`);
        }
      } else {
        assert.deepStrictEqual(actual, expected, message);
      }
    }),

    notEqual: guarded((actual, expected, message) => {
      const EJSON = typeof Package !== 'undefined' && Package.ejson && Package.ejson.EJSON;
      if (typeof actual === 'string' && typeof expected === 'string') {
        assert.notStrictEqual(actual, expected, message);
      } else if (EJSON) {
        assert.ok(
          !EJSON.equals(actual, expected),
          message || `expected values to differ`,
        );
      } else {
        assert.notDeepStrictEqual(actual, expected, message);
      }
    }),

    isTrue: guarded((v, msg) => {
      assert.ok(v, msg || 'expected truthy value');
    }),

    isFalse: guarded((v, msg) => {
      assert.ok(!v, msg || 'expected falsy value');
    }),

    isNull: guarded((v, msg) => {
      assert.strictEqual(v, null, msg || 'expected null');
    }),

    isNotNull: guarded((v, msg) => {
      assert.notStrictEqual(v, null, msg || 'expected non-null');
    }),

    isUndefined: guarded((v, msg) => {
      assert.strictEqual(v, undefined, msg || 'expected undefined');
    }),

    isNotUndefined: guarded((v, msg) => {
      assert.notStrictEqual(v, undefined, msg || 'expected defined value');
    }),

    isNaN: guarded((v, msg) => {
      assert.ok(Number.isNaN(v), msg || `expected NaN, got ${v}`);
    }),

    isNotNaN: guarded((v, msg) => {
      assert.ok(!Number.isNaN(v), msg || 'expected non-NaN');
    }),

    instanceOf: guarded((obj, klass, msg) => {
      assert.ok(obj instanceof klass, msg || 'expected instanceof to be true');
    }),

    notInstanceOf: guarded((obj, klass, msg) => {
      assert.ok(!(obj instanceof klass), msg || 'expected instanceof to be false');
    }),

    matches: guarded((actual, regexp, msg) => {
      assert.match(actual, regexp, msg);
    }),

    notMatches: guarded((actual, regexp, msg) => {
      assert.doesNotMatch(actual, regexp, msg);
    }),

    include: guarded((s, v, message) => {
      if (Array.isArray(s)) {
        const found = s.some(item => {
          try { assert.deepStrictEqual(item, v); return true; }
          catch { return false; }
        });
        // Lazy + safe: don't stringify v (possibly circular) unless the
        // assertion is actually about to fail.
        if (!found) {
          assert.fail(message || `expected array to include ${safeShow(v)}`);
        }
      } else if (s && typeof s === 'object') {
        assert.ok(v in s, message || `expected object to have key "${v}"`);
      } else if (typeof s === 'string') {
        assert.ok(s.includes(v), message || `expected "${s}" to include "${v}"`);
      } else {
        assert.fail(message || 'include: first argument must be array, object, or string');
      }
    }),

    notInclude: guarded((s, v, message) => {
      if (Array.isArray(s)) {
        const found = s.some(item => {
          try { assert.deepStrictEqual(item, v); return true; }
          catch { return false; }
        });
        // Lazy + safe — see include() above.
        if (found) {
          assert.fail(message || `expected array not to include ${safeShow(v)}`);
        }
      } else if (s && typeof s === 'object') {
        assert.ok(!(v in s), message || `expected object not to have key "${v}"`);
      } else if (typeof s === 'string') {
        assert.ok(!s.includes(v), message || `expected "${s}" not to include "${v}"`);
      }
    }),

    length: guarded((obj, expected, msg) => {
      assert.strictEqual(obj.length, expected,
        msg || `expected length ${expected}, got ${obj.length}`);
    }),

    throws: guarded((f, expected, message) => {
      if (expected === undefined) {
        assert.throws(f, message);
      } else if (typeof expected === 'string') {
        assert.throws(f, { message: new RegExp(escapeRegExp(expected)) }, message);
      } else if (expected instanceof RegExp) {
        assert.throws(f, { message: expected }, message);
      } else if (typeof expected === 'function') {
        try {
          f();
          assert.fail(message || 'expected function to throw');
        } catch (e) {
          assert.ok(expected(e), message || `predicate rejected error: ${e.message}`);
        }
      }
    }),

    // Mirrors tinytest.js's doesNotThrows (packages/tinytest/tinytest.js:278):
    // run f; if it throws, fail with a message naming the thrown error
    // (plus the caller's failureMessage, if given).
    doesNotThrows: guarded((f, failureMessage) => {
      try {
        f();
      } catch (e) {
        assert.fail(
          `threw an error unexpectedly: ${e.message}` +
          (failureMessage ? `: ${failureMessage}` : ''),
        );
      }
    }),

    throwsAsync: guardedAsync(async (f, expected, message) => {
      if (expected === undefined) {
        await assert.rejects(f, message);
      } else if (typeof expected === 'string') {
        await assert.rejects(f, { message: new RegExp(escapeRegExp(expected)) }, message);
      } else if (expected instanceof RegExp) {
        await assert.rejects(f, { message: expected }, message);
      } else if (typeof expected === 'function') {
        try {
          await f();
          assert.fail(message || 'expected async function to throw');
        } catch (e) {
          assert.ok(expected(e), message || `predicate rejected error: ${e.message}`);
        }
      }
    }),

    // Mirrors tinytest.js's doesNotThrowsAsync (packages/tinytest/tinytest.js:322)
    // — same as doesNotThrows above, but awaits f.
    doesNotThrowsAsync: guardedAsync(async (f, failureMessage) => {
      try {
        await f();
      } catch (e) {
        assert.fail(
          `threw an error unexpectedly: ${e.message}` +
          (failureMessage ? `: ${failureMessage}` : ''),
        );
      }
    }),

    // Tinytest-specific: arms the one-shot "expect the next assertion to
    // fail" flag consumed by guarded()/guardedAsync() above.
    expect_fail() {
      expectingFail = true;
    },

    // Extra details attached to failures — no-op in bridge
    extraDetails: {},

    runId() { return id; },
  };

  return proxy;
}

module.exports = { makeTestProxy };
