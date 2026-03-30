# Spike Journal — ESM Bundle Format

**Branch:** `spike/esm-bundle-format` (from `devel` @ 5d4893f51c)
**Goal:** `meteor build --format=esm` produces an `index.mjs` with static ESM imports
**Started:** 2026-03-30

---

## Step 1 — Understanding the current bundle generation

### 1.1 The complete code path

```
meteor build (CLI)
  → exports.bundle()                          bundler.js:3281
    → async function bundle()                 bundler.js:3285
      → makeServerTarget()                    bundler.js:3369
        → new ServerTarget()                  bundler.js:2771
      → target.make()
        → _determineLoadOrder()               bundler.js:932   ← topological sort of packages
        → _runCompilerPlugins()               bundler.js:857
        → _emitResources()                    bundler.js:1162  ← produces this.js[]
      → writeSiteArchive()                    bundler.js:3064
        → writeTargetToPath()                 bundler.js:3000
          → serverTarget.write(builder)       bundler.js:2792  ← writes boot.js, runtime.js, etc.
            → jsImage.write(builder)          bundler.js:2413  ← writes JS files + program.json
```

### 1.2 _mainJsContents — the main.js template

**File:** `tools/isobuild/bundler.js:208-214`

```js
exports._mainJsContents = [
  "",
  "process.argv.splice(2, 0, 'program.json');",
  "process.chdir(require('path').join(__dirname, 'programs', 'server'));",
  'require("./programs/server/runtime.js")({ cachePath: process.env.METEOR_REIFY_CACHE_DIR });',
  "require('./programs/server/boot.js');",
].join("\n");
```

This is the content of `main.js` at the root of the bundle. 6 lines. CJS require().

### 1.3 ServerTarget.write() — what gets copied into programs/server/

**File:** `tools/isobuild/bundler.js:2792-2906`

Files copied from `tools/static-assets/server/`:
- `boot.js` — main bootstrap, vm.runInThisContext loop
- `boot-utils.js` — utilities
- `debug.ts` — debugger pause
- `server-json.js` — reads program.json
- `mini-files.ts` — filesystem utilities
- `npm-require.js` — custom npm resolution
- `npm-rebuild.js` — native rebuild
- `npm-rebuild-args.js` — rebuild args
- `runtime.js` — Module.prototype patching + Reify
- `profile.ts` — profiling

Also:
- `config.json` (release, appId, client archs)
- `package.json` + `npm-shrinkwrap.json` (npm deps for the bundle)
- `node_modules/` (copied or symlinked)

Then calls `jsImage.write()` for the package JS files.

### 1.4 JsImageTarget.write() — program.json generation

**File:** `tools/isobuild/bundler.js:2413-2662`

Iterates over `this.jsToLoad[]` (the ordered list of JS files). For each file:
1. Writes the .js file to disk via `builder.writeToGeneratedFilename()`
2. Writes the source map if present
3. Writes associated static assets
4. Builds an item for the `load[]` array

Each item in `load[]`:
```json
{
  "path": "packages/meteor.js",
  "node_modules": { "meteor": "packages/node_modules/meteor" },
  "assets": { "file.txt": "assets/packages/meteor/file.txt" },
  "sourceMap": "packages/meteor.js.map"
}
```

Then writes program.json:
```js
await builder.writeJson('program.json', {
  format: "javascript-image-pre1",
  arch: self.arch,
  load: load
});
```

### 1.5 The load order — _determineLoadOrder()

**File:** `tools/isobuild/bundler.js:932-1083`

Topological sort in 2 phases:
1. **Phase 1**: Which packages are used? (follows `uses` recursively)
2. **Phase 2**: Topo sort — if X depends on Y, Y appears before X

Result: `this.unibuilds[]` — ordered list used subsequently by `_emitResources()`.

**IMPORTANT NOTE:** The dependency order is ALREADY computed by isobuild. We don't need to recompute it. We just need to emit it as ESM imports in the correct order.

### 1.6 How packages are wrapped — linker.js

**File:** `tools/isobuild/linker.js:661-689`

Two wrapping modes:

**IIFE mode (packages without modules):**
```js
(function(){
  // package code
}).call(this);
```

**Module mode (packages with meteorInstall):**
```js
function module(require, exports, module) {
  // package code
}
```

The linker does the wrapping. In the current runtime, boot.js iterates over program.json, reads each file, re-wraps it in an IIFE with `(function(Npm, Assets){...})`, and executes it via `vm.runInThisContext`.

### 1.7 Existing flags for the output format

**File:** `tools/isobuild/bundler.js:3285-3310`

Current `bundle()` options:
- `buildMode` : 'production' | 'development' | 'test'
- `minifyMode` : 'production' | 'development'
- `includeNodeModules` : false | 'symlink'
- `serverArch` : string
- `webArchs` : string[]

File formats:
- `program.json` : `"javascript-image-pre1"`
- `star.json` : `"site-archive-pre1"`

**No existing `--format` flag.** We'll need to add it.

### 1.8 Current output structure

