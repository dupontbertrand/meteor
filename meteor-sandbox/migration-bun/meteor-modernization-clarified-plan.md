# Clarified Modernization Plan — Fourth Pass

**Date:** 2026-03-29
**Author:** dupontbertrand (with Claude analysis)
**Status:** Operational clarification of previous passes
**Objective:** Transform directional recommendations into a sequenceable and discussable plan

---

## 1. Clarified Thesis

The modernization thesis remains the same in its direction. But it deserves to be broken down into three levels of certainty:

### What is a direction of travel (strategic heading)
Meteor should, over time, reduce its dependence on undocumented Node internals (`vm`, `Module.prototype`, `_compile`, `_extensions`) and migrate toward standard language mechanisms (ESM, `Function()`, public APIs). This heading is valid regardless of Bun/Deno, because it makes Meteor simpler, more debuggable and more maintainable on Node itself.

### What is an implementation recommendation (actionable now or soon)
Certain changes are feasible today with manageable risk: making `vm.runInThisContext` optional in boot.js, making the `cluster` import conditional, using `--enable-source-maps` instead of `source-map-support`. These are cleanups that don't require deciding the future of the loading model.

### What is only a possible future target (not a commitment)
Completely replacing reify with native ESM, removing the vendored dev bundle, producing a "lean" bundle format without boot.js — these are architectural targets that deserve to be explored but require design work, prototyping and consensus before being committed to. Presenting them as decisions already made would be premature.

**The important distinction:** pass 3 was right about the "what" but was too abrupt on the "when" and "how". Modernization is a gradient, not a switch.

---

## 2. Architectural Debt vs Cleanup vs Model Change

| Subject | Category | Why | User-visible? | Changeable incrementally? | Requires a migration plan? |
|---|---|---|---|---|---|
| **boot.js usage of vm** | Architectural debt | `vm.runInThisContext` is a non-standard loading mechanism that blocks portability | No | Yes — `Function()` fallback is a one-line change | No |
| **runtime.js / Module.prototype patching** | Architectural debt | Depends on undocumented internal Node APIs (`_compile`, `_extensions`, `_resolveFilename`) | No | Partially — patching can be kept (guarded) but not removed without changing the loading model | Yes if you want to remove it completely |
| **Reify** | Transitional compatibility layer | ESM->CJS polyfill that has outlived its usefulness, but is deeply integrated | No (as long as `import`/`export` work) | No — removing reify requires the bundler to generate native ESM | Yes — it's a model change disguised as a cleanup |
| **Source maps** | Tactical cleanup | `source-map-support` + `Error.prepareStackTrace` is V8-specific; Node has `--enable-source-maps` since v12 | No (stack traces change slightly in format) | Yes | No |
| **Import cluster** | Tactical cleanup | Module-level import but only used in a conditional block for Unix sockets | No | Yes — make the import lazy/conditional | No |
| **Shell-server** | Optional subsystem | Coupled to `net` + `repl`; not used in production by most apps | No (except for `meteor shell` users) | Yes — can be isolated into an optional package | No |
| **Vendored Node / dev bundle** | Model change | Vendoring solves a real problem (consistency), but with disproportionate cost | Yes (workflow change from `meteor npm` to `npm`) | No — deeply integrated into the CLI, bootstrap and release engineering | Yes — multi-phase, multi-year |
| **Npm.require** | Transitional compatibility layer | Custom indirection on top of `require`; works but duplicates standard behavior | No (API internal to Meteor packages) | Yes — can be reimplemented as a simple re-export of `require` | No for simplification; yes for removal |
| **Npm.depends** | Transitional compatibility layer | npm dependency declaration in package.js; existed before package-lock | Yes (Meteor package authors) | Partially — can coexist with package.json | Yes — impacts the Atmosphere ecosystem |
| **Native addons** | Architectural debt + cleanup | node-gyp bundled in the bundle; npm-rebuild.js at deploy; recurring source of failures | No (if packages work) | Yes — evaluate WASM alternatives on a case-by-case basis | No for evaluation; yes for a systematic change |
| **Bundle output format** | Model change | The current format (boot.js + program.json + vm-eval) is Meteor-specific | Yes (deployment tooling, Galaxy, Docker) | Partially — a new format can be added without removing the old one | Yes |
| **ESM transition** | Model change | Moving the server from CJS+reify to native ESM is the most structural change | No if done well (packages already write `import`/`export`) | No — requires changes in the bundler and the runtime | Yes — this is the core of the matter |

