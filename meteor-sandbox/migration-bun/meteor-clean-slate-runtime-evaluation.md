# Clean-Slate Server Runtime Evaluation — Fifth Pass

**Date:** 2026-03-29
**Author:** dupontbertrand (with Claude analysis)
**Status:** Architectural evaluation — legacy rescue vs new path
**Central question:** Should we continue modernizing the existing server runtime, or build a new one in parallel?

---

## 1. The Real Decision

The decision is NOT "should we rewrite Meteor?"

The decision is: **is the current Meteor server loading/boot/runtime model still the right foundation for the next 5 years, or has it become a weight that the team pays an ever-increasing price to maintain?**

To be precise, here is what is in question:

- 9 files in `tools/static-assets/server/` (boot.js, runtime.js, npm-require.js, server-json.js, mini-files.ts, boot-utils.js, debug.ts, npm-rebuild.js, npm-rebuild-args.js)
- The bundler's server output format (the way `bundler.js` generates main.js + program.json + wrapped package files)
- The loading model (JSON loop -> file read -> string wrapping -> vm.runInThisContext -> function call)
- The module model (Module.prototype patching + reify transforms on every require)

That's it. This is neither DDP, nor the accounts system, nor minimongo, nor Tracker, nor the CLI, nor isobuild.

The question is: are these ~1500 lines of runtime code + the bundler's output contract the right ground to build the future on, or should we lay a new one alongside?

---

## 2. What Must Absolutely Remain Meteor

| Domain | Must be preserved as core identity | Why |
|---|---|---|
| **DDP** | Yes | This is the protocol that defines Meteor. Data on the wire, not HTML on the wire. No other mainstream framework does this. |
| **Pub/sub** | Yes | The "server publishes, client subscribes reactively" model is the core of the Meteor DX. |
| **Methods** | Yes | RPC with return semantics, error handling and context. This is Meteor's server API. |
| **Optimistic UI / method stubs** | Yes | Core innovation. The client simulates, the server confirms or rolls back. No alternative is as integrated. |
| **Minimongo + Tracker** | Yes | The reactive client data store. This is what makes the Meteor client fundamentally different. |
| **Accounts system** | Yes | Unified API, pluggable strategies (password, OAuth), tokens, sessions. Extremely practical. |
| **Hot code push** | Yes | Update without full reload. Fundamental DX in dev, differentiator in production. |
| **Zero-config dev experience** | Yes (the experience, not the implementation) | `meteor create && meteor run` works immediately. This is a product promise. The *way* it's implemented (vendored dev bundle, etc.) is NOT sacred. |
| **Isomorphism** | Partially | The idea that the same package can have client and server code is useful. But the specific mechanism (api.addFiles with architectures) is an implementation detail. |
| **AsyncLocalStorage for DDP context** | Yes | This is the successor to Fibers. It's standard, supported everywhere, and it's the right choice. |

**Key point:** Everything in this table is Meteor application code (packages/). Nothing in this table depends on the boot/runtime/loading model. The server runtime is a *delivery mechanism* for these features, not the features themselves.

---

## 3. What Is Probably NOT Sacred

