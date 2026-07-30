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

function makeTestProxy() {
  // One-shot "expect the next assertion to fail" flag, set by expect_fail().
  // Every assertion-throwing method below is wrapped through guarded()/
  // guardedAsync(): on success the flag is disarmed; on throw, an armed flag
  // consumes itself and swallows the failure instead of propagating it.
  let expectingFail = false;

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
    // No-op sleep for compat (returns a promise)
    sleep(ms = 0) {
      return new Promise(resolve => setTimeout(resolve, ms));
    },

    ok() { /* success — no-op in assert style */ },

    fail: guarded((doc) => {
      const msg = typeof doc === 'string'
        ? doc
        : (doc && doc.message) || JSON.stringify(doc);
      assert.fail(msg);
    }),

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
        assert.ok(
          EJSON.equals(actual, expected),
          message || `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
        );
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
        assert.ok(found, message || `expected array to include ${JSON.stringify(v)}`);
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
        assert.ok(!found, message || `expected array not to include ${JSON.stringify(v)}`);
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

    runId() { return 'bridge-' + Math.random().toString(36).slice(2); },
  };

  return proxy;
}

module.exports = { makeTestProxy };
