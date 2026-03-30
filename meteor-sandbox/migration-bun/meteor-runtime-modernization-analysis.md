# Meteor Runtime Modernization Analysis — Third Pass

**Date:** 2026-03-29
**Author:** dupontbertrand (with Claude analysis)
**Status:** Architectural analysis — forward-looking
**Mindset:** Not "how do we port Meteor?" but "what should Meteor become?"

---

## 1. Reframed Objective

The real question is not "can Meteor run on Bun or Deno?" The real question is:

**If Meteor had to justify every internal implementation choice today — not in 2012, not in 2015, not in the Fibers era — which parts would survive, which would be redesigned, and which would be quietly removed?**

Bun and Deno are catalysts for this question, not the question itself. A runtime migration that faithfully reproduces Meteor's current internals would inherit all the accumulated coupling, all the workarounds, and all the accidental complexity — just on a different engine. That's the worst outcome: same debt, new host.

The better framing is:

1. **Identify what Meteor IS** — the product, the developer experience, the guarantees.
2. **Identify what Meteor DOES BECAUSE OF NODE** — the implementation details shaped by Node's specific module system, process model, and ecosystem circa 2012–2020.
3. **Separate 1 from 2.** Port (1). Redesign or remove (2).

If this analysis is done well, it produces value even if Bun/Deno support never ships. It tells the core team where Meteor's real architecture ends and where Node-shaped scar tissue begins.

---

## 2. Core Meteor Value vs Historical Implementation