```
bundle/
├── main.js                          ← _mainJsContents (6 lines CJS)
├── README
├── star.json                        ← global manifest
├── .node_version.txt
├── programs/
│   ├── server/
│   │   ├── boot.js                  ← copied from static-assets
│   │   ├── boot-utils.js
│   │   ├── runtime.js               ← copied from static-assets
│   │   ├── npm-require.js
│   │   ├── server-json.js
│   │   ├── mini-files.js
│   │   ├── debug.js
│   │   ├── npm-rebuild.js
│   │   ├── npm-rebuild-args.js
│   │   ├── profile.js
│   │   ├── config.json              ← appId, release, client archs
│   │   ├── program.json             ← load order manifest
│   │   ├── package.json             ← npm deps
│   │   ├── npm-shrinkwrap.json
│   │   ├── npm-rebuilds.json
│   │   ├── node_modules/            ← npm packages
│   │   ├── packages/
│   │   │   ├── meteor.js            ← meteor package code
│   │   │   ├── mongo.js
│   │   │   └── ...
│   │   ├── app/
│   │   │   └── app.js               ← application code
│   │   └── assets/
│   │       ├── packages/
│   │       └── app/
│   ├── web.browser/
│   └── web.browser.legacy/
```

---

## Step 2 — Intervention points for the ESM format

### 2.1 What needs to be modified

1. **`_mainJsContents`** (bundler.js:208) — New ESM version:
   - `index.mjs` instead of `main.js`
   - Static imports instead of require()

2. **`ServerTarget.write()`** (bundler.js:2792) — Don't copy boot.js, runtime.js, npm-require.js when format=esm. Only copy files that are still needed (npm-rebuild.js for postinstall).

3. **`JsImageTarget.write()`** (bundler.js:2413) — When format=esm:
   - Write each file as an ESM module (.mjs)
   - Generate `index.mjs` with imports in the order of `load[]`
   - Don't generate program.json (the order is in the imports)

4. **`writeSiteArchive()`** (bundler.js:3064) — Write `index.mjs` instead of `main.js`

5. **`File._getClosureHeader/Footer()`** (linker.js:661) — May not need to change if we keep the existing wrapping and emit it as an ESM module.

### 2.2 What should NOT be modified

- `_determineLoadOrder()` — the order is already correct
- `_emitResources()` — the resources are already correct
- `toJsImage()` — the intermediate serialization remains valid
- The package compilation pipeline
- The linker (except possibly the closures)
- The client targets

### 2.3 Key question to resolve

**The package code in the bundle is already compiled by Reify (imports → module.link).** In an ESM bundle, this code should be real ESM (native import/export). Two approaches:

**Approach A — Minimal:** Keep the code as-is (with module.link etc.) but wrap it in an ESM module. The internal code still uses Reify calls, but the module itself is a .mjs.

**Approach B — Clean:** Modify the compilation pipeline to emit real ESM instead of CJS+Reify. Much more work but cleaner result.

**For the spike: Approach A.** We keep the compiled code as-is, we only change the wrapper and the loading mechanism.

---

## Step 2b — Analysis of a real bundle (app --bare + webapp)

### 2b.1 Actual structure of a package file in the bundle

**Critical discovery:** Packages are NOT simple IIFEs. They use `Package["core-runtime"].queue()`:

```js
// packages/meteor.js — actual structure
Package["core-runtime"].queue("meteor", function () {
  /* Package-scope variables */
  var global, meteorEnv, Meteor, EmitterPromise;

  (function(){
    // ... global.js code ...
  }).call(this);

  (function(){
    // ... server_environment.js code ...
  }).call(this);

  // ... more files ...

  /* Exports */
  return {
    export: function () { return {
      Meteor: Meteor,
      global: global,
      meteorEnv: meteorEnv,
      EmitterPromise: EmitterPromise
    };}
  }
});
```

**And core-runtime.js** is loaded first, it creates `Package['core-runtime'] = { queue, waitUntilAllLoaded }`. It's an async queue system — packages register via `queue()` and are executed in order.

**Implication for the spike:** We can NOT just put `import` in front of each file. The package code is coupled to the `Package["core-runtime"].queue()` system. This system:
1. Queues packages by name
2. Executes them sequentially
3. Stores exports in `Package[name]`

For the minimal ESM approach (Approach A), we have two options:

**Option A1 — Keep core-runtime.queue():** The `index.mjs` loads core-runtime first, then imports the packages that use `queue()` as before. This is the path of least resistance. We only replace the loading mechanism (vm → import), not the registration mechanism.

**Option A2 — Rewrite the wrappers:** The linker emits real ESM (`export const Meteor = ...`) instead of `Package["core-runtime"].queue(...)`. Much more work.

**Decision: Option A1 for the spike.** We keep the queue system, we only change the loader.

### 2b.2 program.json — actual content

54 packages in a --bare + webapp app. Order:
```
1. core-runtime.js    ← creates Package['core-runtime'].queue()
2. meteor.js          ← registers via queue("meteor", ...)
3. meteor-base.js
4. mobile-experience.js
5. npm-mongo.js
...
50. minifier-css.js
51. hot-code-push.js
52. launch-screen.js
53. autoupdate.js
54. app/global-imports.js
```

### 2b.3 What boot.js does with these files (recap)

boot.js reads program.json, then for EACH file in `load[]`:
1. `fs.readFileSync(path)` — reads the content
2. Wraps in `(function(Npm, Assets, ...){ <content> })`
3. `vm.runInThisContext(wrapped, { filename })` — executes
4. Calls the resulting function with the appropriate args

**But** the file contents already contain `Package["core-runtime"].queue(...)`. So the boot.js wrapping adds an ADDITIONAL layer on top of the wrapping already done by the linker.

