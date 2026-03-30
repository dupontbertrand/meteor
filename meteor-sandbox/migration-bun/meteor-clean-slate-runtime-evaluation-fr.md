# Evaluation clean-slate du runtime serveur — Cinquieme passe

**Date :** 2026-03-29
**Auteur :** dupontbertrand (avec analyse Claude)
**Statut :** Evaluation architecturale — legacy rescue vs nouveau chemin
**Question centrale :** Faut-il continuer a moderniser le runtime serveur existant, ou en construire un nouveau en parallele ?

---

## 1. La vraie decision

La decision n'est PAS "faut-il reecrire Meteor ?"

La decision est : **le modele de chargement/boot/runtime du serveur Meteor actuel est-il encore le bon fondement pour les 5 prochaines annees, ou est-il devenu un poids que l'equipe paie de plus en plus cher pour maintenir ?**

Pour etre precis, voici ce qui est en question :

- 9 fichiers dans `tools/static-assets/server/` (boot.js, runtime.js, npm-require.js, server-json.js, mini-files.ts, boot-utils.js, debug.ts, npm-rebuild.js, npm-rebuild-args.js)
- Le format de sortie du bundler pour le serveur (la facon dont `bundler.js` genere main.js + program.json + fichiers de packages enveloppes)
- Le modele de chargement (boucle JSON -> lecture fichier -> enveloppement string -> vm.runInThisContext -> appel de fonction)
- Le modele de modules (Module.prototype patching + reify transforms a chaque require)

C'est tout. Ce n'est ni DDP, ni le systeme de comptes, ni minimongo, ni Tracker, ni le CLI, ni isobuild.

La question est : ces ~1500 lignes de code runtime + le contrat de sortie du bundler sont-ils le bon terrain pour construire l'avenir, ou faut-il en poser un nouveau a cote ?

---

## 2. Ce qui doit absolument rester Meteor

| Domaine | Doit etre preserve comme identite coeur | Pourquoi |
|---|---|---|
| **DDP** | Oui | C'est le protocole qui definit Meteor. Data on the wire, pas HTML on the wire. Aucun autre framework mainstream ne fait ca. |
| **Pub/sub** | Oui | Le modele "le serveur publie, le client s'abonne de maniere reactive" est le coeur de la DX Meteor. |
| **Methods** | Oui | RPC avec semantique de retour, gestion d'erreur et contexte. C'est l'API serveur de Meteor. |
| **UI optimiste / method stubs** | Oui | Innovation coeur. Le client simule, le serveur confirme ou rollback. Aucune alternative aussi integree. |
| **Minimongo + Tracker** | Oui | Le data store reactif client. C'est ce qui rend le client Meteor fondamentalement different. |
| **Systeme de comptes** | Oui | API unifiee, strategies pluggables (password, OAuth), tokens, sessions. Extremement pratique. |
| **Hot code push** | Oui | Mise a jour sans rechargement complet. DX fondamentale en dev, differenciateur en production. |
| **Experience dev zero-config** | Oui (l'experience, pas l'implementation) | `meteor create && meteor run` fonctionne immediatement. C'est une promesse produit. La *facon* dont c'est implemente (dev bundle vendored, etc.) n'est PAS sacree. |
| **Isomorphisme** | Partiellement | L'idee que le meme package peut avoir du code client et serveur est utile. Mais le mecanisme specifique (api.addFiles avec architectures) est un detail d'implementation. |
| **AsyncLocalStorage pour le contexte DDP** | Oui | C'est le successeur des Fibers. C'est standard, supporte partout, et c'est le bon choix. |

**Point cle :** Tout ce qui est dans ce tableau est du code applicatif Meteor (packages/). Rien de ce qui est dans ce tableau ne depend du modele de boot/runtime/chargement. Le runtime serveur est un *mecanisme de livraison* pour ces fonctionnalites, pas les fonctionnalites elles-memes.

---

## 3. Ce qui n'est probablement PAS sacre

