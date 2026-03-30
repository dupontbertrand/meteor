# Meteor Runtime Capability Model

**Date :** 2026-03-30
**Auteur :** dupontbertrand (with Claude analysis)
**Status :** Architecture document

---

## Pourquoi ce document

La question "Meteor peut-il tourner sur Bun ?" est la mauvaise question. Elle part du principe que l'implémentation actuelle (vm.runInThisContext, Module.prototype patching, Reify, boot.js) EST Meteor. Ce ne sont que des choix d'implémentation de 2012, quand ESM n'existait pas et CJS était le seul système de modules.

**La bonne question :** "De quelles capacités runtime Meteor a-t-il réellement besoin, et comment un runtime moderne pourrait-il les fournir ?"

---

## 1. Capability map

| Capacité runtime | Pourquoi Meteor en a besoin | Implémentation Node actuelle | Bun-native alternative | Partagé ou runtime-spécifique ? |
|---|---|---|---|---|
| **Point d'entrée serveur** | Démarrer le processus | `main.js` → `require('runtime.js')` → `require('boot.js')` | `index.mjs` avec imports ESM statiques | **Partagé** (ESM standard) |
| **Chargement de modules en ordre** | Dépendances entre packages | boot.js lit program.json, boucle via `vm.runInThisContext` | Imports ESM statiques — le runtime résout l'ordre | **Partagé** |
| **Isolation de packages + contexte** | Chaque package reçoit `Npm`, `Assets` | IIFE wrapping exécuté via vm | Modules ESM avec imports explicites | **Partagé** |
| **Exports / live bindings** | Symboles partagés entre packages | Reify (module.link, module.export) polyfillant ESM sur CJS | **ESM natif** — live bindings gratuits | **Partagé** |
| **Startup hooks** | Initialisation post-chargement | Tableau de callbacks, JS pur | Identique | **Partagé** |
| **Accès npm** | Deps npm des packages Meteor | `Npm.require()` résolution custom multi-path | `import`/`require()` standard | **Partagé** |
| **Assets** | Fichiers privés bundlés | `fs.readFileSync` via objet injecté | `fs.readFileSync` ou `Bun.file()` | **Abstraction optionnelle** |
| **Serveur HTTP** | Servir assets + HTML + middlewares | `http.createServer()` + Express | `Bun.serve()` (2.5x plus rapide) ou `http.createServer` | **Abstraction nécessaire** |
| **WebSocket / DDP** | Transport bidirectionnel temps réel | SockJS + permessage-deflate | WebSocket natif dans `Bun.serve()` (7x) | **Abstraction nécessaire** |
| **Contexte async** | Binding d'environnement Meteor 3 | `AsyncLocalStorage` | Identique — plein support Bun | **Partagé** |
| **Source maps** | Stack traces lisibles | `source-map-support` (monkey-patch) | Bun : natif. Node : `--enable-source-maps` | **Runtime-spécifique** (rien à faire) |
| **Cycle de vie processus** | Signals, graceful shutdown | `process.on('SIGTERM')` | Identique + `Bun.serve().stop()` bonus | **Partagé** |
| **Shell / REPL** | Debug interactif (optionnel) | `net.createServer` + `repl` | `bun --inspect` + `debug.bun.sh` | **Drop du chemin critique** |

**Résultat :** Seuls 2 concerns justifient une abstraction : le **transport DDP** et le **serveur HTTP**. Tout le reste est du JS pur partagé ou géré identiquement par les deux runtimes.

---

## 2. Exigence réelle vs bagage historique Node

