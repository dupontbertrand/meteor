# What We Would Challenge If Meteor Was Redesigned Today

**Date :** 2026-03-30
**Auteur :** dupontbertrand (with Claude analysis)
**Status :** Vision document
**Contexte :** Croisement entre l'analyse capability-first et le thread forum ["What if Meteor was created in 2025"](https://forums.meteor.com/t/what-if-meteor-was-created-in-2025/63566)

---

## Travail déjà fait

**PR #14231 — Transport DDP pluggable** (MERGED ✅)
- 4 transports : SockJS (défaut), faye, ws, uWebSockets.js
- Interface : `{ name, setup(httpServer, pathPrefix, options) => EventEmitter }`
- Benchmarks : uws 14,300 calls/sec vs sockjs 8,156 (+75%)

**PR #14235 — Serializer DDP pluggable** (open, prototype)
- Architecture 3 couches : `toWireMessage()` → `serialize()` → `transport.send()`
- CBOR : -23% wire size (dates), **-86 à -90%** (binary), **+38%** throughput 1KB
- Interface : `{ name, wireFormat: 'text'|'binary', serialize(wireMsg), deserialize(raw) }`

---

## Convergences avec le thread forum

| Idée du thread | Statut |
|---|---|
| Remplacer SockJS par WebSocket natif | **✅ PR #14231 merged** — 4 transports disponibles |
| Serializer pluggable (EJSON → CBOR) | **🔶 PR #14235 open** — prototype fonctionnel |
| Bundle ESM standard | À faire — spike bundler (voir `meteor-esm-bundle-prototype.md`) |
| Moins de tribal knowledge | Découle du bundle ESM |
| DISABLE_SOCKJS devrait être le défaut | Facilité par PR #14231 (changer le défaut = 1 ligne) |

---

## 1. Change streams au lieu d'oplog tailing

**Consensus forum :** jam : "Must eliminate oplog tailing in favor of change streams."

Change streams sont supportés par MongoDB 4.0+. `jam:pub-sub` les utilise déjà. L'observe driver devrait être pluggable :

```js
// packages/mongo-observe.mjs — contrat abstrait
export function observeChanges(collection, query, callbacks) {
  const strategy = process.env.METEOR_OBSERVE_STRATEGY || 'change-stream';
  return strategies[strategy](collection, query, callbacks);
}
```

---

## 2. Réactivité DB-agnostique

**italojs (forum) :** "real-time data from any source: queue systems (ZMQ, Redis Streams, Kafka), external APIs, or application events."

```js
// packages/reactive-source.mjs — contrat
export function createReactiveSource({ watch, unwatch }) {
  return { watch, unwatch };
}

// packages/mongo-reactive.mjs — implémentation MongoDB
export const mongoSource = createReactiveSource({
  watch: (query, cb) => collection.watch(query.pipeline).on('change', cb),
  unwatch: (handle) => handle.close(),
});

// packages/redis-reactive.mjs — future
// packages/kafka-reactive.mjs — future
```

---

## 3. Webapp + Accounts : intégration HTTP fetch-native

**ceigey (forum) :** "API endpoint serving needs Accounts/Webapp integration."

Aujourd'hui, exposer une API REST authentifiée = tribal knowledge (connectHandlers + vérification manuelle de token). La solution :

```js
// packages/webapp.mjs — routeur Web Standard (fetch-based)
export function addRoute(method, path, handler) { /* ... */ }

// packages/accounts-middleware.mjs — middleware d'auth
import { getUser } from './accounts-base.mjs';
export function authenticated(handler) {
  return async (req) => {
    const token = req.headers.get('authorization')?.replace('Bearer ', '')
                || parseCookie(req.headers.get('cookie'))?.meteorLoginToken;
    const user = token ? await getUser(token) : null;
    return handler(req, { user });
  };
}

// Code utilisateur — simple, documenté
import { addRoute } from 'meteor/webapp';
import { authenticated } from 'meteor/accounts-middleware';

addRoute('GET', '/api/invoices', authenticated(async (req, { user }) => {
  if (!user) return new Response('Unauthorized', { status: 401 });
  const invoices = await Invoices.find({ userId: user._id }).fetchAsync();
  return Response.json(invoices);
}));
```

L'API `fetch` (Request/Response) est un Web Standard supporté par Node 18+ et Bun. Code portable par design.

---

## 4. Convergence npm/Atmosphere

**ceigey (forum) :** "NPM-Atmosphere duality requiring workarounds."

Dans un bundle ESM, la distinction disparaît au runtime : un package Atmosphere et un package npm sont tous deux des modules ESM. La distinction ne reste que dans le build system (package.js vs package.json).

Chemin de migration : les packages Atmosphere qui fonctionnent en ESM sont, de facto, des modules npm avec un wrapper de build.

---

## 5. Tribal knowledge → code explicite

**mvogt22 (forum) :** "new developers shouldn't have to dig through all the documentation and history."