| Legacy server/runtime element | Why it's probably not sacred | Cost of preserving it | Cost of replacing it | Recommendation |
|---|---|---|---|---|
| **boot.js: JSON loop -> vm.runInThisContext** | It's a loading mechanism, not a feature. No user knows that their packages are wrapped in strings and eval'd via vm. | Medium: blocks portability, fragile, opaque to debug, depends on under-documented vm APIs | Low to medium: replacing with standard ESM imports or Function() is technically simple; the effort is in the bundler | **Replace** |
| **runtime.js: Module.prototype patching** | Depends on undocumented internal Node APIs (`_compile`, `_extensions`, `_resolveFilename`). This is the most fragile code in the runtime. | High: every Node version could break these APIs; other runtimes don't implement them; this is the most "magical" layer | Medium to high: removal requires the bundler to generate native ESM, which is a model change | **Replace as part of ESM transition** |
| **Reify in the server runtime** | Polyfill for ESM that is no longer needed since Node 22 supports ESM natively. Every server .js goes through a transformation pipeline. | Medium: parsing overhead on every load, complexity of the acorn+babel pipeline, dependency on @meteorjs/reify | High: reify is deeply integrated; removal requires a new loading model | **Gradually deprecate via native ESM** |
| **Npm.require internals** | Custom resolution that looks in multiple node_modules. Duplicates what require/import does natively. | Low: works but adds a layer of indirection | Low: can be simplified internally without changing the API | **Simplify internally, keep the API** |
| **Server bundle entry format** | main.js (6 lines CJS) -> runtime.js -> boot.js -> vm-eval loop. Meteor-specific format that only Meteor understands. | Medium: all deployment tooling must know this format; it's an obstacle for standard hosting providers | Medium to high: changing the format impacts Galaxy, Docker, deploy scripts | **Create a new opt-in format** |
| **source-map-support** | V8-specific monkey-patch (`Error.prepareStackTrace`). Doesn't work on Bun (JSC). Node has `--enable-source-maps` since v12. | Low: one more dependency, one more monkey-patch | Low: near-direct replacement with the native flag | **Replace** |
| **Shell-server** | REPL via Unix socket. Coupled to `net` + `repl`. Almost nobody uses it in production. | Negligible: it works | Negligible: extract into optional package | **Make optional** |
| **Dev-bundle assumptions in production thinking** | The dev bundle is a dev tool, but some assumptions (paths, npm resolution) leak into the production runtime. | Low but chronic: creates confusion between dev and prod | Medium: clean up path assumptions in the production bundle | **Decouple dev and prod** |
| **Implicit globals** | `Package`, `__meteor_bootstrap__`, `__meteor_runtime_config__`. Inter-package communication via mutable global objects. | Low short-term, high long-term: prevents isolation, tree-shaking, and standard tooling | Medium to high: moving to explicit imports requires a change in the package model | **Replace as part of the new model** |

---

## 4. Comparison of the Three Options

| | Option A: Modernize the legacy | Option B: New parallel path | Option C: Complete rewrite |
|---|---|---|---|
| **Short description** | Continue patching boot.js, runtime.js, add guards, replace vm with Function(), keep the loading model | Build a new ESM boot/runtime path alongside the legacy, opt-in experimental, compare, then decide | Rewrite Meteor from scratch |
| **Benefits** | Low risk, continuous progress, no breakage | Clean architecture, no inherited debt, native portability, can coexist with the legacy | Clean slate, ideal architecture |
| **Costs** | Every patch adds complexity to the legacy; the fundamental model (vm-eval + Module patching) remains; gains are asymptotic | Initial prototyping effort; temporary dual path; risk of never finishing | Enormous: person-years; loss of the ecosystem; relearning all the subtleties |
| **Risks** | Death by a thousand patches — the runtime becomes a layer cake of guards and fallbacks without cohesion | The prototype stalls; nobody opts in; wasted effort | No team has the resources; the ecosystem dies during the rewrite; the result is worse than the original |
| **Horizon** | Continuous, no end | 6-12 months for the prototype, 12-24 months for the transition | 2-4 years minimum |
| **Strategic advantage** | Stability, continuity, ecosystem trust | Possibility to skip a technical generation; Bun/Deno support "for free"; architecture that ages well | Ideal architecture (in theory) |
| **Strategic disadvantage** | The fundamental model remains fragile; gains diminish over time; debt remains | Temporary complexity of the dual path; risk of abandonment | Project suicide. Software history is paved with rewrites that killed the product. |

---

## 5. Is the Legacy Runtime Still Worth Saving?

### Subsystem-by-Subsystem Evaluation

**boot.js** — *Salvageable but increasingly less cost-effective.*
boot.js does three things: (1) read the configuration, (2) install source maps, (3) loop over server files and execute them via vm. Parts (1) and (2) are trivial. Part (3) — the vm-eval loop — is the problem. It's functional but it's not a good foundation: it's opaque, non-standard, and it forces every future improvement through the bottleneck of `vm.runInThisContext`. Patching it (Function fallback) is easy and useful. But every additional patch is a band-aid on a model that isn't the right one.

**runtime.js** — *The most fragile subsystem.*
runtime.js exists for one reason only: to make reify functional by patching Module internals. If reify were no longer needed (because the bundler generates native ESM), runtime.js would be deleted entirely. There is nothing in runtime.js worth preserving independently of reify. It's scaffolding for a polyfill.

