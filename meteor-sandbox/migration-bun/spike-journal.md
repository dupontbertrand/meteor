# Spike Journal — ESM Bundle Format

**Branche :** `spike/esm-bundle-format` (depuis `devel` @ 5d4893f51c)
**Objectif :** `meteor build --format=esm` produit un `index.mjs` avec imports ESM statiques
**Début :** 2026-03-30

---

## Étape 1 — Comprendre la génération actuelle du bundle

### 1.1 Le chemin de code complet

```
meteor build (CLI)
  → exports.bundle()                          bundler.js:3281
    → async function bundle()                 bundler.js:3285
      → makeServerTarget()                    bundler.js:3369
        → new ServerTarget()                  bundler.js:2771
      → target.make()
        → _determineLoadOrder()               bundler.js:932   ← tri topologique des packages
        → _runCompilerPlugins()               bundler.js:857
        → _emitResources()                    bundler.js:1162  ← produit this.js[]
      → writeSiteArchive()                    bundler.js:3064
        → writeTargetToPath()                 bundler.js:3000
          → serverTarget.write(builder)       bundler.js:2792  ← écrit boot.js, runtime.js, etc.
            → jsImage.write(builder)          bundler.js:2413  ← écrit les fichiers JS + program.json
```

### 1.2 _mainJsContents — le template de main.js

**Fichier :** `tools/isobuild/bundler.js:208-214`

```js
exports._mainJsContents = [
  "",
  "process.argv.splice(2, 0, 'program.json');",
  "process.chdir(require('path').join(__dirname, 'programs', 'server'));",
  'require("./programs/server/runtime.js")({ cachePath: process.env.METEOR_REIFY_CACHE_DIR });',
  "require('./programs/server/boot.js');",
].join("\n");
```

C'est le contenu de `main.js` dans la racine du bundle. 6 lignes. CJS require().

### 1.3 ServerTarget.write() — ce qui est copié dans programs/server/

**Fichier :** `tools/isobuild/bundler.js:2792-2906`

Fichiers copiés depuis `tools/static-assets/server/` :
- `boot.js` — bootstrap principal, vm.runInThisContext loop
- `boot-utils.js` — utilitaires
- `debug.ts` — debugger pause
- `server-json.js` — lit program.json
- `mini-files.ts` — utilitaires filesystem
- `npm-require.js` — résolution npm custom
- `npm-rebuild.js` — rebuild natifs
- `npm-rebuild-args.js` — args pour rebuild
- `runtime.js` — Module.prototype patching + Reify
- `profile.ts` — profiling

Aussi :
- `config.json` (release, appId, client archs)
- `package.json` + `npm-shrinkwrap.json` (deps npm pour le bundle)
- `node_modules/` (copié ou symlinké)

Puis appelle `jsImage.write()` pour les fichiers JS des packages.

### 1.4 JsImageTarget.write() — génération de program.json

**Fichier :** `tools/isobuild/bundler.js:2413-2662`

Itère sur `this.jsToLoad[]` (la liste ordonnée des fichiers JS). Pour chaque fichier :
1. Écrit le fichier .js sur disque via `builder.writeToGeneratedFilename()`
2. Écrit la source map si présente
3. Écrit les assets statiques associés
4. Construit un item pour le tableau `load[]`

Chaque item dans `load[]` :
```json
{
  "path": "packages/meteor.js",
  "node_modules": { "meteor": "packages/node_modules/meteor" },
  "assets": { "file.txt": "assets/packages/meteor/file.txt" },
  "sourceMap": "packages/meteor.js.map"
}
```

Puis écrit program.json :
```js
await builder.writeJson('program.json', {
  format: "javascript-image-pre1",
  arch: self.arch,
  load: load
});
```

### 1.5 L'ordre de chargement — _determineLoadOrder()

**Fichier :** `tools/isobuild/bundler.js:932-1083`

Tri topologique en 2 phases :
1. **Phase 1** : Quels packages sont utilisés ? (suit les `uses` récursivement)
2. **Phase 2** : Tri topo — si X dépend de Y, Y apparaît avant X

Résultat : `this.unibuilds[]` — liste ordonnée utilisée ensuite par `_emitResources()`.

**NOTE IMPORTANTE :** L'ordre de dépendance est DÉJÀ calculé par isobuild. On n'a pas à le recalculer. On doit juste l'émettre comme des imports ESM dans le bon ordre.

### 1.6 Comment les packages sont wrappés — linker.js

**Fichier :** `tools/isobuild/linker.js:661-689`

Deux modes de wrapping :

**Mode IIFE (packages sans modules) :**
```js
(function(){
  // code du package
}).call(this);
```

**Mode module (packages avec meteorInstall) :**
```js
function module(require, exports, module) {
  // code du package
}
```

C'est le linker qui wrappe. Dans le runtime actuel, boot.js itère sur program.json, lit chaque fichier, le re-wrappe dans une IIFE avec `(function(Npm, Assets){...})`, et l'exécute via `vm.runInThisContext`.

### 1.7 Flags existants pour le format de sortie

**Fichier :** `tools/isobuild/bundler.js:3285-3310`

Options actuelles de `bundle()` :
- `buildMode` : 'production' | 'development' | 'test'
- `minifyMode` : 'production' | 'development'
- `includeNodeModules` : false | 'symlink'
- `serverArch` : string
- `webArchs` : string[]

Formats de fichier :
- `program.json` : `"javascript-image-pre1"`
- `star.json` : `"site-archive-pre1"`

**Pas de flag `--format` existant.** Il faudra l'ajouter.