| Element legacy serveur/runtime | Pourquoi il n'est probablement pas sacre | Cout de le preserver | Cout de le remplacer | Recommandation |
|---|---|---|---|---|
| **boot.js : boucle JSON -> vm.runInThisContext** | C'est un mecanisme de chargement, pas une feature. Aucun utilisateur ne sait que ses packages sont enveloppes dans des strings et eval'd via vm. | Moyen : bloque la portabilite, fragile, opaque a debugger, depend d'APIs vm sous-documentees | Faible a moyen : remplacer par des imports ESM standard ou Function() est techniquement simple ; l'effort est dans le bundler | **Remplacer** |
| **runtime.js : Module.prototype patching** | Depend d'APIs internes non documentees de Node (`_compile`, `_extensions`, `_resolveFilename`). C'est le code le plus fragile du runtime. | Eleve : chaque version de Node pourrait casser ces APIs ; les autres runtimes ne les implementent pas ; c'est la couche la plus "magique" | Moyen a eleve : le retrait necessite que le bundler genere de l'ESM natif, ce qui est un changement de modele | **Remplacer dans le cadre du passage a ESM** |
| **Reify dans le runtime serveur** | Polyfill pour ESM qui n'est plus necessaire depuis que Node 22 supporte ESM nativement. Chaque .js serveur passe par un pipeline de transformation. | Moyen : surcharge de parsing a chaque chargement, complexite du pipeline acorn+babel, dependance a @meteorjs/reify | Eleve : reify est profondement integre ; le retrait necessite un nouveau modele de chargement | **Deprecier progressivement via ESM natif** |
| **Npm.require internals** | Resolution custom qui cherche dans plusieurs node_modules. Duplique ce que require/import fait nativement. | Faible : fonctionne mais ajoute un layer d'indirection | Faible : peut etre simplifie en interne sans changer l'API | **Simplifier en interne, garder l'API** |
| **Format d'entree du bundle serveur** | main.js (6 lignes CJS) -> runtime.js -> boot.js -> vm-eval loop. Format specifique Meteor que seul Meteor comprend. | Moyen : tout l'outillage de deploiement doit connaitre ce format ; c'est un obstacle pour les hebergeurs standard | Moyen a eleve : changer le format impacte Galaxy, Docker, scripts de deploy | **Creer un nouveau format opt-in** |
| **source-map-support** | Monkey-patch V8 specifique (`Error.prepareStackTrace`). Ne fonctionne pas sur Bun (JSC). Node a `--enable-source-maps` depuis v12. | Faible : une dependance de plus, un monkey-patch de plus | Faible : remplacement quasi direct par le flag natif | **Remplacer** |
| **Shell-server** | REPL via socket Unix. Couple a `net` + `repl`. Quasiment personne ne l'utilise en production. | Negligeable : ca marche | Negligeable : l'extraire en package optionnel | **Optionaliser** |
| **Hypotheses dev-bundle dans la pensee production** | Le dev bundle est un outil de dev, mais certaines hypotheses (chemins, resolution npm) fuient dans le runtime de production. | Faible mais chronique : cree de la confusion entre dev et prod | Moyen : nettoyer les hypotheses de chemin dans le bundle de production | **Decoupler dev et prod** |
| **Globales implicites** | `Package`, `__meteor_bootstrap__`, `__meteor_runtime_config__`. Communication inter-packages via objets globaux mutables. | Faible a court terme, eleve a long terme : empeche l'isolation, le tree-shaking, et les outils standard | Moyen a eleve : passer a des imports explicites necessite un changement du modele de packages | **Remplacer dans le cadre du nouveau modele** |

---

## 4. Comparaison des trois options

