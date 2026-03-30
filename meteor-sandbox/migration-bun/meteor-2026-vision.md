# What We Would Challenge If Meteor Was Redesigned Today

**Date:** 2026-03-30
**Author:** dupontbertrand (with Claude analysis)
**Status:** Vision document
**Context:** Intersection between the capability-first analysis and the forum thread ["What if Meteor was created in 2025"](https://forums.meteor.com/t/what-if-meteor-was-created-in-2025/63566)

---

## Work already done

**PR #14231 — Pluggable DDP transport** (MERGED)
- 4 transports: SockJS (default), faye, ws, uWebSockets.js
- Interface: `{ name, setup(httpServer, pathPrefix, options) => EventEmitter }`
- Benchmarks: uws 14,300 calls/sec vs sockjs 8,156 (+75%)

**PR #14235 — Pluggable DDP serializer** (open, prototype)
- 3-layer architecture: `toWireMessage()` -> `serialize()` -> `transport.send()`
- CBOR: -23% wire size (dates), **-86 to -90%** (binary), **+38%** throughput 1KB
- Interface: `{ name, wireFormat: 'text'|'binary', serialize(wireMsg), deserialize(raw) }`

---

## Convergences with the forum thread

| Thread idea | Status |
|---|---|
| Replace SockJS with native WebSocket | **PR #14231 merged** — 4 transports available |
| Pluggable serializer (EJSON -> CBOR) | **PR #14235 open** — working prototype |
| Standard ESM bundle | To do — bundler spike (see `meteor-esm-bundle-prototype.md`) |
| Less tribal knowledge | Follows from the ESM bundle |
| DISABLE_SOCKJS should be the default | Facilitated by PR #14231 (changing the default = 1 line) |

---

## 1. Change streams instead of oplog tailing

**Forum consensus:** jam: "Must eliminate oplog tailing in favor of change streams."

Change streams are supported by MongoDB 4.0+. `jam:pub-sub` already uses them. The observe driver should be pluggable:

```js
// packages/mongo-observe.mjs — abstract contract
export function observeChanges(collection, query, callbacks) {
  const strategy = process.env.METEOR_OBSERVE_STRATEGY || 'change-stream';
  return strategies[strategy](collection, query, callbacks);
}
```

---

## 2. DB-agnostic reactivity

**italojs (forum):** "real-time data from any source: queue systems (ZMQ, Redis Streams, Kafka), external APIs, or application events."

```js
// packages/reactive-source.mjs — contract
export function createReactiveSource({ watch, unwatch }) {
  return { watch, unwatch };
}

// packages/mongo-reactive.mjs — MongoDB implementation
export const mongoSource = createReactiveSource({
  watch: (query, cb) => collection.watch(query.pipeline).on('change', cb),
  unwatch: (handle) => handle.close(),
});

// packages/redis-reactive.mjs — future
// packages/kafka-reactive.mjs — future
```

---

## 3. Webapp + Accounts: fetch-native HTTP integration

**ceigey (forum):** "API endpoint serving needs Accounts/Webapp integration."

Today, exposing an authenticated REST API = tribal knowledge (connectHandlers + manual token verification). The solution:

```js
// packages/webapp.mjs — Web Standard router (fetch-based)
export function addRoute(method, path, handler) { /* ... */ }

// packages/accounts-middleware.mjs — auth middleware
import { getUser } from './accounts-base.mjs';
export function authenticated(handler) {
  return async (req) => {
    const token = req.headers.get('authorization')?.replace('Bearer ', '')
                || parseCookie(req.headers.get('cookie'))?.meteorLoginToken;
    const user = token ? await getUser(token) : null;
    return handler(req, { user });
  };
}

// User code — simple, documented
import { addRoute } from 'meteor/webapp';
import { authenticated } from 'meteor/accounts-middleware';

addRoute('GET', '/api/invoices', authenticated(async (req, { user }) => {
  if (!user) return new Response('Unauthorized', { status: 401 });
  const invoices = await Invoices.find({ userId: user._id }).fetchAsync();
  return Response.json(invoices);
}));
```

The `fetch` API (Request/Response) is a Web Standard supported by Node 18+ and Bun. Portable code by design.

---

## 4. npm/Atmosphere convergence

**ceigey (forum):** "NPM-Atmosphere duality requiring workarounds."

In an ESM bundle, the distinction disappears at runtime: an Atmosphere package and an npm package are both ESM modules. The distinction only remains in the build system (package.js vs package.json).

Migration path: Atmosphere packages that work in ESM are, de facto, npm modules with a build wrapper.

---

## 5. Tribal knowledge -> explicit code

**mvogt22 (forum):** "new developers shouldn't have to dig through all the documentation and history."

| Current tribal knowledge | How the ESM bundle eliminates it |
|---|---|
| "program.json is the boot.js manifest" | No manifest — imports are in the code |
| "Reify transforms imports into module.link" | No Reify — native ESM |
| "vm.runInThisContext wraps code with Npm/Assets" | No vm — normal modules |
| "Package.meteor.Meteor is the export" | `import { Meteor } from './packages/meteor.mjs'` — standard |
| "Npm.require resolves across multiple node_modules" | Standard `import` |
| "source-map-support monkey-patches Error.prepareStackTrace" | Native source maps |
| "SockJS encapsulates WebSocket + XHR fallback" | Direct WebSocket |
| "DDPCommon.parseDDP is overridable" | `setSerializer()` explicitly exported |

**The ESM bundle doesn't document tribal knowledge — it eliminates it.**

---

## 6. PWA, Capacitor, and Electron

### What changes between targets

| Target | Server | Client served how | DDP | Auth |
|---|---|---|---|---|
| **Web** | Remote | HTTP from the server | WebSocket -> server | Cookies + token |
| **PWA** | Remote | Service worker cache + HTTP | WebSocket -> server | Cookies + token |
| **Capacitor** | Remote | Local assets (localhost) | WebSocket -> remote server | **Token only** |
| **Electron** | Local or remote | Renderer -> localhost or files | WebSocket local/remote | Token or session |

### Decisions to make during ESM design

| Decision | Why now | Cost of not thinking about it |
|---|---|---|
| Externalized config (not inline HTML) | Capacitor/Electron have different ROOT_URLs | Config system overhaul |
| Separable build output (server / client / mobile) | Capacitor needs assets without the server | Bundler restructuring |
| Bearer auth in HTTP routes | Capacitor doesn't have cookies | Auth middleware rewrite |
| Version endpoint for OTA | Capacitor hot code push | No mobile update without app store |
| Service worker in the build pipeline | PWA offline | Ad-hoc addition, poorly integrated |

### What is already compatible

- DDP is **already token-based** -> Capacitor works for sub/methods
- The `index.mjs` format is already startable by Electron
- The pluggable transport (PR #14231) works for all targets

---

## 7. Minimongo: challenge, abstract, or replace?

### What no longer works well

| Limitation | Impact | Severity |
|---|---|---|
| **No indexes** — linear O(n) scan | Performance > 1000 docs | High |
| **No persistence** — all in memory | No offline, re-fetch on refresh | High |
| **No pagination** | Large datasets impossible | Medium |
| **Server-side MergeBox** | RAM proportional to clients x subs x docs | High |
| **Coupled to MongoDB** | Query syntax = MongoDB syntax | Medium |
| **No CRDT** | No real-time collaboration | Medium (growing) |

### 2026 landscape of reactive client stores

| Solution | Reactivity | Persistence | Optimistic | SQL syntax | Size | Strengths |
|---|---|---|---|---|---|---|
| **Minimongo** | Tracker | No | Yes | No (MongoDB) | ~100kB | Integrated with Meteor |
| **TinyBase** | Listeners | IndexedDB, OPFS | Yes | Yes (TinyQL) | **6-13kB** | Native CRDT, 0 deps |
| **RxDB** | RxJS | IndexedDB, SQLite WASM | Yes | No (MongoDB-like) | ~50kB | Mature, indexes |
| **PowerSync** | Reactive | SQLite WASM | Yes | **Yes (native SQL)** | ~60kB | Mobile-first |
| **SignalDB** | Signals | IndexedDB | Yes | No (MongoDB-like) | ~20kB | Signal-based |
| **Zero** | Reactive | IndexedDB | Yes | **Yes (ZQL)** | ~40kB | SQL queries |

### Pluggable interface for the client store

```js
interface ClientStore {
  // Server data reception
  applyAdded(collection, id, fields);
  applyChanged(collection, id, fields, cleared);
  applyRemoved(collection, id);

  // Reactive queries
  find(collection, selector, options) -> ReactiveCursor;
  findOne(collection, selector, options) -> ReactiveValue;

  // Mutations (optimistic)
  insert(collection, doc) -> id;
  update(collection, selector, modifier) -> count;
  remove(collection, selector) -> count;

  // Lifecycle
  clear(collection);
  snapshot(collection);
  restore(collection, snapshot);
}
```

### TinyBase — the most natural candidate

| Dimension | TinyBase | Meteor fit |
|---|---|---|
| Size | 6.2kB gzip, 0 deps | 10x smaller than Minimongo |
| Native CRDT | `MergeableStore` | What Minimongo doesn't have |
| Persistence | IndexedDB, OPFS, SQLite, Bun SQLite | Free offline |
| Sync | `WsSynchronizer` WebSocket, `BroadcastChannel` multi-tab | Converges with DDP |
| Query | TinyQL (SQL-adjacent) | Not MongoDB selectors |
| Framework | Native React hooks | Blaze = adapter needed |
| Data | Tables/Rows/Cells | Natural mapping: Collection=Table, Doc=Row |

**3 major gains vs Minimongo:**
1. **Free offline** — IndexedDB persistence
2. **Free multi-tab** — BroadcastChannel sync
3. **No server-side MergeBox** — client-side CRDT merge -> server RAM divided

**Sync alignment:** TinyBase `WsServer` routes messages between clients without storing data — **exactly the role of a DDP server**. The `MergeableStore` handles CRDT merge — **what MergeBox does, but better**.

### Recommended sequence

1. Define the `ClientStore` interface (design document)
2. Refactor Minimongo to implement this interface (without changing the public API)
3. Add IndexedDB persistence to Minimongo (quick win)
4. Create a TinyBase adapter as a POC
5. Propose the pluggable store as an opt-in feature

---

## 8. Meteor package audit

### Red — Replace or remove

| Component | Why | Replacement |
|---|---|---|
| **Reify / modules-runtime** | Native ESM exists | ESM bundle |
| **source-map-support** | Node/Bun handle it natively | Drop |
| **es5-shim** | No 2026 browser needs it | Remove |
| **SockJS** | Universal WebSocket | PR #14231 |
| **accounts-ui** | Outdated Blaze templates | Remove from core |
| **mobile-experience / launch-screen / crosswalk** | Cordova is obsolete | Remove |
| **autopublish / insecure** | Antipatterns | Remove from meteor-base |
| **promise** polyfill | Native since Node 4 | Remove |
| **fetch** polyfill | Native in Node 18+ and Bun | Remove |

### Yellow — Abstract (pluggable interface)

| Component | Target interface | Effort |
|---|---|---|
| **Minimongo** | `ClientStore { apply*, find, insert... }` | 6-10 weeks |
| **mongo** (oplog/observe) | `ReactiveSource { watch, unwatch }` | 4-8 weeks |
| **EJSON** (serialization) | `Serializer { serialize, deserialize }` | PR #14235 |
| **webapp** (HTTP) | `ServerHost { listen, handleRequest }` | 4-6 weeks |
| **Tracker** | Keep + TC39 Signals adapter | 2-4 weeks |
| **check** | Keep + Zod integration | 1-2 weeks |

### Green — Keep as is

DDP protocol, accounts-base/password/2fa, AsyncLocalStorage, reactive-var/dict, random, retry, ddp-rate-limiter, logging, ecmascript, typescript, hot-code-push, minifiers.

### The 3 most problematic couplings

**1. MongoDB — pervasive:** mongo -> minimongo -> accounts -> service-configuration -> mongo-id -> ejson -> allow-deny -> oplog. 6+ packages. 6+ month effort.

**2. Blaze — in UI packages:** accounts-ui, facts-ui, test-in-browser. Easy: remove from core.

**3. Express — in webapp:** webapp -> Express 5.1.0 -> accounts-oauth, force-ssl, browser-policy. The `ServerHost` interface solves this.

### Visual summary

```
Remove (pure debt):
  es5-shim, promise polyfill, fetch polyfill, autopublish, insecure,
  accounts-ui, mobile-experience, launch-screen, crosswalk

Remove from critical path (keep as option):
  SockJS (default -> ws), Reify (default -> ESM), source-map-support, shell-server

Abstract (pluggable interface):
  DDP Transport    done (#14231)
  DDP Serializer   in progress (#14235)
  Client store     to do (Minimongo -> pluggable)
  Observe driver   to do (oplog -> change streams -> pluggable)
  HTTP server      to do (Express -> pluggable)
  Reactivity       to do (Tracker + Signals adapter)

Keep as is:
  DDP, accounts-base/password/2fa, AsyncLocalStorage, reactive-var/dict,
  random, retry, logging, ecmascript, typescript, hot-code-push, minifiers
```

---

## Conclusion

> The real project isn't "Meteor on Bun." It's "Meteor with a standard server bundle format, capable of running on multiple modern runtimes."

A standard ESM bundle simultaneously solves:
- Runtime portability (Node/Bun/Deno)
- Elimination of tribal knowledge
- Foundation for pluggable transport/serializer/store/observe
- npm/Atmosphere convergence
- Webapp/Accounts integration via Web Standards
- Foundations for PWA/Capacitor/Electron