| Area | Core Meteor value to preserve | Current implementation detail | Keep / Abstract / Redesign / Remove | Why |
|---|---|---|---|---|
| **Data on the wire** | Server publishes data, client subscribes reactively. No HTML rendering on the server required. | DDP protocol over SockJS/WebSocket | **Keep** the protocol, **abstract** the transport | DDP is Meteor's identity. SockJS is a transport choice. Transport is already being abstracted. |
| **Isomorphic packages** | Same package code can run on client and server with arch-specific slicing | `Package.onUse(api => api.addFiles(..., ['client', 'server']))` + isobuild arch system | **Keep** the concept, **redesign** the package execution model | The concept is core. The `vm.runInThisContext` evaluation model is not. |
| **Zero-config dev experience** | `meteor create && meteor run` works out of the box with Mongo, HMR, build | Vendored Node + vendored MongoDB + custom npm + custom package catalog | **Keep** the experience, **abstract** the runtime dependencies | Users love the DX. They don't care that Node is vendored or that there's a dev bundle. |
| **Hot code push** | App updates without full page reload in development and production | Server detects changes → rebuilds → signals client via DDP | **Keep** | This is product value. Implementation is already reasonable. |
| **Reactive data / minimongo** | Client-side reactive data store that mirrors server collections | Minimongo + Tracker (client), MongoDB oplog/polling (server) | **Keep** | Core product differentiator. Implementation is clean. |
| **Accounts system** | Unified accounts with pluggable strategies (password, OAuth, etc.) | accounts-base + accounts-password + bcrypt/argon2 native addons | **Keep** the API, **abstract** the crypto backend | The accounts API is valuable. Depending on native addon bcrypt is an implementation detail. |
| **Optimistic UI** | Methods simulate on client, confirm from server | Method stubs + DDP method protocol | **Keep** | Core Meteor innovation. Implementation is clean. |
| **Server startup / package evaluation** | Packages load in dependency order, each gets its own scope with `Npm`, `Assets` | `vm.runInThisContext` wrapping each package in a closure, injecting symbols | **Redesign** | The wrapping-in-closure-and-eval pattern was smart in 2012. In 2026, ES modules + dynamic import can achieve the same scoping without vm. |
| **Module system / reify** | ES module syntax works in Meteor packages | Monkey-patching `Module.prototype._compile` and `_extensions['.js']` to intercept every require and run reify transforms | **Remove** (replace with native ESM) | Reify exists because Node didn't support ESM. Node 22 does. Bun and Deno do natively. The entire reify pipeline is a polyfill for a problem that no longer exists. |
| **Npm.require / Npm.depends** | Meteor packages can declare and use npm dependencies | Custom resolution in npm-require.js, npm-shrinkwrap management in meteor-npm.js | **Redesign** | `Npm.require` is a Meteor-specific indirection over `require`. In a world with native ESM and standard package.json dependencies, this indirection adds complexity without value. |
| **HTTP server** | Meteor serves static assets and connects middleware | Express on top of `http.createServer` | **Abstract** | The HTTP server should be a pluggable host, not hardwired to Express + Node http. |
| **Build output / bundle format** | `meteor build` produces a deployable artifact | Tar containing main.js + programs/server/ + programs/web.browser/ | **Redesign** the server entry, **keep** the structure | The bundle structure is fine. The entry point (main.js → runtime.js → boot.js → vm.eval each package) is where all the coupling lives. |
| **Async context (DDP method/pub binding)** | Each DDP method/publication call has its own execution context | `AsyncLocalStorage` (Meteor 3) replacing Fibers + dynamic variables | **Keep** | Already modern. AsyncLocalStorage is supported everywhere. |
| **Process lifecycle** | Server starts, stays alive, handles signals | `process.exit`, signal handlers, parent PID polling | **Abstract** | These are reasonable patterns but hardwired to Node's process model. A runtime host contract should handle this. |
| **Shell server / REPL** | `meteor shell` gives a server REPL | Unix socket + Node REPL module | **Remove** or make optional | Useful for debugging but not core product value. Couples to `net` + `repl` modules. In production, nobody uses `meteor shell`. |
| **Source maps** | Errors show original source locations | `source-map-support` npm package + `Error.prepareStackTrace` (V8-specific) | **Redesign** | Source maps are valuable. The integration strategy (monkey-patching V8's stack trace API) is engine-specific. Modern runtimes have their own source map support. |
| **Debugging / inspector** | `meteor debug` / `--inspect` | V8 Inspector Protocol integration | **Abstract** | Debugging is essential. Hardwiring to V8's protocol is not. |
| **Native addon story** | Packages like bcrypt, argon2 work | node-gyp + node-pre-gyp bundled in build output, npm rebuild at deploy time | **Redesign** | The node-gyp dependency chain is fragile and platform-specific. WASM alternatives exist for bcrypt. The rebuild-at-deploy-time pattern is a constant source of deployment failures. |

---

## 3. Lessons from Node-Coupled Pain

### Lesson 1: Fibers — building on a runtime extension that the runtime rejected

**Historical choice:** Meteor used Fibers (a native C++ addon) to provide synchronous-looking async code. This was Meteor's killer DX feature: you could write `Collection.findOne()` without callbacks or await.

**Why it made sense:** In 2012, Node had callbacks. No Promises in the standard library. No async/await. Fibers genuinely provided a better programming model.

**Pain it caused:** Fibers was never part of Node core. It was maintained by one person. When Node moved to newer V8 versions and then to N-API, Fibers broke repeatedly. It blocked Node upgrades for years. The migration to async/await in Meteor 3 was the single largest breaking change in Meteor's history.

**Lesson:** Never build a core product abstraction on a runtime-specific extension that isn't part of the runtime's own roadmap. If you need a capability the runtime doesn't provide, either (a) contribute it upstream, (b) build it as a removable layer with a clear migration path, or (c) accept the runtime's model. Meteor chose (d): build on it permanently with no fallback. That cost years.

**For Bun/Deno:** If Meteor needs a capability that Bun or Deno doesn't support, the answer is NOT to hack around it. The answer is to not need it.

---

### Lesson 2: vm.runInThisContext — scope isolation via runtime internals

**Historical choice:** Meteor packages each get their own scope with injected symbols (`Package`, `Npm`, `Assets`). This is achieved by wrapping each package's code in a function expression and evaluating it via `vm.runInThisContext`.

**Why it made sense:** In 2012, there were no ES modules. No `import`/`export`. No standard way to create isolated module scopes. The vm module was the only way to evaluate code with a custom filename (for stack traces) without creating a file on disk.

**Pain it caused:** Deep coupling to Node's `vm` module. Build plugins also use `vm` (in isobuild). The pattern is fragile — no sandboxing, no error isolation, no memory isolation. It also makes the boot sequence opaque: boot.js reads files, wraps them in strings, evals them. Debugging this is painful. And now it's the #1 blocker for alternative runtimes.

**Lesson:** Scope isolation should use the language's own module system, not runtime eval. In 2026, ES modules provide exactly the isolation Meteor needs: each module has its own scope, can export symbols, can import dependencies. The vm wrapper should be replaced with standard module loading.

---

### Lesson 3: Module.prototype monkey-patching — reify as a permanent polyfill

**Historical choice:** To support ES `import`/`export` syntax before Node did, Meteor uses `@meteorjs/reify`, which monkey-patches `Module.prototype._compile` and `Module._extensions['.js']` to intercept every `require()` call and transform ES module syntax to CJS at load time.

**Why it made sense:** When reify was created, Node had no native ESM support. Babel was too slow for development-time compilation. Reify was a clever, fast, inline transform.

**Pain it caused:** Every `.js` file loaded by the server goes through a string transformation pipeline involving acorn parsing with a babel fallback. The Module prototype patching is the most Node-specific code in Meteor's runtime — it depends on undocumented internals (`_compile`, `_extensions`, `_resolveFilename`) that other runtimes explicitly don't support. It also means Meteor's module loading is fundamentally different from standard Node module loading, which causes subtle bugs and confuses tools.

**Lesson:** Polyfills should have expiration dates. Reify was a bridge. The bridge's destination (native ESM) arrived years ago. The bridge should be removed, not carried forward to new runtimes.

---

### Lesson 4: Vendored Node binary — runtime version lock as a feature

**Historical choice:** Meteor bundles a specific Node version in its dev bundle. `meteor run` uses this vendored Node, not the system Node. `meteor npm` uses the vendored npm.

**Why it made sense:** Guaranteed consistency. No "works on my machine" for Node version differences. Especially important when Meteor needed specific V8 features or Fibers compatibility.

**Pain it caused:** Meteor is always behind on Node versions because someone has to manually update the vendored version, test everything, and rebuild dev bundles for every platform. Users can't use newer Node features until Meteor catches up. The dev bundle is large (~120MB for Node alone). The vendoring creates a parallel npm universe that confuses tooling (IDEs, linters, package managers don't understand `meteor npm`).