| Tribal knowledge actuel | Comment le bundle ESM l'élimine |
|---|---|
| "program.json est le manifest de boot.js" | Pas de manifest — les imports sont dans le code |
| "Reify transforme les imports en module.link" | Pas de Reify — ESM natif |
| "vm.runInThisContext wrappe le code avec Npm/Assets" | Pas de vm — modules normaux |
| "Package.meteor.Meteor est l'export" | `import { Meteor } from './packages/meteor.mjs'` — standard |
| "Npm.require résout dans plusieurs node_modules" | `import` standard |
| "source-map-support monkey-patche Error.prepareStackTrace" | Source maps natives |
| "SockJS encapsule WebSocket + fallback XHR" | WebSocket direct |
| "DDPCommon.parseDDP est overridable" | `setSerializer()` exporté explicitement |

**Le bundle ESM ne documente pas le tribal knowledge — il l'élimine.**

---

## 6. PWA, Capacitor et Electron

### Ce qui change entre les cibles

| Cible | Serveur | Client servi comment | DDP | Auth |
|---|---|---|---|---|
| **Web** | Distant | HTTP depuis le serveur | WebSocket → serveur | Cookies + token |
| **PWA** | Distant | Service worker cache + HTTP | WebSocket → serveur | Cookies + token |
| **Capacitor** | Distant | Assets locaux (localhost) | WebSocket → serveur distant | **Token only** |
| **Electron** | Local ou distant | Renderer → localhost ou fichiers | WebSocket local/distant | Token ou session |

### Décisions à prendre dès le design ESM

| Décision | Pourquoi maintenant | Coût de ne pas y penser |
|---|---|---|
| Config externalisée (pas inline HTML) | Capacitor/Electron ont des ROOT_URL différents | Refonte du système de config |
| Build output séparable (server / client / mobile) | Capacitor a besoin des assets sans le serveur | Restructuration du bundler |
| Auth Bearer dans les routes HTTP | Capacitor n'a pas de cookies | Réécriture du middleware auth |
| Endpoint de version pour OTA | Hot code push Capacitor | Pas d'update mobile sans app store |
| Service worker dans le pipeline de build | PWA offline | Ajout ad-hoc, mal intégré |

### Ce qui est déjà compatible