### 1.8 Structure de sortie actuelle

```
bundle/
├── main.js                          ← _mainJsContents (6 lignes CJS)
├── README
├── star.json                        ← manifest global
├── .node_version.txt
├── programs/
│   ├── server/
│   │   ├── boot.js                  ← copié depuis static-assets
│   │   ├── boot-utils.js
│   │   ├── runtime.js               ← copié depuis static-assets
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
│   │   │   ├── meteor.js            ← code du package meteor
│   │   │   ├── mongo.js
│   │   │   └── ...
│   │   ├── app/
│   │   │   └── app.js               ← code applicatif
│   │   └── assets/
│   │       ├── packages/
│   │       └── app/
│   ├── web.browser/
│   └── web.browser.legacy/
```

---

## Étape 2 — Points d'intervention pour le format ESM

### 2.1 Ce qu'il faut modifier

1. **`_mainJsContents`** (bundler.js:208) — Nouvelle version ESM :
   - `index.mjs` au lieu de `main.js`
   - Imports statiques au lieu de require()

2. **`ServerTarget.write()`** (bundler.js:2792) — Ne pas copier boot.js, runtime.js, npm-require.js quand format=esm. Copier seulement les fichiers encore nécessaires (npm-rebuild.js pour postinstall).

3. **`JsImageTarget.write()`** (bundler.js:2413) — Quand format=esm :
   - Écrire chaque fichier comme module ESM (.mjs)
   - Générer `index.mjs` avec les imports dans l'ordre de `load[]`
   - Ne pas générer program.json (l'ordre est dans les imports)

4. **`writeSiteArchive()`** (bundler.js:3064) — Écrire `index.mjs` au lieu de `main.js`

5. **`File._getClosureHeader/Footer()`** (linker.js:661) — Peut-être pas besoin de changer si on garde le wrapping existant et qu'on l'émet comme module ESM.

### 2.2 Ce qu'il ne faut PAS modifier

- `_determineLoadOrder()` — l'ordre est déjà correct
- `_emitResources()` — les ressources sont déjà correctes
- `toJsImage()` — la sérialisation intermédiaire reste valide
- Le pipeline de compilation des packages
- Le linker (sauf potentiellement les closures)
- Les client targets

### 2.3 Question clé à résoudre

**Le code des packages dans le bundle est déjà compilé par Reify (imports → module.link).** Dans un bundle ESM, ce code devrait être du vrai ESM (import/export natifs). Deux approches :

**Approche A — Minimal :** Garder le code tel quel (avec module.link etc.) mais le wrapper dans un module ESM. Le code interne utilise toujours les appels Reify, mais le module lui-même est un .mjs.

**Approche B — Propre :** Modifier le pipeline de compilation pour émettre du vrai ESM au lieu de CJS+Reify. Beaucoup plus de travail mais résultat plus propre.

**Pour le spike : Approche A.** On garde le code compilé tel quel, on change juste le wrapper et le mécanisme de chargement.

---

## Étape 2b — Analyse d'un bundle réel (app --bare + webapp)

### 2b.1 Structure réelle d'un fichier package dans le bundle

**Découverte critique :** Les packages ne sont PAS des IIFE simples. Ils utilisent `Package["core-runtime"].queue()` :

```js
// packages/meteor.js — structure réelle
Package["core-runtime"].queue("meteor", function () {
  /* Package-scope variables */
  var global, meteorEnv, Meteor, EmitterPromise;

  (function(){
    // ... code de global.js ...
  }).call(this);

  (function(){
    // ... code de server_environment.js ...
  }).call(this);

  // ... plus de fichiers ...

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

**Et core-runtime.js** est le premier chargé, il crée `Package['core-runtime'] = { queue, waitUntilAllLoaded }`. C'est un système de queue async — les packages s'enregistrent via `queue()` et sont exécutés dans l'ordre.

**Implication pour le spike :** On ne peut PAS juste mettre `import` devant chaque fichier. Le code des packages est couplé au système `Package["core-runtime"].queue()`. Ce système :
1. Queue les packages par nom
2. Les exécute séquentiellement
3. Stocke les exports dans `Package[name]`

Pour l'approche ESM minimale (Approche A), on a deux options :

**Option A1 — Garder core-runtime.queue() :** Le `index.mjs` charge core-runtime d'abord, puis importe les packages qui utilisent `queue()` comme avant. C'est le chemin de moindre résistance. On remplace juste le mécanisme de chargement (vm → import), pas le mécanisme d'enregistrement.

**Option A2 — Réécrire les wrappers :** Le linker émet du vrai ESM (`export const Meteor = ...`) au lieu de `Package["core-runtime"].queue(...)`. Beaucoup plus de travail.

**Décision : Option A1 pour le spike.** On garde le système queue, on change juste le loader.

### 2b.2 program.json — contenu réel

54 packages dans une app --bare + webapp. Ordre :
```
1. core-runtime.js    ← crée Package['core-runtime'].queue()
2. meteor.js          ← s'enregistre via queue("meteor", ...)
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

### 2b.3 Ce que boot.js fait avec ces fichiers (rappel)

boot.js lit program.json, puis pour CHAQUE fichier dans `load[]` :
1. `fs.readFileSync(path)` — lit le contenu
2. Wrappe dans `(function(Npm, Assets, ...){ <contenu> })`
3. `vm.runInThisContext(wrapped, { filename })` — exécute
4. Appelle la fonction résultante avec les args appropriés

**Mais** le contenu des fichiers contient déjà `Package["core-runtime"].queue(...)`. Donc le wrapping boot.js ajoute une couche SUPPLÉMENTAIRE au-dessus du wrapping déjà fait par le linker.

### 2b.4 Ce que ça signifie pour le spike ESM

Le chemin le plus simple :

```js
// index.mjs — remplace main.js + boot.js
import './__meteor_config.mjs';

// core-runtime DOIT être chargé en premier — il crée Package['core-runtime'].queue()
import './packages/core-runtime.js';

// Les autres packages s'enregistrent via queue() — l'import les exécute
import './packages/meteor.js';
import './packages/meteor-base.js';
// ... 50+ imports dans l'ordre de program.json ...
import './app/global-imports.js';

// Attendre que tous les packages async soient chargés
const { waitUntilAllLoaded } = Package['core-runtime'];
const ready = waitUntilAllLoaded();
if (ready) await ready;

// Startup hooks
Meteor._runStartupHooks?.();
```

**Le code des packages ne change pas.** Ils utilisent toujours `queue()`. Mais au lieu d'être chargés par boot.js via vm, ils sont chargés par `import` — l'import exécute le code top-level, qui appelle `queue()`, qui enregistre le package.

**Avantage :** On ne touche pas au linker, pas au compilateur, pas au format des packages. On change SEULEMENT le mécanisme de chargement.

---

## Étape 2c — Analyse du wrapping boot.js (Npm, Assets, specialArgs)

### 2c.1 Le wrapping supplémentaire de boot.js

boot.js ajoute un wrapping **autour** du contenu de chaque fichier :

```js
// boot.js ligne 387-400 : wrapping
const wrapped = "(function(Npm, Assets" + specialKeys + "){ " + code + "\n})";
const func = require('vm').runInThisContext(wrapped, { filename: scriptPath });
func.apply(global, [NpmObj, AssetsObj, ...specialValues]);
```

Donc le code final exécuté pour `packages/webapp.js` est :

```js
(function(Npm, Assets) {
  Package["core-runtime"].queue("webapp", function() {
    // ... code qui utilise Npm.require('express/package.json') ...
  });
})(NpmObj, AssetsObj)
```

`Npm` est un paramètre de la fonction wrapper. Le code interne le capture par **closure**.

### 2c.2 L'objet Npm — ce qu'il contient

Créé à boot.js:259 pour CHAQUE fichier dans `serverJson.load` :

```js
const Npm = {
  require: function(name, error) {
    // 1. Cherche dans les node_modules spécifiques au package (fileInfo.node_modules)
    // 2. Cherche dans le node_modules global du bundle
    // 3. Tombe sur require.resolve() natif
    // 4. Throw si pas trouvé
  }
};
```

**Point critique :** L'objet `Npm` est différent pour chaque fichier ! Il a une liste de `nonLocalNodeModulesPaths` spécifique à ce package (basée sur `fileInfo.node_modules` de program.json).

### 2c.3 L'objet Assets — ce qu'il contient

Créé à boot.js:356 pour CHAQUE fichier :

```js
const Assets = {
  getTextAsync(assetPath, callback) { ... },
  getBinaryAsync(assetPath, callback) { ... },
  absoluteFilePath(assetPath) { ... },
  getServerDir() { return serverDir; }
};
```

Résout les assets depuis `fileInfo.assets` (le map dans program.json).

### 2c.4 specialArgPaths — arguments injectés pour 2 packages seulement

boot.js:197-222 :

| Package | Argument injecté | Ce qu'il contient |
|---|---|---|
| `packages/modules-runtime.js` | `npmRequire`, `Profile` | La fonction `require` depuis npm-require.js + le profiler |
| `packages/dynamic-import.js` | `dynamicImportInfo` | Map des chemins `dynamic/` par architecture client |

Seulement 2 packages sur 54 ont des arguments spéciaux.

### 2c.5 Combien de packages utilisent Npm et Assets ?

**Npm.require() — 8 packages sur 54 :**
- meteor.js (4 usages : async_hooks, denque, url, events)
- npm-mongo.js (3 : mongodb driver)
- modules-runtime.js (3 : fallback require)
- ddp-server.js (3)
- socket-stream-client.js (2)
- webapp.js (1 : express version)
- ecmascript-runtime-server.js (1)
- autoupdate.js (1)

**Assets — 1 package sur 54 :**
- mongo.js (1 usage : chemin vers un fichier TLS/SSL)

### 2c.6 Le problème ESM et la solution

**PROBLÈME :** Si on fait `import './packages/webapp.js'`, le code s'exécute immédiatement. Mais `Npm` n'est pas défini car il n'y a pas de fonction wrapper qui le passe en paramètre. → `ReferenceError: Npm is not defined`.

**SOLUTION la plus simple : mettre Npm et Assets en globaux.**

```js
// Dans index.mjs, AVANT les imports de packages
globalThis.Npm = { require: createNpmRequire(serverDir) };
globalThis.Assets = createAssets(serverDir);
```

Puis les packages font `Npm.require('express')` → cherche dans `globalThis.Npm`.

**Inconvénient :** Aujourd'hui chaque package a son propre objet Npm avec des chemins de résolution spécifiques. En global, tous les packages partagent le même Npm.

**Mais dans la pratique :** Le bundler flatten déjà les `node_modules` dans un seul répertoire. La résolution multi-path de npm-require.js est surtout un héritage du temps où chaque package avait son propre `node_modules`. Dans un bundle built, un `require('express')` standard résout correctement.

**SOLUTION RETENUE pour le spike :**

```js
// index.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.Npm = { require: (name) => require(name) };
globalThis.Assets = { /* ... */ };

// Puis les imports de packages
import './packages/core-runtime.js';
import './packages/meteor.js';
// ...
```

### 2c.7 specialArgPaths — comment les gérer en ESM

**modules-runtime.js** a besoin de `npmRequire` et `Profile`. Solutions :
- `npmRequire` = le même `require` de node:module → `globalThis.npmRequire = require`
- `Profile` = le profiler de boot → peut être un no-op pour le spike

**dynamic-import.js** a besoin de `dynamicImportInfo`. Solution :
- Mettre en global : `globalThis.dynamicImportInfo = { server: { dynamicRoot: ... }, ... }`

### 2c.8 Le flow complet de boot.js qu'on remplace

```
boot.js fait :
1. Check version Node                          → DROP (engines dans package.json)
2. Lit program.json, config.json, star.json     → SIMPLIFIER (config inline dans index.mjs)
3. Setup __meteor_bootstrap__                   → GARDER (global)
4. Setup __meteor_runtime_config__              → GARDER (global)
5. Install source-map-support                   → DROP (natif runtime)
6. Setup AsyncLocalStorage                      → GARDER
7. Pour chaque fichier dans program.json:
   a. Lit le fichier (fs.readFileSync)          → REMPLACER par import
   b. Crée Npm spécifique au fichier            → REMPLACER par global Npm
   c. Crée Assets spécifique au fichier         → REMPLACER par global Assets
   d. Wrappe dans (function(Npm,Assets){...})   → PLUS NÉCESSAIRE
   e. vm.runInThisContext                       → PLUS NÉCESSAIRE
   f. Appelle la fonction avec args             → PLUS NÉCESSAIRE
8. waitUntilAllLoaded()                         → GARDER
9. callStartupHooks()                           → GARDER
10. runMain()                                   → GARDER
```

---

## Étape 2d — Micro-tests d'import sur un vrai bundle

### 2d.1 Test v2 — core-runtime + meteor (premiers résultats)

**Setup :** App `--bare` + webapp, `meteor build --directory`, `npm install`, puis un `test-import.mjs` qui setup les globals et importe les packages un par un.

**Résultat :**
```
✅ core-runtime.js imported OK — crée Package['core-runtime'].queue()
✅ meteor.js imported OK — Meteor.isServer = true
```

**Première découverte :** Les fichiers du bundle SONT importables via `import`. Le code top-level (qui appelle `Package["core-runtime"].queue(...)`) s'exécute correctement.

**Problème rencontré :** `meteor.js` échoue sur `Npm.require('denque')` car notre `Npm.require` global ne résout pas dans le bon `node_modules`. Chaque package a son propre chemin `node_modules` défini dans `program.json` (ex: `npm/node_modules/meteor/meteor/node_modules` pour le package meteor).

### 2d.2 Test v3 — résolution contextuelle par package

**Solution :** Lire `program.json`, construire un map `packagePath → node_modules[]`, et setter `currentPackagePath` avant chaque import pour que `Npm.require` sache où chercher.

**Résultat :** 53/54 packages importés avec succès. Le seul échec : `modules.js` qui utilise `npmRequire` (pas `Npm.require`) avec un chemin virtuel absolu `/node_modules/meteor/modules/node_modules/@meteorjs/reify/...`.

### 2d.3 Test v4 — chemins virtuels absolus

**Découverte critique : `meteorInstall` et les chemins virtuels**

Le système de modules Meteor (`modules-runtime.js`) crée un filesystem virtuel où chaque package vit dans `/node_modules/meteor/<package>/`. Quand un package fait `require('@meteorjs/reify')`, `meteorInstall` le résout comme `/node_modules/meteor/modules/node_modules/@meteorjs/reify/...`.

La fonction `useNode()` dans modules-runtime.js (ligne 731-751) appelle `npmRequire(this.id)` avec ce chemin virtuel absolu. C'est `npmRequire` (injecté par boot.js comme specialArg) qui fait le mapping vers le vrai chemin sur disque.

**Solution partielle :** Notre `contextualRequire` strip le préfixe `/node_modules/meteor/<pkg>/node_modules/` et résout le reste via `createRequire` depuis le bon `node_modules` du package.

**Résultat :** 53/54, `modules.js` passe maintenant. Échec restant : `react-fast-refresh.js` (même problème de chemin virtuel pour `react-refresh/babel.js`).

### 2d.4 Test v5 — cascade de dépendances

**Problème :** `react-fast-refresh` échoue → `ecmascript` dépend de `ReactFastRefresh` → `base64` dépend de `ECMAScript` → cascade.

La queue de `core-runtime` est **séquentielle** : si un package échoue, les packages suivants ne s'exécutent jamais. `react-fast-refresh` est à l'index 7 sur 54, donc 47 packages ne sont jamais exécutés par la queue.

**Le problème n'est pas l'import** (53/54 s'importent). Le problème est que **le resolver de chemins virtuels** (`npmRequire` / `contextualRequire`) ne résout pas tous les patterns correctement.

### 2d.5 Diagnostic : pourquoi on reproduit boot.js

**Constat :** On est en train de réécrire la logique de résolution de `npmRequire` de boot.js. C'est exactement ce qu'on voulait éviter.

**La cause racine :** Le code des packages dans le bundle utilise `meteorInstall` (de modules-runtime) qui crée un filesystem virtuel avec des chemins comme `/node_modules/meteor/X/node_modules/Y`. Quand un module fait `require('Y')`, `meteorInstall` le résout dans le filesystem virtuel, et quand le module n'est pas dans le bundle (c'est un vrai package npm), il appelle `useNode()` qui appelle `npmRequire(absoluteVirtualPath)`.

`npmRequire` de boot.js sait comment mapper un chemin virtuel vers un vrai chemin disque car il a les `nonLocalNodeModulesPaths` de `program.json`. Notre version simplifiée ne couvre pas tous les patterns.

### 2d.6 Décision : 2 stratégies, 2 horizons

**Pour le spike (maintenant) : Option 2 — Resolver minimal réécrit**

Au lieu de copier la logique complexe de boot.js, écrire un resolver minimal qui :
1. Prend les paths de `program.json`
2. Map les chemins virtuels `/node_modules/meteor/X/node_modules/Y` → vrai chemin `npm/node_modules/meteor/X/node_modules/Y`
3. Fallback sur `node_modules/` global du bundle

C'est plus propre que de copier boot.js mais c'est toujours un resolver custom.

**Pour la destination (plus tard) : Option 3 — Le bundler émet des vrais chemins**

La vraie solution : modifier le **linker/bundler** pour que les packages émis dans le bundle n'utilisent pas de chemins virtuels. Au lieu de :
```js
meteorInstall({"node_modules":{"meteor":{"modules":{"server.js": function(require) { ... }}}}})
```

Le bundler émettrait des vrais modules ESM avec des imports relatifs réels :
```js
// packages/modules.mjs
import reify from '../npm/node_modules/meteor/modules/node_modules/@meteorjs/reify/lib/runtime/index.js';
```

Ça élimine complètement `meteorInstall`, `npmRequire`, `useNode`, et le filesystem virtuel. Mais c'est un changement dans le **linker** (`tools/isobuild/linker.js`), pas juste dans le format de sortie.

**Chemin critique :**
- Spike (option 2) → valide que le bundle EST importable avec un resolver minimal
- Si validé → option 3 modifie le linker pour rendre le resolver inutile
- Résultat final : des vrais modules ESM sans aucun resolver custom

---

## Étape 2e — RÉSULTAT : le bundle EST importable

### Test v6 — resolver minimal + tous les globals

**Résultat :**
```
54/54 packages importés ✅
54 packages enregistrés dans Package ✅
Meteor.isServer = true ✅
webapp chargé ✅
mongo chargé ✅
ddp-server chargé ✅
```

Le crash initial (avant ROOT_URL) était `Must pass options.rootUrl or set ROOT_URL` — c'est le comportement **normal** de webapp qui démarre. Avec `ROOT_URL=http://localhost:3000`, tout passe.

### Ce qui a été nécessaire pour que ça marche

1. **Globals à setter avant les imports :**
   - `__meteor_bootstrap__` (startupHooks, serverDir, configJson)
   - `__meteor_runtime_config__` (meteorRelease, gitCommitHash)
   - `process.env.APP_ID`
   - `__METEOR_ASYNC_LOCAL_STORAGE` (AsyncLocalStorage)

2. **Npm.require en global** (remplace l'injection par closure de boot.js)
   - Doit résoudre les chemins virtuels `/node_modules/meteor/X/node_modules/Y`
   - Doit résoudre les noms de modules classiques (`express`, `denque`, etc.)
   - Doit avoir un `.resolve()` pour `useNode()` dans modules-runtime

3. **npmRequire en global** (specialArg pour modules-runtime)
   - Même fonction que Npm.require

4. **Profile en global** (specialArg pour modules-runtime)
   - No-op pour le spike : `function(name, fn) { return fn || function(){}; }`

5. **dynamicImportInfo en global** (specialArg pour dynamic-import)
   - Map des chemins `dynamic/` par architecture

6. **Assets en global** (remplace l'injection par closure de boot.js)
   - Stubs pour le spike (l'app --bare n'utilise pas Assets)

### Le resolver minimal — ~50 lignes

Le cœur : mapper les chemins virtuels de meteorInstall vers les vrais chemins disque.

Pattern principal : `/node_modules/meteor/X/node_modules/Y` → résolu via `createRequire` depuis le `node_modules` du package X (défini dans `program.json`).

Fallback : `node_modules/` global du bundle.

### Ce qui reste à faire pour le spike complet

- [ ] Tester que le serveur HTTP écoute réellement (PORT=3000, curl)
- [ ] Tester avec une app qui a du code applicatif (pas juste --bare)
- [ ] Tester avec accounts-password
- [ ] Tester avec MongoDB (MONGO_URL)
- [ ] Intégrer ce loader dans le bundler (index.mjs généré)
- [ ] Tester sous Bun

### Conclusion de la phase exploratoire

**Le bundle serveur Meteor actuel EST importable via ESM** avec :
- ~10 lignes de setup de globals
- ~50 lignes de resolver pour les chemins virtuels meteorInstall
- Aucune modification du code des packages
- Aucune modification du linker
- Aucune modification du compilateur

La preuve de concept est validée. Le spike peut passer à l'implémentation dans le bundler.

---

## Étape 2f — Le serveur HTTP boot et répond

### Test serveur complet

Ajout de la séquence post-chargement (copiée de boot.js) :
1. `waitUntilAllLoaded()` — attend que la queue core-runtime finisse
2. Exécution des `startupHooks` — `__meteor_bootstrap__.startupHooks`
3. `runMain()` — trouve et appelle `main()` exporté par les packages

**Résultat :**
```
Importing 54 packages...
All packages imported.
All packages registered.
Startup hooks executed.
Running main()...
Server started (DAEMON mode).

=== HTTP RESULT: 200 ===
```

**Le serveur Meteor boot intégralement via un script ESM (`import`) et répond HTTP 200 sur `curl http://localhost:4000/`.**

Sans MongoDB (pas de MONGO_URL), sans code applicatif (app --bare), mais le serveur HTTP fonctionne.

### Ce que le test-server.mjs fait (le "ESM boot" complet)

```
1. Setup globals (~15 lignes)
   __meteor_bootstrap__, __meteor_runtime_config__, Npm, Assets,
   npmRequire, Profile, dynamicImportInfo, AsyncLocalStorage

2. Import des 54 packages via `await import()` (~5 lignes de boucle)
   program.json fournit l'ordre
   currentPackagePath permet au resolver contextuel de fonctionner

3. waitUntilAllLoaded() (~2 lignes)
   La queue core-runtime exécute chaque package séquentiellement

4. Startup hooks (~4 lignes)
   Même logique que boot.js:448-457

5. runMain() (~10 lignes)
   Trouve main() dans les exports des packages, l'appelle
   Retourne 'DAEMON' → le serveur reste en vie
```

**Total : ~100 lignes de JS remplacent boot.js (510 lignes) + runtime.js (152 lignes) + npm-require.js (~200 lignes) + program.json.**

### Prochaines étapes

- [ ] Tester sous Bun (`bun test-server.mjs`)
- [ ] Tester avec MONGO_URL (MongoDB réel)
- [ ] Tester avec une app qui a du code (pas --bare)
- [ ] Intégrer dans le bundler (générer index.mjs automatiquement)

---

## Étape 3 — Test Bun

### 3.1 Premier essai — ReferenceError strict mode

**Bun 1.2.4.** Premier essai avec `test-server.mjs` : crash sur `app/global-imports.js`.

```
ReferenceError: Can't find variable: Mongo
  at app/global-imports.js:4:1
```

**Cause :** `global-imports.js` fait des assignations globales implicites (`Mongo = Package.mongo.Mongo` sans `var`/`let`/`const`). Bun exécute en **strict mode** où les assignations implicites sont illegales. Node ne crash pas car les `.js` sont traités comme CJS (mode non-strict) même quand importés via `import()`.

**Ce n'est PAS un problème Bun profond** — c'est un fichier généré par le bundler Meteor qui suppose un environnement non-strict. Le fix est trivial.

### 3.2 Fix — pre-déclaration des globals

Solution : lire `global-imports.js`, extraire les noms de variables avec une regex, les pré-déclarer sur `globalThis` avant les imports.

```js
const src = fs.readFileSync(globalImportsPath, 'utf8');
const matches = src.matchAll(/^(\w+)\s*=\s*Package/gm);
for (const m of matches) {
  if (!(m[1] in globalThis)) globalThis[m[1]] = undefined;
}
```

~5 lignes de fix. Pas un shim, pas une émulation — juste une pré-déclaration.

### 3.3 Résultat — Bun HTTP 200 ✅

```
Importing 54 packages...
All packages imported.
All packages registered.
Startup hooks executed.
Server started (DAEMON mode).

=== BUN HTTP RESULT: 200 ===
```

**Le serveur Meteor boot sous Bun 1.2.4 et répond HTTP 200.**

### 3.4 Résumé : Node vs Bun

| | Node | Bun |
|---|---|---|
| Import des 54 packages | ✅ | ✅ |
| core-runtime queue | ✅ | ✅ |
| Packages registered | 54/54 | 54/54 |
| Startup hooks | ✅ | ✅ |
| main() DAEMON | ✅ | ✅ |
| HTTP 200 | ✅ | ✅ |
| Fix spécifique nécessaire | Aucun | Pre-déclaration globals (~5 lignes) |

### 3.5 Observation Bun

Le seul problème Bun-spécifique est le strict mode pour `global-imports.js`. C'est un fichier **généré par le bundler** — le fix permanent est dans le bundler (émettre `globalThis.Mongo = ...` au lieu de `Mongo = ...`), pas dans le loader.

Pour la destination (option 3 — le bundler émet des vrais modules ESM), `global-imports.js` disparaît complètement car les imports deviennent des `import { Mongo } from './packages/mongo.mjs'`.

---

## Étape 4 — App complète (--full) avec MongoDB

### 4.1 App testée

`meteor create --full` génère une app avec : Blaze, FlowRouter, jQuery, Less, MongoDB, Rspack, Mocha, shell-server, accounts. **67 packages** dans le bundle.

### 4.2 Résultat Node

```
MONGO_URL=mongodb://localhost:27099/esm-spike ROOT_URL=http://localhost:4010 PORT=4010 node test-full.mjs

Importing 67 packages...
All packages imported.
All packages registered.
Startup hooks executed.
Server started (DAEMON mode).

=== NODE: HTTP 200, body 1722 bytes ===
```

### 4.3 Résultat Bun

Même fix que l'app --bare (globals implicites en strict mode) mais élargi à TOUS les fichiers du bundle (pas juste `global-imports.js` — `app/app.js` a le même pattern).

Le fix générique (~10 lignes) scanne tous les `.js` dans `packages/` et `app/` pour pré-déclarer les globals sur `globalThis`.

```
MONGO_URL=mongodb://localhost:27099/esm-spike-bun ROOT_URL=http://localhost:4011 PORT=4011 bun test-full-v2.mjs

Importing 67 packages...
All packages imported.
All packages registered.
Startup hooks executed.
Server started (DAEMON mode).

=== BUN: HTTP 200, body 1722 bytes ===
```

### 4.4 Tableau récapitulatif

| | App --bare (54 pkg) | App --full (67 pkg) |
|---|---|---|
| **Node** | ✅ HTTP 200 | ✅ HTTP 200, 1722 bytes |
| **Bun** | ✅ HTTP 200 | ✅ HTTP 200, 1722 bytes |
| **MongoDB** | Non testé | ✅ Connexion OK |
| **Blaze** | N/A | ✅ Chargé |
| **FlowRouter** | N/A | ✅ Chargé |
| **Rspack** | N/A | ✅ Chargé |

### 4.5 Fix Bun élargi

Le bundler Meteor génère des assignations globales implicites (`Mongo = Package.mongo.Mongo`) dans TOUS les fichiers qui ont des globals importés — pas juste `global-imports.js` mais aussi `app/app.js` et potentiellement d'autres.

**Fix runtime (spike) :** Scanner tous les `.js` du bundle et pré-déclarer les variables.

**Fix permanent (bundler) :** Émettre `globalThis.Mongo = ...` au lieu de `Mongo = ...`. Ou mieux : pour le format ESM (option 3), ces assignations deviennent des `import { Mongo } from './packages/mongo.mjs'` et le problème disparaît.

---

## Étape 5 — Benchmark cold start

### 5.1 Résultats (app --full, 67 packages, MongoDB)

3 runs chaque, `performance.now()` dans le script, mesure de RSS.

| Runtime | Setup | Import | Queue | Startup | Main | **Total** | **RSS** |
|---|---|---|---|---|---|---|---|
| **Node** run 1 | 52ms | 673ms | 0ms | 32ms | 1ms | **758ms** | 135 MB |
| **Node** run 2 | 22ms | 543ms | 0ms | 27ms | 1ms | **593ms** | 138 MB |
| **Node** run 3 | 26ms | 699ms | 0ms | 32ms | 1ms | **758ms** | 136 MB |
| **Bun** run 1 | 15ms | 567ms | 0ms | 38ms | 4ms | **624ms** | 136 MB |
| **Bun** run 2 | 18ms | 810ms | 0ms | 49ms | 5ms | **883ms** | 138 MB |
| **Bun** run 3 | 15ms | 633ms | 0ms | 43ms | 5ms | **696ms** | 139 MB |

**Observations :**
- Setup : Bun légèrement plus rapide (15ms vs 22-52ms)
- Import : comparable, variabilité élevée des deux côtés
- Total : dans la même fourchette (600-880ms), pas d'écart significatif
- RSS : identique (~136-139 MB)
- Queue = 0ms car les packages sont tous synchrones dans cette app

**Conclusion bench :** Pas de gain majeur de Bun en cold start pour cette charge. Le temps dominant est l'import des 67 packages (~600ms), identique sur les deux runtimes. Le gain Bun serait plus visible avec Bun.serve() (pas http.createServer) et pour des workloads HTTP à fort throughput.

---

## Étape 6 — DDP smoke test

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

Handshake DDP, method call, subscription — tout passe sur Node.

### 6.2 Bun — WebSocket upgrade ne fonctionne pas ❌

- HTTP : ✅ 200
- WebSocket upgrade : ❌ timeout, pas de réponse au handshake

**Cause :** Bun ne supporte pas complètement l'événement `upgrade` de `http.createServer`. SockJS (et les transports ws/faye de PR #14231) montent le WebSocket via cet événement. Bun attend que les WebSockets soient gérés via `Bun.serve({ websocket: { ... } })`.

**Ce n'est PAS un bug de notre spike.** C'est une limitation connue de Bun avec `http.createServer` + upgrade. Le fix serait :
1. Utiliser `Bun.serve()` au lieu de `http.createServer` (= l'abstraction ServerHost de la section 7 du capability model)
2. Ou attendre que Bun améliore la compat `http.createServer` upgrade

**Impact :** Sous Bun, le serveur HTTP fonctionne mais DDP (WebSocket) ne fonctionne pas. C'est cohérent avec l'analyse : le serveur HTTP et le transport DDP sont les deux seuls concerns qui nécessitent une abstraction runtime-spécifique.

### 6.3 Résumé DDP

| | Node | Bun |
|---|---|---|
| HTTP | ✅ 200 | ✅ 200 |
| WebSocket open | ✅ | ❌ timeout |
| DDP connect | ✅ | ❌ |
| DDP method | ✅ | ❌ |
| DDP subscription | ✅ | ❌ |

---

## Étape 7 — Bun.serve() + WebSocket DDP natif

### 7.1 Architecture du spike

```
Client (browser ou test)
    │
    ▼ port 4071
Bun.serve()
    ├── HTTP → proxy fetch() vers port 4070 (webapp Express)
    └── WebSocket → bridge vers StreamServer de ddp-server
            │
            ▼
    EventEmitter socket compatible SockJS
    (send, write, on('data'), on('close'))
            │
            ▼
    StreamServer.registration_callbacks
            │
            ▼
    DDP Server (livedata_server.js)
```

### 7.2 L'interface socket pour le StreamServer

Le DDP server attend un socket avec :
- `.on('data', cb)` — réception de messages DDP (JSON strings)
- `.on('close', cb)` — déconnexion
- `.send(data)` / `.write(data)` — envoi de messages DDP
- `._meteorSession` — null initialement, assigné par le DDP server
- `.setWebsocketTimeout(ms)` — pour les timeouts SockJS (no-op pour nous)

Implémentation : un `EventEmitter` de Node, avec `.send()` qui appelle `ws.send()` du WebSocket Bun.

### 7.3 Accès au StreamServer

`Package['ddp-server'].DDPServer` n'expose pas `stream_server` directement.
Le bon chemin : **`Package.meteor.Meteor.server.stream_server`** (le Meteor.server est un `Server` créé à ddp-server.js:2135).

`streamServer.registration_callbacks` contient le callback qui setup le handler DDP (parseDDP, processMessage, etc.).
`streamServer.open_sockets` track les sockets ouverts.

### 7.4 Résultat

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

### 7.5 Résumé complet Node vs Bun

| | Node (ESM loader) | Bun (ESM loader) | Bun (+ Bun.serve()) |
|---|---|---|---|
| Import 67 packages | ✅ | ✅ | ✅ |
| core-runtime queue | ✅ | ✅ | ✅ |
| HTTP 200 | ✅ | ✅ | ✅ (proxy) |
| WebSocket open | ✅ | ❌ (http upgrade) | ✅ (natif) |
| DDP connect | ✅ | ❌ | ✅ |
| DDP method | ✅ | ❌ | ✅ |
| DDP subscription | ✅ | ❌ | ✅ |
| MongoDB | ✅ | ✅ | ✅ |

### 7.6 Ce que ça signifie

Le spike Bun est **fonctionnellement complet** : HTTP + DDP + MongoDB sous Bun.

L'architecture Bun.serve() comme proxy est un pattern viable qui pourrait devenir un 5ème transport pluggable dans PR #14231, ou une variante du ServerHost abstrait.

Le bridge EventEmitter est minimal (~15 lignes). Il ne shim rien — il traduit l'interface WebSocket Bun en l'interface socket que le StreamServer attend déjà.

### 7.7 Notes pour la destination

Pour un vrai support Bun en production, `Bun.serve()` ne devrait pas être un proxy devant webapp. Il devrait ÊTRE le serveur principal :
- HTTP direct via fetch handler (pas de proxy vers Express)
- WebSocket natif (pas de bridge)
- Middleware Express remplacé par des handlers fetch

C'est l'abstraction ServerHost du capability model — mais pour le spike, le proxy suffit pour prouver que DDP fonctionne.

---

## Étape 8 — Prochaines étapes

- [ ] Intégrer le loader ESM dans le bundler (`meteor build --format=esm`)
- [ ] Tester avec accounts-password (login flow complet)
- [ ] Considérer Bun.serve() comme 5ème transport dans PR #14231

---

## Observations et découvertes

- L'ordre de dépendance est **déjà calculé** par isobuild dans `_determineLoadOrder()`. C'est un tri topologique. On n'a pas à le refaire.
- `JsImageTarget.write()` itère déjà sur `this.jsToLoad[]` dans le bon ordre. C'est là qu'on génère les imports ESM.
- Le format `"javascript-image-pre1"` dans program.json suggère qu'un format v2 était envisagé mais jamais implémenté.
- `npm-rebuild.js` est exécuté en postinstall (pas au boot), donc il reste nécessaire même en ESM.
- Les assets statiques (fichiers privés des packages) sont copiés dans `assets/` et référencés dans program.json. En ESM, il faudra un mécanisme alternatif pour `Assets.getText()`.
- **CRITIQUE :** Les packages utilisent `Package["core-runtime"].queue()` pour s'enregistrer, pas des IIFE simples. Le système de queue de core-runtime est le vrai mécanisme d'orchestration. boot.js ne fait que charger les fichiers — c'est queue() qui gère l'ordre d'exécution.
- Les fichiers .js du bundle sont déjà exécutables tels quels — leur contenu appelle `queue()` au top-level. Un simple `import './packages/meteor.js'` devrait suffire pour déclencher l'enregistrement.
- 54 packages pour une app --bare + webapp. C'est beaucoup mais c'est attendu (meteor-base tire tout l'écosystème).
- Le format `"javascript-image-pre1"` dans program.json n'a jamais eu de "pre2". C'est le seul format depuis la création.
- boot.js ajoute un wrapping SUPPLÉMENTAIRE `(function(Npm, Assets){...})` autour du contenu des fichiers. Ce wrapping injecte Npm et Assets. En ESM, il faudra un autre mécanisme pour ces deux objets.
- **CRITIQUE :** Le filesystem virtuel de `meteorInstall` (modules-runtime) est le vrai obstacle. Les packages ne font pas juste `require('express')` — ils passent par un arbre virtuel `/node_modules/meteor/X/node_modules/Y` résolu par `meteorInstall` + `npmRequire`. C'est plus profond que le wrapping boot.js.
- **Deux horizons clairs :** Spike = resolver minimal (option 2, rapide). Destination = le bundler émet des vrais chemins (option 3, propre, modifie le linker).
- Les fichiers du bundle sont importables — 53/54 passent l'import. Le blocage est dans l'EXÉCUTION de la queue core-runtime quand un package a un `require()` qui passe par le filesystem virtuel et que notre resolver ne couvre pas le pattern.
- `react-fast-refresh` est à l'index 7/54 dans l'ordre de chargement. Son échec bloque les 47 packages suivants car la queue core-runtime est séquentielle.
- `Package._define(name, exports)` est appelé par la queue APRÈS l'exécution réussie d'un package. C'est pour ça qu'on ne voit que 7 packages enregistrés malgré 53 imports réussis — l'import charge le code mais la queue ne l'exécute pas tant que le précédent n'a pas fini.