**Lesson:** Version consistency is valuable. Achieving it by vendoring the entire runtime is expensive. A better approach: declare a supported Node version range, validate at startup, let users bring their own runtime. This is what every other framework does. It's also what makes runtime portability trivial — Meteor stops owning the runtime binary.

---

### Lesson 5: Npm.require / Npm.depends — a parallel package system

**Historical choice:** Meteor has its own package format (package.js) with its own dependency declaration (`Npm.depends()`). At runtime, `Npm.require()` provides a custom resolution mechanism that searches multiple node_modules directories.

**Why it made sense:** npm in 2012 was immature. Semantic versioning was poorly adopted. Meteor's package system provided constraint solving that npm couldn't. `Npm.depends` gave Meteor packages reproducible npm dependencies before npm-shrinkwrap/package-lock existed.

**Pain it caused:** Two package systems to understand and maintain. Confusing mental model for newcomers ("do I use npm install or meteor add?"). Custom resolution logic in npm-require.js that duplicates what Node's module system already does. Maintenance burden for meteor-npm.js which shells out to npm with specific flags and expects specific lock file formats.

**Lesson:** If the ecosystem provides what you need, use it. npm now has lock files, workspaces, peer dependencies, and constraint solving. Meteor's parallel package system duplicates this at high maintenance cost. New code should use standard package.json dependencies wherever possible.

---

### Lesson 6: source-map-support via Error.prepareStackTrace — V8-specific DX

**Historical choice:** Meteor uses the `source-map-support` npm package which hooks into V8's `Error.prepareStackTrace` to rewrite stack traces using source maps.

**Why it made sense:** Stack traces in compiled/bundled code are unreadable. Source maps fix this. V8's `Error.prepareStackTrace` was the only hook available.

**Pain it caused:** Completely V8-specific. Won't work on JavaScriptCore (Bun). Fragile when interacting with other tools that also monkey-patch `Error.prepareStackTrace`. Modern Node has `--enable-source-maps` flag which does this natively.

**Lesson:** Use the runtime's own source map support rather than monkey-patching error handling. Node has `--enable-source-maps`. Deno and Bun handle source maps natively. The `source-map-support` package is legacy.

---

## 4. Preserve vs Redesign Map