| Élément | Exigence réelle ? | Implémentation Node historique | Verdict | Pourquoi |
|---|---|---|---|---|
| Exécution de code dans une closure | **Oui** | vm.runInThisContext + IIFE wrapping | **Reimplement** | Module ESM = même isolation sans vm |
| Module.prototype patching | **Non** | Monkey-patching _compile, _extensions | **Drop** | Hack pour Reify. ESM = plus besoin. |
| Reify runtime | **Non** | Polyfill ES live bindings sur CJS | **Drop** | ESM natif = live bindings gratuits |
| global.Package | **Partiel** | Objet global mutable | **Reimplement** | Imports ESM explicites + façade globale pour rétrocompat |
| Npm.require() | **Non** | Résolution custom multi-path | **Drop** | import/require standard suffisent |
| source-map-support | **Non** | Monkey-patch Error.prepareStackTrace | **Drop** | Node et Bun gèrent nativement |
| program.json | **Partiel** | Manifest JSON parsé au runtime | **Reimplement** | L'ordre est dans les imports statiques |
| main.js → runtime.js → boot.js | **Non** | 3 fichiers séparés | **Reimplement** | Un seul `index.mjs` |
| shell-server | **Non** | net.createServer + repl | **Drop** du chemin critique | Package optionnel |
| Semver version check | **Non** | boot.js vérifie la version Node | **Drop** | `engines` dans package.json suffit |

---

## 3. Ce qui ne doit PAS être porté littéralement depuis Node

| Mécanisme | Pourquoi le copier serait une erreur |
|---|---|
| `vm.runInThisContext` pour charger les packages | C'est un module loader écrit à la main. `import` existe. |
| `Module.prototype` patching | APIs internes non-documentées de Node. No-ops sur Bun. |
| Reify runtime | Polyfill pour un problème résolu (ESM). |
| `source-map-support` library | Les runtimes modernes gèrent ça nativement. |
| `Npm.require()` résolution custom | Le runtime résout `node_modules` correctement. |
| program.json + boucle de chargement | Si les imports sont statiques, le manifest est le code lui-même. |
| Express middleware stack | Si on utilise `Bun.serve()`, Express n'est pas compatible. Handlers fetch = Web Standard. |

---

## 4. Shared core vs runtime-specific

| Concern | Logique Meteor partagée | Implémentation Node | Implémentation Bun | Abstraction ? |
|---|---|---|---|---|
| **Protocole DDP** | Parsing/sérialisation, subscriptions, methods | Identique | Identique | **Non** — JS pur |
| **Transport DDP** | — | SockJS + ws | WebSocket natif Bun.serve | **Oui** |
| **Serveur HTTP** | Routing, assets, boilerplate HTML | http.createServer + Express | Bun.serve + fetch handler | **Oui** |
| **MongoDB driver** | Queries, change streams | mongodb npm | mongodb npm (identique) | **Non** |
| **Accounts / Auth** | Login, tokens, validation | bcrypt N-API | bcrypt N-API (devrait marcher) | **Non** |
| **Startup hooks** | Callbacks | JS pur | JS pur | **Non** |
| **AsyncLocalStorage** | Contexte async | async_hooks | async_hooks (identique) | **Non** |
| **Source maps** | — | source-map-support | Natif Bun | **Non** (chaque runtime gère) |
| **Module loading** | Ordre de dépendance | vm.runInThisContext loop | ESM import statique | **Non** — le format du bundle est le contrat |
| **Assets** | API Assets.getText/getBinary | fs.readFileSync | fs.readFileSync ou Bun.file() | **Optionnel** |
| **Process lifecycle** | Graceful shutdown | process.on('SIGTERM') | Identique + Bun.serve.stop() | **Non** |

---

## 5. Les 5 interfaces pluggables

Le même pattern architectural se répète : **abstraire le contrat, garder l'implémentation par défaut, permettre le swap.**

### 5.1 Transport DDP ✅ (PR #14231 — merged)

```js
{ name: string, setup(httpServer, pathPrefix, options) => EventEmitter }
```

Implémentations : SockJS (défaut), faye, ws, uWebSockets.js.
Config : `DDP_TRANSPORT=ws` ou `settings.json`.
Benchmarks : uws 14,300 calls/sec vs sockjs 8,156 (+75%).