**vm.runInThisContext** — *Not a foundation, it's a historical hack.*
vm is used neither for sandboxing nor for isolation. It is used solely for two things: (1) executing code with an associated filename (for stack traces), and (2) injecting symbols (`Npm`, `Assets`). Reason (1) is solved by `//# sourceURL=`. Reason (2) is solved by module imports. vm provides nothing that standard mechanisms don't already provide.

**Module.prototype patching** — *Not viable long-term.*
`Module._compile`, `Module._extensions`, `Module._resolveFilename` are not public APIs. They are not part of Node's stability contract. Every major Node version could modify or remove them. And they are explicitly unsupported on Bun and partially on Deno. Building on these APIs is building on sand.

**Reify** — *A polyfill that has outlived its usefulness.*
Reify was brilliant when Node didn't have ESM. Now it's a transformation pipeline (acorn parse + babel fallback) that runs on every server `require()`, depends on Module.prototype patching, and is the reason runtime.js exists. Its removal is the keystone of modernization. But it requires the bundler to generate native ESM.

**The bundle contract** — *Functional but specific.*
The star.json + program.json + wrapped package files format is a proprietary format. It works, but it means deploying Meteor requires knowing that it's Meteor. A bundle format that looks like a standard JS app would be more portable and more understandable.

**The server loading model** — *The real issue.*
The current model is: "the bundler generates CJS package files wrapped in closures -> boot.js reads them from disk -> wraps them in function strings -> evals them via vm -> calls them with injected arguments." Every step in this chain is a 2012 choice that made sense at the time and no longer does today. The alternative model is: "the bundler generates standard ESM modules -> the runtime imports them -> each module manages its own dependencies via import." It's simpler, more standard, more portable, and more debuggable.

### Verdict

The legacy runtime is **salvageable but not the right foundation.** The Layer A patches (Function fallback, source maps, cluster, guards) are useful and immediate. But they don't change the fact that the underlying model (vm-eval + Module patching + reify) is an assembly of historical hacks.

The question is not "does it work?" — it works. The question is "is it the right base to invest developer time in for the next 5 years?" And the answer is: **probably not.**

The cost of preservation is not that of individual patches. It's the opportunity cost: every hour spent making the vm-eval model slightly more resilient is an hour not spent building the model that would make all of this unnecessary.

---

## 6. Smallest Viable Clean-Slate Runtime

Here is the minimal design of a new server runtime that would remain 100% Meteor, but without legacy baggage.

### Runtime Entry Point

```javascript
// programs/server/index.mjs
// Generated by the bundler. Not hand-written.

// Meteor configuration
import { config } from './meteor-config.mjs';
globalThis.__meteor_runtime_config__ = config;

// Async context
import { AsyncLocalStorage } from 'node:async_hooks';
globalThis.__METEOR_ASYNC_LOCAL_STORAGE = new AsyncLocalStorage();

// Meteor packages in dependency order
// Each package is a real ESM module with its own imports
import './packages/meteor.mjs';
import './packages/ddp-server.mjs';
import './packages/mongo.mjs';
import './packages/accounts-base.mjs';
import './packages/webapp.mjs';
// ... other packages in dependency order

// Application code
import './app/server/main.mjs';

// Startup
const { startupHooks } = await import('./packages/meteor.mjs');
for (const hook of startupHooks) {
  await hook();
}
```

### Module Loading Model

**No vm.** No Module.prototype patching. No reify. Packages are standard ESM modules that any JS runtime can import.

The bundler generates each package as a standalone `.mjs` file:

```javascript
// programs/server/packages/webapp.mjs
// Generated by the bundler from packages/webapp/

import { createServer } from 'node:http';
import express from 'express';
import { Meteor } from './meteor.mjs';
// ... rest of webapp code

// Exports for other packages
export const WebApp = { /* ... */ };
export const WebAppInternals = { /* ... */ };

// Register in the global package registry
// (legacy compatibility — removable later)
globalThis.Package = globalThis.Package || {};
globalThis.Package.webapp = { WebApp, WebAppInternals };
```

### Package Loading Model

The loading order is encoded as module imports, not as a JSON manifest. The bundler resolves the dependency order at compile time and generates the imports in the correct order in `index.mjs`.

**Npm.require**: in ESM mode, `Npm.require(name)` is reimplemented as:

```javascript
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export function npmRequire(name) {
  return require(name);
}
```

**Assets**: assets are accessible via a standard Meteor module:

```javascript
import { getAsset } from './meteor-assets.mjs';
const text = await getAsset('private/data.json', 'utf8');
```

### How DDP/pub-sub/methods Integrate

Exactly as today. DDP, publications and methods are application code in the `ddp-server`, `livedata`, etc. packages. They have no dependency on the loading model. They import `WebApp` to get the HTTP server, and `mongo` to access the database. Nothing changes in their internal logic.

### How Meteor-Specific Server Features Are Initialized

The `__meteor_bootstrap__.startupHooks` pattern is replaced by an export/import mechanism:

```javascript
// packages/meteor.mjs
export const startupHooks = [];
export function startup(fn) {
  if (startupHooks === null) {
    // After boot: call immediately
    fn();
  } else {
    startupHooks.push(fn);
  }
}
```

### npm/Package Interop

npm dependencies are in a standard `node_modules` in the output directory. `import` and `require` (via `createRequire`) work normally. No custom resolution. No npm-require.js.

### Source Maps / Debugging

Each generated `.mjs` file includes a `//# sourceMappingURL=` comment. The runtime uses `--enable-source-maps` (Node) or native support (Bun/Deno). No dependency on `source-map-support`. No monkey-patching.

### Build Output

```
bundle/
├── index.mjs                    # Entry point (generated)
├── meteor-config.mjs            # Configuration (generated from config.json)
├── meteor-assets.mjs            # Assets API (generated)
├── packages/
│   ├── meteor.mjs
│   ├── ddp-server.mjs
│   ├── mongo.mjs
│   ├── webapp.mjs
│   └── ... (one .mjs per package)
├── app/
│   └── server/
│       └── main.mjs             # Application code
├── node_modules/                # Standard npm dependencies
├── package.json                 # {"type": "module"}
└── star.json                    # Metadata (legacy compatibility)
```

Startup: `node index.mjs` or `bun index.mjs` or `deno run --allow-all index.mjs`.

### What Remains Compatible with the Legacy

- `globalThis.Package` is still populated (for compat with code that does `Package.meteor.Meteor`)
- `Npm.require` still works (reimplemented on `createRequire`)
- `Assets.getTextAsync` / `Assets.getBinaryAsync` still work (reimplemented as module)
- `Meteor.startup` still works
- Application code (methods, publications, startup) does not change

### What Does NOT Remain Compatible

- The program.json / server-json.js format no longer exists
- boot.js / runtime.js / npm-require.js no longer exist
- Code no longer goes through vm.runInThisContext
- Code no longer goes through reify
- Module.prototype is not patched
- `source-map-support` is not loaded

---

## 7. What This New Path Deliberately Refuses to Carry Forward

1. **Package execution via vm.runInThisContext.** Packages are modules, not eval'd strings. Period.

2. **Module.prototype monkey-patching.** The runtime's module system is used as-is. No undocumented internal API is patched.

3. **Reify as a required runtime layer.** The ESM->CJS transformation is done at compile time (in the bundler), not at runtime. Output files are native ESM.

4. **Implicit globals as the primary communication mechanism.** `globalThis.Package` is kept as a compatibility bridge, but inter-package imports are explicit ESM imports. Eventually, the global registry can be removed.

5. **JSON-driven loading loop.** The loading order is structurally encoded in the imports of the `index.mjs` file, not in a JSON manifest read at runtime.

6. **source-map-support and Error.prepareStackTrace.** Source maps use the runtime's native mechanism.

7. **npm-require.js with its custom resolution.** npm imports use standard module resolution.

8. **Process assumptions in boot.** No parent PID polling. No semver version barrier. No debugger wait loop. These concerns are handled outside the runtime (in the invocation script or in the dev server).

---

## 8. Migration Realism

### Coexistence with the Legacy Path

**Yes, it's possible and it's even the only viable approach.** The new path is generated by a bundler flag (`meteor build --format=esm`). The old format remains the default. The two can coexist indefinitely.

### Opt-in Boundary

The opt-in is at the `meteor build` level, not at the app level. A developer who runs `meteor build --format=esm` gets the new format. A developer who runs `meteor build` (without flag) gets the old format. Nothing changes in the application code.