### 2b.4 What this means for the ESM spike

The simplest path:

```js
// index.mjs — replaces main.js + boot.js
import './__meteor_config.mjs';

// core-runtime MUST be loaded first — it creates Package['core-runtime'].queue()
import './packages/core-runtime.js';

// The other packages register via queue() — the import executes them
import './packages/meteor.js';
import './packages/meteor-base.js';
// ... 50+ imports in the order of program.json ...
import './app/global-imports.js';

// Wait for all async packages to load
const { waitUntilAllLoaded } = Package['core-runtime'];
const ready = waitUntilAllLoaded();
if (ready) await ready;

// Startup hooks
Meteor._runStartupHooks?.();
```

**The package code doesn't change.** They still use `queue()`. But instead of being loaded by boot.js via vm, they are loaded by `import` — the import executes the top-level code, which calls `queue()`, which registers the package.

**Advantage:** We don't touch the linker, the compiler, or the package format. We ONLY change the loading mechanism.

---

## Step 2c — Analysis of boot.js wrapping (Npm, Assets, specialArgs)

### 2c.1 The additional boot.js wrapping

boot.js adds a wrapping **around** the content of each file:

```js
// boot.js line 387-400: wrapping
const wrapped = "(function(Npm, Assets" + specialKeys + "){ " + code + "\n})";
const func = require('vm').runInThisContext(wrapped, { filename: scriptPath });
func.apply(global, [NpmObj, AssetsObj, ...specialValues]);
```

So the final executed code for `packages/webapp.js` is:

```js
(function(Npm, Assets) {
  Package["core-runtime"].queue("webapp", function() {
    // ... code that uses Npm.require('express/package.json') ...
  });
})(NpmObj, AssetsObj)
```

`Npm` is a parameter of the wrapper function. The internal code captures it by **closure**.

### 2c.2 The Npm object — what it contains

Created at boot.js:259 for EACH file in `serverJson.load`:

```js
const Npm = {
  require: function(name, error) {
    // 1. Looks in the node_modules specific to the package (fileInfo.node_modules)
    // 2. Looks in the global node_modules of the bundle
    // 3. Falls back to native require.resolve()
    // 4. Throws if not found
  }
};
```

**Critical point:** The `Npm` object is different for each file! It has a `nonLocalNodeModulesPaths` list specific to that package (based on `fileInfo.node_modules` from program.json).

### 2c.3 The Assets object — what it contains

Created at boot.js:356 for EACH file:

```js
const Assets = {
  getTextAsync(assetPath, callback) { ... },
  getBinaryAsync(assetPath, callback) { ... },
  absoluteFilePath(assetPath) { ... },
  getServerDir() { return serverDir; }
};
```

Resolves assets from `fileInfo.assets` (the map in program.json).

### 2c.4 specialArgPaths — arguments injected for only 2 packages

boot.js:197-222:

| Package | Injected argument | What it contains |
|---|---|---|
| `packages/modules-runtime.js` | `npmRequire`, `Profile` | The `require` function from npm-require.js + the profiler |
| `packages/dynamic-import.js` | `dynamicImportInfo` | Map of `dynamic/` paths per client architecture |

Only 2 packages out of 54 have special arguments.

### 2c.5 How many packages use Npm and Assets?

**Npm.require() — 8 packages out of 54:**
- meteor.js (4 usages: async_hooks, denque, url, events)
- npm-mongo.js (3: mongodb driver)
- modules-runtime.js (3: fallback require)
- ddp-server.js (3)
- socket-stream-client.js (2)
- webapp.js (1: express version)
- ecmascript-runtime-server.js (1)
- autoupdate.js (1)

**Assets — 1 package out of 54:**
- mongo.js (1 usage: path to a TLS/SSL file)

### 2c.6 The ESM problem and the solution

**PROBLEM:** If we do `import './packages/webapp.js'`, the code executes immediately. But `Npm` is not defined because there is no wrapper function passing it as a parameter. → `ReferenceError: Npm is not defined`.

**SIMPLEST SOLUTION: make Npm and Assets globals.**

```js
// In index.mjs, BEFORE the package imports
globalThis.Npm = { require: createNpmRequire(serverDir) };
globalThis.Assets = createAssets(serverDir);
```

Then packages do `Npm.require('express')` → looks up `globalThis.Npm`.

**Drawback:** Today each package has its own Npm object with specific resolution paths. As a global, all packages share the same Npm.

**But in practice:** The bundler already flattens `node_modules` into a single directory. The multi-path resolution of npm-require.js is mostly a legacy from the time when each package had its own `node_modules`. In a built bundle, a standard `require('express')` resolves correctly.

**SOLUTION CHOSEN for the spike:**

```js
// index.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.Npm = { require: (name) => require(name) };
globalThis.Assets = { /* ... */ };

// Then the package imports
import './packages/core-runtime.js';
import './packages/meteor.js';
// ...
```

### 2c.7 specialArgPaths — how to handle them in ESM

**modules-runtime.js** needs `npmRequire` and `Profile`. Solutions:
- `npmRequire` = the same `require` from node:module → `globalThis.npmRequire = require`
- `Profile` = the boot profiler → can be a no-op for the spike

**dynamic-import.js** needs `dynamicImportInfo`. Solution:
- Make it global: `globalThis.dynamicImportInfo = { server: { dynamicRoot: ... }, ... }`

