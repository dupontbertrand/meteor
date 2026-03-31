# Bundler Integration Journal — `meteor build --format=esm`

**Branch:** `spike/esm-bundle-format`
**Goal:** `meteor build --format=esm` generates `index.mjs` + ESM loader instead of `main.js` + boot.js + runtime.js
**Prerequisite:** Spike validated (13/13 consolidation tests pass on Node + Bun)
**Started:** 2026-03-31

---

## Step 1 — Understanding the bundler output code path

### 1.1 Points of intervention in bundler.js

From the spike journal, we identified these key locations:

| Location | What it does | What we change for ESM |
|---|---|---|
| `bundler.js:208-214` | `_mainJsContents` — template for main.js | Generate `index.mjs` content instead |
| `bundler.js:2792-2906` | `ServerTarget.write()` — copies boot.js, runtime.js, etc. | Skip these files when format=esm |
| `bundler.js:2413-2662` | `JsImageTarget.write()` — writes package files + program.json | Keep program.json (resolver needs it) |
| `bundler.js:3064-3208` | `writeSiteArchive()` — writes main.js + star.json | Write index.mjs instead of main.js |
| `bundler.js:3281-3310` | `exports.bundle()` — entry point, accepts options | Add format option |

### 1.2 Code read — what we found

**`writeSiteArchive()` (line 3064):**
- Creates the top-level builder
- Writes `main.js` at line 3124 using `exports._mainJsContents`
- Writes `README` with `node main.js` instructions
- Calls `writeTargetToPath()` for each target
- Writes `star.json`

**Key observation:** `writeSiteArchive` receives its options from `bundle()` (line 3285). The `buildOptions` object is where we'd add `format: 'esm'`. It flows: `bundle()` → `writeSiteArchive()` → `writeTargetToPath()` → `target.write()`.

**`ServerTarget.write()` (line 2792):**
- Writes `config.json` (meteorRelease, appId, clientArchs)
- Writes `package.json` + `npm-shrinkwrap.json` for npm deps
- Handles `node_modules` (symlink or copy)
- Calls `jsImage.write()` for the actual package files + program.json
- Copies boot files at lines 2868-2888:
  ```
  boot.js, boot-utils.js, debug.ts, server-json.js,
  mini-files.ts, npm-require.js, npm-rebuild.js,
  npm-rebuild-args.js, runtime.js
  ```
- Also copies `profile.ts` from tool-env (line 2861-2865)
- Returns `{ controlFile: 'boot.js' }`

**For ESM format, we need to:**
1. Skip copying: boot.js, boot-utils.js, debug.ts, server-json.js, mini-files.ts, npm-require.js, runtime.js, profile.ts
2. Keep copying: npm-rebuild.js, npm-rebuild-args.js (needed for postinstall)
3. Keep: config.json, package.json, npm-shrinkwrap.json, node_modules
4. Keep: jsImage.write() (writes program.json + package files — we need both)

**`writeSiteArchive()` changes for ESM:**
1. Write `index.mjs` instead of `main.js` (line 3124)
2. Write updated README with `node index.mjs` / `bun index.mjs`

---

## Step 2 — Implementation plan

### 2.1 Changes needed (4 locations)

**1. `exports.bundle()` / `bundle()` (line 3285):**
Pass `buildOptions.format` through to `writeSiteArchive()`.

**2. `writeSiteArchive()` (line 3064):**
- Accept `format` option
- When `format === 'esm'`: write `index.mjs` instead of `main.js`, write ESM README
- Pass `format` to `writeTargetToPath()`

**3. `ServerTarget.write()` (line 2792):**
- Accept `format` option
- When `format === 'esm'`: skip boot.js/runtime.js/etc., write `esm-loader.mjs` instead
- Return `{ controlFile: 'index.mjs' }` instead of `{ controlFile: 'boot.js' }`

**4. `_mainJsContents` → `_esmIndexContents`:**
New template for `index.mjs` that embeds the ESM loader logic.

### 2.2 What NOT to change

- `JsImageTarget.write()` — keep program.json generation intact
- `_determineLoadOrder()` — load order stays the same
- `_emitResources()` — resource emission stays the same
- Linker — no changes
- Compiler — no changes
- Client targets — no changes

