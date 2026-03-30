# Meteor → Bun / Deno Migration Assessment

**Date:** 2026-03-29
**Author:** dupontbertrand (with Claude analysis)
**Status:** First-pass feasibility study
**Scope:** Evidence-based, subsystem-by-subsystem audit

---

## 1. Executive Summary

**What is realistic:**
- Running a *built* Meteor server bundle under Bun is the closest thing to feasible, but is blocked today by unresolved MongoDB driver memory leaks on Bun and reliance on `vm.runInThisContext` in boot.js.
- Preparatory refactors (reducing `vm` usage, abstracting the module loader, making boot.js runtime-agnostic) are valuable regardless of whether a migration ever happens.

**What is unrealistic:**
- Full migration of Meteor (CLI + build system + runtime) to either Bun or Deno. The CLI/isobuild stack is so deeply welded to Node internals (`vm`, `module`, `require.resolve`, `child_process` for npm, vendored Node binary) that replacing it would be a multi-quarter rewrite, not a migration.
- Deno as an app runtime: `node:cluster` is completely non-functional stubs, CJS requires unstable flags, and the permission model adds friction at every layer.

**Best first path:**
- Scope A only, Bun only: spike a built Meteor bundle running under Bun, with a trivial app (no native addons, minimal Mongo usage). This gives maximum signal for minimum effort.

**Biggest hidden cost:**
- The `vm` module. Meteor uses `vm.runInThisContext` in *two* critical places: isobuild (plugin execution) and the production server (boot.js loading server bundles). Both Bun and Deno have partial `vm` support, but Meteor's usage pattern (injecting symbols like `Package`, `Npm`, `Assets` into a compiled script) is exactly the kind of advanced usage that breaks.

**Biggest strategic takeaway:**
- The highest-ROI work is not "migrate to Bun/Deno" — it's "make Meteor's runtime boot less Node-coupled." Removing `vm.runInThisContext` from boot.js, replacing `Module.prototype` manipulation in runtime.js with standard ESM, and abstracting the HTTP server creation would benefit Meteor regardless: faster startup, better debugging, easier deployment. A Bun/Deno spike is worth a weekend to calibrate expectations, but a full migration is a 6+ month coordinated effort that is not justified today.

---

## 2. Scope Split

### Scope A — App runtime only
The *built* Meteor app (output of `meteor build`) runs on Bun/Deno instead of Node. The CLI, dev bundle, isobuild, and `meteor run` development flow all stay on Node. This means: you develop with `meteor run` (Node), you `meteor build`, then you run `node main.js` → `bun main.js` or `deno run main.js` in production.

### Scope B — Partial tooling migration
Parts of Meteor's CLI or dev toolchain run on Bun/Deno. For example: using `bun install` instead of `npm install`, or running file watching under Bun. The build system and app runtime might remain on Node or be mixed.

### Scope C — Full migration
Everything: CLI bootstrap, dev bundle, isobuild, build plugins, app runtime, test infra, deployment — all off Node entirely.

### Why people underestimate this
1. **"Bun is Node-compatible" means ~90% compat.** The missing 10% is exactly the advanced APIs that frameworks use: `vm`, `module` internals, `child_process` IPC, `inspector`, `cluster`.
2. **Meteor's CLI is not a normal Node app.** It vendors its own Node binary, its own npm, its own MongoDB. It constructs custom PATHs, manipulates `process.execPath`, and shells out to itself. This is closer to a platform than an application.
3. **The build system is the hard part, not the runtime.** Isobuild loads and executes build plugins via `vm.runInThisContext` with injected globals. There is no process isolation — plugins run in the same context as the build tool. This is not portable.
4. **Testing is the long tail.** Even if the runtime works, Meteor's self-test suite spawns Node processes via `process.execPath`, expects specific npm behaviors, and assumes specific process lifecycle semantics.

---

## 3. Meteor Subsystem Audit

### Quick Feasibility Verdict

| Scope | Bun | Deno |
|---|---|---|
| App-runtime only | **Maybe** (blocked by MongoDB leak) | **Maybe** (blocked by cluster stubs, CJS friction) |
| Partial tooling | **Maybe** (significant refactoring) | **No** (too much friction) |
| Full migration | **No** (not worth doing) | **No** (not worth doing) |

### Detailed Subsystem Table