### 2c.8 The complete boot.js flow that we're replacing

```
boot.js does:
1. Check Node version                          → DROP (engines in package.json)
2. Read program.json, config.json, star.json    → SIMPLIFY (config inline in index.mjs)
3. Setup __meteor_bootstrap__                   → KEEP (global)
4. Setup __meteor_runtime_config__              → KEEP (global)
5. Install source-map-support                   → DROP (native runtime)
6. Setup AsyncLocalStorage                      → KEEP
7. For each file in program.json:
   a. Read the file (fs.readFileSync)           → REPLACE with import
   b. Create file-specific Npm                  → REPLACE with global Npm
   c. Create file-specific Assets               → REPLACE with global Assets
   d. Wrap in (function(Npm,Assets){...})       → NO LONGER NEEDED
   e. vm.runInThisContext                       → NO LONGER NEEDED
   f. Call the function with args               → NO LONGER NEEDED
8. waitUntilAllLoaded()                         → KEEP
9. callStartupHooks()                           → KEEP
10. runMain()                                   → KEEP
```

---

## Step 2d — Micro-tests of import on a real bundle

### 2d.1 Test v2 — core-runtime + meteor (first results)

**Setup:** App `--bare` + webapp, `meteor build --directory`, `npm install`, then a `test-import.mjs` that sets up globals and imports packages one by one.

**Result:**
```
✅ core-runtime.js imported OK — creates Package['core-runtime'].queue()
✅ meteor.js imported OK — Meteor.isServer = true
```

**First discovery:** The bundle files ARE importable via `import`. The top-level code (which calls `Package["core-runtime"].queue(...)`) executes correctly.

**Problem encountered:** `meteor.js` fails on `Npm.require('denque')` because our global `Npm.require` doesn't resolve in the correct `node_modules`. Each package has its own `node_modules` path defined in `program.json` (e.g., `npm/node_modules/meteor/meteor/node_modules` for the meteor package).

### 2d.2 Test v3 — contextual resolution per package

**Solution:** Read `program.json`, build a map `packagePath → node_modules[]`, and set `currentPackagePath` before each import so that `Npm.require` knows where to look.

**Result:** 53/54 packages imported successfully. The only failure: `modules.js` which uses `npmRequire` (not `Npm.require`) with an absolute virtual path `/node_modules/meteor/modules/node_modules/@meteorjs/reify/...`.

### 2d.3 Test v4 — absolute virtual paths

**Critical discovery: `meteorInstall` and virtual paths**

The Meteor module system (`modules-runtime.js`) creates a virtual filesystem where each package lives in `/node_modules/meteor/<package>/`. When a package does `require('@meteorjs/reify')`, `meteorInstall` resolves it as `/node_modules/meteor/modules/node_modules/@meteorjs/reify/...`.

The `useNode()` function in modules-runtime.js (line 731-751) calls `npmRequire(this.id)` with this absolute virtual path. It's `npmRequire` (injected by boot.js as a specialArg) that does the mapping to the real path on disk.

**Partial solution:** Our `contextualRequire` strips the `/node_modules/meteor/<pkg>/node_modules/` prefix and resolves the rest via `createRequire` from the correct package `node_modules`.

**Result:** 53/54, `modules.js` passes now. Remaining failure: `react-fast-refresh.js` (same virtual path problem for `react-refresh/babel.js`).

### 2d.4 Test v5 — dependency cascade

**Problem:** `react-fast-refresh` fails → `ecmascript` depends on `ReactFastRefresh` → `base64` depends on `ECMAScript` → cascade.

The core-runtime queue is **sequential**: if a package fails, the following packages never execute. `react-fast-refresh` is at index 7 out of 54, so 47 packages are never executed by the queue.

**The problem isn't the import** (53/54 import successfully). The problem is that **the virtual path resolver** (`npmRequire` / `contextualRequire`) doesn't resolve all patterns correctly.

### 2d.5 Diagnosis: why we're reproducing boot.js

**Observation:** We're rewriting the resolution logic of boot.js's `npmRequire`. That's exactly what we wanted to avoid.

**The root cause:** The package code in the bundle uses `meteorInstall` (from modules-runtime) which creates a virtual filesystem with paths like `/node_modules/meteor/X/node_modules/Y`. When a module does `require('Y')`, `meteorInstall` resolves it in the virtual filesystem, and when the module isn't in the bundle (it's a real npm package), it calls `useNode()` which calls `npmRequire(absoluteVirtualPath)`.

boot.js's `npmRequire` knows how to map a virtual path to a real disk path because it has the `nonLocalNodeModulesPaths` from `program.json`. Our simplified version doesn't cover all patterns.

### 2d.6 Decision: 2 strategies, 2 horizons

**For the spike (now): Option 2 — Rewritten minimal resolver**

Instead of copying the complex logic of boot.js, write a minimal resolver that:
1. Takes the paths from `program.json`
2. Maps virtual paths `/node_modules/meteor/X/node_modules/Y` → real path `npm/node_modules/meteor/X/node_modules/Y`
3. Falls back to the global `node_modules/` of the bundle

It's cleaner than copying boot.js but it's still a custom resolver.

**For the destination (later): Option 3 — The bundler emits real paths**

