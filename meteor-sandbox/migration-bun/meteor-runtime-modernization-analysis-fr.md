# Analyse de modernisation du runtime Meteor — Troisieme passe

**Date :** 2026-03-29
**Auteur :** dupontbertrand (avec analyse Claude)
**Statut :** Analyse architecturale — vision prospective
**Posture :** Non pas "comment porter Meteor ?" mais "que devrait devenir Meteor ?"

---

## 1. Objectif reformule

La vraie question n'est pas "est-ce que Meteor peut tourner sur Bun ou Deno ?" La vraie question est :

**Si Meteor devait justifier chacun de ses choix d'implementation internes aujourd'hui — pas en 2012, pas en 2015, pas a l'epoque des Fibers — quels elements survivraient, lesquels seraient reconcevoir, et lesquels seraient discretement supprimes ?**

Bun et Deno sont des catalyseurs pour cette question, pas la question elle-meme. Une migration de runtime qui reproduirait fidelement les mecanismes internes actuels de Meteor heriterait de tout le couplage accumule, de tous les contournements et de toute la complexite accidentelle — juste sur un moteur different. C'est le pire scenario : meme dette, nouvel hote.

Le meilleur cadrage est :

1. **Identifier ce que Meteor EST** — le produit, l'experience developpeur, les garanties.
2. **Identifier ce que Meteor FAIT A CAUSE DE NODE** — les details d'implementation faconnes par le systeme de modules specifique de Node, son modele de processus et son ecosysteme circa 2012-2020.
3. **Separer 1 de 2.** Porter (1). Reconcevoir ou supprimer (2).

Si cette analyse est bien faite, elle produit de la valeur meme si le support Bun/Deno n'est jamais livre. Elle indique a la core team ou s'arrete la vraie architecture de Meteor et ou commence le tissu cicatriciel herite de Node.

---

## 2. Valeur coeur de Meteor vs implementation historique

| Domaine | Valeur coeur de Meteor a preserver | Detail d'implementation actuel | Garder / Abstraire / Reconcevoir / Supprimer | Pourquoi |
|---|---|---|---|---|
| **Data on the wire** | Le serveur publie des donnees, le client s'abonne de maniere reactive. Pas de rendu HTML cote serveur requis. | Protocole DDP sur SockJS/WebSocket | **Garder** le protocole, **abstraire** le transport | DDP est l'identite de Meteor. SockJS est un choix de transport. Le transport est deja en cours d'abstraction. |
| **Packages isomorphiques** | Le meme code de package peut tourner cote client et serveur avec un decoupage par architecture | `Package.onUse(api => api.addFiles(..., ['client', 'server']))` + systeme d'archi isobuild | **Garder** le concept, **reconcevoir** le modele d'execution des packages | Le concept est coeur. Le modele d'evaluation `vm.runInThisContext` ne l'est pas. |
| **Experience dev zero-config** | `meteor create && meteor run` fonctionne out of the box avec Mongo, HMR, build | Node vendored + MongoDB vendored + npm custom + catalogue de packages custom | **Garder** l'experience, **abstraire** les dependances runtime | Les utilisateurs adorent la DX. Ils se fichent que Node soit vendored ou qu'il y ait un dev bundle. |
| **Hot code push** | Mise a jour de l'app sans rechargement complet de page en dev et production | Le serveur detecte les changements -> rebuild -> signale le client via DDP | **Garder** | C'est de la valeur produit. L'implementation est deja raisonnable. |
| **Donnees reactives / minimongo** | Data store reactif cote client qui reflete les collections serveur | Minimongo + Tracker (client), MongoDB oplog/polling (serveur) | **Garder** | Differenciateur produit coeur. Implementation propre. |
| **Systeme de comptes** | Comptes unifies avec strategies pluggables (mot de passe, OAuth, etc.) | accounts-base + accounts-password + addons natifs bcrypt/argon2 | **Garder** l'API, **abstraire** le backend crypto | L'API comptes a de la valeur. Dependre de l'addon natif bcrypt est un detail d'implementation. |
| **UI optimiste** | Les methodes simulent cote client, confirment depuis le serveur | Method stubs + protocole de methode DDP | **Garder** | Innovation coeur de Meteor. Implementation propre. |
| **Demarrage serveur / evaluation des packages** | Les packages chargent dans l'ordre de dependance, chacun a son propre scope avec `Npm`, `Assets` | `vm.runInThisContext` enveloppant chaque package dans une closure, injectant les symboles | **Reconcevoir** | Le pattern envelopper-dans-une-closure-et-eval etait malin en 2012. En 2026, les modules ES + import dynamique peuvent atteindre le meme scoping sans vm. |
| **Systeme de modules / reify** | La syntaxe ES module fonctionne dans les packages Meteor | Monkey-patching de `Module.prototype._compile` et `_extensions['.js']` pour intercepter chaque require et executer les transformations reify | **Supprimer** (remplacer par ESM natif) | Reify existe parce que Node ne supportait pas ESM. Node 22 le supporte. Bun et Deno le supportent nativement. Le pipeline reify entier est un polyfill pour un probleme qui n'existe plus. |
| **Npm.require / Npm.depends** | Les packages Meteor peuvent declarer et utiliser des dependances npm | Resolution custom dans npm-require.js, gestion npm-shrinkwrap dans meteor-npm.js | **Reconcevoir** | `Npm.require` est une indirection specifique a Meteor au-dessus de `require`. Dans un monde avec ESM natif et des dependances package.json standard, cette indirection ajoute de la complexite sans valeur. |
| **Serveur HTTP** | Meteor sert les assets statiques et connecte les middlewares | Express au-dessus de `http.createServer` | **Abstraire** | Le serveur HTTP devrait etre un hote pluggable, pas cable en dur sur Express + Node http. |
| **Sortie de build / format de bundle** | `meteor build` produit un artefact deployable | Tar contenant main.js + programs/server/ + programs/web.browser/ | **Reconcevoir** le point d'entree serveur, **garder** la structure | La structure du bundle est correcte. Le point d'entree (main.js -> runtime.js -> boot.js -> vm.eval chaque package) est la ou vit tout le couplage. |
| **Contexte async (binding methode/pub DDP)** | Chaque appel de methode/publication DDP a son propre contexte d'execution | `AsyncLocalStorage` (Meteor 3) remplacant Fibers + variables dynamiques | **Garder** | Deja moderne. AsyncLocalStorage est supporte partout. |
| **Cycle de vie du processus** | Le serveur demarre, reste en vie, gere les signaux | `process.exit`, gestionnaires de signaux, polling du PID parent | **Abstraire** | Ce sont des patterns raisonnables mais cables en dur sur le modele de processus de Node. Un contrat d'hote runtime devrait gerer ca. |
| **Shell server / REPL** | `meteor shell` donne un REPL serveur | Socket Unix + module REPL de Node | **Supprimer** ou rendre optionnel | Utile pour le debug mais pas une valeur produit coeur. Couple a `net` + `repl`. En production, personne n'utilise `meteor shell`. |
| **Source maps** | Les erreurs montrent les emplacements source originaux | Package npm `source-map-support` + `Error.prepareStackTrace` (specifique V8) | **Reconcevoir** | Les source maps ont de la valeur. La strategie d'integration (monkey-patching de l'API de stack trace de V8) est specifique au moteur. Les runtimes modernes ont leur propre support de source maps. |
| **Debugging / inspector** | `meteor debug` / `--inspect` | Integration du protocole V8 Inspector | **Abstraire** | Le debugging est essentiel. Le cablage en dur sur le protocole V8 ne l'est pas. |
| **Addons natifs** | Les packages comme bcrypt, argon2 fonctionnent | node-gyp + node-pre-gyp inclus dans la sortie de build, npm rebuild au moment du deploiement | **Reconcevoir** | La chaine de dependances node-gyp est fragile et specifique a la plateforme. Des alternatives WASM existent pour bcrypt. Le pattern rebuild-au-deploiement est une source constante d'echecs de deploiement. |