### Dual Format Period

**Acceptable for 2-3 major versions.** Precedent: Meteor has already had similar transitions (Fibers -> async/await, which coexisted during the Meteor 3 beta). The pattern is: old format as default -> new format as option -> new format as default -> old format as `--format=legacy` -> old format retired.

### Migration Burden for Users

**Near zero for application code.** Methods, publications, startup hooks, package imports — all of this works identically. The only change is the build command and the output format.

**Low for deployment.** The startup script changes from `node main.js` to `node index.mjs` (or `bun index.mjs`). Environment variables (`MONGO_URL`, `ROOT_URL`, `PORT`) remain the same.

**Moderate for Atmosphere package authors.** Packages that use only `import`/`export` and `Npm.require` work without change. Packages that depend on implicit `require`, direct `global.Package` or non-standard CJS patterns might need adjustments.

### Realistic Coexistence Duration

2-3 years. Long enough for the ecosystem to migrate. Short enough to avoid the maintenance cost of the dual path.

---

## 9. Cost Comparison: Legacy Rescue vs Clean Path

| Domain | If we continue modernizing the legacy | If we build a new parallel path | Cheaper long-term? | Cheaper short-term? |
|---|---|---|---|---|
| **Boot/runtime loading** | Incremental patches: Function fallback, guards, every improvement is a special case added to existing code. Cumulative cost growing. | A single clean design: generated index.mjs with imports. No guards, no fallbacks, no vm. Moderate initial cost then near-zero. | **New path** | Legacy (patches are quick) |
| **Module system** | Keep reify + Module patching + defensive guards. Every Node version is a regression risk. Test Module._extensions compat on every upgrade. | Native ESM. Zero patching. Works on Node, Bun, Deno without effort. | **New path** (clearly) | Legacy |
| **Source maps / debugging** | Migrate from source-map-support to --enable-source-maps (easy in both cases). | Same source maps, no source-map-support. | Equivalent | Equivalent |
| **Native addons** | Same problem in both cases: node-gyp/WASM is a question orthogonal to the loading model. | Same. | Equivalent | Equivalent |
| **Runtime portability** | Every alternative runtime requires an audit of guards and fallbacks. Bun: does vm work? Is Module._extensions a no-op? Deno: is CJS detected? Dozens of questions per runtime. | A standard ESM bundle works on any runtime that supports ESM (= all of them). Zero questions per runtime. | **New path** (massively) | Legacy |
| **Bundle format** | The current format remains. All deployment tooling must know it. | A standard format: package.json + index.mjs + node_modules. All standard tooling already understands it. | **New path** | Legacy (no change) |
| **Mental complexity for contributors** | The runtime is a layer cake: boot.js + runtime.js + npm-require.js + server-json.js + vm semantics + Module internals + reify pipeline. Understanding how the server starts requires understanding 6 interdependent layers. | The runtime is a generated `index.mjs` file with imports. Understanding startup requires reading one file. | **New path** (massively) | Legacy (familiarity) |
| **Maintenance over 2-3 years** | Every Node/npm version is a risk for Module._extensions and reify. Every Bun/Deno version is a compat audit. Regression tests accumulate. | ESM modules are an ECMA standard. The probability of regression between runtime versions is near zero. | **New path** | Legacy |

**Summary:** The legacy is cheaper short-term for each individual patch. But the new path is cheaper long-term for nearly all domains. The tipping point is probably around 6-12 months: beyond that, the cumulative costs of the legacy exceed the initial investment of the new path.

---

## 10. Best Case / Worst Case for Option B

### Best Case

The `meteor build --format=esm` prototype works in 4-6 weeks. It produces a bundle that starts under Node, Bun and Deno without modification. Early adopters try it and report that it's simpler to deploy, faster to start, and easier to debug. The Atmosphere ecosystem gradually migrates its active packages (most work without change because they already use `import`/`export`). After 2-3 versions, the ESM format becomes the default. The legacy is kept as `--format=legacy` for compatibility. The team saves dozens of hours of vm/reify/Module maintenance every year.

### Worst Case

