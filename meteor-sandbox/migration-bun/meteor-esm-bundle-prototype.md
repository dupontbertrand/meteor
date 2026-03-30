# Meteor Server ESM Bundle — Prototype Specification

**Date :** 2026-03-30
**Auteur :** dupontbertrand (with Claude analysis)
**Status :** Prototype specification

---

## Objectif

`meteor build --format=esm` produit un `index.mjs` avec des imports ESM statiques au lieu de `main.js → runtime.js → boot.js`.

**La question que le spike doit trancher :** Le bundler Meteor peut-il émettre de vrais modules ESM qui bootent sans vm, sans Reify, sans program.json ?

---

## Scope strict

### Ce qu'on change

Le format de sortie serveur de `meteor build` — uniquement quand `--format=esm` est passé.

| Avant | Après |
|---|---|
| `main.js` (6 lignes CJS) | `index.mjs` (imports ESM statiques) |
| `runtime.js` (Module.prototype patching + Reify) | **Supprimé** — ESM natif |
| `boot.js` (vm.runInThisContext loop) | **Supprimé** — les imports SONT le chargement |
| `program.json` (manifest de chargement) | **Supprimé** — l'ordre est dans les imports |
| `source-map-support` (monkey-patch) | **Supprimé** — source maps natives du runtime |
| `npm-require.js` (résolution custom) | **Supprimé** — résolution standard via import/require |

### Ce qu'on NE change PAS

- `http.createServer` + Express → inchangé
- Transport DDP (SockJS ou ws via PR #14231) → inchangé
- MongoDB / Minimongo → inchangé
- Accounts → inchangé
- Tracker / reactive-var / reactive-dict → inchangé
- Format legacy (`meteor build` sans `--format=esm`) → inchangé, tous les tests passent
- CLI / `meteor run` → inchangé (reste sur Node)
- Isobuild / build plugins → inchangé (on modifie seulement la sortie, pas le pipeline)

---

## Format de sortie cible

### Entrypoint : `index.mjs`

```js
// Généré par meteor build --format=esm
// Pas de runtime.js, pas de boot.js, pas de program.json

// 1. Configuration
import { config } from './__meteor_config.mjs';
globalThis.__meteor_runtime_config__ = config;

// 2. Async context
import { AsyncLocalStorage } from 'node:async_hooks';
globalThis.__METEOR_ASYNC_LOCAL_STORAGE = new AsyncLocalStorage();

// 3. Packages Meteor — imports statiques en ordre de dépendance
// (Le bundler calcule l'ordre, émet les imports)
import './packages/meteor.mjs';
import './packages/random.mjs';
import './packages/ddp-common.mjs';
import './packages/ddp-server.mjs';
import './packages/mongo.mjs';
import './packages/accounts-base.mjs';
import './packages/accounts-password.mjs';
import './packages/webapp.mjs';

// 4. Code applicatif
import './app/server/main.mjs';

// 5. Startup
import { _runStartupHooks } from './packages/meteor.mjs';
await _runStartupHooks();
```

### Chaque package : un module ESM

```js
// packages/meteor.mjs (généré par le bundler)
const startupHooks = [];

export const Meteor = {
  isServer: true,
  startup(fn) { startupHooks.push(fn); },
  // ... reste de l'API Meteor
};

export async function _runStartupHooks() {
  for (const fn of startupHooks) await fn();
}

// Rétrocompatibilité temporaire
globalThis.Package = globalThis.Package || {};
globalThis.Package.meteor = { Meteor };
```

---

## Compatibilité temporaire

Ces mécanismes sont maintenus dans le proto pour ne pas casser le code existant :

| Mécanisme | Pourquoi le garder temporairement | Comment |
|---|---|---|
| `globalThis.Package.xxx` | Du code existant accède aux exports via `Package.meteor.Meteor` | Chaque package ESM enregistre ses exports dans `globalThis.Package` |
| `Npm.require()` | Des packages utilisent `Npm.require('lodash')` | Façade triviale : `export function NpmRequire(id) { return require(id); }` ou `await import(id)` |
| `__meteor_runtime_config__` | Tout Meteor dépend de ce global | Importé depuis `__meteor_config.mjs` puis mis en global |

---

## Fichier clé à modifier

**`tools/isobuild/bundler.js`** — la fonction qui génère le contenu de `main.js` et la structure `programs/server/`.

Lignes pertinentes :
- `_mainJsContents` (lignes 208-214) — template de main.js
- Structure de sortie `programs/server/` (autour de la ligne 3100-3150)

Le changement : quand `--format=esm` est passé, au lieu de générer `main.js` + `program.json` + copier `boot.js`/`runtime.js`, émettre :
- `index.mjs` avec les imports statiques dans l'ordre de dépendance (cet ordre est **déjà calculé** par isobuild dans `serverJson.load`)
- `packages/*.mjs` — chaque entrée de `serverJson.load` devient un module ESM
- `__meteor_config.mjs` — la config extraite de `config.json`
- Les fichiers `.map` pour les source maps

---

## Steps

1. Lire `bundler.js` pour comprendre comment `_mainJsContents` et la structure `programs/server/` sont générés
2. Ajouter un flag `--format=esm` (ou détection dans les options du bundler)
3. Quand ESM : générer `index.mjs` + `packages/*.mjs` au lieu de `main.js` + `boot.js` + `runtime.js` + `program.json`
4. Construire une app `--bare` avec `webapp` : `meteor create --bare spike-app && meteor add webapp`
5. `meteor build --format=esm ../spike-output --directory`
6. `cd ../spike-output/bundle && npm install`
7. Test Node : `node index.mjs` → le serveur HTTP répond sur `curl http://localhost:3000/`
8. Test Bun : `bun index.mjs` → même test

---

## Critères GO / NO-GO

**GO :** `node index.mjs` boot l'app et HTTP répond. Les packages Meteor s'initialisent dans le bon ordre. Les startup hooks s'exécutent.

**NO-GO :** Le bundler ne peut pas émettre les packages comme modules ESM séparés (dépendances circulaires, effets de bord non résolubles, code qui dépend de l'évaluation dynamique via vm).

**Si NO-GO :** Documenter exactement ce qui bloque. Le blocage sera probablement dans la manière dont certains packages accèdent aux exports d'autres packages (via `Package.xxx` au lieu d'imports explicites). Ce serait l'info la plus précieuse du spike.

---

## Effort

1-2 semaines pour le spike (1 contributeur).

---

## Explicitement HORS SCOPE

- Bun.serve() / nouveau serveur HTTP
- Nouveau transport DDP
- TinyBase / nouveau client store
- Nouvelles routes Accounts/HTTP
- PWA / Capacitor / Electron
- Nettoyage de packages historiques
- Modifications de Minimongo

Tout cela appartient à des documents séparés (`meteor-runtime-capability-model.md` et `meteor-2026-vision.md`).