### 2.3 The ESM index.mjs template

The `esm-loader.mjs` from our spike, inlined into the generated `index.mjs`. It needs to:
1. Read program.json to get the load order and node_modules paths
2. Setup globals
3. Import packages in order
4. Wait for core-runtime queue
5. Run startup hooks
6. Run main()

---

## Step 3 — Implementation

### 3.1 Files modified

| File | Change |
|---|---|
| `tools/isobuild/bundler.js:214+` | Added `_esmIndexContents` template for `index.mjs` |
| `tools/isobuild/bundler.js` writeSiteArchive | Accept `format` option, write `index.mjs` + ESM README when `format=esm` |
| `tools/isobuild/bundler.js` writeTargetToPath | Pass `format` through to `target.write()` |
| `tools/isobuild/bundler.js` ServerTarget.write | Accept `format`, skip boot/runtime files when ESM, copy `esm-loader.mjs` instead |
| `tools/isobuild/bundler.js` ServerTarget.write | Return `controlFile: 'esm-loader.mjs'` when ESM |
| `tools/isobuild/bundler.js` bundle→writeOptions | Pass `buildOptions.format` through |
| `tools/cli/commands.js` buildCommands.options | Added `format: { type: String }` CLI option |
| `tools/cli/commands.js` buildCommand | Pass `options.format` to `buildOptions` |
| `tools/static-assets/server/esm-loader.mjs` | NEW — the ESM loader (copied from spike) |

### 3.2 Flow of the format option

```
meteor build --format=esm ../output --directory
  → commands.js: options.format = 'esm'
  → bundler.bundle({ buildOptions: { format: 'esm' } })
  → writeOptions.format = 'esm'
  → writeSiteArchive(..., { format: 'esm' })
    → writes index.mjs instead of main.js
    → writes ESM README
  → writeTargetToPath(..., { format: 'esm' })
    → target.write(builder, { format: 'esm' })
      → ServerTarget.write: skips boot.js/runtime.js, copies esm-loader.mjs
      → returns { controlFile: 'esm-loader.mjs' }
```

---

## Step 4 — Testing

### 4.1 Build with --format=esm

```bash
cd /tmp/esm-spike/spike-app  # --bare + webapp app
/home/ber/Tech/meteor/meteor build --format=esm --directory ../esm-bare-output
```

**Build succeeds.** Output structure:

```
bundle/
├── index.mjs              ← NEW (replaces main.js)
├── README                 ← Updated with node/bun instructions
├── star.json
├── programs/
│   └── server/
│       ├── esm-loader.mjs ← NEW (replaces boot.js + runtime.js)
│       ├── npm-rebuild.js  ← Kept (postinstall)
│       ├── npm-rebuild-args.js
│       ├── config.json
│       ├── program.json   ← Kept (load order for resolver)
│       ├── package.json
│       ├── npm-shrinkwrap.json
│       ├── packages/      ← Unchanged
│       ├── app/            ← Unchanged
│       ├── assets/         ← Unchanged
│       └── npm/            ← Unchanged
```

**Absent (as intended):** boot.js, boot-utils.js, runtime.js, npm-require.js, server-json.js, mini-files.js, debug.js, profile.js

### 4.2 Boot results

| Runtime | Command | HTTP |
|---|---|---|
| Node | `node index.mjs` | ✅ 200 |
| Bun | `bun index.mjs` | ✅ 200 |

### 4.3 Note on --full app with Rspack

The `--full` template uses Rspack which crashes when built from our Meteor checkout (not related to our changes — same crash without `--format`). The `--bare` + webapp app works fine. This is a pre-existing issue with building from checkout.

### 4.4 Verification: legacy format unchanged

`meteor build --directory ../legacy-output` (without `--format=esm`) still produces the standard `main.js` + `boot.js` + `runtime.js` structure. No regression.

---

## Summary

`meteor build --format=esm` is implemented and working:
- 9 files modified (bundler.js, commands.js, new esm-loader.mjs)
- The `--format=esm` flag is fully opt-in — legacy builds are unaffected
- The generated `index.mjs` is 7 lines, delegates to `esm-loader.mjs`
- `esm-loader.mjs` is the spike's proven loader (~100 lines)
- HTTP 200 on both Node and Bun