The real solution: modify the **linker/bundler** so that the packages emitted in the bundle don't use virtual paths. Instead of:
```js
meteorInstall({"node_modules":{"meteor":{"modules":{"server.js": function(require) { ... }}}}})
```

The bundler would emit real ESM modules with actual relative imports:
```js
// packages/modules.mjs
import reify from '../npm/node_modules/meteor/modules/node_modules/@meteorjs/reify/lib/runtime/index.js';
```

This completely eliminates `meteorInstall`, `npmRequire`, `useNode`, and the virtual filesystem. But it's a change in the **linker** (`tools/isobuild/linker.js`), not just in the output format.

**Critical path:**
- Spike (option 2) → validates that the bundle IS importable with a minimal resolver
- If validated → option 3 modifies the linker to make the resolver unnecessary
- Final result: real ESM modules without any custom resolver

---

## Step 2e — RESULT: the bundle IS importable

### Test v6 — minimal resolver + all globals

**Result:**
```
54/54 packages imported ✅
54 packages registered in Package ✅
Meteor.isServer = true ✅
webapp loaded ✅
mongo loaded ✅
ddp-server loaded ✅
```

The initial crash (before ROOT_URL) was `Must pass options.rootUrl or set ROOT_URL` — this is the **normal** behavior of webapp starting up. With `ROOT_URL=http://localhost:3000`, everything passes.

### What was needed to make it work

1. **Globals to set before the imports:**
   - `__meteor_bootstrap__` (startupHooks, serverDir, configJson)
   - `__meteor_runtime_config__` (meteorRelease, gitCommitHash)
   - `process.env.APP_ID`
   - `__METEOR_ASYNC_LOCAL_STORAGE` (AsyncLocalStorage)