---

## 3. Lecons de la douleur liee au couplage Node

### Lecon 1 : Fibers — construire sur une extension runtime que le runtime a rejetee

**Choix historique :** Meteor utilisait Fibers (un addon natif C++) pour fournir du code async a l'apparence synchrone. C'etait le killer feature DX de Meteor : on pouvait ecrire `Collection.findOne()` sans callbacks ni await.

**Pourquoi c'etait sense :** En 2012, Node avait des callbacks. Pas de Promises dans la bibliotheque standard. Pas d'async/await. Fibers fournissait genuinement un meilleur modele de programmation.

**Douleur causee :** Fibers n'a jamais fait partie du coeur de Node. Il etait maintenu par une seule personne. Quand Node a migre vers des versions V8 plus recentes puis vers N-API, Fibers a casse a repetition. Ca a bloque les mises a jour de Node pendant des annees. La migration vers async/await dans Meteor 3 a ete le plus gros changement cassant de l'histoire de Meteor.

**Lecon :** Ne jamais construire une abstraction produit coeur sur une extension specifique au runtime qui ne fait pas partie de la roadmap du runtime lui-meme. Si on a besoin d'une capacite que le runtime ne fournit pas, soit (a) on la contribue en amont, (b) on la construit comme une couche amovible avec un chemin de migration clair, soit (c) on accepte le modele du runtime. Meteor a choisi (d) : construire dessus de maniere permanente sans fallback. Ca a coute des annees.

**Pour Bun/Deno :** Si Meteor a besoin d'une capacite que Bun ou Deno ne supporte pas, la reponse N'EST PAS de hacker un contournement. La reponse est de ne pas en avoir besoin.

---

### Lecon 2 : vm.runInThisContext — isolation de scope via les internes du runtime

**Choix historique :** Les packages Meteor ont chacun leur propre scope avec des symboles injectes (`Package`, `Npm`, `Assets`). C'est realise en enveloppant le code de chaque package dans une expression de fonction et en l'evaluant via `vm.runInThisContext`.

**Pourquoi c'etait sense :** En 2012, il n'y avait pas de modules ES. Pas d'`import`/`export`. Aucun moyen standard de creer des scopes de modules isoles. Le module vm etait le seul moyen d'evaluer du code avec un nom de fichier custom (pour les stack traces) sans creer un fichier sur le disque.

**Douleur causee :** Couplage profond au module `vm` de Node. Les plugins de build utilisent aussi `vm` (dans isobuild). Le pattern est fragile — pas de sandboxing, pas d'isolation d'erreurs, pas d'isolation memoire. Ca rend aussi la sequence de demarrage opaque : boot.js lit des fichiers, les enveloppe dans des chaines, les eval. Debugger ca est penible. Et maintenant c'est le bloqueur n°1 pour les runtimes alternatifs.