The prototype reveals deep incompatibilities: some Atmosphere packages use implicit CJS patterns (require without import, dependency on loading order via side effects, access to `global.Package` before the package is loaded). The compatibility work stretches out. The new format is more complex than expected to generate in the bundler. The dual path becomes a maintenance burden. The prototype stalls and ends up abandoned, leaving dead code in the bundler.

### Warning Signs

1. **The prototype can't boot a trivial app within 2 weeks.** If the bundler's ESM generation is more complex than expected, it's a signal that the problem is in isobuild, not in the runtime.

2. **More than 10% of active Atmosphere packages break.** If the majority of the ecosystem depends on implicit CJS patterns, the migration cost is too high.

3. **The dual path generates production bugs.** If users encounter subtle bugs because they don't know which format they're using, the coexistence becomes toxic.

4. **The team can't maintain both paths.** If the maintenance cost of the dual path exceeds the savings of the new path, it's a failure.

5. **The new path does NOT work better than the patched legacy.** If after prototyping, the new path isn't significantly simpler, faster or more portable, it's not solving the right problem.

---

## 11. Recommendation

### Is "from scratch" a bad instinct here, or a meaningful signal?

**It's a meaningful signal.** The "from scratch" instinct comes from the fact that the current model (vm-eval + Module patching + reify) isn't a model — it's an assembly of workarounds accumulated over 14 years. Each layer was added to solve a specific problem of its era (no ES modules -> reify; no scope isolation -> vm; no interceptable require -> Module patching). These problems have been solved for years by the language and the runtimes themselves. The "from scratch" instinct says: "stop patching the workarounds and use the solutions."

This instinct is correct, but it must be contained: "from scratch" for the server runtime (9 files, ~1500 lines, + the bundler's output format). Not "from scratch" for Meteor.

### What Is the Right Strategy?

**Start the parallel path (Option B) after finishing the Layer A patches.**

The order is:
1. **Now:** finish the 5 Layer A changes (Function fallback, source maps, cluster, version check, runtime.js guards). This takes 2-4 weeks and immediately improves the legacy.
2. **Then:** prototype `meteor build --format=esm`. This takes 4-8 weeks of focused work. The prototype doesn't need to be perfect — it needs to answer the question "does this work for a realistic app?"
3. **Decision:** if the prototype works, we stabilize it and propose it as opt-in. Otherwise, we continue with the patched legacy (which will already be more solid thanks to Layer A).

### What Would Be the Most Reasonable First Prototype?

A script in `tools/isobuild/` that, for an already-built bundle in legacy format, regenerates the server files in ESM format:
- Reads program.json
- For each package file, generates an equivalent `.mjs` (removes the closure wrapping, converts `Npm.require` to `createRequire`, adds exports)
- Generates `index.mjs` with imports in the correct order
- Generates `package.json` with `"type": "module"`

This script is a conversion tool, not a bundler change. It allows testing the ESM format without touching isobuild.

### What Should Definitely NOT Be Rewritten?

- **DDP / livedata** — works well, no significant debt
- **Minimongo** — client code, not affected
- **Tracker** — client code, not affected
- **Accounts** — clean API, well-structured code
- **Isobuild** — complex but functional; modifying it to generate ESM is different from rewriting it
- **The CLI / tools/** — stays on Node, not affected by the server runtime

### What Should Stop Being Treated as Untouchable?

- **boot.js** — it's a startup script, not a feature. It can be replaced.
- **runtime.js** — it's scaffolding for reify. If reify is no longer needed, runtime.js has no reason to exist.
- **The bundler's server output format** — it's a build artifact. It can change without the app source code changing.
- **The assumption that the Meteor server needs a custom loading model** — this was true in 2012. It no longer is.

---

## 12. Final Summary in Simple Terms

We are not talking about rewriting Meteor.

We are talking about **replacing the server's startup and loading mechanism** — 9 files, about 1500 lines of code, and the way the bundler generates server output — with something simpler and more standard.

Meteor's application code (DDP, methods, publications, accounts, reactivity, minimongo, hot code push) does not change. Meteor package code does not change. The developer experience does not change.

What changes is that the Meteor server starts like any other modern JavaScript application: an entry file that imports modules. No vm. No monkey-patching. No transformation pipeline on every require. No proprietary format that only Meteor understands.

This is the kind of change that is invisible to 95% of users, but that determines whether Meteor is easy or hard to maintain, debug and evolve over the next 5 years.
