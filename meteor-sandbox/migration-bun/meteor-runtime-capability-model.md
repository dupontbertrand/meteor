# Meteor Runtime Capability Model

**Date:** 2026-03-30
**Author:** dupontbertrand (with Claude analysis)
**Status:** Architecture document

---

## Why this document

The question "Can Meteor run on Bun?" is the wrong question. It assumes that the current implementation (vm.runInThisContext, Module.prototype patching, Reify, boot.js) IS Meteor. These are merely implementation choices from 2012, when ESM didn't exist and CJS was the only module system.

**The right question:** "What runtime capabilities does Meteor actually need, and how could a modern runtime provide them?"

---

## 1. Capability map

| Runtime capability | Why Meteor needs it | Current Node implementation | Bun-native alternative | Shared or runtime-specific? |
|---|---|---|---|---|
| **Server entrypoint** | Start the process | `main.js` -> `require('runtime.js')` -> `require('boot.js')` | `index.mjs` with static ESM imports | **Shared** (standard ESM) |
| **Ordered module loading** | Dependencies between packages | boot.js reads program.json, loops via `vm.runInThisContext` | Static ESM imports — the runtime resolves the order | **Shared** |
| **Package isolation + context** | Each package receives `Npm`, `Assets` | IIFE wrapping executed via vm | ESM modules with explicit imports | **Shared** |
| **Exports / live bindings** | Shared symbols between packages | Reify (module.link, module.export) polyfilling ESM on CJS | **Native ESM** — free live bindings | **Shared** |
| **Startup hooks** | Post-loading initialization | Array of callbacks, pure JS | Identical | **Shared** |
| **npm access** | npm deps of Meteor packages | `Npm.require()` custom multi-path resolution | Standard `import`/`require()` | **Shared** |
| **Assets** | Bundled private files | `fs.readFileSync` via injected object | `fs.readFileSync` or `Bun.file()` | **Optional abstraction** |
| **HTTP server** | Serve assets + HTML + middlewares | `http.createServer()` + Express | `Bun.serve()` (2.5x faster) or `http.createServer` | **Abstraction needed** |
| **WebSocket / DDP** | Bidirectional real-time transport | SockJS + permessage-deflate | Native WebSocket in `Bun.serve()` (7x) | **Abstraction needed** |
| **Async context** | Meteor 3 environment binding | `AsyncLocalStorage` | Identical — full Bun support | **Shared** |
| **Source maps** | Readable stack traces | `source-map-support` (monkey-patch) | Bun: native. Node: `--enable-source-maps` | **Runtime-specific** (nothing to do) |
| **Process lifecycle** | Signals, graceful shutdown | `process.on('SIGTERM')` | Identical + `Bun.serve().stop()` bonus | **Shared** |
| **Shell / REPL** | Interactive debug (optional) | `net.createServer` + `repl` | `bun --inspect` + `debug.bun.sh` | **Drop from critical path** |

**Result:** Only 2 concerns justify an abstraction: the **DDP transport** and the **HTTP server**. Everything else is pure shared JS or handled identically by both runtimes.

---

## 2. Actual requirement vs historical Node baggage

| Element | Actual requirement? | Historical Node implementation | Verdict | Why |
|---|---|---|---|---|
| Code execution in a closure | **Yes** | vm.runInThisContext + IIFE wrapping | **Reimplement** | ESM module = same isolation without vm |
| Module.prototype patching | **No** | Monkey-patching _compile, _extensions | **Drop** | Hack for Reify. ESM = no longer needed. |
| Reify runtime | **No** | Polyfill for ES live bindings on CJS | **Drop** | Native ESM = free live bindings |
| global.Package | **Partial** | Mutable global object | **Reimplement** | Explicit ESM imports + global facade for backward compat |
| Npm.require() | **No** | Custom multi-path resolution | **Drop** | Standard import/require is sufficient |
| source-map-support | **No** | Monkey-patch Error.prepareStackTrace | **Drop** | Node and Bun handle it natively |
| program.json | **Partial** | JSON manifest parsed at runtime | **Reimplement** | The order is in the static imports |
| main.js -> runtime.js -> boot.js | **No** | 3 separate files | **Reimplement** | A single `index.mjs` |
| shell-server | **No** | net.createServer + repl | **Drop** from critical path | Optional package |
| Semver version check | **No** | boot.js checks Node version | **Drop** | `engines` in package.json is sufficient |

---

## 3. What must NOT be ported literally from Node

| Mechanism | Why copying it would be a mistake |
|---|---|
| `vm.runInThisContext` to load packages | This is a hand-written module loader. `import` exists. |
| `Module.prototype` patching | Undocumented Node internal APIs. No-ops on Bun. |
| Reify runtime | Polyfill for a solved problem (ESM). |
| `source-map-support` library | Modern runtimes handle this natively. |
| `Npm.require()` custom resolution | The runtime resolves `node_modules` correctly. |
| program.json + loading loop | If imports are static, the manifest is the code itself. |
| Express middleware stack | If using `Bun.serve()`, Express is not compatible. Fetch handlers = Web Standard. |

---

## 4. Shared core vs runtime-specific