| | Option A : Moderniser le legacy | Option B : Nouveau chemin parallele | Option C : Reecriture complete |
|---|---|---|---|
| **Description courte** | Continuer a patcher boot.js, runtime.js, ajouter des guards, remplacer vm par Function(), garder le modele de chargement | Construire un nouveau chemin de boot/runtime ESM a cote du legacy, opt-in experimental, comparer, puis decider | Reecrire Meteor de zero |
| **Benefices** | Faible risque, progression continue, aucune rupture | Architecture propre, pas de dette heritee, portabilite native, peut coexister avec le legacy | Table rase, architecture ideale |
| **Couts** | Chaque patch ajoute de la complexite au legacy ; le modele fondamental (vm-eval + Module patching) reste ; les gains sont asymptotiques | Effort initial de prototypage ; dual path temporaire ; risque de ne jamais finir | Enorme : des annees-personnes ; perte de l'ecosysteme ; reapprendre toutes les subtilites |
| **Risques** | Mort par mille patches — le runtime devient un millefeuille de guards et fallbacks sans cohesion | Le prototype stagne ; personne n'opt-in ; effort gaspille | Aucune equipe n'a les ressources ; l'ecosysteme meurt pendant la reecriture ; le resultat est pire que l'original |
| **Horizon** | Continu, pas de fin | 6-12 mois pour le prototype, 12-24 mois pour la transition | 2-4 ans minimum |
| **Avantage strategique** | Stabilite, continuite, confiance de l'ecosysteme | Possibilite de sauter une generation technique ; support Bun/Deno "gratuit" ; architecture qui vieillit bien | Architecture ideale (en theorie) |
| **Desavantage strategique** | Le modele fondamental reste fragile ; les gains diminuent avec le temps ; la dette reste | Complexite temporaire du dual path ; risque d'abandon | Suicide de projet. L'histoire du logiciel est pavee de reecritures qui ont tue le produit. |

---

## 5. Le runtime legacy vaut-il encore la peine d'etre sauve ?

### Evaluation subsysteme par subsysteme

**boot.js** — *Salvageable mais de moins en moins rentable.*
boot.js fait trois choses : (1) lire la configuration, (2) installer les source maps, (3) boucler sur les fichiers serveur et les executer via vm. Les parties (1) et (2) sont triviales. La partie (3) — la boucle vm-eval — est le probleme. Elle est fonctionnelle mais elle n'est pas un bon fondement : elle est opaque, non standard, et elle force chaque amelioration future a passer par le goulot d'etranglement de `vm.runInThisContext`. La patcher (Function fallback) est facile et utile. Mais chaque patch supplementaire est un sparadrap sur un modele qui n'est pas le bon.