| Surface / subsystem | Port faithfully | Preserve but abstract | Redesign | Remove | Rationale |
|---|---|---|---|---|---|
| DDP protocol | **X** | | | | Core identity. Well-designed. Runtime-agnostic. |
| Pub/sub + methods | **X** | | | | Core product value. |
| Minimongo (client) | **X** | | | | Core product value. Client-only, runtime-irrelevant. |
| Tracker (client reactivity) | **X** | | | | Client-only, runtime-irrelevant. |
| Accounts API | **X** | | | | Core DX. Clean abstraction. |
| Optimistic UI / method stubs | **X** | | | | Core innovation. |
| AsyncLocalStorage context | **X** | | | | Already modern. Works everywhere. |
| Build output structure | **X** | | | | star.json + programs/ is a fine format. |
| Hot code push | **X** | | | | Core DX. |
| HTTP server hosting | | **X** | | | Should accept any HTTP server implementation, not hardwire Express + http.createServer. |
| Transport layer (WebSocket/SockJS) | | **X** | | | Already being abstracted. |
| MongoDB driver integration | | **X** | | | Mongo is core to Meteor but the driver should be a pluggable dependency. |
| Process lifecycle / signals | | **X** | | | Reasonable patterns, but should be a contract, not hardcoded process.on calls. |
| Crypto backend (bcrypt/argon2) | | **X** | | | Keep the accounts security, abstract the implementation. WASM bcrypt exists. |
| Package scoping / evaluation | | | **X** | | Replace vm.runInThisContext with ES module loading. Packages become real modules, not eval'd strings. |
| Boot sequence (boot.js) | | | **X** | | Replace the read-file-wrap-eval loop with a standard module import chain. |
| runtime.js / Module patching | | | | **X** | Delete entirely. Replace with native ESM or a standard loader. Reify is a polyfill for solved problems. |
| Npm.require / npm-require.js | | | **X** | | Replace with standard `import` or `require` from standard node_modules. |
| Npm.depends in package.js | | | **X** | | Move toward standard package.json for npm dependencies. |
| npm-rebuild.js | | | **X** | | Simplify: either use WASM alternatives for native deps, or use standard npm rebuild without custom wrapper. |
| Shell server (REPL) | | | | **X** | Non-essential. Couples to `net` + `repl`. Can be a separate optional package. |
| source-map-support integration | | | | **X** | Use runtime-native source map support (`--enable-source-maps` or equivalent). |
| Dev bundle vendored Node | | | **X** | | Stop vendoring. Declare supported runtimes. Let users bring their own. |
| semver version gate in boot.js | | | | **X** | Feature-detect instead of version-check. Or just remove — let the runtime fail naturally on unsupported APIs. |
| Parent PID liveness check | | | | **X** | Only used in dev mode. Not relevant for production bundles. Add to dev server only, not boot.js. |
| debug.ts pause function | | | | **X** | Single `debugger` statement in a function. Not worth carrying as infrastructure. |

---

## 5. If We Allowed Ourselves to Break Internals, What Gets Simpler?

### 5.1 Boot/runtime loading model
**Current:** main.js → runtime.js (patches Module) → boot.js (reads JSON, loops files, wraps each in string, vm.runInThisContext, calls result).
**If broken:** main.js → `import './packages/meteor.js'` → `import './packages/webapp.js'` → etc. Standard ES module imports. No vm. No string wrapping. No JSON-driven file loop. Each package is a real module with its own imports.
**Risk:** Medium — changes how the bundler generates output, but the loading semantics are equivalent.
**Worth doing even without Bun/Deno:** **Yes.** This makes boot faster (no string concatenation + eval overhead), debuggable (standard module loading shows up in profilers), and compatible with any runtime that supports ES modules.

### 5.2 vm-based execution
**Current:** `vm.runInThisContext(wrappedCode, {filename})` for every server package.
**If broken:** Replace with standard `import()` or `require()`. The `(function(Npm, Assets){...})` wrapper becomes a real module that imports its dependencies normally.
**Risk:** Medium — `Npm` and `Assets` injection must be handled differently. Could use module-level globals, a DI container, or per-package import maps.
**Worth doing even without Bun/Deno:** **Yes.** Removes the most fragile Node-specific code in the server runtime.