**Lecon :** L'isolation de scope devrait utiliser le systeme de modules du langage lui-meme, pas l'eval du runtime. En 2026, les modules ES fournissent exactement l'isolation dont Meteor a besoin : chaque module a son propre scope, peut exporter des symboles, peut importer des dependances. Le wrapper vm devrait etre remplace par du chargement de modules standard.

---

### Lecon 3 : Monkey-patching de Module.prototype — reify comme polyfill permanent

**Choix historique :** Pour supporter la syntaxe ES `import`/`export` avant que Node ne le fasse, Meteor utilise `@meteorjs/reify`, qui monkey-patche `Module.prototype._compile` et `Module._extensions['.js']` pour intercepter chaque appel `require()` et transformer la syntaxe ES module en CJS au moment du chargement.

**Pourquoi c'etait sense :** Quand reify a ete cree, Node n'avait pas de support ESM natif. Babel etait trop lent pour la compilation en temps de developpement. Reify etait une transformation inline clevere et rapide.

**Douleur causee :** Chaque fichier `.js` charge par le serveur passe par un pipeline de transformation de chaines impliquant le parsing acorn avec un fallback babel. Le patching de Module.prototype est le code le plus specifique a Node du runtime de Meteor — il depend d'internes non documentes (`_compile`, `_extensions`, `_resolveFilename`) que les autres runtimes ne supportent explicitement pas. Ca signifie aussi que le chargement de modules de Meteor est fondamentalement different du chargement standard de Node, ce qui cause des bugs subtils et deroute les outils.

**Lecon :** Les polyfills devraient avoir des dates d'expiration. Reify etait un pont. La destination du pont (ESM natif) est arrivee il y a des annees. Le pont devrait etre supprime, pas transporte vers de nouveaux runtimes.

---

### Lecon 4 : Binaire Node vendored — le verrouillage de version runtime comme feature

**Choix historique :** Meteor embarque une version specifique de Node dans son dev bundle. `meteor run` utilise ce Node vendored, pas le Node systeme. `meteor npm` utilise le npm vendored.

**Pourquoi c'etait sense :** Coherence garantie. Pas de "ca marche sur ma machine" pour les differences de version Node. Particulierement important quand Meteor avait besoin de features V8 specifiques ou de compatibilite Fibers.

**Douleur causee :** Meteor est toujours en retard sur les versions Node parce que quelqu'un doit manuellement mettre a jour la version vendored, tout tester et reconstruire les dev bundles pour chaque plateforme. Les utilisateurs ne peuvent pas utiliser les nouvelles features Node tant que Meteor ne rattrape pas son retard. Le dev bundle est gros (~120 Mo pour Node seul). Le vendoring cree un univers npm parallele qui deroute l'outillage (les IDE, linters, gestionnaires de packages ne comprennent pas `meteor npm`).

**Lecon :** La coherence de version a de la valeur. L'atteindre en vendorant le runtime entier est couteux. Une meilleure approche : declarer une plage de versions Node supportees, valider au demarrage, laisser les utilisateurs apporter leur propre runtime. C'est ce que fait chaque autre framework. C'est aussi ce qui rend la portabilite runtime triviale — Meteor arrete de posseder le binaire runtime.

---

### Lecon 5 : Npm.require / Npm.depends — un systeme de packages parallele

**Choix historique :** Meteor a son propre format de package (package.js) avec sa propre declaration de dependances (`Npm.depends()`). Au runtime, `Npm.require()` fournit un mecanisme de resolution custom qui cherche dans plusieurs repertoires node_modules.

**Pourquoi c'etait sense :** npm en 2012 etait immature. Le versioning semantique etait mal adopte. Le systeme de packages de Meteor fournissait une resolution de contraintes que npm ne pouvait pas offrir. `Npm.depends` donnait aux packages Meteor des dependances npm reproductibles avant que npm-shrinkwrap/package-lock n'existe.

**Douleur causee :** Deux systemes de packages a comprendre et maintenir. Un modele mental confus pour les nouveaux venus ("j'utilise npm install ou meteor add ?"). Une logique de resolution custom dans npm-require.js qui duplique ce que le systeme de modules de Node fait deja. Un fardeau de maintenance pour meteor-npm.js qui shell out vers npm avec des flags specifiques et attend des formats de fichier de verrouillage specifiques.

**Lecon :** Si l'ecosysteme fournit ce dont vous avez besoin, utilisez-le. npm a maintenant des fichiers de verrouillage, des workspaces, des peer dependencies et de la resolution de contraintes. Le systeme de packages parallele de Meteor duplique tout ca a un cout de maintenance eleve. Le nouveau code devrait utiliser des dependances package.json standard autant que possible.

---

### Lecon 6 : source-map-support via Error.prepareStackTrace — DX specifique V8

**Choix historique :** Meteor utilise le package npm `source-map-support` qui se branche sur `Error.prepareStackTrace` de V8 pour reecrire les stack traces en utilisant les source maps.

**Pourquoi c'etait sense :** Les stack traces dans du code compile/bundle sont illisibles. Les source maps corrigent ca. `Error.prepareStackTrace` de V8 etait le seul hook disponible.

**Douleur causee :** Completement specifique V8. Ne fonctionne pas sur JavaScriptCore (Bun). Fragile en interaction avec d'autres outils qui monkey-patchent aussi `Error.prepareStackTrace`. Node moderne a le flag `--enable-source-maps` qui fait ca nativement.

**Lecon :** Utiliser le support source maps propre au runtime plutot que de monkey-patcher la gestion des erreurs. Node a `--enable-source-maps`. Deno et Bun gerent les source maps nativement. Le package `source-map-support` est un heritage.