2. **Global Npm.require** (replaces boot.js's closure injection)
   - Must resolve virtual paths `/node_modules/meteor/X/node_modules/Y`
   - Must resolve standard module names (`express`, `denque`, etc.)
   - Must have a `.resolve()` for `useNode()` in modules-runtime

3. **Global npmRequire** (specialArg for modules-runtime)
   - Same function as Npm.require

4. **Global Profile** (specialArg for modules-runtime)
   - No-op for the spike: `function(name, fn) { return fn || function(){}; }`

5. **Global dynamicImportInfo** (specialArg for dynamic-import)
   - Map of `dynamic/` paths per architecture

6. **Global Assets** (replaces boot.js's closure injection)
   - Stubs for the spike (the --bare app doesn't use Assets)

### The minimal resolver — ~50 lines

The core: map meteorInstall's virtual paths to real disk paths.

Main pattern: `/node_modules/meteor/X/node_modules/Y` → resolved via `createRequire` from package X's `node_modules` (defined in `program.json`).

Fallback: the bundle's global `node_modules/`.

### What remains to be done for the full spike

- [ ] Test that the HTTP server actually listens (PORT=3000, curl)
- [ ] Test with an app that has application code (not just --bare)
- [ ] Test with accounts-password
- [ ] Test with MongoDB (MONGO_URL)
- [ ] Integrate this loader into the bundler (generated index.mjs)
- [ ] Test under Bun

### Conclusion of the exploratory phase

**The current Meteor server bundle IS importable via ESM** with:
- ~10 lines of global setup
- ~50 lines of resolver for meteorInstall virtual paths
- No modification to the package code
- No modification to the linker
- No modification to the compiler

The proof of concept is validated. The spike can move on to implementation in the bundler.

---

## Step 2f — The HTTP server boots and responds

### Full server test

Added the post-loading sequence (copied from boot.js):
1. `waitUntilAllLoaded()` — waits for the core-runtime queue to finish
2. Execution of `startupHooks` — `__meteor_bootstrap__.startupHooks`
3. `runMain()` — finds and calls `main()` exported by the packages

**Result:**
```
Importing 54 packages...
All packages imported.
All packages registered.
Startup hooks executed.
Running main()...
Server started (DAEMON mode).

=== HTTP RESULT: 200 ===
```

**The Meteor server boots entirely via an ESM script (`import`) and responds HTTP 200 on `curl http://localhost:4000/`.**

Without MongoDB (no MONGO_URL), without application code (app --bare), but the HTTP server works.

### What test-server.mjs does (the complete "ESM boot")

```
1. Setup globals (~15 lines)
   __meteor_bootstrap__, __meteor_runtime_config__, Npm, Assets,
   npmRequire, Profile, dynamicImportInfo, AsyncLocalStorage

2. Import the 54 packages via `await import()` (~5 lines of loop)
   program.json provides the order
   currentPackagePath allows the contextual resolver to work

3. waitUntilAllLoaded() (~2 lines)
   The core-runtime queue executes each package sequentially

4. Startup hooks (~4 lines)
   Same logic as boot.js:448-457

5. runMain() (~10 lines)
   Finds main() in the package exports, calls it
   Returns 'DAEMON' → the server stays alive
```

**Total: ~100 lines of JS replace boot.js (510 lines) + runtime.js (152 lines) + npm-require.js (~200 lines) + program.json.**

### Next steps

- [ ] Test under Bun (`bun test-server.mjs`)
- [ ] Test with MONGO_URL (real MongoDB)
- [ ] Test with an app that has code (not --bare)
- [ ] Integrate into the bundler (generate index.mjs automatically)

---

## Step 3 — Bun test

### 3.1 First attempt — ReferenceError strict mode

**Bun 1.2.4.** First attempt with `test-server.mjs`: crash on `app/global-imports.js`.

```
ReferenceError: Can't find variable: Mongo
  at app/global-imports.js:4:1
```

**Cause:** `global-imports.js` does implicit global assignments (`Mongo = Package.mongo.Mongo` without `var`/`let`/`const`). Bun executes in **strict mode** where implicit assignments are illegal. Node doesn't crash because `.js` files are treated as CJS (non-strict mode) even when imported via `import()`.

**This is NOT a deep Bun problem** — it's a file generated by the Meteor bundler that assumes a non-strict environment. The fix is trivial.

### 3.2 Fix — pre-declaration of globals

Solution: read `global-imports.js`, extract variable names with a regex, pre-declare them on `globalThis` before the imports.

```js
const src = fs.readFileSync(globalImportsPath, 'utf8');
const matches = src.matchAll(/^(\w+)\s*=\s*Package/gm);
for (const m of matches) {
  if (!(m[1] in globalThis)) globalThis[m[1]] = undefined;
}
```

~5 lines of fix. Not a shim, not an emulation — just a pre-declaration.

### 3.3 Result — Bun HTTP 200 ✅

```
Importing 54 packages...
All packages imported.
All packages registered.
Startup hooks executed.
Server started (DAEMON mode).

=== BUN HTTP RESULT: 200 ===
```

**The Meteor server boots under Bun 1.2.4 and responds HTTP 200.**

### 3.4 Summary: Node vs Bun

| | Node | Bun |
|---|---|---|
| Import of 54 packages | ✅ | ✅ |
| core-runtime queue | ✅ | ✅ |
| Packages registered | 54/54 | 54/54 |
| Startup hooks | ✅ | ✅ |
| main() DAEMON | ✅ | ✅ |
| HTTP 200 | ✅ | ✅ |
| Specific fix needed | None | Pre-declaration of globals (~5 lines) |

### 3.5 Bun observation

The only Bun-specific problem is the strict mode for `global-imports.js`. This is a file **generated by the bundler** — the permanent fix is in the bundler (emit `globalThis.Mongo = ...` instead of `Mongo = ...`), not in the loader.

For the destination (option 3 — the bundler emits real ESM modules), `global-imports.js` disappears entirely because the imports become `import { Mongo } from './packages/mongo.mjs'`.

---

## Step 4 — Full app (--full) with MongoDB

### 4.1 App tested

`meteor create --full` generates an app with: Blaze, FlowRouter, jQuery, Less, MongoDB, Rspack, Mocha, shell-server, accounts. **67 packages** in the bundle.

### 4.2 Node result

```
MONGO_URL=mongodb://localhost:27099/esm-spike ROOT_URL=http://localhost:4010 PORT=4010 node test-full.mjs

Importing 67 packages...
All packages imported.
All packages registered.
Startup hooks executed.
Server started (DAEMON mode).

=== NODE: HTTP 200, body 1722 bytes ===
```

### 4.3 Bun result

Same fix as the --bare app (implicit globals in strict mode) but extended to ALL files in the bundle (not just `global-imports.js` — `app/app.js` has the same pattern).

The generic fix (~10 lines) scans all `.js` files in `packages/` and `app/` to pre-declare globals on `globalThis`.

```
MONGO_URL=mongodb://localhost:27099/esm-spike-bun ROOT_URL=http://localhost:4011 PORT=4011 bun test-full-v2.mjs

Importing 67 packages...
All packages imported.
All packages registered.
Startup hooks executed.
Server started (DAEMON mode).

=== BUN: HTTP 200, body 1722 bytes ===
```

### 4.4 Summary table

| | App --bare (54 pkg) | App --full (67 pkg) |
|---|---|---|
| **Node** | ✅ HTTP 200 | ✅ HTTP 200, 1722 bytes |
| **Bun** | ✅ HTTP 200 | ✅ HTTP 200, 1722 bytes |
| **MongoDB** | Not tested | ✅ Connection OK |
| **Blaze** | N/A | ✅ Loaded |
| **FlowRouter** | N/A | ✅ Loaded |
| **Rspack** | N/A | ✅ Loaded |

### 4.5 Extended Bun fix

The Meteor bundler generates implicit global assignments (`Mongo = Package.mongo.Mongo`) in ALL files that have imported globals — not just `global-imports.js` but also `app/app.js` and potentially others.

**Runtime fix (spike):** Scan all `.js` files in the bundle and pre-declare the variables.

**Permanent fix (bundler):** Emit `globalThis.Mongo = ...` instead of `Mongo = ...`. Or better: for the ESM format (option 3), these assignments become `import { Mongo } from './packages/mongo.mjs'` and the problem disappears.

---

## Step 5 — Cold start benchmark

### 5.1 Results (app --full, 67 packages, MongoDB)

3 runs each, `performance.now()` in the script, RSS measurement.

| Runtime | Setup | Import | Queue | Startup | Main | **Total** | **RSS** |
|---|---|---|---|---|---|---|---|
| **Node** run 1 | 52ms | 673ms | 0ms | 32ms | 1ms | **758ms** | 135 MB |
| **Node** run 2 | 22ms | 543ms | 0ms | 27ms | 1ms | **593ms** | 138 MB |
| **Node** run 3 | 26ms | 699ms | 0ms | 32ms | 1ms | **758ms** | 136 MB |
| **Bun** run 1 | 15ms | 567ms | 0ms | 38ms | 4ms | **624ms** | 136 MB |
| **Bun** run 2 | 18ms | 810ms | 0ms | 49ms | 5ms | **883ms** | 138 MB |
| **Bun** run 3 | 15ms | 633ms | 0ms | 43ms | 5ms | **696ms** | 139 MB |

**Observations:**
- Setup: Bun slightly faster (15ms vs 22-52ms)
- Import: comparable, high variability on both sides
- Total: in the same range (600-880ms), no significant gap
- RSS: identical (~136-139 MB)
- Queue = 0ms because the packages are all synchronous in this app

**Benchmark conclusion:** No major Bun gain in cold start for this workload. The dominant time is the import of the 67 packages (~600ms), identical on both runtimes. The Bun gain would be more visible with Bun.serve() (not http.createServer) and for high-throughput HTTP workloads.

---

## Step 6 — DDP smoke test

### 6.1 Node — DDP OK ✅

```
WebSocket open
← connected
✅ DDP connected, session: nzJhMa3Bs3MX7oKD7
← result (id=1) ERROR: Method 'nonexistent.method' not found [404]
✅ Method result received
← nosub (id=sub1) ERROR: Subscription 'nonexistent.pub' not found [404]
✅ Subscription response received

=== DDP SMOKE TEST PASSED ===
```

Handshake DDP, method call, subscription — everything passes on Node.

### 6.2 Bun — WebSocket upgrade doesn't work ❌

- HTTP: ✅ 200
- WebSocket upgrade: ❌ timeout, no response to the handshake

**Cause:** Bun doesn't fully support the `upgrade` event of `http.createServer`. SockJS (and the ws/faye transports from PR #14231) mount the WebSocket via this event. Bun expects WebSockets to be handled via `Bun.serve({ websocket: { ... } })`.

**This is NOT a bug in our spike.** It's a known Bun limitation with `http.createServer` + upgrade. The fix would be:
1. Use `Bun.serve()` instead of `http.createServer` (= the ServerHost abstraction from section 7 of the capability model)
2. Or wait for Bun to improve `http.createServer` upgrade compatibility

**Impact:** Under Bun, the HTTP server works but DDP (WebSocket) doesn't work. This is consistent with the analysis: the HTTP server and the DDP transport are the only two concerns that require a runtime-specific abstraction.

### 6.3 DDP summary

| | Node | Bun |
|---|---|---|
| HTTP | ✅ 200 | ✅ 200 |
| WebSocket open | ✅ | ❌ timeout |
| DDP connect | ✅ | ❌ |
| DDP method | ✅ | ❌ |
| DDP subscription | ✅ | ❌ |

---

## Step 7 — Bun.serve() + native WebSocket DDP

### 7.1 Spike architecture

```
Client (browser or test)
    │
    ▼ port 4071
Bun.serve()
    ├── HTTP → proxy fetch() to port 4070 (webapp Express)
    └── WebSocket → bridge to StreamServer from ddp-server
            │
            ▼
    EventEmitter socket compatible with SockJS
    (send, write, on('data'), on('close'))
            │
            ▼
    StreamServer.registration_callbacks
            │
            ▼
    DDP Server (livedata_server.js)
```

### 7.2 The socket interface for the StreamServer

The DDP server expects a socket with:
- `.on('data', cb)` — receives DDP messages (JSON strings)
- `.on('close', cb)` — disconnection
- `.send(data)` / `.write(data)` — sends DDP messages
- `._meteorSession` — null initially, assigned by the DDP server
- `.setWebsocketTimeout(ms)` — for SockJS timeouts (no-op for us)

Implementation: a Node `EventEmitter`, with `.send()` that calls `ws.send()` from Bun's WebSocket.

### 7.3 Accessing the StreamServer

`Package['ddp-server'].DDPServer` doesn't expose `stream_server` directly.
The right path: **`Package.meteor.Meteor.server.stream_server`** (the Meteor.server is a `Server` created at ddp-server.js:2135).

`streamServer.registration_callbacks` contains the callback that sets up the DDP handler (parseDDP, processMessage, etc.).
`streamServer.open_sockets` tracks the open sockets.

### 7.4 Result

```
=== HTTP ===
HTTP: 200

=== DDP ===
WebSocket open
← connected
✅ DDP connected, session: eaaapFB6uWjZ9MyJv
← result (id=1) ERROR: Method 'nonexistent.method' not found [404]
✅ Method result received
← nosub (id=sub1) ERROR: Subscription 'nonexistent.pub' not found [404]
✅ Subscription response received

=== DDP SMOKE TEST PASSED ===
```

### 7.5 Full summary Node vs Bun

| | Node (ESM loader) | Bun (ESM loader) | Bun (+ Bun.serve()) |
|---|---|---|---|
| Import 67 packages | ✅ | ✅ | ✅ |
| core-runtime queue | ✅ | ✅ | ✅ |
| HTTP 200 | ✅ | ✅ | ✅ (proxy) |
| WebSocket open | ✅ | ❌ (http upgrade) | ✅ (native) |
| DDP connect | ✅ | ❌ | ✅ |
| DDP method | ✅ | ❌ | ✅ |
| DDP subscription | ✅ | ❌ | ✅ |
| MongoDB | ✅ | ✅ | ✅ |

### 7.6 What this means

The Bun spike is **functionally complete**: HTTP + DDP + MongoDB under Bun.

The Bun.serve() as proxy architecture is a viable pattern that could become a 5th pluggable transport in PR #14231, or a variant of the abstract ServerHost.

The EventEmitter bridge is minimal (~15 lines). It doesn't shim anything — it translates the Bun WebSocket interface into the socket interface that the StreamServer already expects.

### 7.7 Notes for the destination

For real Bun support in production, `Bun.serve()` should not be a proxy in front of webapp. It should BE the main server:
- Direct HTTP via fetch handler (no proxy to Express)
- Native WebSocket (no bridge)
- Express middleware replaced by fetch handlers

This is the ServerHost abstraction from the capability model — but for the spike, the proxy is sufficient to prove that DDP works.

---

## Step 8 — Consolidation tests (real app: publications + accounts + reconnection + soak)

### 8.1 Test app

`meteor create --full` + `accounts-password` + custom collection/publication/methods. **74 packages** in the bundle.

Server code:
- `Tasks` collection with `tasks.insert` and `tasks.count` methods
- `Meteor.publish('tasks.all')` returning `Tasks.find()`
- `accounts-password` with email/password login

### 8.2 Results

**Node: 13/13 passed ✅**
**Bun: 13/13 passed ✅**

| Test | Node | Bun |
|---|---|---|
| DDP connect | ✅ | ✅ |
| Method `tasks.insert` → returns id | ✅ | ✅ |
| Subscription `tasks.all` → receives document with correct text | ✅ | ✅ |
| Method `tasks.count` → returns correct count | ✅ | ✅ |
| `createUser` → account created | ✅ | ✅ |
| `login` → token returned | ✅ | ✅ |
| Authenticated method call → has userId | ✅ | ✅ |
| WebSocket close + reconnect → new session | ✅ | ✅ |
| Method call after reconnect → works | ✅ | ✅ |
| Soak 15s (74 method calls) → RSS stable | ✅ (delta: -2MB) | ✅ (delta: -2MB) |

### 8.3 What this proves beyond the basic spike

- **Real Meteor data flow works**: insert → MongoDB → publication → DDP `added` → client receives document
- **Accounts system works**: createUser, login with SHA-256 password digest, token-based auth, userId in method context
- **WebSocket reconnection works**: close, wait, reconnect, new session, methods still work
- **No memory leak over 15s**: RSS stable on both runtimes (74 insert calls)
- **74 packages** (including Blaze, FlowRouter, accounts-password, jQuery, Less, Rspack) all boot and function

---

## Step 9 — Next steps

- [ ] Integrate the ESM loader into the bundler (`meteor build --format=esm`)
- [ ] Consider Bun.serve() as 5th transport in PR #14231
- [ ] Write-up for Meteor forum
- [ ] Longer soak test (30min+) to check MongoDB leak under Bun

---

## Observations and discoveries

- The dependency order is **already computed** by isobuild in `_determineLoadOrder()`. It's a topological sort. We don't need to redo it.
- `JsImageTarget.write()` already iterates over `this.jsToLoad[]` in the correct order. That's where we generate the ESM imports.
- The `"javascript-image-pre1"` format in program.json suggests that a v2 format was envisioned but never implemented.
- `npm-rebuild.js` is executed in postinstall (not at boot), so it remains necessary even in ESM.
- Static assets (package private files) are copied into `assets/` and referenced in program.json. In ESM, an alternative mechanism for `Assets.getText()` will be needed.
- **CRITICAL:** Packages use `Package["core-runtime"].queue()` to register, not simple IIFEs. The core-runtime queue system is the real orchestration mechanism. boot.js only loads the files — it's queue() that manages the execution order.
- The .js files in the bundle are already executable as-is — their content calls `queue()` at the top level. A simple `import './packages/meteor.js'` should be enough to trigger registration.
- 54 packages for a --bare + webapp app. That's a lot but expected (meteor-base pulls in the entire ecosystem).
- The `"javascript-image-pre1"` format in program.json never had a "pre2". It's the only format since creation.
- boot.js adds an ADDITIONAL wrapping `(function(Npm, Assets){...})` around the file contents. This wrapping injects Npm and Assets. In ESM, another mechanism will be needed for these two objects.
- **CRITICAL:** The virtual filesystem of `meteorInstall` (modules-runtime) is the real obstacle. Packages don't just do `require('express')` — they go through a virtual tree `/node_modules/meteor/X/node_modules/Y` resolved by `meteorInstall` + `npmRequire`. It goes deeper than the boot.js wrapping.
- **Two clear horizons:** Spike = minimal resolver (option 2, fast). Destination = the bundler emits real paths (option 3, clean, modifies the linker).
- The bundle files are importable — 53/54 pass the import. The blocker is in the EXECUTION of the core-runtime queue when a package has a `require()` that goes through the virtual filesystem and our resolver doesn't cover the pattern.
- `react-fast-refresh` is at index 7/54 in the load order. Its failure blocks the 47 following packages because the core-runtime queue is sequential.
- `Package._define(name, exports)` is called by the queue AFTER the successful execution of a package. That's why we only see 7 registered packages despite 53 successful imports — the import loads the code but the queue doesn't execute it as long as the previous one hasn't finished.