### 5.3 Module.prototype patching (reify)
**Current:** Patches `_compile`, `_extensions['.js']`, `_resolveFilename` to transform ES modules at load time.
**If broken:** Use native ESM. Node 22 supports it. Bun and Deno support it natively.
**Risk:** High — this is a fundamental change to how all Meteor packages are loaded. Every package that uses `import`/`export` relies on reify.
**Worth doing even without Bun/Deno:** **Yes, absolutely.** This is the single highest-value modernization. Reify is a polyfill for a problem that's been solved for years. Removing it eliminates the most Node-internal-dependent code in the entire runtime, improves startup performance, and makes Meteor's module loading standard.

### 5.4 Startup / main entrypoint model
**Current:** main.js is 6 lines of CJS (`require('path')`, `process.chdir`, `require('./runtime.js')`, `require('./boot.js')`). boot.js has a complex async startup: load bundles → call startup hooks → call main().
**If broken:** main.js is an ES module entry point. Package load order is encoded as import dependencies, not a JSON manifest. Startup hooks become standard ES module side effects.
**Risk:** Medium — changes the bundle output format.
**Worth doing even without Bun/Deno:** **Yes.** A standard ESM entry point is debuggable, profileable, and understandable by any JS developer.

### 5.5 Server package evaluation model
**Current:** Each package's code is wrapped in `(function(Npm, Assets, ...specialArgs){ ... })` and called with injected objects.
**If broken:** Each package is a real module. `Npm` becomes `import` (standard). `Assets` becomes a function imported from a Meteor-provided module. Special args (like `npmRequire` for modules-runtime) become explicit imports.
**Risk:** Low-Medium — the wrapper pattern is a scope isolation mechanism. ES modules provide scope isolation natively.
**Worth doing even without Bun/Deno:** **Yes.** Makes package code standard JavaScript that works with standard tools (linters, type checkers, bundlers, debuggers).

### 5.6 Shell / REPL behavior
**Current:** shell-server creates a Unix socket, listens for connections, spawns a Node REPL.
**If broken:** Remove from core. Offer as an optional package. Or replace with a WebSocket-based REPL that works on any runtime.
**Risk:** Very low — few users depend on `meteor shell` in production.
**Worth doing even without Bun/Deno:** **Yes.** Reduces core surface area.

### 5.7 Source map / debugging strategy
**Current:** `source-map-support` package hooks V8's `Error.prepareStackTrace`.
**If broken:** Use `--enable-source-maps` on Node (built-in since v12.12). On Bun/Deno, source maps are handled natively. Embed `//# sourceMappingURL=` comments in generated code.
**Risk:** Low — `--enable-source-maps` is a well-tested Node feature.
**Worth doing even without Bun/Deno:** **Yes.** Removes a dependency and a monkey-patch.

### 5.8 Native module story
**Current:** node-gyp and node-pre-gyp bundled in every build output. npm-rebuild.js runs as postinstall.
**If broken:** Prefer WASM alternatives where available (bcrypt → `bcrypt-wasm` or `@aspect/bcrypt`; argon2 has WASM variants). For packages where WASM isn't viable, use prebuilt binaries via `prebuildify` or `@napi-rs`. Stop bundling node-gyp in the output.
**Risk:** Medium — some packages may not have WASM alternatives. Need case-by-case evaluation.
**Worth doing even without Bun/Deno:** **Yes.** Removes the #1 cause of deployment failures ("npm rebuild failed in production").

### 5.9 Process model
**Current:** boot.js assumes it's the main process. Polls parent PID. Handles SIGTERM/SIGINT. Calls `process.exit()`.
**If broken:** Define a "Meteor server host" contract: the host provides a way to start, a way to stop, and a way to signal readiness. Whether that host is a Node process, a Bun process, a Deno process, or a serverless function is abstracted.
**Risk:** Low for the contract definition. Medium for implementation.
**Worth doing even without Bun/Deno:** **Yes** — especially for serverless deployment models.

---

## 6. New Architecture Candidates

### Candidate A: "ESM Boot" — Standard module entry point

**Core idea:** Replace the boot.js vm-eval loop with a generated ES module entry point. The bundler outputs `server/index.mjs` that imports each package as a real module in dependency order. No vm. No reify. No Module patching.

**What it preserves:**
- Build output structure (star.json, programs/)
- DDP, pub/sub, methods, accounts — all untouched
- Package dependency ordering
- `Npm` and `Assets` semantics (reimplemented as module imports)