| Concern | Shared Meteor logic | Node implementation | Bun implementation | Abstraction? |
|---|---|---|---|---|
| **DDP protocol** | Parsing/serialization, subscriptions, methods | Identical | Identical | **No** — pure JS |
| **DDP transport** | — | SockJS + ws | Native WebSocket Bun.serve | **Yes** |
| **HTTP server** | Routing, assets, HTML boilerplate | http.createServer + Express | Bun.serve + fetch handler | **Yes** |
| **MongoDB driver** | Queries, change streams | mongodb npm | mongodb npm (identical) | **No** |
| **Accounts / Auth** | Login, tokens, validation | bcrypt N-API | bcrypt N-API (should work) | **No** |
| **Startup hooks** | Callbacks | Pure JS | Pure JS | **No** |
| **AsyncLocalStorage** | Async context | async_hooks | async_hooks (identical) | **No** |
| **Source maps** | — | source-map-support | Native Bun | **No** (each runtime handles it) |
| **Module loading** | Dependency order | vm.runInThisContext loop | Static ESM import | **No** — the bundle format is the contract |
| **Assets** | Assets.getText/getBinary API | fs.readFileSync | fs.readFileSync or Bun.file() | **Optional** |
| **Process lifecycle** | Graceful shutdown | process.on('SIGTERM') | Identical + Bun.serve.stop() | **No** |

---

## 5. The 5 pluggable interfaces

The same architectural pattern repeats: **abstract the contract, keep the default implementation, allow swapping.**

### 5.1 DDP Transport (PR #14231 — merged)

```js
{ name: string, setup(httpServer, pathPrefix, options) => EventEmitter }
```

Implementations: SockJS (default), faye, ws, uWebSockets.js.
Config: `DDP_TRANSPORT=ws` or `settings.json`.
Benchmarks: uws 14,300 calls/sec vs sockjs 8,156 (+75%).

### 5.2 DDP Serializer (PR #14235 — open)

```js
{ name: string, wireFormat: 'text'|'binary', serialize(wireMsg), deserialize(raw) }
```

3-layer architecture: `toWireMessage()` -> `serialize()` -> `transport.send()`.
Implementations: EJSON (default), CBOR (experimental).
Benchmarks: CBOR +38% throughput 1KB, -23% wire size, 2-3x serialize.

### 5.3 Client Store (Minimongo -> pluggable) — to do

```js
interface ClientStore {
  applyAdded(collection, id, fields);
  applyChanged(collection, id, fields, cleared);
  applyRemoved(collection, id);
  find(collection, selector, options) -> ReactiveCursor;
  findOne(collection, selector, options) -> ReactiveValue;
  insert(collection, doc) -> id;
  update(collection, selector, modifier) -> count;
  remove(collection, selector) -> count;
  clear(collection);
  snapshot(collection);
  restore(collection, snapshot);
}
```

Possible implementations: Minimongo (default), TinyBase, RxDB, PowerSync.

### 5.4 Observe Driver (oplog -> change streams -> pluggable) — to do

```js
interface ReactiveSource {
  watch(collection, query, callbacks) -> handle;
  unwatch(handle) -> void;
}
```

Implementations: oplog tailing (legacy), change streams (modern), polling (fallback).
Config: `METEOR_OBSERVE_STRATEGY=change-stream`.

### 5.5 HTTP Host (Express -> pluggable) — to do

```js
interface ServerHost {
  listen(port, callback);
  handleRequest(req) -> Response;
  stop(graceful: boolean);
}
```

Implementations: http.createServer + Express (Node), Bun.serve (Bun).

---

## 6. Cost of reimplementation vs emulation

### Strategy A — Emulate Node internals

| Dimension | Assessment |
|---|---|
| Short-term effort | Low — guards in 4 files, env vars, try/catch |
| Long-term maintenance | **High** — each Bun update can break the shims |
| Technical debt | **Inherited + new** — we keep vm/Reify/Module patching AND add shims |
| Performance potential | **Limited** — Bun as a faster Node, not as Bun |
| Contributor complexity | **High** — Node internals + shims + Bun |
| Migration risk | Low but fragile result |

### Strategy B — Reimplement via standards (ESM)

| Dimension | Assessment |
|---|---|
| Short-term effort | **Higher** — modify the bundler to emit ESM |
| Long-term maintenance | **Low** — ESM is standard, no shims |
| Technical debt | **Reduced** — vm, Reify, Module patching, source-map-support, npm-require.js, program.json all go away |
| Performance potential | **Maximum** — Bun.serve (2.5x), native WebSocket (7x), fast cold start |
| Contributor complexity | **Lower** — ESM is standard, well documented |
| Migration risk | Medium — new bundle format, coexistence across 2-3 versions |

### Verdict

Strategy A is an attractive trap. Strategy B is more cost-effective as soon as the bundler work is amortized. If Meteor wants to support Bun (or Deno, or any future runtime) seriously, this is the only viable path.

---

## 7. Recommendation

**Reimplementation via standards.** The ESM bundle is the central lever. It benefits Meteor on Node as well (cleaner, faster, less debt).

**Sequence:**
1. **ESM bundler spike** (Doc 1) — validate feasibility
2. **Transport + Serializer** — already in progress (PRs #14231, #14235)
3. **Abstract Client Store** — extract the interface from Minimongo
4. **Abstract Observe Driver** — change streams as default
5. **Abstract HTTP Host** — only if/when Bun.serve delivers measurable gains

Each step has value independently of the subsequent ones.