| Subsystem | Why it may be Node-coupled | Bun outlook | Deno outlook | Migration difficulty | Confidence | Notes / unknowns |
|---|---|---|---|---|---|---|
| **CLI bootstrap** | Shell script execs `$DEV_BUNDLE/bin/node` with V8 flags (`--no-wasm-code-gc`). `tools/index.js` uses `process.nextTick`, requires Babel setup. | Could replace shebang to `bun`, but V8-specific flags would fail silently or error. | Would need `deno run --allow-all` plus unstable flags for CJS. | Major architectural change | High | V8 flags (`--max-old-space-size`, `--no-wasm-code-gc`) have no Bun/Deno equivalent |
| **Dev bundle generation** | Downloads Node binary from nodejs.org/S3, bundles npm 10.9.4, node-gyp, MongoDB. `scripts/generate-dev-bundle.sh` | Would need entirely new bundle with Bun binary + Bun-compatible npm equivalent | Would need Deno binary + deno install flow | Major architectural change | High | This is months of work per runtime |
| **npm/package install flow** | `meteor-npm.js` calls `child_process.execFile($DEV_BUNDLE/bin/npm, ...)`. `Npm.depends()` in package.js triggers npm shrinkwrap. | Bun has `bun install` but Meteor expects npm CLI semantics (shrinkwrap, specific lock format v4) | Deno has npm compat but no drop-in `npm` CLI | Major architectural change | High | npm shrinkwrap behavior is deeply assumed |
| **Build system / isobuild** | `vm.createScript` + `vm.runInThisContext` for plugin execution (`tools/fs/files.ts:1112`). `require.resolve` for module type detection. `require('module').builtinModules` for stub mapping. | Bun's `vm` is "partial and fragile." Plugin execution is the highest-risk surface. | Deno's `vm` lacks `importModuleDynamically`. Core `runInThisContext` may work but untested with Meteor's injection pattern. | Likely deal-breaker for full migration | Medium | **Needs spike**: run a Meteor build plugin under Bun/Deno's vm |
| **Module resolution / loader** | `resolver.ts` uses `require('module').builtinModules`. Import scanner assumes CJS `require()` semantics. `runtime.js` patches `Module.prototype` to add reify support. | `Module._extensions`/`_pathCache`/`_cache` are no-ops in Bun. `Module.prototype` patching untested. | `createRequire` works but Module internals are limited. | Moderate refactor (runtime), major (build) | Medium | runtime.js Module.prototype patching is a key unknown |
| **File watching** | ParcelWatcher primary, `fs.watchFile` polling fallback (`tools/fs/safe-watcher.ts`). | `fs.watchFile` **not implemented** in Bun. ParcelWatcher is npm-based, might work. | Both `fs.watch` and `fs.watchFile` work in Deno. | Moderate refactor | High | Bun `fs.watch` has known bugs with new files in directories |
| **Server boot/runtime** | `vm.runInThisContext` executes server bundles (`boot.js:414`). `async_hooks.AsyncLocalStorage` for context. `Module.prototype` manipulation. `process.kill(parentPid, 0)` for liveness. | `vm.runInThisContext` may work (core vm works in Bun). `AsyncLocalStorage` supported. | `vm.runInThisContext` likely works. `AsyncLocalStorage` supported. | Moderate refactor | Medium | **Highest-signal spike target** |
| **webapp/HTTP server** | `http.createServer` + Express middleware (`webapp_server.js:1318`). `cluster` imported. Signal handling. | `http` module FULL in Bun. `cluster` PARTIAL (no socket handle passing). | `http` PARTIAL. `cluster` **COMPLETELY NON-FUNCTIONAL** in Deno. | Possible with moderate refactors (Bun), major (Deno) | High | Deno cluster being stubs is a hard blocker for production deployments |
| **DDP/socket layer** | SockJS server, WebSocket permessage-deflate via `zlib` (`stream_server.js:2`). | `zlib` FULL in Bun. WebSocket native. SockJS compatibility unknown. | `zlib` missing Brotli. WebSocket native. SockJS untested. | Possible with moderate refactors | Medium | SockJS npm package compatibility is an unknown on both |
| **Mongo integration** | Official `mongodb` npm driver. Oplog tailing. Change streams. TLS connections. | **MongoDB memory leaks on Bun** (issues #12117, #24118, #25948 spanning June 2024-Jan 2026). Not production-safe. | MongoDB Atlas connectivity regressions reported (issue #26413). Standalone works. | Not realistic today (Bun), moderate risk (Deno) | High | Bun MongoDB leak is THE showstopper for Scope A |
| **Native addon story** | `node-gyp` + `@mapbox/node-pre-gyp` bundled in output. npm-rebuild.js runs postinstall. bcrypt, argon2 are native. | N-API addons work. V8-specific addons fail (Bun uses JavaScriptCore). bcrypt works via N-API. | N-API works with `--allow-ffi` + `nodeModulesDir`. | Moderate refactor | Medium | Need to verify every native dep in a real Meteor app |
| **Test infrastructure** | Self-tests spawn Node via `process.execPath`. Tinytest runs in-process. CI sets up Node 22.x. | Would need parallel CI matrix. Self-tests hardwired to Node. | Same issues plus permission flags everywhere. | Major architectural change | High | Test infra is the long tail — weeks of work |
| **Build output / deployment** | `main.js` hardcoded: `require()`, `process.chdir()`, `process.argv`. `.node_version.txt` in bundle. README says `node main.js`. npm-rebuild.js uses `process.execPath`. | Could work if boot.js/main.js vm usage survives Bun. npm-rebuild needs adaptation. | CJS `require()` in main.js needs unstable flags. Permission model adds ops friction. | Moderate refactor | Medium | main.js is ~6 lines, easily rewritten |
| **Release/install/update flow** | Downloads Node binary from CloudFront. Springboarding between versions. Tropohouse warehouse at `~/.meteor`. | Would need Bun binary distribution + download infrastructure | Would need Deno binary distribution | Major architectural change | High | This is infrastructure, not just code |
| **Debugging/profiling** | `--inspect` support. `process.execArgv` inspection. Inspector protocol. | Bun uses **WebKit Inspector Protocol**, not V8 Chrome DevTools. | Deno uses V8/Chrome DevTools Protocol (better story). | Not realistic (Bun), possible (Deno) | High | Bun debugging story is fundamentally different |

---

## 4. Top Blockers

### 1. `vm.runInThisContext` in isobuild plugin execution
- **Why:** Build plugins are compiled to JS, then executed via `vm.createScript` + `vm.runInThisContext` with injected symbols (`Package`, `Npm`, `Assets`). This is the core of how Meteor's build system works.
- **Affects:** Bun (partial vm, "fragile") and Deno (partial vm, `importModuleDynamically` missing)
- **Classification:** Likely deal-breaker for Scopes B and C. Needs spike for Scope A (boot.js also uses vm).

### 2. MongoDB driver memory leaks on Bun
- **Why:** Unresolved memory leaks in the official `mongodb` npm package running on Bun (3 open issues spanning 18+ months). Makes any long-running Meteor server on Bun unsafe for production.
- **Affects:** Bun only
- **Classification:** Deal-breaker for Bun Scope A until fixed by Bun team

### 3. `node:cluster` completely non-functional on Deno
- **Why:** Meteor's webapp imports `cluster`. Production Meteor deployments (Galaxy, custom) may rely on cluster for multi-process. Even if not used directly, the import alone could cause issues.
- **Affects:** Deno only
- **Classification:** Deal-breaker for Deno production deployment. Refactorable if cluster is only conditionally imported.

### 4. Dev bundle architecture (vendored Node binary)
- **Why:** Meteor downloads and bundles a specific Node binary. The entire tool assumes `$DEV_BUNDLE/bin/node` exists and is used for everything: CLI, app server, npm operations, native addon compilation.
- **Affects:** Both (Scopes B and C)
- **Classification:** Major architectural change. Months of work.

### 5. npm CLI assumptions throughout the codebase
- **Why:** `meteor-npm.js` shells out to `npm` with specific flags, expects npm-shrinkwrap.json format v4, uses `NPM_CONFIG_PREFIX` and `NPM_CONFIG_NODEDIR`. Bun's `bun install` and Deno's npm support don't expose the same CLI interface.
- **Affects:** Both (Scopes B and C)
- **Classification:** Architectural change

### 6. `Module.prototype` manipulation in runtime.js
- **Why:** The server runtime patches Node's `Module.prototype` to integrate reify (ES module support). Both Bun and Deno have their own module systems; patching `Module` internals is likely to break or be ignored.
- **Affects:** Both (Scope A)
- **Classification:** Refactor — could be replaced with standard ESM, but touches every Meteor package's loading behavior

### 7. `process.execPath` for app server spawning
- **Why:** `run-app.js:261` spawns the user's app server via `child_process.spawn(process.execPath, ...)`. This hardwires the runtime to whatever binary started the CLI.
- **Affects:** Both (Scope B — mixed runtime scenario)
- **Classification:** Refactor — make the server runtime binary configurable

### 8. `fs.watchFile` missing on Bun
- **Why:** Meteor's file watcher falls back to `fs.watchFile` when ParcelWatcher is disabled or fails. Bun has not implemented `fs.watchFile`. Additionally, `fs.watch` has bugs with new files in directories.
- **Affects:** Bun only (Scope B)
- **Classification:** Refactor — could be worked around by ensuring ParcelWatcher always works

### 9. Inspector protocol mismatch (Bun)
- **Why:** Bun uses WebKit Inspector Protocol, not V8/Chrome DevTools Protocol. All Meteor debugging tooling (`--inspect`, IDE integration, `meteor debug`) assumes V8 protocol.
- **Affects:** Bun only
- **Classification:** Not worth fixing — fundamental engine difference

### 10. CJS everywhere, Deno wants ESM
- **Why:** Meteor's entire codebase (tools/, packages/, server bundles) is CJS with `require()`. Deno's CJS support requires `--unstable-detect-cjs` or explicit package.json `type` fields. The tool code uses dynamic `require()` patterns that are hard to statically convert.
- **Affects:** Deno only
- **Classification:** Major architectural change for full migration; manageable for Scope A with flags

---

## 5. Effort Estimates

### Person-weeks by scope

| Scope | Optimistic | Realistic | Pessimistic | Notes |
|---|---|---|---|---|
| **Bun app-runtime only** | 2 pw | 6 pw | 12 pw | Blocked by MongoDB leak. Without that: boot.js vm compat, Module.prototype patching, native addon verification |
| **Bun partial tooling** | 8 pw | 20 pw | 40 pw | Replace npm with bun install, adapt file watching, mixed binary management |
| **Bun full migration** | 30 pw | 60 pw | 100+ pw | Dev bundle rewrite, isobuild vm replacement, test infra overhaul, release engineering |
| **Deno app-runtime only** | 4 pw | 10 pw | 20 pw | CJS flag management, cluster stub workaround, permission model friction, MongoDB verification |
| **Deno partial tooling** | 12 pw | 30 pw | 50 pw | Everything in Bun partial + CJS conversion burden + permission model throughout |
| **Deno full migration** | 40 pw | 80 pw | 120+ pw | Effectively a rewrite of the tools/ layer |

*pw = person-weeks of a senior engineer familiar with Meteor internals*

### Team and coordination

- **Scope A:** 1 contributor can do it
- **Scope B:** 2-3 coordinated contributors minimum
- **Scope C:** Core team initiative, 3-5 people, with community buy-in
- **Parallelization:** Limited. The subsystems have deep dependencies (e.g., you can't test app runtime properly without build output changes, and you can't change build output without understanding isobuild).

---

## 6. Recommended Migration Strategy

### Recommended path: Dual-runtime abstraction as long-term prep without committing yet

This is NOT "do nothing." This is: do targeted refactors that make Meteor's runtime boot less Node-coupled, then re-evaluate.

**Why this is the best ROI:**
1. The Bun MongoDB memory leak makes Bun Scope A a non-starter *today*. This is outside your control.
2. Deno's broken cluster and CJS friction make it the worse choice for Scope A.
3. The highest-value work — removing `vm.runInThisContext` from boot.js, replacing `Module.prototype` patching, making the HTTP server creation pluggable — improves Meteor even on Node: faster startup, cleaner debugging, easier testing, better ESM story.
4. When/if Bun fixes its MongoDB leak (they're aware, it's tracked), you'll be ready to try Scope A with minimal additional work.

**What NOT to do yet:**
- Don't touch the dev bundle generation pipeline
- Don't try to replace npm with bun install in isobuild
- Don't attempt isobuild vm replacement (massive risk, unclear reward)
- Don't add Bun/Deno to CI matrix yet

**What to make more runtime-agnostic even if you never migrate:**

1. **boot.js**: Replace `vm.runInThisContext` with `Function()` constructor or dynamic `import()`. The vm usage here is not for sandboxing — it's for symbol injection, which can be done other ways.
2. **runtime.js**: Replace `Module.prototype` patching with standard ESM loader hooks or a simpler CJS wrapper.
3. **main.js template** (in bundler.js): Parameterize the entry point so it's not hardwired to `require()` and `process.chdir()`.
4. **webapp_server.js**: Make `cluster` import conditional. Guard it behind a feature check.
5. **run-app.js**: Make the server runtime binary path configurable (env var or setting), not hardwired to `process.execPath`.

---

## 7. Concrete Spikes / POCs

Ordered by signal/effort ratio.

### Spike 1: Boot a built Meteor bundle under Bun
- **Objective:** Determine if `bun main.js` can start a trivial Meteor app
- **Hypothesis:** boot.js's `vm.runInThisContext` will work under Bun's vm implementation for the server bundle loading pattern
- **Target:** `meteor create --bare spike-app && cd spike-app && meteor build ../spike-output --directory`, then `cd ../spike-output/bundle/programs/server && npm install && cd ../.. && bun main.js`
- **Success criteria:** Server starts, listens on PORT, responds to HTTP request
- **Conclusion on success:** Scope A is technically feasible (modulo MongoDB)
- **Conclusion on failure:** Identifies exactly which Node API breaks first
- **Effort:** 2-4 hours

### Spike 2: Boot a built Meteor bundle under Deno
- **Objective:** Determine if `deno run --allow-all --unstable-detect-cjs --unstable-bare-node-builtins main.js` works
- **Hypothesis:** CJS loading will work with unstable flags, but `cluster` import or some other Node API will fail
- **Target:** Same trivial built bundle as Spike 1
- **Success criteria:** Server starts and responds to HTTP
- **Conclusion on success:** Deno Scope A is feasible (with caveats)
- **Conclusion on failure:** Identifies the Deno-specific blockers
- **Effort:** 2-4 hours

### Spike 3: Replace `vm.runInThisContext` in boot.js with `Function()`
- **Objective:** Prove that boot.js can load server bundles without the `vm` module
- **Hypothesis:** The vm usage is for symbol injection, not sandboxing; `new Function(paramNames, code)` can achieve the same effect
- **Target:** Fork boot.js, replace the vm call, verify a built bundle still works on Node
- **Success criteria:** Built bundle works identically on Node with the modified boot.js
- **Conclusion on success:** Removes the #1 Scope A blocker on both runtimes. PR-ready.
- **Conclusion on failure:** vm is doing something subtle (source maps? stack traces?) that `Function()` can't replicate
- **Effort:** 4-8 hours

### Spike 4: ParcelWatcher under Bun
- **Objective:** Verify that `@parcel/watcher` (Meteor's primary file watcher) works under Bun
- **Hypothesis:** ParcelWatcher uses native addon (N-API), should work if N-API is solid in Bun
- **Target:** Simple script: watch a directory with ParcelWatcher under Bun, create/modify/delete files, verify events
- **Success criteria:** All file change events detected correctly
- **Conclusion on success:** File watching is not a blocker for Scope B
- **Conclusion on failure:** Bun's N-API has gaps for this specific addon
- **Effort:** 1-2 hours

### Spike 5: MongoDB driver under Bun long-running test
- **Objective:** Quantify the MongoDB memory leak severity for Meteor's usage pattern
- **Hypothesis:** Memory will grow unbounded over hours with typical Meteor pub/sub and method patterns
- **Target:** Simple script: connect to Mongo, run insert/find/subscribe loop for 1 hour, measure RSS every 10s
- **Success criteria:** Memory stays bounded (< 2x initial RSS after 1 hour)
- **Conclusion on success:** MongoDB leak may be usage-pattern dependent; Meteor might be okay
- **Conclusion on failure:** Confirms Bun Scope A is blocked until Bun fixes the leak
- **Effort:** 2-3 hours

### Spike 6: Run `meteor create` CLI commands under Bun
- **Objective:** How far does the Meteor CLI get if you replace `$DEV_BUNDLE/bin/node` with `bun` in the shell script?
- **Hypothesis:** Babel transpilation will work, but isobuild's vm plugin execution will fail
- **Target:** Modify the `meteor` shell script to call `bun` instead of `node`, run `meteor create test-app`
- **Success criteria:** `meteor create` completes and produces a valid app scaffold
- **Conclusion on success:** Scope B is more feasible than expected
- **Conclusion on failure:** Identifies exactly which CLI bootstrap step fails under Bun
- **Effort:** 2-4 hours

### Spike 7: Native addon audit for a realistic Meteor app
- **Objective:** Inventory all native addons in a real Meteor app and test each under Bun
- **Hypothesis:** Most are N-API (bcrypt, argon2, better-sqlite3) and will work; some obscure ones may not
- **Target:** Pick a real Meteor app (or create one with accounts-password, mongo, email), list all `.node` binaries, attempt `require()` under Bun
- **Success criteria:** All critical native addons load and pass basic smoke tests
- **Conclusion on success:** Native addons are not a blocker
- **Conclusion on failure:** Identifies which specific addons need alternatives
- **Effort:** 3-5 hours

---

## 8. Suggested Roadmap

### Phase 0 — Definition and success criteria
- **Goal:** Align on what "Bun/Deno support" would mean for Meteor
- **Exit criteria:** Written document with: target scope (A/B/C), success metrics, acceptable regressions, community communication plan
- **Who:** 1 contributor + 1 core team member
- **Time:** 1 week

### Phase 1 — Static audit
- **Goal:** Complete the subsystem audit with actual code evidence (this document is the starting point)
- **Exit criteria:** Every `vm`, `module`, `child_process`, and `cluster` usage catalogued. Compatibility matrix filled in with confidence levels.
- **Who:** 1 contributor
- **Time:** 1-2 weeks

### Phase 2 — Spikes / prototypes
- **Goal:** Run Spikes 1-7 above. Collect hard data.
- **Exit criteria:** For each spike: pass/fail + specific error log + writeup of what broke and why
- **Who:** 1 contributor
- **Time:** 2-3 weeks (some spikes run in parallel)

### Phase 3 — Targeted refactors
- **Goal:** Make boot.js, runtime.js, and main.js runtime-agnostic. These are valuable on Node too.
- **Exit criteria:**
  - boot.js works without `vm` module
  - runtime.js works without `Module.prototype` patching (or patching is guarded)
  - main.js template is parameterizable
  - `cluster` import in webapp is conditional
  - All existing tests pass on Node
- **Who:** 1 contributor + code review from core team
- **Time:** 4-8 weeks

### Phase 4 — Go / no-go decision
- **Goal:** Based on spike results and refactor success, decide whether to pursue Scope A for Bun
- **Exit criteria:** Written decision with rationale. Key question: has Bun fixed the MongoDB leak?
- **Who:** Contributor + core team
- **Time:** 1 week

### Phase 5 — Implementation path (only if justified)
- **Goal:** Official "experimental Bun runtime" support for built Meteor bundles
- **Exit criteria:**
  - `meteor build` can produce a bundle that boots under Bun
  - CI runs a basic smoke test on Bun
  - Documentation says "experimental, Node recommended for production"
  - Known limitations documented
- **Who:** 2-3 contributors
- **Time:** 8-16 weeks

---

## 9. Bun & Deno Node.js Compatibility Reference

### Bun Node Built-in Module Compatibility

| Module | Status | Notes |
|--------|--------|-------|
| `node:fs` | FULL | 92% of Node.js test suite passes |
| `node:path` | FULL | 100% of Node.js test suite passes |
| `node:net` | FULL | Fully implemented |
| `node:tls` | PARTIAL | Missing `tls.createSecurePair` |
| `node:http` | FULL | Outgoing request body buffered instead of streamed |
| `node:https` | PARTIAL | Agent not always used |
| `node:zlib` | FULL | 98% of Node.js test suite passes |
| `node:crypto` | PARTIAL | Missing `secureHeapUsed`, `setEngine`, `setFips` |
| `node:stream` | FULL | Fully implemented |
| `node:child_process` | PARTIAL | Missing `proc.gid`, `proc.uid`; IPC cannot send socket handles |
| `node:worker_threads` | PARTIAL | Missing `stdin`/`stdout`/`stderr` options, `resourceLimits` |
| `node:os` | FULL | 100% of Node.js test suite passes |
| `node:vm` | PARTIAL | Core works (Script, createContext, runInThisContext). Missing `vm.measureMemory`. Described as "partial and fragile" |
| `node:module` | PARTIAL | `createRequire` works. `_extensions`, `_pathCache`, `_cache` are no-ops. `Module._resolveFilename` unreliable |
| `node:inspector` | PARTIAL | Only Profiler API. Uses WebKit Inspector Protocol, NOT V8/Chrome DevTools |
| `node:cluster` | PARTIAL | Handles/file descriptors cannot transfer between workers |
| `node:dgram` | FULL | Over 90% of Node.js test suite passes |
| `node:dns` | FULL | Over 90% of Node.js test suite passes |
| `node:url` | FULL | Fully implemented |
| `node:querystring` | FULL | 100% of Node.js test suite passes |
| `node:buffer` | FULL | Fully implemented |
| `node:async_hooks` | FULL | AsyncLocalStorage works |

**Bun critical issues for Meteor:**
- MongoDB memory leaks (oven-sh/bun#12117, #24118, #25948) — unresolved as of Jan 2026
- `fs.watchFile` not implemented (oven-sh/bun#3812)
- `fs.watch` directory bug (oven-sh/bun#23992)
- V8-specific native addons incompatible (Bun uses JavaScriptCore)

### Deno Node Built-in Module Compatibility

| Module | Status | Notes |
|--------|--------|-------|
| `node:fs` | FULL | Minor gaps: some encoding edge cases |
| `node:path` | FULL | Fully supported |
| `node:net` | PARTIAL | `fd` option not supported for Socket |
| `node:tls` | PARTIAL | `createSecurePair` not supported |
| `node:http` | PARTIAL | `createConnection` option unsupported |
| `node:https` | PARTIAL | Server cert/key options lack array input |
| `node:zlib` | PARTIAL | Brotli compression classes unsupported |
| `node:crypto` | FULL | Fully supported |
| `node:stream` | FULL | Fully supported |
| `node:child_process` | FULL | All spawn/exec variants supported |
| `node:worker_threads` | PARTIAL | Missing `emit`, `removeAllListeners`, `getHeapSnapshot` |
| `node:os` | FULL | Fully supported |
| `node:vm` | PARTIAL | `importModuleDynamically` unsupported. Core functions work |
| `node:module` | FULL | `createRequire` works. `Module.register` is a stub |
| `node:inspector` | PARTIAL | Only console supported; other APIs are stubs |
| `node:cluster` | **MISSING** | All exports are non-functional stubs |
| `node:dgram` | PARTIAL | Multiple socket methods are stubs |
| `node:dns` | PARTIAL | `ttl` option not supported |
| `node:url` | FULL | Fully supported |
| `node:querystring` | FULL | Fully supported |
| `node:buffer` | FULL | Fully supported |
| `node:async_hooks` | FULL | AsyncLocalStorage works |

**Deno critical issues for Meteor:**
- `node:cluster` completely non-functional — hard blocker
- CJS requires `--unstable-detect-cjs` flag
- Permission model (`--allow-read`, `--allow-net`, etc.) adds operational friction
- MongoDB Atlas connectivity regressions (denoland/deno#26413)
- Brotli missing in zlib

**Deno unstable flags needed for Meteor:**

| Flag | Importance | Purpose |
|------|-----------|---------|
| `--unstable-bare-node-builtins` | HIGH | Import `fs` instead of `node:fs` |
| `--unstable-detect-cjs` | HIGH | Auto-detect CJS modules |
| `--unstable-node-globals` | HIGH | Inject `Buffer`, `global`, `setImmediate` |
| `--unstable-sloppy-imports` | MEDIUM | Allow omitting file extensions |
| `--unstable-unsafe-proto` | MEDIUM | Enable `__proto__` for npm packages |

---

## 10. Appendix: Evidence and Assumptions

### Meteor files inspected

**CLI / bootstrap:**
- `meteor` (shell script) — CLI entry point, dev bundle download, Node binary exec
- `tools/index.js` — Pre-Babel entry, dev-bundle-bin command interception
- `tools/cli/dev-bundle-bin-commands.js` — `meteor npm`/`meteor node` dispatching
- `tools/cli/dev-bundle-bin-helpers.js` — PATH/env construction for npm
- `tools/cli/dev-bundle.js` — Dev bundle resolution per project
- `tools/cli/dev-bundle-links.js` — Symlink-based release switching
- `tools/cli/main.js` — CLI main, Node version enforcement

**Build system:**
- `tools/fs/files.ts` — `vm.createScript`, `runInThisContext`, `getDevBundle()`
- `tools/fs/safe-watcher.ts` — ParcelWatcher + fs.watchFile fallback
- `tools/isobuild/bundler.js` — Bundle generation, main.js template, Npm.require, vm plugin execution
- `tools/isobuild/resolver.ts` — `module.builtinModules`, module resolution
- `tools/isobuild/import-scanner.ts` — Module dependency scanning
- `tools/isobuild/meteor-npm.js` — npm subprocess execution, shrinkwrap
- `tools/isobuild/compiler.js` — Package compilation pipeline
- `tools/isobuild/isopack.js` — Plugin loading
- `tools/isobuild/build-plugin.js` — Plugin factory execution

**Server runtime:**
- `tools/static-assets/server/boot.js` — Server bootstrap, `vm.runInThisContext`, version check
- `tools/static-assets/server/runtime.js` — Module.prototype patching, reify
- `tools/static-assets/server/npm-require.js` — Npm.require() resolution
- `tools/static-assets/server/npm-rebuild.js` — Native addon rebuild
- `tools/static-assets/server/npm-rebuild-args.js` — node-pre-gyp flags
- `tools/runners/run-app.js` — App server spawning via `process.execPath`

**Packages:**
- `packages/webapp/webapp_server.js` — HTTP server, cluster, signals
- `packages/ddp-server/stream_server.js` — SockJS, zlib compression
- `packages/mongo/mongo_connection.js` — MongoDB driver usage
- `packages/random/NodeRandomGenerator.js` — crypto.randomBytes
- `packages/accounts-password/password_server.js` — bcrypt/argon2
- `packages/accounts-base/accounts_server.js` — crypto import
- `packages/shell-server/shell-server.js` — net.createServer, REPL
- `packages/inter-process-messaging/inter-process-messaging.js` — IPC via process.send
- `packages/email/email.js` — nodemailer

**Scripts / CI / tooling:**
- `scripts/generate-dev-bundle.sh` — Dev bundle build
- `scripts/build-dev-bundle-common.sh` — Node/npm/Mongo version pins
- `tools/tool-env/install-babel.js` — Babel pre-load exclusions
- `tools/tool-env/rspack.js` — Rspack integration
- `tools/tool-testing/selftest.js` — Self-test framework
- `tools/tool-testing/run.js` — Test process spawning
- `tools/packaging/release.js` — Release management
- `tools/packaging/updater.js` — Self-update mechanism
- `tools/packaging/tropohouse.js` — Package warehouse
- `.github/workflows/unit-tests.yml` — CI Node setup
- `.github/workflows/e2e-tests.yml` — CI E2E matrix

### Official docs relied on
- Bun Node.js Compatibility: bun.sh/docs/runtime/nodejs-compat
- Bun Node-API: bun.sh/docs/runtime/node-api
- Bun Debugger: bun.sh/docs/runtime/debugger
- Deno Node APIs Reference: docs.deno.com/runtime/reference/node_apis/
- Deno Node/npm compat: docs.deno.com/runtime/fundamentals/node/
- Deno Unstable flags: docs.deno.com/runtime/reference/cli/unstable_flags/
- Deno vm API: docs.deno.com/api/node/vm/

### Explicit assumptions
1. Transport layer abstraction (recent work) means DDP/WebSocket is NOT the main blocker
2. Fibers are fully gone in Meteor 3 — no legacy fiber compat to worry about
3. Meteor 3 targets Node 22.x (confirmed: 22.22.0 in build-dev-bundle-common.sh)
4. Bun and Deno compatibility data is as of early 2026; both runtimes evolve rapidly
5. MongoDB memory leak on Bun is not yet fixed (last issue activity Jan 2026)
6. "Full migration" means Meteor works without Node installed anywhere

### Open questions
1. Does Bun's `vm.runInThisContext` handle Meteor's specific pattern of wrapping code in `function(Package, Npm, Assets) { ... }` and executing it?
2. Does `Module.prototype` patching in runtime.js actually work on Bun where `Module._extensions` etc. are no-ops?
3. Does SockJS (npm package) work on Bun/Deno? It has its own HTTP server integration.
4. What is the actual performance of Bun vs Node for Meteor's workload (DDP pub/sub + HTTP + Mongo)?
5. Does `@parcel/watcher` native addon work on Bun?
6. How does `inter-process-messaging` (IPC via `process.send`) behave on Bun where IPC socket handle passing is unsupported?
7. Would Galaxy (Meteor's hosting platform) support Bun/Deno runtime containers?
8. What is the Meteor community appetite for alternative runtime support?