**What it breaks:**
- boot.js is replaced entirely
- runtime.js is deleted
- Packages must be output as real ESM files, not wrapped strings
- `Npm.require()` becomes `import` or `createRequire()`
- source-map-support removed (use native)

**Why better than faithful porting:** Removes 100% of Module patching, 100% of vm usage, 100% of reify from the runtime. The server boot path becomes standard JavaScript that any runtime understands.

**Compatibility cost:** High for isobuild (bundler must generate ESM output). Zero for user code (packages still write `import`/`export`, it just works natively now).

**Migration difficulty:** 4-8 weeks for the bundler changes + new boot entry point. Requires a Meteor minor or major version.

**Helps:** Bun, Deno, and all future runtimes. Also helps Node (faster startup, better debugging).

---

### Candidate B: "Runtime Host Contract" — Pluggable server host

**Core idea:** Define an explicit contract between Meteor's application logic and its runtime host. The contract specifies: how to start an HTTP server, how to handle signals, how to access the filesystem, how to load modules. Each runtime provides a thin adapter.

```
MeteorApp ←→ HostContract ←→ NodeHost / BunHost / DenoHost / ServerlessHost
```

**What it preserves:**
- All of Meteor's application-level logic (DDP, accounts, Mongo, etc.)
- Package system and build output
- Developer experience

**What it breaks:**
- Direct `require('http')` in webapp — replaced by `Host.createServer()`
- Direct `process.on('SIGTERM')` — replaced by `Host.onShutdown()`
- Direct `cluster` import — replaced by `Host.isWorker()`
- Direct filesystem access in boot — replaced by `Host.loadModule()`

**Why better than faithful porting:** Makes runtime choice a configuration decision, not an architecture decision. Adding a new runtime becomes writing a thin adapter, not auditing the entire codebase.

**Compatibility cost:** Medium — webapp and boot.js need refactoring. User code is unaffected.

**Migration difficulty:** 6-12 weeks. Most time spent on defining the contract and testing edge cases.

**Helps:** All runtimes, and also serverless (Cloudflare Workers, Vercel Edge, etc.).

---

### Candidate C: "Lean Bundle" — Minimal runtime, no magic loading

**Core idea:** `meteor build` produces a bundle that looks like a normal Node/Bun/Deno application. No custom module loader. No boot.js orchestration. Just a `package.json` with `"type": "module"`, an `index.mjs` entry point, and standard `node_modules`. The consumer runs it like any other app.

**What it preserves:**
- Meteor's application semantics (DDP, reactivity, accounts)
- The build system (isobuild still handles compilation, but outputs standard format)

**What it breaks:**
- The entire custom runtime infrastructure (boot.js, runtime.js, npm-require.js, server-json.js)
- `Npm.require()` (replaced by standard import)
- The star.json / program.json metadata format
- npm-rebuild.js (standard npm install handles everything)
- The distinction between "Meteor bundle" and "normal Node app"

**Why better than faithful porting:** The built bundle is no longer a special format that only Meteor understands. It's a normal application. Any hosting platform, any runtime, any process manager can run it without Meteor-specific knowledge.

**Compatibility cost:** Very high for ecosystem tooling that expects the current bundle format. Galaxy deployment would need updating. Docker images would change.

**Migration difficulty:** 12-20 weeks. Fundamental change to build output.

**Helps:** Everything — Bun, Deno, serverless, edge, standard hosting. Also massively simplifies deployment documentation and debugging.

---

### Candidate D: "Incremental Decoupling" — Fix the worst coupling, keep the rest

**Core idea:** Don't redesign. Just fix the 3-4 worst Node-specific surfaces in the runtime, keeping everything else as-is. Specifically: (1) replace vm.runInThisContext with Function(), (2) remove Module.prototype patching, (3) make cluster import lazy, (4) use native source maps.

**What it preserves:** Almost everything. boot.js still loops through serverJson.load. npm-require.js still resolves modules. The bundle format is unchanged.

**What it breaks:** runtime.js is significantly simplified or removed. boot.js gets a small patch. source-map-support dependency is removed.

**Why better than faithful porting:** Removes the actual blockers without redesigning anything. Low risk, fast delivery.

**Compatibility cost:** Very low. Internal changes only.

**Migration difficulty:** 2-4 weeks.

**Helps:** Bun primarily. Deno partially (CJS flag requirement remains). But the value is limited — this is a tactical fix, not a strategic improvement.