---

## 4. Carte preserver vs reconcevoir

| Surface / sous-systeme | Porter fidelement | Preserver mais abstraire | Reconcevoir | Supprimer | Justification |
|---|---|---|---|---|---|
| Protocole DDP | **X** | | | | Identite coeur. Bien concu. Agnostique du runtime. |
| Pub/sub + methodes | **X** | | | | Valeur produit coeur. |
| Minimongo (client) | **X** | | | | Valeur produit coeur. Client uniquement, non pertinent pour le runtime. |
| Tracker (reactivite client) | **X** | | | | Client uniquement, non pertinent pour le runtime. |
| API Comptes | **X** | | | | DX coeur. Abstraction propre. |
| UI optimiste / method stubs | **X** | | | | Innovation coeur. |
| Contexte AsyncLocalStorage | **X** | | | | Deja moderne. Fonctionne partout. |
| Structure de sortie de build | **X** | | | | star.json + programs/ est un format correct. |
| Hot code push | **X** | | | | DX coeur. |
| Hebergement serveur HTTP | | **X** | | | Devrait accepter toute implementation de serveur HTTP, pas cablage en dur Express + http.createServer. |
| Couche transport (WebSocket/SockJS) | | **X** | | | Deja en cours d'abstraction. |
| Integration driver MongoDB | | **X** | | | Mongo est coeur pour Meteor mais le driver devrait etre une dependance pluggable. |
| Cycle de vie processus / signaux | | **X** | | | Patterns raisonnables, mais devrait etre un contrat, pas des appels process.on codes en dur. |
| Backend crypto (bcrypt/argon2) | | **X** | | | Garder la securite des comptes, abstraire l'implementation. Le bcrypt WASM existe. |
| Scoping / evaluation des packages | | | **X** | | Remplacer vm.runInThisContext par du chargement de modules ES. Les packages deviennent de vrais modules, pas des chaines eval'd. |
| Sequence de boot (boot.js) | | | **X** | | Remplacer la boucle lecture-fichier-enveloppe-eval par une chaine d'imports de modules standard. |
| runtime.js / patching Module | | | | **X** | Supprimer entierement. Remplacer par ESM natif ou un loader standard. Reify est un polyfill pour des problemes resolus. |
| Npm.require / npm-require.js | | | **X** | | Remplacer par des `import` ou `require` standard depuis des node_modules standard. |
| Npm.depends dans package.js | | | **X** | | Migrer vers du package.json standard pour les dependances npm. |
| npm-rebuild.js | | | **X** | | Simplifier : soit utiliser des alternatives WASM pour les deps natives, soit utiliser npm rebuild standard sans wrapper custom. |
| Shell server (REPL) | | | | **X** | Non essentiel. Couple a `net` + `repl`. Peut etre un package optionnel separe. |
| Integration source-map-support | | | | **X** | Utiliser le support source maps natif du runtime (`--enable-source-maps` ou equivalent). |
| Dev bundle Node vendored | | | **X** | | Arreter de vendorer. Declarer les runtimes supportes. Laisser les utilisateurs apporter le leur. |
| Barriere de version semver dans boot.js | | | | **X** | Detecter les features au lieu de verifier la version. Ou simplement supprimer — laisser le runtime echouer naturellement sur les API non supportees. |
| Verification du PID parent | | | | **X** | Utilise uniquement en mode dev. Non pertinent pour les bundles production. A ajouter au serveur de dev uniquement, pas dans boot.js. |
| Fonction pause de debug.ts | | | | **X** | Un simple `debugger` statement dans une fonction. Ne merite pas d'etre transporte comme infrastructure. |

---

## 5. Si on s'autorisait a casser les internes, qu'est-ce qui se simplifie ?