- DDP est **déjà token-based** → Capacitor fonctionne pour sub/methods
- Le format `index.mjs` est déjà démarrable par Electron
- Le transport pluggable (PR #14231) marche pour toutes les cibles

---

## 7. Minimongo : challenger, abstraire, ou remplacer ?

### Ce qui ne va plus

| Limitation | Impact | Gravité |
|---|---|---|
| **Pas d'index** — scan linéaire O(n) | Performance > 1000 docs | Haute |
| **Pas de persistance** — tout en mémoire | Pas d'offline, re-fetch au refresh | Haute |
| **Pas de pagination** | Datasets larges impossibles | Moyenne |
| **MergeBox serveur** | RAM ∝ clients × subs × docs | Haute |
| **Couplé à MongoDB** | Query syntax = MongoDB syntax | Moyenne |
| **Pas de CRDT** | Pas de collab temps réel | Moyenne (croissante) |

### Paysage 2026 des stores client réactifs

| Solution | Réactivité | Persistance | Optimistic | SQL syntax | Taille | Forces |
|---|---|---|---|---|---|---|
| **Minimongo** | Tracker | Non | Oui | Non (MongoDB) | ~100kB | Intégré Meteor |
| **TinyBase** | Listeners | IndexedDB, OPFS | Oui | Oui (TinyQL) | **6-13kB** | CRDT natif, 0 deps |
| **RxDB** | RxJS | IndexedDB, SQLite WASM | Oui | Non (MongoDB-like) | ~50kB | Mature, indexes |
| **PowerSync** | Réactif | SQLite WASM | Oui | **Oui (SQL natif)** | ~60kB | Mobile-first |
| **SignalDB** | Signals | IndexedDB | Oui | Non (MongoDB-like) | ~20kB | Signal-based |
| **Zero** | Réactif | IndexedDB | Oui | **Oui (ZQL)** | ~40kB | SQL queries |

### Interface pluggable pour le store client

```js
interface ClientStore {
  // Réception des données serveur
  applyAdded(collection, id, fields);
  applyChanged(collection, id, fields, cleared);
  applyRemoved(collection, id);

  // Queries réactives
  find(collection, selector, options) → ReactiveCursor;
  findOne(collection, selector, options) → ReactiveValue;

  // Mutations (optimistic)
  insert(collection, doc) → id;
  update(collection, selector, modifier) → count;
  remove(collection, selector) → count;

  // Lifecycle
  clear(collection);
  snapshot(collection);
  restore(collection, snapshot);
}
```

### TinyBase — le candidat le plus naturel

| Dimension | TinyBase | Fit Meteor |
|---|---|---|
| Taille | 6.2kB gzip, 0 deps | ✅ 10x plus petit que Minimongo |
| CRDT natif | `MergeableStore` | ✅ Ce que Minimongo n'a pas |
| Persistance | IndexedDB, OPFS, SQLite, Bun SQLite | ✅ Offline gratuit |
| Sync | `WsSynchronizer` WebSocket, `BroadcastChannel` multi-tab | ✅ Converge avec DDP |
| Query | TinyQL (SQL-adjacent) | 🔶 Pas MongoDB selectors |
| Framework | React hooks natifs | 🔶 Blaze = adaptateur nécessaire |
| Données | Tables/Rows/Cells | 🔶 Mapping naturel : Collection=Table, Doc=Row |

**3 gains majeurs vs Minimongo :**
1. **Offline gratuit** — persister IndexedDB
2. **Multi-tab gratuit** — BroadcastChannel sync
3. **Pas de MergeBox serveur** — CRDT merge côté client → RAM serveur divisée

**L'alignement sync :** TinyBase `WsServer` route les messages entre clients sans stocker de données — **exactement le rôle d'un serveur DDP**. Le `MergeableStore` gère le merge CRDT — **ce que MergeBox fait, mais mieux**.

### Séquence recommandée

1. Définir l'interface `ClientStore` (document de design)
2. Refactorer Minimongo pour implémenter cette interface (sans changer l'API publique)
3. Ajouter la persistance IndexedDB à Minimongo (quick win)
4. Créer un adaptateur TinyBase comme POC
5. Proposer le store pluggable comme feature opt-in

---

## 8. Audit des packages Meteor

### 🔴 À remplacer ou supprimer

| Brique | Pourquoi | Remplacement |
|---|---|---|
| **Reify / modules-runtime** | ESM natif existe | Bundle ESM |
| **source-map-support** | Node/Bun gèrent nativement | Drop |
| **es5-shim** | Aucun browser 2026 n'en a besoin | Supprimer |
| **SockJS** | WebSocket universel | ✅ PR #14231 |
| **accounts-ui** | Templates Blaze datés | Supprimer du core |
| **mobile-experience / launch-screen / crosswalk** | Cordova obsolète | Supprimer |
| **autopublish / insecure** | Antipatterns | Supprimer de meteor-base |
| **promise** polyfill | Natif depuis Node 4 | Supprimer |
| **fetch** polyfill | Natif dans Node 18+ et Bun | Supprimer |

### 🟡 À abstraire (interface pluggable)

| Brique | Interface cible | Effort |
|---|---|---|
| **Minimongo** | `ClientStore { apply*, find, insert... }` | 6-10 sem |
| **mongo** (oplog/observe) | `ReactiveSource { watch, unwatch }` | 4-8 sem |
| **EJSON** (sérialisation) | `Serializer { serialize, deserialize }` | ✅ PR #14235 |
| **webapp** (HTTP) | `ServerHost { listen, handleRequest }` | 4-6 sem |
| **Tracker** | Garder + adaptateur TC39 Signals | 2-4 sem |
| **check** | Garder + intégration Zod | 1-2 sem |

### 🟢 À garder tel quel

DDP protocole, accounts-base/password/2fa, AsyncLocalStorage, reactive-var/dict, random, retry, ddp-rate-limiter, logging, ecmascript, typescript, hot-code-push, minifiers.

### Les 3 couplages les plus problématiques

**1. MongoDB — omniprésent :** mongo → minimongo → accounts → service-configuration → mongo-id → ejson → allow-deny → oplog. 6+ packages. Chantier 6+ mois.

**2. Blaze — dans les UI packages :** accounts-ui, facts-ui, test-in-browser. Facile : supprimer du core.

**3. Express — dans webapp :** webapp → Express 5.1.0 → accounts-oauth, force-ssl, browser-policy. L'interface `ServerHost` résout ça.

### Résumé visuel

```
Supprimer (dette pure) :
  es5-shim, promise polyfill, fetch polyfill, autopublish, insecure,
  accounts-ui, mobile-experience, launch-screen, crosswalk

Supprimer du chemin critique (garder en option) :
  SockJS (défaut → ws), Reify (défaut → ESM), source-map-support, shell-server

Abstraire (interface pluggable) :
  Transport DDP    ✅ fait (#14231)
  Serializer DDP   🔶 en cours (#14235)
  Client store     ⬜ à faire (Minimongo → pluggable)
  Observe driver   ⬜ à faire (oplog → change streams → pluggable)
  Serveur HTTP     ⬜ à faire (Express → pluggable)
  Réactivité       ⬜ à faire (Tracker + Signals adaptateur)

Garder tel quel :
  DDP, accounts-base/password/2fa, AsyncLocalStorage, reactive-var/dict,
  random, retry, logging, ecmascript, typescript, hot-code-push, minifiers
```

---

## Conclusion

> Le vrai chantier n'est pas "Meteor sur Bun". C'est "Meteor avec un format de bundle serveur standard, capable de tourner sur plusieurs runtimes modernes."

Un bundle ESM standard résout simultanément :
- Portabilité runtime (Node/Bun/Deno)
- Élimination du tribal knowledge
- Base pour transport/serializer/store/observe pluggables
- Convergence npm/Atmosphere
- Intégration Webapp/Accounts via Web Standards
- Fondations pour PWA/Capacitor/Electron