### 5.2 Serializer DDP 🔶 (PR #14235 — open)

```js
{ name: string, wireFormat: 'text'|'binary', serialize(wireMsg), deserialize(raw) }
```

Architecture 3 couches : `toWireMessage()` → `serialize()` → `transport.send()`.
Implémentations : EJSON (défaut), CBOR (expérimental).
Benchmarks : CBOR +38% throughput 1KB, -23% wire size, 2-3x serialize.

### 5.3 Client Store (Minimongo → pluggable) — à faire

```js
interface ClientStore {
  applyAdded(collection, id, fields);
  applyChanged(collection, id, fields, cleared);
  applyRemoved(collection, id);
  find(collection, selector, options) → ReactiveCursor;
  findOne(collection, selector, options) → ReactiveValue;
  insert(collection, doc) → id;
  update(collection, selector, modifier) → count;
  remove(collection, selector) → count;
  clear(collection);
  snapshot(collection);
  restore(collection, snapshot);
}
```

Implémentations possibles : Minimongo (défaut), TinyBase, RxDB, PowerSync.

### 5.4 Observe Driver (oplog → change streams → pluggable) — à faire

```js
interface ReactiveSource {
  watch(collection, query, callbacks) → handle;
  unwatch(handle) → void;
}
```

Implémentations : oplog tailing (legacy), change streams (modern), polling (fallback).
Config : `METEOR_OBSERVE_STRATEGY=change-stream`.

### 5.5 HTTP Host (Express → pluggable) — à faire

```js
interface ServerHost {
  listen(port, callback);
  handleRequest(req) → Response;
  stop(graceful: boolean);
}
```

Implémentations : http.createServer + Express (Node), Bun.serve (Bun).

---

## 6. Coût de réimplémentation vs émulation

### Stratégie A — Émuler les internals Node

| Dimension | Évaluation |
|---|---|
| Effort court terme | Faible — guards dans 4 fichiers, env vars, try/catch |
| Maintenance long terme | **Élevée** — chaque update Bun peut casser les shims |
| Dette technique | **Héritée + nouvelle** — on garde vm/Reify/Module patching ET on ajoute des shims |
| Potentiel performance | **Limité** — Bun comme Node plus rapide, pas comme Bun |
| Complexité contributeur | **Haute** — internals Node + shims + Bun |
| Risque migration | Faible mais résultat fragile |

### Stratégie B — Réimplémenter via standards (ESM)

| Dimension | Évaluation |
|---|---|
| Effort court terme | **Plus élevé** — modifier le bundler pour émettre ESM |
| Maintenance long terme | **Faible** — ESM est standard, pas de shims |
| Dette technique | **Réduite** — vm, Reify, Module patching, source-map-support, npm-require.js, program.json disparaissent |
| Potentiel performance | **Maximum** — Bun.serve (2.5x), WebSocket natif (7x), cold start rapide |
| Complexité contributeur | **Plus faible** — ESM est standard, documenté |
| Risque migration | Moyen — nouveau format de bundle, coexistence 2-3 versions |

### Verdict

La stratégie A est un piège attractif. La stratégie B est plus rentable dès que le travail sur le bundler est amorti. Si Meteor veut supporter Bun (ou Deno, ou tout futur runtime) sérieusement, c'est le seul chemin viable.

---

## 7. Recommandation

**Réimplémentation via standards.** Le bundle ESM est le levier central. Il bénéficie à Meteor sur Node aussi (plus propre, plus rapide, moins de dette).

**Séquence :**
1. **Spike bundler ESM** (Doc 1) — valider la faisabilité
2. **Transport + Serializer** — déjà en cours (PRs #14231, #14235)
3. **Client Store abstrait** — extraire l'interface de Minimongo
4. **Observe Driver abstrait** — change streams comme défaut
5. **HTTP Host abstrait** — uniquement si/quand Bun.serve apporte un gain mesurable

Chaque étape a de la valeur indépendamment des suivantes.