---

## 7. What Should Never Be Carried Forward

### 7.1 vm.runInThisContext as a module loading mechanism
The vm module was designed for sandboxing and code evaluation, not for loading application modules. Using it for package loading was a reasonable hack in 2012 when ES modules didn't exist. Carrying it forward to any new runtime would be reproducing a historical accident.

### 7.2 Module.prototype monkey-patching
Patching Node's internal module APIs (`_compile`, `_extensions`, `_resolveFilename`) is inherently fragile. These APIs are not part of Node's public contract. Other runtimes explicitly don't implement them. Any code that depends on them is, by definition, non-portable.

### 7.3 Reify as a permanent layer
Reify transforms ES module syntax to CJS at load time. Every runtime Meteor will ever care about supports ESM natively. Reify should be treated as a compatibility layer for old packages, not a permanent part of the architecture.

### 7.4 Vendored runtime binary
Vendoring a specific Node binary solved a real problem (Fibers needed specific V8 versions). That problem is gone. The vendoring now creates more problems than it solves: stale versions, large downloads, confusion about which Node is being used.

### 7.5 Custom npm management (meteor-npm.js)
Shelling out to npm with specific flags, managing shrinkwrap files, version-checking npm — all of this duplicates what the ecosystem provides. The custom npm layer should be replaced with standard package.json dependencies.

### 7.6 Process-level coupling in boot.js
Parent PID polling, version-gating, debug-wait polling — these are dev-tool concerns mixed into the production boot path. They should be separated: production boot should be clean and minimal.

### 7.7 Implicit globals as the inter-package communication mechanism
`Package`, `__meteor_bootstrap__`, `__meteor_runtime_config__`, `global.Package` — the reliance on mutable global objects for inter-package communication is a code smell that was acceptable with vm-based loading but should not survive into an ESM world.

### 7.8 node-gyp as a runtime deployment dependency
Bundling node-gyp into every build output and running npm rebuild at deploy time assumes that the deployment environment has a C++ compiler. This fails in containers, serverless, and minimal environments. Native deps should be prebuilt or replaced with WASM.

---

## 8. Practical Modernization Track

### A. Worth doing even if Meteor stays on Node forever

| Refactor | Effort | Impact |
|---|---|---|
| **Replace vm.runInThisContext in boot.js with Function()** | 1-2 days | Removes fragile vm dependency. Simpler debugging. |
| **Use Node's --enable-source-maps instead of source-map-support** | 2-3 days | Removes a dependency and a V8-specific monkey-patch. |
| **Make cluster import lazy/conditional in webapp** | 1 hour | Reduces unnecessary module loading. Fixes Deno stubs issue. |
| **Extract shell-server from core into optional package** | 1-2 days | Reduces core surface area. Removes `net` + `repl` dependency from production. |
| **Remove parent PID polling from production boot path** | 1 hour | Cleaner production boot. Only needed for `meteor run` dev server. |
| **Remove semver version gate from boot.js** | 30 min | Let the runtime fail naturally on unsupported APIs. Or use feature detection. |
| **Add sourceURL pragmas to vm-evaluated code** | 1 hour | Better stack traces even on Node. Enables Function() fallback. |
| **Evaluate WASM alternatives for bcrypt/argon2** | 1 week | Removes native addon compilation from deployment. Huge DevOps win. |
| **Move toward ESM output from bundler** | 4-8 weeks | The big one. Makes all other modernization easier. Removes reify dependency. |

### B. Worth doing only if pursuing runtime portability

| Refactor | Effort | Impact |
|---|---|---|
| **Define a runtime host contract (HTTP, signals, module loading)** | 4-6 weeks | Required for multi-runtime support. Overkill if staying on Node. |
| **Build Bun/Deno adapters for the host contract** | 2-4 weeks each | Direct runtime support. No value on Node alone. |
| **Rewrite npm-require.js for standard module resolution** | 2-3 weeks | Current version works fine on Node. Only broken on other runtimes. |
| **Create Deno-specific build output with import maps** | 2-3 weeks | Deno-specific. |
| **CI matrix for multi-runtime testing** | 1-2 weeks | Only needed if officially supporting multiple runtimes. |

### C. Not worth doing

