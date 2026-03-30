# Appendix — Testing Implications of an ESM Server Bundle

**Status:** Strategic note — potential consequence of the ESM bundle, not an immediate workstream.
**Prerequisite:** The ESM prototype works (`meteor build --format=esm` produces importable modules).

---

## If the ESM bundle works, testing gets simpler

Truly importable server modules make the following possible:

- **Server unit tests with `bun:test` / `node:test`** — import a method, call it, assert. No need to start a full Meteor server to test a function.
- **Less dependency on Tinytest / test drivers** — the test runner is the runtime itself, not a Meteor package.
- **Clearer unit / integration / e2e separation** — unit = direct import, integration = server started, e2e = Playwright.

```js
// Example: unit test of a method (only possible with importable ESM modules)
import { test, expect } from 'bun:test';
import { createTask } from '../imports/methods/tasks.mjs';

test('createTask validates text', () => {
  expect(() => createTask({ text: '' })).toThrow();
  expect(() => createTask({ text: 'Hello' })).not.toThrow();
});
```

## What would still be necessary

- **Playwright** for real browser tests (happy-dom/jsdom don't cover everything)
- **Integration tests with a running server** for DDP / publications / auth flows
- **Bootstrap/context helpers** for tests that need a user context, a DDP invocation context, or a test database — "less need to start all of Meteor" does not mean "never need to again"
- **Client reactivity tests** — even with a pluggable store, change propagation and client-side effects must be tested

## What could be challenged later

| Current component | Why challenge it | Possible replacement |
|---|---|---|
| Tinytest | Custom test framework from 2012 | `bun:test` / `node:test` / Vitest |
| Test drivers (packages) | Bridge Tinytest to browser, unnecessary complexity | Playwright direct |
| `meteor test-packages` | Starts a full server for unit testing | Direct import + native runner |

## What doesn't change

- E2E = Playwright (not Meteor-specific, no change)
- Integration tests = server + DDP client (the protocol doesn't change)
- CI = same matrix, just the runner changes

## Dependency

All of this is conditional on the success of the ESM prototype. If the ESM bundle doesn't produce importable modules, this vision remains hypothetical.