### 5.1 Modele de chargement boot/runtime
**Actuel :** main.js -> runtime.js (patche Module) -> boot.js (lit du JSON, boucle sur les fichiers, enveloppe chacun dans une chaine, vm.runInThisContext, appelle le resultat).
**Si casse :** main.js -> `import './packages/meteor.js'` -> `import './packages/webapp.js'` -> etc. Imports de modules ES standard. Pas de vm. Pas d'enveloppement de chaines. Pas de boucle pilotee par JSON. Chaque package est un vrai module avec ses propres imports.
**Risque :** Moyen — change la facon dont le bundler genere la sortie, mais la semantique de chargement est equivalente.
**Utile meme sans Bun/Deno :** **Oui.** Ca rend le boot plus rapide (pas d'overhead concatenation de chaines + eval), debuggable (le chargement standard de modules apparait dans les profileurs), et compatible avec tout runtime supportant les modules ES.

### 5.2 Execution basee sur vm
**Actuel :** `vm.runInThisContext(wrappedCode, {filename})` pour chaque package serveur.
**Si casse :** Remplacer par `import()` ou `require()` standard. Le wrapper `(function(Npm, Assets){...})` devient un vrai module qui importe ses dependances normalement.
**Risque :** Moyen — l'injection de `Npm` et `Assets` doit etre geree differemment. Pourrait utiliser des globales au niveau module, un conteneur DI, ou des import maps par package.
**Utile meme sans Bun/Deno :** **Oui.** Supprime le code le plus fragile et specifique a Node du runtime serveur.

### 5.3 Patching de Module.prototype (reify)
**Actuel :** Patche `_compile`, `_extensions['.js']`, `_resolveFilename` pour transformer les modules ES au moment du chargement.
**Si casse :** Utiliser ESM natif. Node 22 le supporte. Bun et Deno le supportent nativement.
**Risque :** Eleve — c'est un changement fondamental de la facon dont tous les packages Meteor sont charges. Chaque package qui utilise `import`/`export` depend de reify.
**Utile meme sans Bun/Deno :** **Oui, absolument.** C'est la modernisation a plus haute valeur. Reify est un polyfill pour un probleme resolu depuis des annees. Le supprimer elimine le code le plus dependant des internes Node de tout le runtime, ameliore les performances de demarrage et rend le chargement de modules de Meteor standard.

### 5.4 Modele de demarrage / point d'entree main
**Actuel :** main.js fait 6 lignes de CJS (`require('path')`, `process.chdir`, `require('./runtime.js')`, `require('./boot.js')`). boot.js a un demarrage async complexe : charger les bundles -> appeler les hooks de startup -> appeler main().
**Si casse :** main.js est un point d'entree ES module. L'ordre de chargement des packages est encode comme dependances d'import, pas un manifeste JSON. Les hooks de startup deviennent des effets de bord standard des modules ES.
**Risque :** Moyen — change le format de sortie du bundle.
**Utile meme sans Bun/Deno :** **Oui.** Un point d'entree ESM standard est debuggable, profilable et comprehensible par tout developpeur JS.

### 5.5 Modele d'evaluation des packages serveur
**Actuel :** Le code de chaque package est enveloppe dans `(function(Npm, Assets, ...specialArgs){ ... })` et appele avec des objets injectes.
**Si casse :** Chaque package est un vrai module. `Npm` devient `import` (standard). `Assets` devient une fonction importee depuis un module fourni par Meteor. Les arguments speciaux (comme `npmRequire` pour modules-runtime) deviennent des imports explicites.
**Risque :** Faible-Moyen — le pattern d'enveloppement est un mecanisme d'isolation de scope. Les modules ES fournissent l'isolation de scope nativement.
**Utile meme sans Bun/Deno :** **Oui.** Rend le code des packages du JavaScript standard qui fonctionne avec les outils standard (linters, verificateurs de types, bundlers, debuggers).

### 5.6 Comportement Shell / REPL
**Actuel :** shell-server cree un socket Unix, ecoute les connexions, lance un REPL Node.
**Si casse :** Retirer du coeur. Proposer comme package optionnel. Ou remplacer par un REPL base sur WebSocket qui fonctionne sur tout runtime.
**Risque :** Tres faible — peu d'utilisateurs dependent de `meteor shell` en production.
**Utile meme sans Bun/Deno :** **Oui.** Reduit la surface coeur.

### 5.7 Strategie source maps / debugging
**Actuel :** Le package `source-map-support` se branche sur `Error.prepareStackTrace` de V8.
**Si casse :** Utiliser `--enable-source-maps` sur Node (integre depuis v12.12). Sur Bun/Deno, les source maps sont gerees nativement. Embarquer les commentaires `//# sourceMappingURL=` dans le code genere.
**Risque :** Faible — `--enable-source-maps` est une feature bien testee de Node.
**Utile meme sans Bun/Deno :** **Oui.** Supprime une dependance et un monkey-patch.

### 5.8 Les modules natifs
**Actuel :** node-gyp et node-pre-gyp inclus dans chaque sortie de build. npm-rebuild.js tourne en postinstall.
**Si casse :** Preferer les alternatives WASM la ou c'est disponible (bcrypt -> `bcrypt-wasm` ou `@aspect/bcrypt` ; argon2 a des variantes WASM). Pour les packages ou le WASM n'est pas viable, utiliser des binaires preconstruits via `prebuildify` ou `@napi-rs`. Arreter d'embarquer node-gyp dans la sortie.
**Risque :** Moyen — certains packages pourraient ne pas avoir d'alternatives WASM. Evaluation au cas par cas necessaire.
**Utile meme sans Bun/Deno :** **Oui.** Supprime la cause n°1 d'echecs de deploiement ("npm rebuild a echoue en production").

### 5.9 Modele de processus
**Actuel :** boot.js suppose qu'il est le processus principal. Poll le PID parent. Gere SIGTERM/SIGINT. Appelle `process.exit()`.
**Si casse :** Definir un contrat "hote serveur Meteor" : l'hote fournit un moyen de demarrer, un moyen d'arreter et un moyen de signaler la disponibilite. Que cet hote soit un processus Node, un processus Bun, un processus Deno ou une fonction serverless est abstrait.
**Risque :** Faible pour la definition du contrat. Moyen pour l'implementation.
**Utile meme sans Bun/Deno :** **Oui** — surtout pour les modeles de deploiement serverless.

---

## 6. Candidats de nouvelle architecture

### Candidat A : "ESM Boot" — Point d'entree module standard

**Idee centrale :** Remplacer la boucle vm-eval de boot.js par un point d'entree ES module genere. Le bundler produit `server/index.mjs` qui importe chaque package comme un vrai module dans l'ordre de dependance. Pas de vm. Pas de reify. Pas de patching Module.

**Ce que ca preserve :**
- Structure de sortie de build (star.json, programs/)
- DDP, pub/sub, methodes, comptes — tout intact
- Ordre de dependance des packages
- Semantique `Npm` et `Assets` (reimplementee comme imports de module)

**Ce que ca casse :**
- boot.js est entierement remplace
- runtime.js est supprime
- Les packages doivent etre generes comme de vrais fichiers ESM, pas des chaines enveloppees
- `Npm.require()` devient `import` ou `createRequire()`
- source-map-support supprime (utiliser le natif)

**Pourquoi c'est mieux qu'un portage fidele :** Supprime 100% du patching Module, 100% de l'utilisation de vm, 100% de reify du runtime. Le chemin de boot serveur devient du JavaScript standard que tout runtime comprend.

**Cout de compatibilite :** Eleve pour isobuild (le bundler doit generer de la sortie ESM). Zero pour le code utilisateur (les packages ecrivent toujours `import`/`export`, ca fonctionne nativement maintenant).

**Difficulte de migration :** 4-8 semaines pour les changements du bundler + nouveau point d'entree boot. Necessite une version mineure ou majeure de Meteor.

**Aide :** Bun, Deno et tous les futurs runtimes. Aide aussi Node (demarrage plus rapide, meilleur debugging).

---

### Candidat B : "Runtime Host Contract" — Hote serveur pluggable

**Idee centrale :** Definir un contrat explicite entre la logique applicative de Meteor et son hote runtime. Le contrat specifie : comment demarrer un serveur HTTP, comment gerer les signaux, comment acceder au systeme de fichiers, comment charger les modules. Chaque runtime fournit un adaptateur leger.

```
MeteorApp <-> ContratHote <-> NodeHost / BunHost / DenoHost / ServerlessHost
```

**Ce que ca preserve :**
- Toute la logique applicative de Meteor (DDP, comptes, Mongo, etc.)
- Systeme de packages et sortie de build
- Experience developpeur

**Ce que ca casse :**
- `require('http')` direct dans webapp — remplace par `Host.createServer()`
- `process.on('SIGTERM')` direct — remplace par `Host.onShutdown()`
- Import `cluster` direct — remplace par `Host.isWorker()`
- Acces direct au systeme de fichiers dans boot — remplace par `Host.loadModule()`

**Pourquoi c'est mieux qu'un portage fidele :** Le choix de runtime devient une decision de configuration, pas une decision d'architecture. Ajouter un nouveau runtime se resume a ecrire un adaptateur leger, pas a auditer tout le codebase.

**Cout de compatibilite :** Moyen — webapp et boot.js necessitent du refactoring. Le code utilisateur n'est pas affecte.

**Difficulte de migration :** 6-12 semaines. L'essentiel du temps passe a definir le contrat et tester les cas limites.

**Aide :** Tous les runtimes, et aussi le serverless (Cloudflare Workers, Vercel Edge, etc.).

---

### Candidat C : "Lean Bundle" — Runtime minimal, pas de chargement magique

**Idee centrale :** `meteor build` produit un bundle qui ressemble a une application Node/Bun/Deno normale. Pas de loader de modules custom. Pas d'orchestration boot.js. Juste un `package.json` avec `"type": "module"`, un point d'entree `index.mjs`, et des `node_modules` standard. Le consommateur le lance comme n'importe quelle autre app.

**Ce que ca preserve :**
- La semantique applicative de Meteor (DDP, reactivite, comptes)
- Le systeme de build (isobuild gere toujours la compilation, mais genere un format standard)

**Ce que ca casse :**
- Toute l'infrastructure runtime custom (boot.js, runtime.js, npm-require.js, server-json.js)
- `Npm.require()` (remplace par un import standard)
- Le format de metadonnees star.json / program.json
- npm-rebuild.js (npm install standard gere tout)
- La distinction entre "bundle Meteor" et "app Node normale"

**Pourquoi c'est mieux qu'un portage fidele :** Le bundle construit n'est plus un format special que seul Meteor comprend. C'est une application normale. Toute plateforme d'hebergement, tout runtime, tout gestionnaire de processus peut le lancer sans connaissance specifique a Meteor.

**Cout de compatibilite :** Tres eleve pour l'outillage de l'ecosysteme qui attend le format de bundle actuel. Le deploiement Galaxy devrait etre mis a jour. Les images Docker changeraient.

**Difficulte de migration :** 12-20 semaines. Changement fondamental de la sortie de build.

**Aide :** Tout — Bun, Deno, serverless, edge, hebergement standard. Simplifie aussi massivement la documentation de deploiement et le debugging.

---

### Candidat D : "Decouplage Incremental" — Corriger le pire couplage, garder le reste

**Idee centrale :** Pas de reconception. Juste corriger les 3-4 pires surfaces specifiques a Node dans le runtime, en gardant tout le reste tel quel. Specifiquement : (1) remplacer vm.runInThisContext par Function(), (2) supprimer le patching Module.prototype, (3) rendre l'import cluster lazy, (4) utiliser les source maps natives.

**Ce que ca preserve :** Presque tout. boot.js boucle toujours sur serverJson.load. npm-require.js resout toujours les modules. Le format de bundle est inchange.

**Ce que ca casse :** runtime.js est significativement simplifie ou supprime. boot.js recoit un petit patch. La dependance source-map-support est supprimee.

**Pourquoi c'est mieux qu'un portage fidele :** Supprime les vrais bloqueurs sans rien reconcevoir. Faible risque, livraison rapide.

**Cout de compatibilite :** Tres faible. Changements internes uniquement.

**Difficulte de migration :** 2-4 semaines.

**Aide :** Bun principalement. Deno partiellement (l'exigence de flag CJS reste). Mais la valeur est limitee — c'est un correctif tactique, pas une amelioration strategique.

---

## 7. Ce qui ne devrait jamais etre reconduit

### 7.1 vm.runInThisContext comme mecanisme de chargement de modules
Le module vm a ete concu pour le sandboxing et l'evaluation de code, pas pour le chargement de modules applicatifs. L'utiliser pour le chargement de packages etait un hack raisonnable en 2012 quand les modules ES n'existaient pas. Le reconduire vers tout nouveau runtime serait reproduire un accident historique.

### 7.2 Monkey-patching de Module.prototype
Patcher les API internes de modules de Node (`_compile`, `_extensions`, `_resolveFilename`) est inheremment fragile. Ces API ne font pas partie du contrat public de Node. Les autres runtimes ne les implementent explicitement pas. Tout code qui en depend est, par definition, non portable.

### 7.3 Reify comme couche permanente
Reify transforme la syntaxe ES module en CJS au moment du chargement. Chaque runtime qui interessera Meteor supporte ESM nativement. Reify devrait etre traite comme une couche de compatibilite pour les anciens packages, pas comme une partie permanente de l'architecture.

### 7.4 Binaire runtime vendored
Vendorer un binaire Node specifique resolvait un vrai probleme (Fibers avait besoin de versions V8 specifiques). Ce probleme est resolu. Le vendoring cree maintenant plus de problemes qu'il n'en resout : versions obsoletes, gros telechargements, confusion sur quel Node est utilise.

### 7.5 Gestion npm custom (meteor-npm.js)
Shell out vers npm avec des flags specifiques, gerer des fichiers shrinkwrap, verifier la version de npm — tout ca duplique ce que l'ecosysteme fournit. La couche npm custom devrait etre remplacee par des dependances package.json standard.

### 7.6 Couplage au niveau processus dans boot.js
Polling du PID parent, barriere de version, polling d'attente du debugger — ce sont des preoccupations d'outils de dev melangees dans le chemin de boot production. Elles devraient etre separees : le boot production devrait etre propre et minimal.

### 7.7 Globales implicites comme mecanisme de communication inter-packages
`Package`, `__meteor_bootstrap__`, `__meteor_runtime_config__`, `global.Package` — la dependance a des objets globaux mutables pour la communication inter-packages est un code smell qui etait acceptable avec le chargement base sur vm mais ne devrait pas survivre dans un monde ESM.

### 7.8 node-gyp comme dependance de deploiement runtime
Embarquer node-gyp dans chaque sortie de build et lancer npm rebuild au moment du deploiement suppose que l'environnement de deploiement a un compilateur C++. Ca echoue dans les conteneurs, le serverless et les environnements minimaux. Les deps natives devraient etre preconstruites ou remplacees par du WASM.

---

## 8. Piste de modernisation pratique

### A. A faire meme si Meteor reste sur Node pour toujours

| Refactor | Effort | Impact |
|---|---|---|
| **Remplacer vm.runInThisContext dans boot.js par Function()** | 1-2 jours | Supprime la dependance fragile a vm. Debugging plus simple. |
| **Utiliser --enable-source-maps de Node au lieu de source-map-support** | 2-3 jours | Supprime une dependance et un monkey-patch specifique V8. |
| **Rendre l'import cluster lazy/conditionnel dans webapp** | 1 heure | Reduit le chargement de modules inutile. Corrige le probleme des stubs Deno. |
| **Extraire shell-server du coeur vers un package optionnel** | 1-2 jours | Reduit la surface coeur. Supprime la dependance `net` + `repl` de la production. |
| **Supprimer le polling du PID parent du chemin de boot production** | 1 heure | Boot production plus propre. Necessaire uniquement pour le serveur de dev `meteor run`. |
| **Supprimer la barriere de version semver de boot.js** | 30 min | Laisser le runtime echouer naturellement sur les API non supportees. Ou utiliser la detection de features. |
| **Ajouter les pragmas sourceURL au code evalue par vm** | 1 heure | Meilleures stack traces meme sur Node. Permet le fallback Function(). |
| **Evaluer les alternatives WASM pour bcrypt/argon2** | 1 semaine | Supprime la compilation d'addons natifs du deploiement. Enorme gain DevOps. |
| **Migrer vers une sortie ESM depuis le bundler** | 4-8 semaines | Le gros morceau. Rend toutes les autres modernisations plus faciles. Supprime la dependance reify. |

### B. A faire uniquement si on poursuit serieusement Bun/Deno ou la portabilite runtime

| Refactor | Effort | Impact |
|---|---|---|
| **Definir un contrat d'hote runtime (HTTP, signaux, chargement de modules)** | 4-6 semaines | Requis pour le support multi-runtime. Disproportionne si on reste sur Node. |
| **Construire des adaptateurs Bun/Deno pour le contrat d'hote** | 2-4 semaines chacun | Support runtime direct. Pas de valeur sur Node seul. |
| **Reecrire npm-require.js pour une resolution de modules standard** | 2-3 semaines | La version actuelle fonctionne bien sur Node. Ne casse que sur les autres runtimes. |
| **Creer une sortie de build specifique Deno avec import maps** | 2-3 semaines | Specifique a Deno. |
| **Matrice CI pour les tests multi-runtime** | 1-2 semaines | Necessaire uniquement si on supporte officiellement plusieurs runtimes. |

### C. Pas la peine

| Travail | Pourquoi pas |
|---|---|
| **Porter isobuild sur Bun/Deno** | Effort enorme (systeme de plugins base sur vm). Le build reste sur Node ; seul le runtime doit etre portable. |
| **Remplacer npm par bun install dans la toolchain** | bun install a des semantiques differentes. Cree de la divergence sans valeur claire. |
| **Conversion complete CJS->ESM du repertoire tools/** | Des milliers de fichiers. L'outillage de build n'a pas besoin d'etre portable. |
| **Supporter le boot base vm ET le boot ESM en parallele** | Les doubles chemins de code sont pires que d'en choisir un. Livrer le boot ESM, deprecier l'ancien. |
| **Construire une couche d'abstraction runtime universelle** | Sur-ingenierie. N'abstraire que ce qui est necessaire, pas tout ce qui pourrait etre abstrait. |
| **Porter le dev bundle / meteor run sur Bun/Deno** | L'experience dev peut rester sur Node. La portabilite runtime compte pour le deploiement production. |

---

## 9. Cadre de decision

Pour chaque sous-systeme Meteor, appliquer ce filtre :

```
Est-il visible par l'utilisateur comme feature produit ou API ?
|-- OUI -> Depend-il d'internes specifiques a Node ?
|   |-- OUI -> ABSTRAIRE : Garder l'API, remplacer l'implementation
|   |-- NON -> PRESERVER : Porter fidelement
|-- NON -> Est-ce un detail d'implementation du runtime serveur ?
    |-- OUI -> Est-ce encore la meilleure approche pour ce travail ?
    |   |-- OUI -> PRESERVER (mais documenter la dependance)
    |   |-- NON -> REECRIRE : Remplacer par une approche moderne
    |-- NON -> Est-ce activement maintenu et utilise ?
        |-- OUI -> Evaluer au cas par cas
        |-- NON -> SUPPRIMER
```

**Reference rapide :**

| Signal | Decision |
|---|---|
| Les utilisateurs ecrivent du code contre (API) | Preserver |
| Les utilisateurs ne savent pas que ca existe (interne) | A reecrire sans complexe |
| C'est un polyfill pour quelque chose que le runtime fournit maintenant | Supprimer |
| C'est un contournement pour une limitation qui n'existe plus | Supprimer |
| Ca fonctionne mais utilise des API non portables | Abstraire |
| C'est complexe et pourrait etre plus simple avec du JS moderne | Reecrire |
| C'est utilise uniquement en dev, pas en production | Envisager de retirer du chemin production |
| Ca a cause des bugs, de la confusion ou de la douleur de maintenance a repetition | Signal fort pour une reecriture |

---

## 10. Recommandation finale

### Porter fidelement ou moderniser en migrant ?

**Moderniser en migrant. Sans aucune hesitation.**

Un portage fidele des internes runtime actuels de Meteor vers Bun ou Deno produirait un systeme fragile et opaque qui herite de tous les contournements historiques et ajoute de nouveaux shims de compatibilite par-dessus. Ce serait plus difficile a maintenir que le systeme actuel uniquement Node, pas plus facile.

La question Bun/Deno est une force motrice pour une conversation que Meteor devrait avoir de toute facon : **quels mecanismes internes valent leur complexite, et lesquels ont survecu a leur objectif initial ?**

### Quelles parties meritent une protection comme identite coeur ?

Ce sont l'ame de Meteor. Les toucher et c'est un autre framework que l'on construit :

1. **Protocole DDP** — data on the wire, pub/sub, methodes
2. **Donnees reactives** — minimongo + Tracker cote client, oplog/polling cote serveur
3. **Code isomorphique** — memes packages sur client et serveur
4. **UI optimiste** — method stubs et rollback
5. **Systeme de comptes** — auth unifiee avec strategies pluggables
6. **Dev zero-config** — `meteor create && meteor run` fonctionne immediatement
7. **Hot code push** — en dev et production

### Quelles parties devraient etre considerees comme ouvertes a la reconception ?

Tout le reste est de l'implementation :

1. **Modele de chargement des packages** — vm.runInThisContext peut devenir des imports ESM standard
2. **Integration du systeme de modules** — reify/patching Module peut devenir ESM natif
3. **Sequence de boot** — boot.js peut devenir un point d'entree module propre
4. **Hebergement HTTP** — Express + http.createServer peut devenir pluggable
5. **Les addons natifs** — node-gyp peut devenir WASM ou prebuilds
6. **Integration source maps** — source-map-support peut devenir natif au runtime
7. **Format de bundle** — peut devenir une structure d'application Node/Bun/Deno standard
8. **Runtime de l'outillage dev** — peut rester sur Node meme si le runtime production est portable

### Quelle est la plus grosse erreur a eviter ?

**Construire de la glue de compatibilite au lieu de supprimer le besoin d'en avoir.**

La tentation sera d'ecrire des shims : un shim vm pour Bun, un shim Module._extensions pour Deno, un adaptateur source-map-support pour JSC. Chaque shim ajoute de la complexite, cache des bugs et cree une nouvelle surface de maintenance.

L'approche correcte est l'inverse : supprimer le code qui a besoin de shimming. Remplacer vm.runInThisContext par du chargement de modules standard. Remplacer le patching Module par ESM natif. Remplacer source-map-support par les source maps natives du runtime. Chaque suppression rend Meteor plus simple, plus debuggable et automatiquement portable — pas seulement vers Bun et Deno, mais vers tout ce qui viendra apres.

La plus grosse erreur serait de passer 6 mois a faire fonctionner les internes de 2012 de Meteor sur des runtimes de 2026, quand on pourrait passer 3 mois a rendre les internes de Meteor dignes de 2026.
