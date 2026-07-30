// Direct, pure-Node unit tests for the Tinytest -> node:assert compatibility
// layer. No Meteor globals, no spawn: `require` the module exactly as any
// plain Node consumer would.
//
// makeTestProxy() must be loadable and usable with ZERO Meteor globals
// present (Package undefined) -- that's the whole point of the pure-module
// split. Assertions therefore fall back to assert.deepStrictEqual instead of
// EJSON.equals whenever `Package` is not defined.

const { makeTestProxy } = require('../../packages/test-in-node/tinytest-assertions.js');

describe('makeTestProxy', () => {
  let proxy;

  beforeEach(() => {
    proxy = makeTestProxy();
  });

  describe('equal', () => {
    test('strict string equality passes', () => {
      expect(() => proxy.equal('abc', 'abc')).not.toThrow();
    });

    test('strict string inequality throws', () => {
      expect(() => proxy.equal('abc', 'def')).toThrow();
    });

    test('deep equality on plain objects (no Package -> deepStrictEqual fallback)', () => {
      expect(() => proxy.equal({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).not.toThrow();
    });

    test('deep inequality on plain objects throws', () => {
      expect(() => proxy.equal({ a: 1 }, { a: 2 })).toThrow();
    });
  });

  describe('notEqual', () => {
    test('differing strings pass', () => {
      expect(() => proxy.notEqual('abc', 'def')).not.toThrow();
    });

    test('identical strings throw', () => {
      expect(() => proxy.notEqual('abc', 'abc')).toThrow();
    });

    test('differing plain objects pass (deep fallback)', () => {
      expect(() => proxy.notEqual({ a: 1 }, { a: 2 })).not.toThrow();
    });

    test('identical plain objects throw', () => {
      expect(() => proxy.notEqual({ a: 1 }, { a: 1 })).toThrow();
    });
  });

  describe('isTrue / isFalse', () => {
    test('isTrue passes on truthy', () => {
      expect(() => proxy.isTrue(1)).not.toThrow();
    });

    test('isTrue throws on falsy', () => {
      expect(() => proxy.isTrue(0)).toThrow();
    });

    test('isFalse passes on falsy', () => {
      expect(() => proxy.isFalse(0)).not.toThrow();
    });

    test('isFalse throws on truthy', () => {
      expect(() => proxy.isFalse(1)).toThrow();
    });
  });

  describe('isNull / isNotNull', () => {
    test('isNull passes on null', () => {
      expect(() => proxy.isNull(null)).not.toThrow();
    });

    test('isNull throws on non-null', () => {
      expect(() => proxy.isNull(undefined)).toThrow();
    });

    test('isNotNull passes on non-null', () => {
      expect(() => proxy.isNotNull(0)).not.toThrow();
    });

    test('isNotNull throws on null', () => {
      expect(() => proxy.isNotNull(null)).toThrow();
    });
  });

  describe('isUndefined / isNotUndefined', () => {
    test('isUndefined passes on undefined', () => {
      expect(() => proxy.isUndefined(undefined)).not.toThrow();
    });

    test('isUndefined throws on defined', () => {
      expect(() => proxy.isUndefined(null)).toThrow();
    });

    test('isNotUndefined passes on defined value', () => {
      expect(() => proxy.isNotUndefined(null)).not.toThrow();
    });

    test('isNotUndefined throws on undefined', () => {
      expect(() => proxy.isNotUndefined(undefined)).toThrow();
    });
  });

  describe('isNaN / isNotNaN', () => {
    test('isNaN passes on NaN', () => {
      expect(() => proxy.isNaN(NaN)).not.toThrow();
    });

    test('isNaN throws on a number', () => {
      expect(() => proxy.isNaN(1)).toThrow();
    });

    test('isNotNaN passes on a number', () => {
      expect(() => proxy.isNotNaN(1)).not.toThrow();
    });

    test('isNotNaN throws on NaN', () => {
      expect(() => proxy.isNotNaN(NaN)).toThrow();
    });
  });

  describe('instanceOf / notInstanceOf', () => {
    test('instanceOf passes', () => {
      expect(() => proxy.instanceOf(new Error('x'), Error)).not.toThrow();
    });

    test('instanceOf throws when not an instance', () => {
      expect(() => proxy.instanceOf({}, Error)).toThrow();
    });

    test('notInstanceOf passes when not an instance', () => {
      expect(() => proxy.notInstanceOf({}, Error)).not.toThrow();
    });

    test('notInstanceOf throws when it is an instance', () => {
      expect(() => proxy.notInstanceOf(new Error('x'), Error)).toThrow();
    });
  });

  describe('matches / notMatches', () => {
    test('matches passes on regexp match', () => {
      expect(() => proxy.matches('hello world', /world/)).not.toThrow();
    });

    test('matches throws on regexp mismatch', () => {
      expect(() => proxy.matches('hello world', /xyz/)).toThrow();
    });

    test('notMatches passes on regexp mismatch', () => {
      expect(() => proxy.notMatches('hello world', /xyz/)).not.toThrow();
    });

    test('notMatches throws on regexp match', () => {
      expect(() => proxy.notMatches('hello world', /world/)).toThrow();
    });
  });

  describe('include / notInclude', () => {
    test('array: positive include passes', () => {
      expect(() => proxy.include([1, 2, 3], 2)).not.toThrow();
    });

    test('array: negative include throws', () => {
      expect(() => proxy.include([1, 2, 3], 4)).toThrow();
    });

    test('array: positive notInclude passes', () => {
      expect(() => proxy.notInclude([1, 2, 3], 4)).not.toThrow();
    });

    test('array: negative notInclude throws', () => {
      expect(() => proxy.notInclude([1, 2, 3], 2)).toThrow();
    });

    test('object: positive include (key present) passes', () => {
      expect(() => proxy.include({ foo: 1 }, 'foo')).not.toThrow();
    });

    test('object: negative include (key absent) throws', () => {
      expect(() => proxy.include({ foo: 1 }, 'bar')).toThrow();
    });

    test('object: positive notInclude passes', () => {
      expect(() => proxy.notInclude({ foo: 1 }, 'bar')).not.toThrow();
    });

    test('object: negative notInclude throws', () => {
      expect(() => proxy.notInclude({ foo: 1 }, 'foo')).toThrow();
    });

    test('string: positive include (substring present) passes', () => {
      expect(() => proxy.include('hello world', 'world')).not.toThrow();
    });

    test('string: negative include throws', () => {
      expect(() => proxy.include('hello world', 'xyz')).toThrow();
    });

    test('string: positive notInclude passes', () => {
      expect(() => proxy.notInclude('hello world', 'xyz')).not.toThrow();
    });

    test('string: negative notInclude throws', () => {
      expect(() => proxy.notInclude('hello world', 'world')).toThrow();
    });

    // Same eager-JSON.stringify-in-default-message bug as equal() (Stage 2
    // campaign bug #4): a PASSING array include/notInclude check must not
    // crash just because the searched-for value is circular.
    test('array: positive include with a circular value does not throw', () => {
      const circular = {};
      circular.self = circular;
      expect(() => proxy.include([1, circular, 3], circular)).not.toThrow();
    });

    test('array: positive notInclude with a circular value does not throw', () => {
      const circular = {};
      circular.self = circular;
      expect(() => proxy.notInclude([1, 2, 3], circular)).not.toThrow();
    });

    test('array: negative include with a circular value fails safely (no JSON.stringify crash)', () => {
      const circular = {};
      circular.self = circular;
      let thrown;
      try {
        proxy.include([1, 2, 3], circular);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeDefined();
      expect(thrown.message).toEqual(expect.stringMatching(/\[unprintable\]|\[object Object\]/));
    });
  });

  describe('length', () => {
    test('passes when length matches', () => {
      expect(() => proxy.length([1, 2, 3], 3)).not.toThrow();
    });

    test('throws when length differs', () => {
      expect(() => proxy.length([1, 2, 3], 2)).toThrow();
    });
  });

  describe('throws', () => {
    test('undefined expected: passes when fn throws anything', () => {
      expect(() => proxy.throws(() => { throw new Error('boom'); })).not.toThrow();
    });

    test('undefined expected: throws (fails) when fn does not throw', () => {
      expect(() => proxy.throws(() => {})).toThrow();
    });

    test('string expected: matches error message as substring', () => {
      expect(() => proxy.throws(() => { throw new Error('boom goes the dynamite'); }, 'goes the')).not.toThrow();
    });

    test('string expected: fails when message does not match', () => {
      expect(() => proxy.throws(() => { throw new Error('boom'); }, 'nope')).toThrow();
    });

    test('regexp expected: matches error message', () => {
      expect(() => proxy.throws(() => { throw new Error('boom123'); }, /boom\d+/)).not.toThrow();
    });

    test('regexp expected: fails on mismatch', () => {
      expect(() => proxy.throws(() => { throw new Error('boom'); }, /xyz/)).toThrow();
    });

    test('predicate expected: passes when predicate returns truthy', () => {
      expect(() => proxy.throws(() => { throw new TypeError('boom'); }, e => e instanceof TypeError)).not.toThrow();
    });

    test('predicate expected: fails when predicate returns falsy', () => {
      expect(() => proxy.throws(() => { throw new Error('boom'); }, () => false)).toThrow();
    });

    // NOTE: assert.fail() (raised when f() doesn't throw) is caught by the
    // same try/catch and handed to the predicate like any other error — a
    // permissive predicate (`() => true`) can mask this. A discriminating
    // predicate (as real Tinytest tests use) still correctly rejects it,
    // since assert.fail()'s AssertionError isn't a TypeError.
    test('predicate expected: fails when fn does not throw at all', () => {
      expect(() => proxy.throws(() => {}, e => e instanceof TypeError)).toThrow();
    });
  });

  describe('doesNotThrows', () => {
    test('passes when fn does not throw', () => {
      expect(() => proxy.doesNotThrows(() => {})).not.toThrow();
    });

    test('fails when fn throws', () => {
      expect(() => proxy.doesNotThrows(() => { throw new Error('boom'); }))
        .toThrow(/threw an error unexpectedly: boom/);
    });
  });

  describe('throwsAsync', () => {
    test('undefined expected: resolves when fn rejects', async () => {
      await expect(proxy.throwsAsync(async () => { throw new Error('boom'); })).resolves.not.toThrow();
    });

    test('undefined expected: rejects when fn resolves', async () => {
      await expect(proxy.throwsAsync(async () => {})).rejects.toThrow();
    });

    test('string expected: matches rejection message substring', async () => {
      await expect(
        proxy.throwsAsync(async () => { throw new Error('async boom'); }, 'async')
      ).resolves.not.toThrow();
    });

    test('regexp expected: matches rejection message', async () => {
      await expect(
        proxy.throwsAsync(async () => { throw new Error('boom123'); }, /boom\d+/)
      ).resolves.not.toThrow();
    });

    test('predicate expected: passes when predicate returns truthy', async () => {
      await expect(
        proxy.throwsAsync(async () => { throw new TypeError('boom'); }, e => e instanceof TypeError)
      ).resolves.not.toThrow();
    });

    test('predicate expected: rejects when predicate returns falsy', async () => {
      await expect(
        proxy.throwsAsync(async () => { throw new Error('boom'); }, () => false)
      ).rejects.toThrow();
    });

    // Same predicate-masking quirk as the sync throws() case above (see note
    // there) — use a discriminating predicate.
    test('predicate expected: rejects when fn does not reject at all', async () => {
      await expect(proxy.throwsAsync(async () => {}, e => e instanceof TypeError)).rejects.toThrow();
    });
  });

  describe('doesNotThrowsAsync', () => {
    test('resolves when fn does not reject', async () => {
      await expect(proxy.doesNotThrowsAsync(async () => {})).resolves.not.toThrow();
    });

    test('rejects when fn rejects', async () => {
      await expect(proxy.doesNotThrowsAsync(async () => { throw new Error('boom'); }))
        .rejects.toThrow(/threw an error unexpectedly: boom/);
    });
  });

  describe('fail / ok / exception', () => {
    // Real Tinytest's fail() records and returns — see FIX 2 in the
    // tinytest-assertions.js header comment. Non-throwing is what lets
    // `test.fail(msg); onComplete();` (a common timeout/defensive idiom,
    // 44+ call sites across the packages surveyed by the Stage 2 campaign)
    // keep running instead of hanging on an uncaught exception.
    test('fail does not throw', () => {
      expect(() => proxy.fail('nope')).not.toThrow();
    });

    test('fail records a string message into _failures', () => {
      proxy.fail('nope');
      expect(proxy._failures).toEqual(['nope']);
    });

    test('fail accepts a doc object with a message and records it', () => {
      proxy.fail({ message: 'doc failure' });
      expect(proxy._failures).toEqual(['doc failure']);
    });

    test('a later fail() records again (accumulates)', () => {
      proxy.fail('first');
      proxy.fail('second');
      expect(proxy._failures).toEqual(['first', 'second']);
    });

    test('expect_fail() + fail() consumes the flag and records nothing', () => {
      proxy.expect_fail();
      proxy.fail('swallowed');
      expect(proxy._failures).toEqual([]);
    });

    test('after a swallowed fail(), the NEXT fail() records normally', () => {
      proxy.expect_fail();
      proxy.fail('swallowed');
      proxy.fail('recorded');
      expect(proxy._failures).toEqual(['recorded']);
    });

    test('ok never throws', () => {
      expect(() => proxy.ok()).not.toThrow();
    });

    test('exception rethrows the given error', () => {
      const err = new Error('rethrown');
      expect(() => proxy.exception(err)).toThrow('rethrown');
    });
  });

  describe('sleep', () => {
    test('resolves', async () => {
      await expect(proxy.sleep(1)).resolves.toBeUndefined();
    });

    test('resolves with no argument (defaults to 0ms)', async () => {
      await expect(proxy.sleep()).resolves.toBeUndefined();
    });
  });

  describe('extraDetails / runId / id', () => {
    test('extraDetails is present as an object', () => {
      expect(typeof proxy.extraDetails).toBe('object');
    });

    test('runId returns a string', () => {
      expect(typeof proxy.runId()).toBe('string');
    });

    test('id is present as a string property', () => {
      expect(typeof proxy.id).toBe('string');
    });

    // FIX 1: real Tinytest generates test.id ONCE per test run (Random.id()
    // in the TestCaseResults constructor) and runId() returns that same
    // value every time it's called — Tinytest-authored tests rely on both
    // reading test.id directly and calling test.runId() more than once and
    // getting the same answer back.
    test('runId() is stable across repeated calls', () => {
      const first = proxy.runId();
      const second = proxy.runId();
      expect(first).toBe(second);
    });

    test('proxy.id === proxy.runId()', () => {
      expect(proxy.id).toBe(proxy.runId());
    });

    test('id is distinct between two different proxies', () => {
      const other = makeTestProxy();
      expect(proxy.id).not.toBe(other.id);
    });
  });

  describe('expect_fail one-shot semantics', () => {
    test('a failure right after expect_fail() is swallowed (does not throw)', () => {
      proxy.expect_fail();
      expect(() => proxy.equal('a', 'b')).not.toThrow();
    });

    test('after a swallowed failure, the NEXT failing assertion rethrows normally', () => {
      proxy.expect_fail();
      proxy.equal('a', 'b'); // swallowed
      expect(() => proxy.equal('a', 'b')).toThrow();
    });

    test('a passing assertion right after expect_fail() disarms the flag', () => {
      proxy.expect_fail();
      proxy.equal('a', 'a'); // passes -> disarms
      expect(() => proxy.equal('a', 'b')).toThrow(); // no longer armed
    });

    test('expect_fail with no subsequent failure leaves the flag armed for the next call', () => {
      proxy.expect_fail();
      expect(() => proxy.isTrue(false)).not.toThrow();
    });

    test('works across different assertion methods (isTrue then equal)', () => {
      proxy.expect_fail();
      expect(() => proxy.isTrue(false)).not.toThrow(); // swallowed
      expect(() => proxy.equal(1, 2)).toThrow(); // armed already consumed, this rethrows
    });

    test('async path: throwsAsync failure is swallowed after expect_fail', async () => {
      proxy.expect_fail();
      await expect(proxy.throwsAsync(async () => {})).resolves.not.toThrow();
    });

    test('async path: next assertion after a swallowed async failure rethrows', async () => {
      proxy.expect_fail();
      await proxy.throwsAsync(async () => {}); // swallowed (fn didn't reject as expected)
      await expect(proxy.throwsAsync(async () => {})).rejects.toThrow();
    });

    test('a passing async assertion disarms the flag', async () => {
      proxy.expect_fail();
      await proxy.throwsAsync(async () => { throw new Error('x'); }); // passes -> disarms
      await expect(proxy.throwsAsync(async () => {})).rejects.toThrow();
    });
  });
});

describe('makeTestProxy with a Package.ejson global present', () => {
  const originalPackage = global.Package;

  afterEach(() => {
    global.Package = originalPackage;
  });

  test('equal uses EJSON.equals for non-string deep comparison when available', () => {
    let calledWith = null;
    global.Package = {
      ejson: {
        EJSON: {
          equals(a, b) {
            calledWith = [a, b];
            return true;
          },
        },
      },
    };
    const proxy = makeTestProxy();
    expect(() => proxy.equal({ a: 1 }, { totally: 'different' })).not.toThrow();
    expect(calledWith).toEqual([{ a: 1 }, { totally: 'different' }]);
  });

  test('notEqual uses EJSON.equals when available', () => {
    global.Package = {
      ejson: {
        EJSON: {
          equals: () => false,
        },
      },
    };
    const proxy = makeTestProxy();
    expect(() => proxy.notEqual({ a: 1 }, { a: 1 })).not.toThrow();
  });

  // Stage 2 campaign bug #4: the EJSON branch used to build its default
  // failure message EAGERLY (as an argument expression to assert.ok), so
  // JSON.stringify(actual)/JSON.stringify(expected) ran even on a PASSING
  // assertion. Circular structures made JSON.stringify throw
  // "Converting circular structure to JSON", turning a passing assertion
  // into a crash (2 real mongo test cases hit this: `collection - get
  // collection by name`, `CollectionExtensions - constructor extension`).
  test('equal on a PASSING circular-reference comparison does not throw (message must be lazy)', () => {
    global.Package = {
      ejson: {
        EJSON: {
          // Force the EJSON branch; same-reference circular objects are
          // "equal" by this stand-in comparator.
          equals: (a, b) => a === b,
        },
      },
    };
    const proxy = makeTestProxy();
    const circular = {};
    circular.self = circular;
    expect(() => proxy.equal(circular, circular)).not.toThrow();
  });

  test('equal on a FAILING circular-reference comparison fails safely (no JSON.stringify crash)', () => {
    global.Package = {
      ejson: {
        EJSON: {
          equals: () => false,
        },
      },
    };
    const proxy = makeTestProxy();
    const a = {};
    a.self = a;
    const b = {};
    b.self = b;
    let thrown;
    try {
      proxy.equal(a, b);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(thrown.name).not.toBe('TypeError');
    expect(thrown.message).toEqual(expect.stringMatching(/\[unprintable\]|\[object Object\]/));
  });
});