---

## 3. "Remove" vs "Phase Out" vs "Abstract" — Corrections

| Subject | Previous direction | Refined direction | Why this refinement is more realistic |
|---|---|---|---|
| **Reify** | "Remove — replace with native ESM" | **Gradually deprecate** — first make the bundler work in optional ESM mode, then migrate packages one by one, then remove reify when it has no more consumers | Reify is not just a file to delete. It's the mechanism by which all Meteor server packages are loaded. Removing it requires the bundler to produce valid ESM, the package ecosystem to be compatible, and the loading model to be rethought. It's a multi-version process, not a patch. |
| **Vendored Node / dev bundle** | "Redesign — stop vendoring" | **Isolate then make optional** — first abstract access to the Node binary behind an interface (env var, config), then offer a "bring your own runtime" mode as an experimental option, then deprecate vendoring if the option stabilizes | The dev bundle solves a real problem for beginners and heterogeneous teams. Removing it without offering an equally simple alternative would create friction. The gradual approach: support both, then let the market decide. |
| **Npm.require** | "Redesign — replace with standard `import`" | **Shrink then abstract** — simplify the internal implementation (it's already a wrapper around `require`), then in a future ESM mode, reimplement it as `createRequire()`; keep the `Npm.require()` API as a compatibility facade for as long as needed | `Npm.require` is a documented API used by hundreds of Atmosphere packages. Removing it would break the ecosystem. Simplifying it internally breaks nothing. |
| **Npm.depends** | "Redesign — migrate to package.json" | **Coexistence** — support `Npm.depends` and `package.json` in package.js, recommending package.json for new packages; `Npm.depends` remains functional indefinitely | `Npm.depends` is used in all existing Atmosphere packages. Deprecating it would create noise without immediate value. Coexistence is free. |
| **source-map-support** | "Remove — use native" | **Replace** — it's indeed a replacement, not a bare removal. Ensure that `--enable-source-maps` or `//# sourceMappingURL=` produce stack traces of equivalent quality before removing the old one | The risk is low but not zero. Some edge cases (generated code, third-party source maps) might behave differently. Validate first. |
| **Shell-server** | "Remove" | **Make optional** — extract into a `meteor/shell-server` package that is included by default in new projects but can be removed; no longer load it if the package is not present | "Remove" is too strong. Some developers use it in dev. Making it optional achieves the same goal (no more `net`/`repl` coupling in the core) without breaking anything. |
| **Semver version barrier** | "Remove" | **Make configurable** — add `METEOR_SKIP_VERSION_CHECK=1` as an env var; keep the check as default for the safety of users who accidentally deploy with a Node version that's too old | The check protects beginners. Making it bypassable is sufficient for advanced use cases (Bun, Deno, custom Node versions). |
| **Dev-bundle / runtime ownership** | "Redesign — let the user bring their own runtime" | **Two-speed strategy** — keep the dev bundle as default for `meteor run` (zero-config experience); for `meteor build`, the output bundle should NOT depend on the dev bundle; for production, document and support "bring your own Node/Bun/Deno" | The dev bundle is a DX tool for development. The production bundle is a deployment artifact. They don't need the same treatment. |

---

## 4. Sequencing: What Comes First, What Comes Later

### Layer A — Safe Cleanup and Decoupling (now)

**Objectives:** Reduce the most fragile runtime surfaces without changing the loading model. Each change is useful even if Meteor stays on Node 100%.

**Concrete examples:**
1. Make `vm.runInThisContext` optional in boot.js (fallback `Function()` + `//# sourceURL=`)
2. Replace `source-map-support` with `--enable-source-maps` (add the flag in the boot script)
3. Make the `cluster` import conditional in webapp (lazy require inside the `if (unixSocketPath)` block)
4. Add `METEOR_SKIP_VERSION_CHECK=1` to bypass the boot.js semver check
5. Isolate shell-server: ensure it fails gracefully if unavailable

**Expected risk:** Low. These are internal changes that don't modify observable behavior for applications.

**User migration required:** No.

---

### Layer B — Runtime Decoupling (3-6 months)

**Objectives:** Make the production bundle less dependent on Node internals, without yet changing the loading model (boot.js continues to loop on serverJson.load, but without vm or Module patching).

**Concrete examples:**
1. Guard the Module.prototype patching in runtime.js: detect if `Module._extensions` is functional before patching; otherwise, use a fallback (inline reify without cache)
2. Make the runtime binary configurable: `METEOR_SERVER_RUNTIME=bun` or `METEOR_SERVER_RUNTIME=/usr/local/bin/bun` in run-app.js instead of hardcoded `process.execPath`
3. Evaluate and propose WASM alternatives for bcrypt (the biggest native addon in the Meteor ecosystem)
4. Abstract HTTP server creation in webapp: extract `http.createServer(app)` into a replaceable function
5. Document the production bundle's runtime assumptions (which Node modules are required, which minimum version)

**Expected risk:** Medium. The runtime.js guard is the most delicate: you need to ensure the fallback doesn't silently break module loading. Requires solid tests.

**User migration required:** No for internal changes. The runtime assumptions documentation is informational.

---

### Layer C — Model Evolution (6-18 months, if decided)

**Objectives:** Change the way the bundler generates server code and how the server loads packages. This is the territory of Candidate A ("ESM Boot") or Candidate C ("Lean Bundle").

**Concrete examples:**
1. Experimental ESM mode in the bundler: generate `programs/server/index.mjs` that imports each package as a real ESM module, in parallel with the existing boot.js
2. New opt-in bundle format: `meteor build --format=esm` produces a bundle without boot.js/runtime.js/npm-require.js
3. Progressive reify migration: packages that use only standard ESM are loaded natively; legacy packages continue via reify
4. Reimplementation of `Npm.require` as a facade on `createRequire()` in ESM mode
5. "Bring your own runtime" mode for the production bundle

**Expected risk:** High. Every change in Layer C touches the bundler, the output format and potentially the deployment contract. Requires an RFC, prototyping and core team consensus.

**User migration required:** Yes, but only for users who opt in to the new mode. The legacy mode remains available during the transition.

---

## 5. Where Coexistence Is Acceptable

### boot.js: old path (vm) + new path (Function)
**Acceptable:** Yes, and desirable as a first step.
**Duration:** 1-2 major versions. The new path becomes the default, the old is kept as a configurable fallback.
**Why:** The change is invisible to users. The fallback ensures no edge case breaks silently.
**Danger:** Near zero. This isn't a complex "dual path" — it's a try/catch.

### Reify + native ESM
**Acceptable:** Yes, and probably necessary for 2-4 versions.
**Duration:** Until the bundler generates native ESM by default and the Atmosphere ecosystem has migrated its active packages.
**Why:** Reify cannot be removed as long as all server packages are not loaded via native ESM. Coexistence allows a progressive migration.
**Danger:** The real danger is never finishing the migration — keeping reify "just in case" indefinitely. Setting a deprecation date (even a distant one) is important to avoid inertia.

### Vendored runtime + bring-your-own
**Acceptable:** Yes, indefinitely.
**Duration:** As long as Meteor exists. Vendoring is a convenience, not an obligation.
**Why:** Beginners want zero-config. Advanced teams want to choose their runtime. Both are valid use cases.
**Danger:** None, as long as the production bundle doesn't depend on the vendored dev bundle (which is already not the case today).

### Old bundle format + new bundle format
**Acceptable:** Yes, during a transition phase.
**Duration:** 2-3 major versions. The new format becomes the default, the old is maintained as `--format=legacy`.
**Why:** The bundle format is the most ecosystem-sensitive surface (Galaxy, Docker, deploy scripts). Forcing a change without transition would be irresponsible.
**Danger:** The danger is maintaining two formats indefinitely, which doubles test and maintenance costs. There must be an end date.

### Npm.depends + package.json
**Acceptable:** Yes, indefinitely.
**Duration:** No end date necessary. Coexistence is free.
**Why:** `Npm.depends` works and costs nothing to maintain. Forcing it to disappear would only bring friction for existing package authors.
**Danger:** None.

---

## 6. What Is Invisible to Users and Therefore Easier to Modernize

| Subsystem / change | Invisible to users? | Ecosystem sensitivity | Why it is (or isn't) a good target for early modernization |
|---|---|---|---|
| **vm.runInThisContext -> Function() in boot.js** | Yes (except slightly different stack traces) | None | **Excellent target.** Pure internal change. No API affected. |
| **source-map-support -> --enable-source-maps** | Nearly yes (slightly different stack trace format) | None | **Good target.** The only risk is a slight change in stack trace format in logs. |
| **Conditional cluster import** | Yes | None | **Trivial target.** No user depends on the module-level import. |
| **Guard Module.prototype patching** | Yes (as long as behavior is identical) | None | **Good but delicate target.** The guard must be invisible; if it changes loading behavior, it's a bug. |
| **Configurable runtime binary** | Yes (new option, no change to default) | Low | **Good target.** Adding an option breaks nothing. |
| **Internal simplification of Npm.require** | Yes | None | **Good target.** The public API doesn't change, only the internal implementation is cleaned up. |
| **Bundler generates ESM** | Yes if done well (packages already write `import`/`export`) | Moderate (packages that depend on `require()` in CJS) | **Important but not early target.** Requires prototyping and validation. |
| **Removal of reify** | Yes if preceded by ESM transition | High (entire package ecosystem) | **Not an early target.** It's the consequence of ESM transition, not a prerequisite. |
| **Removal of vendored dev bundle** | No — changes the `meteor npm` and `meteor node` workflow | Very high | **Not an early target.** Touches fundamental DX. |
| **New bundle format** | Yes for apps, no for deployment tooling | High (Galaxy, Docker, deploy scripts) | **Layer C target.** Requires a transition with opt-in. |
| **Making shell-server optional** | Low (only `meteor shell` users affected) | Low | **Good target.** Almost nobody uses `meteor shell` in production. |

---

## 7. Political / Ecosystem Sensitivity

### Low controversy
- **vm.runInThisContext fallback** — Purely internal change. Nobody knows Meteor uses vm.
- **source-map-support replacement** — Internal dependency change. Stack traces are nearly identical.
- **Conditional cluster import** — Micro-change. No impact.
- **Guard runtime.js** — Internal. As long as it doesn't break loading, nobody notices.
- **Making shell-server optional** — Few users affected. Easy to communicate.
- **WASM bcrypt as alternative** — Additive, not a forced replacement.

### Moderate controversy
- **Configurable runtime binary** — Some contributors might argue it complicates support. The answer: it's opt-in, the default doesn't change.
- **Experimental ESM bundler** — Early adopters will be enthusiastic, but conservative users will worry about stability. Communicate clearly that it's opt-in and experimental.
- **Simplification of Npm.require** — If the API doesn't change, no problem. If edge cases change behavior, package authors will react.
- **"Bring your own runtime" documentation** — Some will see this as a signal that Meteor is abandoning zero-config. Frame it well: it's an advanced option, not a replacement of the default.

### High controversy
- **Removal of reify** — Even announced as "future", it will worry package authors who don't understand the CJS/ESM distinction. Requires solid educational communication.
- **New bundle format as default** — Breaks existing deploy scripts. Galaxy users will be directly affected. Requires coordination with the Galaxy team and a long transition period.
- **Deprecation of the vendored dev bundle** — Touches Meteor's identity ("it works out of the box"). Even if it's the right direction, the communication must be extremely careful. Don't present it as "we're taking something away from you" but as "we're giving you more choice".
- **Migration from Npm.depends to package.json** — If presented as a deprecation, Atmosphere package authors will react negatively. If presented as "both work, but we recommend package.json for new packages", zero controversy.

---

## 8. Recommended Modernization Posture

### To actively clean up now
These are low-risk changes, invisible to users, that improve Meteor on Node and prepare the ground for everything else.

1. **Function() fallback in boot.js** — try vm, catch Function(). Add `//# sourceURL=` for stack traces.
2. **source-map-support replacement** — Switch to `--enable-source-maps`. Validate stack trace quality.
3. **Conditional cluster import** — Lazy require inside the conditional block.
4. **METEOR_SKIP_VERSION_CHECK env var** — Bypass of semver check for alternative runtimes.
5. **sourceURL pragmas** — Add them to evaluated code, even without changing from vm to Function().

### To isolate now, redesign later
These are subsystems that deserve to be decoupled from their current context, but whose complete redesign belongs to Layer B or C.

1. **runtime.js** — Add guards that detect if Module patching is functional. If not (Bun, Deno), clean fallback. Patching remains the main path on Node. The redesign (removal of reify) comes later.
2. **Shell-server** — Ensure it can be absent without breaking boot. Extract into optional package when ready.
3. **npm-rebuild.js** — Add `METEOR_SKIP_NPM_REBUILD` (already done!) and document WASM alternatives. The bundler redesign to stop bundling node-gyp comes later.
4. **Npm.require implementation** — Simplify the internal implementation. The public API doesn't change.

### To touch only as part of a broader architecture change
These subjects are important but should not be addressed in isolation. They require an RFC, a prototype and consensus.

1. **Moving the bundler to ESM** — This is the structural change that makes possible the removal of reify, the new bundle format and native Bun/Deno support. It should only be undertaken if the core team decides to prioritize it as a major initiative.
2. **New bundle format** — Consequence of the ESM transition. Don't start it before the bundler's ESM mode works.
3. **Removal of reify** — Consequence of the ecosystem's ESM migration. Don't announce it before the ESM path is functional and adopted.
4. **Dev bundle overhaul** — Politically sensitive and technically complex subject. To be addressed only if "bring your own runtime" shows significant adoption.

### What should not be a priority
These are subjects mentioned in previous passes that, on reflection, don't deserve effort now.

1. **Porting isobuild to another runtime** — Confirmed: disproportionate effort, zero user value.
2. **Formal runtime host contract** — Too abstract for now. Tactical decoupling (HTTP, signals) is sufficient. The formal contract will come if/when multi-runtime support is real.
3. **Replacing npm with bun install** — Semantic divergence, no clear value.
4. **Removal of Npm.depends** — Coexistence costs nothing. Forcing removal gains nothing.
5. **CJS->ESM conversion of tools/** — Thousands of files. The CLI stays on Node.

---

## 9. First 5 Changes That Reduce Node Heritage Without Forcing a Rewrite

### 1. Function() Fallback in boot.js
- **File:** `tools/static-assets/server/boot.js:414-417`
- **Change:** Wrap the `vm.runInThisContext` call in a try/catch. On failure, use `new Function('return ' + wrapped)()`. Add `\n//# sourceURL=${scriptPath}` to the wrapped code to preserve filenames in stack traces.
- **Why:** Removes blocker #1 for alternative runtimes. Zero impact on Node.
- **Risk:** Very low. The fallback only activates if vm fails. On Node, the main path doesn't change.
- **Useful on Node alone:** Marginally (the sourceURL pragma improves stack traces even on Node).
- **Compatibility:** 100% preserved.

### 2. source-map-support Replacement
- **File:** `tools/static-assets/server/boot.js:3,140-168`
- **Change:** Remove `require('source-map-support')`. Instead, ensure the entry script passes `--enable-source-maps` to Node, and that generated files include `//# sourceMappingURL=`. Verify that existing source maps are in the right format for native support.
- **Why:** Removes a dependency, a V8 monkey-patch, and the source-maps blocker for Bun (JSC).
- **Risk:** Low. `--enable-source-maps` has been stable since Node 14. Stack trace format may vary slightly.
- **Useful on Node alone:** Yes. Fewer dependencies, less monkey-patching, slightly more reliable stack traces.
- **Compatibility:** Nearly 100%. Some tools that parse stack traces might see a slightly different format.

### 3. Conditional cluster Import in webapp
- **File:** `packages/webapp/webapp_server.js:20,1427-1429`
- **Change:** Replace the module-level `import cluster from 'cluster'` with a lazy `require('cluster')` inside the `if (unixSocketPath)` block where cluster is actually used.
- **Why:** Removes an unnecessary import for 99% of deployments. Resolves the Deno stubs issue.
- **Risk:** Near zero. The import is only used to name worker sockets.
- **Useful on Node alone:** Slightly (one fewer module import at boot).
- **Compatibility:** 100% preserved.

### 4. METEOR_SKIP_VERSION_CHECK Env Var
- **File:** `tools/static-assets/server/boot.js:11-19`
- **Change:** Add `if (process.env.METEOR_SKIP_VERSION_CHECK) { /* skip */ }` before the `semver.lt(process.version, MIN_NODE_VERSION)` check.
- **Why:** Allows attempting to launch a bundle under Bun/Deno without the version check immediately killing the process. Also useful for users who want to test with a Node version newer than the officially supported one.
- **Risk:** Near zero. The default doesn't change. It's an explicit opt-in.
- **Useful on Node alone:** Yes — allows testing with Node versions not yet officially supported.
- **Compatibility:** 100% preserved.

### 5. Defensive Guards in runtime.js
- **File:** `tools/static-assets/server/runtime.js:24-96`
- **Change:** Before patching `Module.prototype.resolve`, verify that `Module._resolveFilename` exists and is a function. Before patching `Module._extensions['.js']`, verify that `Module._extensions` is a non-empty object. If checks fail, log a warning and continue without patching (code will work, but without reify cache and without inline transform — which is acceptable for a Bun/Deno spike).
- **Why:** Allows the runtime to start on Bun/Deno even if Module APIs are no-ops, instead of crashing silently.
- **Risk:** Low. On Node, the checks always pass and the path doesn't change. The risk is that the fallback without patching subtly changes loading behavior — needs careful testing.
- **Useful on Node alone:** Yes — makes runtime.js more defensive against future Node versions that might deprecate these internal APIs.
- **Compatibility:** Preserved on Node. Gracefully degraded on other runtimes.

---

## 10. Clarified Conclusion

### What is the real modernization heading?
Meteor should progressively migrate its server loading mechanisms from "code eval'd via vm + Module patching + reify" to "standard ES modules loaded natively." This heading is correct, but it's a multi-step process across several versions, not a "big bang."

### What is the most dangerous simplification of the previous analysis?
**Treating "remove reify" as a cleanup when it's a model change.** Reify is not a file you can delete. It's the mechanism by which all Meteor server packages are loaded. Removing it requires the bundler to generate native ESM, the package ecosystem to be compatible, and the loading model to be rethought. It's Layer C, not Layer A.

### What is the most realistic migration style for Meteor?
**Mixed approach: immediate tactical cleanup + progressive phase-out + compatibility bridges.**

- Layer A changes (boot.js, source maps, cluster, version check, guards) are pure cleanups. They can be done now, one by one, in independent PRs.
- Layer B changes (runtime.js guards, configurable runtime, WASM bcrypt, HTTP abstraction) are decouplings that require some coordination but no model change.
- Layer C changes (ESM bundler, new bundle format, removal of reify) are model changes that require an RFC process, prototyping and explicit opt-in before becoming the default.

**Compatibility bridges (reify + ESM, old format + new format, Npm.depends + package.json) are not just acceptable but necessary.** The "old path coexists with new path for N versions" pattern is the responsible way to migrate an ecosystem.

### What should the core team beware of in terms of overreaction?
**Don't rush into ESM/Bun/Deno because it's trendy.** The Layer A cleanups are valuable and immediate. But diving into Layer C without a working prototype and without consensus would be premature. The pressure of "we must support Bun" should not dictate the pace — the quality of the resulting architecture should.

### What should the core team beware of in terms of underestimation?
**The runtime.js and reify debt is real and growing.** Every Node version moves a little further away from the internal APIs Meteor depends on. `Module._extensions` and `_compile` are not public APIs — they could change or be removed in a future Node. Doing nothing is also a risk. Layer A is the minimum to reduce this risk now, without committing to Layer C.