| Work | Why not |
|---|---|
| **Porting isobuild to Bun/Deno** | Enormous effort (vm-based plugin system). Build stays on Node; only runtime needs to be portable. |
| **Replacing npm with bun install in the toolchain** | Bun install has different semantics. Creates divergence without clear value. |
| **Full CJS→ESM conversion of tools/ directory** | Thousands of files. The build tooling doesn't need to be portable. |
| **Supporting both vm-based and ESM-based boot in parallel** | Dual code paths are worse than picking one. Ship the ESM boot, deprecate the old one. |
| **Building a universal runtime abstraction layer** | Over-engineering. Abstract only what's needed, not everything that could be abstracted. |
| **Porting dev bundle / meteor run to Bun/Deno** | The dev experience can stay on Node. Runtime portability matters for production deployment. |

---

## 9. Decision Framework

For each Meteor subsystem, apply this filter:

```
Is it visible to the user as a product feature or API?
├── YES → Does it depend on Node-specific internals?
│   ├── YES → ABSTRACT: Keep the API, replace the implementation
│   └── NO → PRESERVE: Port faithfully
└── NO → Is it an implementation detail of the server runtime?
    ├── YES → Is it still the best approach for its job?
    │   ├── YES → PRESERVE (but document the dependency)
    │   └── NO → REWRITE: Replace with a modern approach
    └── NO → Is it actively maintained and used?
        ├── YES → Evaluate case by case
        └── NO → DELETE
```

**Quick reference:**

| Signal | Decision |
|---|---|
| Users write code against it (API) | Preserve |
| Users don't know it exists (internal) | Fair game for rewrite |
| It's a polyfill for something the runtime now provides | Remove |
| It's a workaround for a limitation that no longer exists | Remove |
| It works but uses non-portable APIs | Abstract |
| It's complex and could be simpler with modern JS | Rewrite |
| It's only used in development, not production | Consider removing from production path |
| It has caused repeated bugs, confusion, or maintenance pain | Strong signal for rewrite |

---

## 10. Final Recommendation

### Port faithfully or modernize while migrating?

**Modernize while migrating. Not even close.**

A faithful port of Meteor's current runtime internals to Bun or Deno would produce a fragile, opaque system that inherits all the historical workarounds and adds new compatibility shims on top. It would be harder to maintain than the current Node-only system, not easier.

The Bun/Deno question is a forcing function for a conversation Meteor should be having regardless: **which internal mechanisms are worth their complexity, and which have outlived their original purpose?**

### Which parts deserve protection as core identity?

These are Meteor's soul. Touch them and you're building a different framework:

1. **DDP protocol** — data on the wire, pub/sub, methods
2. **Reactive data** — minimongo + Tracker on client, oplog/polling on server
3. **Isomorphic code** — same packages on client and server
4. **Optimistic UI** — method stubs and rollback
5. **Accounts system** — unified auth with pluggable strategies
6. **Zero-config development** — `meteor create && meteor run` works immediately
7. **Hot code push** — in dev and production

### Which parts should be considered fair game for redesign?

Everything else is implementation:

1. **Package loading model** — vm.runInThisContext can become standard ESM imports
2. **Module system integration** — reify/Module patching can become native ESM
3. **Boot sequence** — boot.js can become a clean module entry point
4. **HTTP hosting** — Express + http.createServer can become pluggable
5. **Native addon story** — node-gyp can become WASM or prebuilds
6. **Source map integration** — source-map-support can become runtime-native
7. **Bundle format** — can become a standard Node/Bun/Deno application structure
8. **Dev tooling runtime** — can stay on Node even if production runtime is portable

### What is the biggest mistake to avoid?

**Building compatibility glue instead of removing the need for it.**

The temptation will be to write shims: a vm shim for Bun, a Module._extensions shim for Deno, a source-map-support adapter for JSC. Each shim adds complexity, hides bugs, and creates a new maintenance surface.

The correct approach is the opposite: remove the code that needs shimming. Replace vm.runInThisContext with standard module loading. Replace Module patching with native ESM. Replace source-map-support with runtime-native source maps. Each removal makes Meteor simpler, more debuggable, and automatically portable — not just to Bun and Deno, but to whatever comes after them.

The biggest mistake would be to spend 6 months making Meteor's 2012 internals work on 2026 runtimes, when you could spend 3 months making Meteor's internals worthy of 2026.