**runtime.js** — *Le sous-systeme le plus fragile.*
runtime.js n'a qu'une raison d'exister : rendre reify fonctionnel en patchant les internes de Module. Si reify n'etait plus necessaire (parce que le bundler genere de l'ESM natif), runtime.js serait supprime entierement. Il n'y a rien dans runtime.js qui merite d'etre preserve independamment de reify. C'est un echafaudage pour un polyfill.

**vm.runInThisContext** — *Pas un fondement, c'est un hack historique.*
Le vm n'est utilise ni pour le sandboxing ni pour l'isolation. Il est utilise uniquement pour deux choses : (1) executer du code avec un nom de fichier associe (pour les stack traces), et (2) injecter des symboles (`Npm`, `Assets`). La raison (1) est resolue par `//# sourceURL=`. La raison (2) est resolue par des imports de modules. Le vm ne fournit rien que des mecanismes standard ne fournissent pas deja.

**Module.prototype patching** — *Non viable a long terme.*
`Module._compile`, `Module._extensions`, `Module._resolveFilename` ne sont pas des APIs publiques. Elles ne font pas partie du contrat de stabilite de Node. Chaque version majeure de Node pourrait les modifier ou les supprimer. Et elles sont explicitement non supportees sur Bun et partiellement sur Deno. Construire sur ces APIs, c'est construire sur du sable.

**Reify** — *Un polyfill qui a survecu a son utilite.*
Reify etait genial quand Node n'avait pas d'ESM. Maintenant, c'est un pipeline de transformation (acorn parse + babel fallback) qui tourne a chaque `require()` serveur, qui depend de Module.prototype patching et qui est la raison d'exister de runtime.js. Sa suppression est la cle de voute de la modernisation. Mais elle necessite que le bundler genere de l'ESM natif.

**Le contrat de bundle** — *Fonctionnel mais specifique.*
Le format star.json + program.json + fichiers de packages enveloppes est un format proprietaire. Il fonctionne, mais il signifie que deployer Meteor necessite de savoir que c'est du Meteor. Un format de bundle qui ressemble a une app JS standard serait plus portable et plus comprehensible.

**Le modele de chargement serveur** — *Le vrai sujet.*
Le modele actuel est : "le bundler genere des fichiers de packages CJS enveloppes dans des closures → boot.js les lit depuis le disque → les enveloppe dans des strings de fonction → les eval via vm → les appelle avec des arguments injectes." Chaque etape de cette chaine est un choix de 2012 qui avait du sens a l'epoque et qui n'en a plus aujourd'hui. Le modele alternatif est : "le bundler genere des modules ESM standard → le runtime les importe → chaque module gere ses propres dependances via import." C'est plus simple, plus standard, plus portable et plus debuggable.

### Verdict

Le runtime legacy est **salvageable mais pas le bon fondement.** Les patches de Layer A (Function fallback, source maps, cluster, guards) sont utiles et immediats. Mais ils ne changent pas le fait que le modele sous-jacent (vm-eval + Module patching + reify) est un assemblage de hacks historiques.

La question n'est pas "est-ce que ca marche ?" — ca marche. La question est "est-ce que c'est la bonne base pour investir du temps de developpeur pendant les 5 prochaines annees ?" Et la reponse est : **probablement pas.**

Le cout de preservation n'est pas celui des patches individuels. C'est le cout d'opportunite : chaque heure passee a rendre le modele vm-eval un peu plus resilient est une heure qui n'est pas passee a construire le modele qui rendrait tout ca inutile.

---

## 6. Plus petit runtime clean-slate viable

Voici le design minimal d'un nouveau runtime serveur qui resterait a 100% du Meteor, mais sans heritage.

### Point d'entree runtime

```javascript
// programs/server/index.mjs
// Genere par le bundler. Pas ecrit a la main.

// Configuration Meteor
import { config } from './meteor-config.mjs';
globalThis.__meteor_runtime_config__ = config;

// Contexte async
import { AsyncLocalStorage } from 'node:async_hooks';
globalThis.__METEOR_ASYNC_LOCAL_STORAGE = new AsyncLocalStorage();

// Packages Meteor dans l'ordre de dependance
// Chaque package est un vrai module ESM avec ses propres imports
import './packages/meteor.mjs';
import './packages/ddp-server.mjs';
import './packages/mongo.mjs';
import './packages/accounts-base.mjs';
import './packages/webapp.mjs';
// ... autres packages dans l'ordre de dependance

// Code applicatif
import './app/server/main.mjs';

// Demarrage
const { startupHooks } = await import('./packages/meteor.mjs');
for (const hook of startupHooks) {
  await hook();
}
```

### Modele de chargement de modules

**Pas de vm.** Pas de Module.prototype patching. Pas de reify. Les packages sont des modules ESM standard que n'importe quel runtime JS peut importer.

Le bundler genere chaque package comme un fichier `.mjs` autonome :

```javascript
// programs/server/packages/webapp.mjs
// Genere par le bundler a partir de packages/webapp/

import { createServer } from 'node:http';
import express from 'express';
import { Meteor } from './meteor.mjs';
// ... reste du code webapp

// Exporte pour les autres packages
export const WebApp = { /* ... */ };
export const WebAppInternals = { /* ... */ };

// Enregistre dans le registre global de packages
// (compatibilite legacy — supprimable plus tard)
globalThis.Package = globalThis.Package || {};
globalThis.Package.webapp = { WebApp, WebAppInternals };
```

### Modele de chargement des packages

L'ordre de chargement est encode comme des imports de modules, pas comme un manifeste JSON. Le bundler resout l'ordre de dependance a la compilation et genere les imports dans le bon ordre dans `index.mjs`.

**Npm.require** : dans le mode ESM, `Npm.require(name)` est reimplemente comme :

```javascript
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export function npmRequire(name) {
  return require(name);
}
```

**Assets** : les assets sont accessibles via un module Meteor standard :

```javascript
import { getAsset } from './meteor-assets.mjs';
const text = await getAsset('private/data.json', 'utf8');
```

### Comment DDP/pub-sub/methods s'integrent

Exactement comme aujourd'hui. DDP, les publications et les methodes sont du code applicatif dans les packages `ddp-server`, `livedata`, etc. Ils n'ont aucune dependance sur le modele de chargement. Ils importent `WebApp` pour obtenir le serveur HTTP, et `mongo` pour acceder a la base. Rien ne change dans leur logique interne.

### Comment les features serveur specifiques Meteor sont initialisees

Le pattern `__meteor_bootstrap__.startupHooks` est remplace par un mecanisme d'export/import :

```javascript
// packages/meteor.mjs
export const startupHooks = [];
export function startup(fn) {
  if (startupHooks === null) {
    // After boot: call immediately
    fn();
  } else {
    startupHooks.push(fn);
  }
}
```

### Interop npm/packages

Les dependances npm sont dans un `node_modules` standard dans le repertoire de sortie. `import` et `require` (via `createRequire`) fonctionnent normalement. Pas de resolution custom. Pas de npm-require.js.

### Source maps / debugging

Chaque fichier `.mjs` genere inclut un commentaire `//# sourceMappingURL=`. Le runtime utilise `--enable-source-maps` (Node) ou le support natif (Bun/Deno). Pas de dependance a `source-map-support`. Pas de monkey-patch.

### Sortie de build

```
bundle/
├── index.mjs                    # Point d'entree (genere)
├── meteor-config.mjs            # Configuration (genere depuis config.json)
├── meteor-assets.mjs            # API Assets (genere)
├── packages/
│   ├── meteor.mjs
│   ├── ddp-server.mjs
│   ├── mongo.mjs
│   ├── webapp.mjs
│   └── ... (un .mjs par package)
├── app/
│   └── server/
│       └── main.mjs             # Code applicatif
├── node_modules/                # Dependances npm standard
├── package.json                 # {"type": "module"}
└── star.json                    # Metadonnees (compatibilite legacy)
```

Demarrage : `node index.mjs` ou `bun index.mjs` ou `deno run --allow-all index.mjs`.

### Ce qui reste compatible avec le legacy

- `globalThis.Package` est toujours rempli (pour la compat avec le code qui fait `Package.meteor.Meteor`)
- `Npm.require` fonctionne toujours (reimplemente sur `createRequire`)
- `Assets.getTextAsync` / `Assets.getBinaryAsync` fonctionnent toujours (reimplementes comme module)
- `Meteor.startup` fonctionne toujours
- Le code applicatif (methods, publications, startup) ne change pas

### Ce qui ne reste PAS compatible

- Le format program.json / server-json.js n'existe plus
- boot.js / runtime.js / npm-require.js n'existent plus
- Le code ne passe plus par vm.runInThisContext
- Le code ne passe plus par reify
- Module.prototype n'est pas patche
- `source-map-support` n'est pas charge

---

## 7. Ce que ce nouveau chemin refuse deliberement de reconduire

1. **Execution de packages via vm.runInThisContext.** Les packages sont des modules, pas des strings eval'd. Point.

2. **Module.prototype monkey-patching.** Le systeme de modules du runtime est utilise tel quel. Aucune API interne non documentee n'est patchee.

3. **Reify comme couche runtime requise.** La transformation ESM→CJS est faite a la compilation (dans le bundler), pas au runtime. Les fichiers de sortie sont de l'ESM natif.

4. **Globales implicites comme mecanisme de communication principal.** `globalThis.Package` est garde comme pont de compatibilite, mais les imports entre packages sont des imports ESM explicites. A terme, le registre global peut etre supprime.

5. **Boucle de chargement pilotee par JSON.** L'ordre de chargement est encode structurellement dans les imports du fichier `index.mjs`, pas dans un manifeste JSON lu a l'execution.

6. **source-map-support et Error.prepareStackTrace.** Les source maps utilisent le mecanisme natif du runtime.

7. **npm-require.js avec sa resolution custom.** Les imports npm utilisent la resolution standard de modules.

8. **Hypotheses de processus dans le boot.** Pas de polling de PID parent. Pas de barriere de version semver. Pas de boucle d'attente de debugger. Ces preoccupations sont gerees a l'exterieur du runtime (dans le script d'invocation ou dans le serveur de dev).

---

## 8. Realisme de la migration

### Coexistence avec le chemin legacy

**Oui, c'est possible et c'est meme la seule approche viable.** Le nouveau chemin est genere par un flag du bundler (`meteor build --format=esm`). L'ancien format reste le defaut. Les deux peuvent coexister indefiniment.

### Frontiere d'opt-in

L'opt-in est au niveau du `meteor build`, pas au niveau de l'app. Un developpeur qui fait `meteor build --format=esm` obtient le nouveau format. Un developpeur qui fait `meteor build` (sans flag) obtient l'ancien format. Rien ne change dans le code applicatif.

### Periode de double format

**Acceptable pendant 2-3 versions majeures.** Precedent : Meteor a deja eu des transitions similaires (Fibers → async/await, qui a coexiste pendant la beta de Meteor 3). Le pattern est : ancien format comme defaut → nouveau format comme option → nouveau format comme defaut → ancien format comme `--format=legacy` → ancien format retire.

### Fardeau de migration pour les utilisateurs

**Quasi nul pour le code applicatif.** Les methodes, publications, startup hooks, imports de packages — tout ca fonctionne identiquement. Le seul changement est la commande de build et le format de sortie.

**Faible pour le deploiement.** Le script de demarrage passe de `node main.js` a `node index.mjs` (ou `bun index.mjs`). Les variables d'environnement (`MONGO_URL`, `ROOT_URL`, `PORT`) restent les memes.

**Modere pour les auteurs de packages Atmosphere.** Les packages qui utilisent uniquement `import`/`export` et `Npm.require` fonctionnent sans changement. Les packages qui dependent de `require` implicite, de `global.Package` direct ou de patterns CJS non standard pourraient necessiter des ajustements.

### Duree realiste de coexistence

2-3 ans. Assez long pour que l'ecosysteme migre. Assez court pour eviter le cout de maintenance du double chemin.

---

## 9. Comparaison des couts : sauvetage legacy vs chemin propre

| Domaine | Si on continue a moderniser le legacy | Si on construit un nouveau chemin parallele | Moins cher a long terme ? | Moins cher a court terme ? |
|---|---|---|---|---|
| **Boot/chargement runtime** | Patches incrementaux : Function fallback, guards, chaque amelioration est un cas special ajoute au code existant. Cout cumule croissant. | Un seul design propre : index.mjs genere avec des imports. Pas de guards, pas de fallbacks, pas de vm. Cout initial modere puis quasi nul. | **Nouveau chemin** | Legacy (les patches sont rapides) |
| **Systeme de modules** | Garder reify + Module patching + guards defensifs. Chaque version de Node est un risque de regression. Tester la compat Module._extensions a chaque upgrade. | ESM natif. Zero patching. Fonctionne sur Node, Bun, Deno sans effort. | **Nouveau chemin** (nettement) | Legacy |
| **Source maps / debugging** | Migrer de source-map-support vers --enable-source-maps (facile dans les deux cas). | Memes source maps, pas de source-map-support. | Equivalent | Equivalent |
| **Addons natifs** | Meme probleme dans les deux cas : node-gyp/WASM est une question orthogonale au modele de chargement. | Idem. | Equivalent | Equivalent |
| **Portabilite runtime** | Chaque runtime alternatif necessite un audit des guards et des fallbacks. Bun : est-ce que vm fonctionne ? Est-ce que Module._extensions est un no-op ? Deno : est-ce que CJS est detecte ? Des dizaines de questions par runtime. | Un bundle ESM standard fonctionne sur tout runtime qui supporte ESM (= tous). Zero questions par runtime. | **Nouveau chemin** (massivement) | Legacy |
| **Format de bundle** | Le format actuel reste. Tout l'outillage de deploiement doit le connaitre. | Un format standard : package.json + index.mjs + node_modules. Tout l'outillage standard le comprend deja. | **Nouveau chemin** | Legacy (aucun changement) |
| **Complexite mentale pour les contributeurs** | Le runtime est un millefeuille : boot.js + runtime.js + npm-require.js + server-json.js + vm semantics + Module internals + reify pipeline. Comprendre comment le serveur demarre necessite de comprendre 6 layers interdependants. | Le runtime est un fichier `index.mjs` genere avec des imports. Comprendre le demarrage necessite de lire un fichier. | **Nouveau chemin** (massivement) | Legacy (familiarite) |
| **Maintenance sur 2-3 ans** | Chaque version de Node/npm est un risque pour Module._extensions et reify. Chaque version de Bun/Deno est un audit de compat. Les tests de regression s'accumulent. | Les modules ESM sont un standard ECMA. La probabilite de regression entre versions de runtime est quasi nulle. | **Nouveau chemin** | Legacy |

**Synthese :** Le legacy est moins cher a court terme pour chaque patch individuel. Mais le nouveau chemin est moins cher a long terme pour presque tous les domaines. Le point de bascule est probablement autour de 6-12 mois : au-dela, les couts cumules du legacy depassent l'investissement initial du nouveau chemin.

---

## 10. Meilleur cas / pire cas pour l'Option B

### Meilleur cas

Le prototype `meteor build --format=esm` fonctionne en 4-6 semaines. Il produit un bundle qui demarre sous Node, Bun et Deno sans modification. Les early adopters l'essaient et rapportent que c'est plus simple a deployer, plus rapide au demarrage, et plus facile a debugger. L'ecosysteme Atmosphere migre progressivement ses packages actifs (la plupart fonctionnent sans changement parce qu'ils utilisent deja `import`/`export`). Apres 2-3 versions, le format ESM devient le defaut. Le legacy est garde comme `--format=legacy` pour la compatibilite. L'equipe economise des dizaines d'heures de maintenance vm/reify/Module chaque annee.

### Pire cas

Le prototype revele des incompatibilites profondes : certains packages Atmosphere utilisent des patterns CJS implicites (require sans import, dependance a l'ordre de chargement via effets de bord, acces a `global.Package` avant que le package ne soit charge). Le travail de compatibilite s'allonge. Le nouveau format est plus complexe que prevu a generer dans le bundler. Le dual path devient un fardeau de maintenance. Le prototype stagne et finit abandonne, laissant du code mort dans le bundler.

### Signaux d'alerte

1. **Le prototype ne fait pas booter une app triviale en moins de 2 semaines.** Si la generation ESM par le bundler est plus complexe que prevu, c'est un signal que le probleme est dans isobuild, pas dans le runtime.

2. **Plus de 10% des packages Atmosphere actifs cassent.** Si la majorite de l'ecosysteme depend de patterns CJS implicites, le cout de migration est trop eleve.

3. **Le dual path genere des bugs de production.** Si des utilisateurs rencontrent des bugs subtils parce qu'ils ne savent pas quel format ils utilisent, la coexistence devient toxique.

4. **L'equipe ne peut pas maintenir les deux chemins.** Si le cout de maintenance du dual path depasse les economies du nouveau chemin, c'est un echec.

5. **Le nouveau chemin ne fonctionne PAS mieux que le legacy patche.** Si apres prototypage, le nouveau chemin n'est pas significativement plus simple, plus rapide ou plus portable, c'est qu'il ne resout pas le bon probleme.

---

## 11. Recommandation

### "From scratch" est-il un mauvais instinct ici, ou un signal significatif ?

**C'est un signal significatif.** L'instinct "from scratch" vient du fait que le modele actuel (vm-eval + Module patching + reify) n'est pas un modele — c'est un assemblage de contournements accumules sur 14 ans. Chaque couche a ete ajoutee pour resoudre un probleme specifique de son epoque (pas de modules ES → reify ; pas d'isolation de scope → vm ; pas de require interceptable → Module patching). Ces problemes sont resolus depuis des annees par le langage et les runtimes eux-memes. L'instinct "from scratch" dit : "arretons de patcher les contournements et utilisons les solutions."

Cet instinct est correct, mais il doit etre contenu : "from scratch" pour le runtime serveur (9 fichiers, ~1500 lignes, + le format de sortie du bundler). Pas "from scratch" pour Meteor.

### Quelle est la bonne strategie ?

**Commencer le chemin parallele (Option B) apres avoir termine les patches de Layer A.**

L'ordre est :
1. **Maintenant :** finir les 5 changements de Layer A (Function fallback, source maps, cluster, version check, guards runtime.js). Ca prend 2-4 semaines et ca ameliore le legacy immediatement.
2. **Ensuite :** prototyper `meteor build --format=esm`. Ca prend 4-8 semaines de travail concentre. Le prototype n'a pas besoin d'etre parfait — il doit repondre a la question "est-ce que ca marche pour une app realiste ?"
3. **Decision :** si le prototype marche, on le stabilise et on le propose en opt-in. Sinon, on continue avec le legacy patche (qui sera deja plus solide grace a la Layer A).

### Quel serait le premier prototype le plus raisonnable ?

Un script dans `tools/isobuild/` qui, pour un bundle deja construit en format legacy, regenere les fichiers serveur en format ESM :
- Lit program.json
- Pour chaque fichier de package, genere un `.mjs` equivalent (retire l'enveloppement de closure, convertit les `Npm.require` en `createRequire`, ajoute les exports)
- Genere `index.mjs` avec les imports dans le bon ordre
- Genere `package.json` avec `"type": "module"`

Ce script est un outil de conversion, pas un changement du bundler. Il permet de tester le format ESM sans toucher a isobuild.

### Qu'est-ce qui ne devrait definitivement PAS etre reecrit ?

- **DDP / livedata** — fonctionne bien, pas de dette significative
- **Minimongo** — code client, pas concerne
- **Tracker** — code client, pas concerne
- **Accounts** — API propre, code bien structure
- **Isobuild** — complexe mais fonctionnel ; le modifier pour generer de l'ESM est different de le reecrire
- **Le CLI / tools/** — reste sur Node, pas concerne par le runtime serveur

### Qu'est-ce qui devrait arreter d'etre traite comme intouchable ?

- **boot.js** — c'est un script de demarrage, pas une feature. Il peut etre remplace.
- **runtime.js** — c'est un echafaudage pour reify. Si reify n'est plus necessaire, runtime.js n'a plus de raison d'exister.
- **Le format de sortie serveur du bundler** — c'est un artefact de compilation. Il peut changer sans que le code source des apps ne change.
- **L'hypothese que le serveur Meteor a besoin d'un modele de chargement custom** — c'etait vrai en 2012. Ca ne l'est plus.

---

## 12. Resume final en termes simples

Nous ne parlons pas de reecrire Meteor.

Nous parlons de **remplacer le mecanisme de demarrage et de chargement du serveur** — 9 fichiers, environ 1500 lignes de code, et la facon dont le bundler genere la sortie serveur — par quelque chose de plus simple et de plus standard.

Le code applicatif de Meteor (DDP, methodes, publications, comptes, reactivite, minimongo, hot code push) ne change pas. Le code des packages Meteor ne change pas. L'experience developpeur ne change pas.

Ce qui change, c'est que le serveur Meteor demarre comme n'importe quelle autre application JavaScript moderne : un fichier d'entree qui importe des modules. Pas de vm. Pas de monkey-patching. Pas de pipeline de transformation a chaque require. Pas de format proprietaire que seul Meteor comprend.

C'est le genre de changement qui est invisible pour 95% des utilisateurs, mais qui determine si Meteor est facile ou difficile a maintenir, a debugger et a faire evoluer pendant les 5 prochaines annees.
