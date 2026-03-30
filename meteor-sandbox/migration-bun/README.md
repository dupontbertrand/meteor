# Meteor Runtime Modernization — Dossier complet

Ensemble de la recherche et des analyses sur la modernisation du runtime serveur Meteor, le support Bun, et la vision architecturale long terme.

## Reflexion globale

Le vrai chantier n'est pas "Meteor sur Bun". C'est **"Meteor avec un format de bundle serveur standard, capable de tourner sur plusieurs runtimes modernes."**

Bun n'est pas l'objectif — c'est un **revelateur** de la dette technique du runtime actuel (vm.runInThisContext, Reify, Module.prototype patching, boot.js). Le levier central est le **bundler ESM** : si `meteor build` emet des vrais modules ESM, le runtime se reduit a `node index.mjs` ou `bun index.mjs`.

### Les 3 niveaux du dossier

1. **Proto concret** — Peut-on faire emettre un bundle ESM par le bundler ?
2. **Abstractions structurantes** — Transport, serializer, store, observe, HTTP : des interfaces pluggables
3. **Vision Meteor 2026** — Que challenger si on redesignait Meteor aujourd'hui ?

## Documents

### Documents de synthese (mars 2026)

| Document | Scope | Status |
|---|---|---|
| [meteor-esm-bundle-prototype.md](meteor-esm-bundle-prototype.md) | Proto concret : `meteor build --format=esm` | Spec prete, spike a faire |
| [meteor-runtime-capability-model.md](meteor-runtime-capability-model.md) | Architecture : capability map, 5 interfaces pluggables | Document de reference |
| [meteor-2026-vision.md](meteor-2026-vision.md) | Vision large : Minimongo, TinyBase, PWA, Capacitor, audit packages | Vision document |

### Analyses precedentes (mars 2026)

| Document | Contenu |
|---|---|
| [meteor-bun-deno-migration-assessment.md](meteor-bun-deno-migration-assessment.md) | Etude de faisabilite Node→Bun/Deno, audit subsysteme par subsysteme, 10 blockers |
| [meteor-bun-deno-built-bundle-spike-plan.md](meteor-bun-deno-built-bundle-spike-plan.md) | Plan de spike detaille : chaine d'execution main.js → runtime.js → boot.js |
| [meteor-runtime-modernization-analysis.md](meteor-runtime-modernization-analysis.md) | Analyse strategique : preserve vs redesign matrix, 4 candidates architecturaux |
| [meteor-runtime-modernization-analysis-fr.md](meteor-runtime-modernization-analysis-fr.md) | Version francaise de l'analyse ci-dessus |
| [meteor-clean-slate-runtime-evaluation-fr.md](meteor-clean-slate-runtime-evaluation-fr.md) | Evaluation clean-slate : moderniser le legacy vs nouveau chemin parallele |
| [meteor-modernization-clarified-plan-fr.md](meteor-modernization-clarified-plan-fr.md) | Plan clarifie en 3 couches (A/B/C) avec corrections des passes precedentes |

## PRs liees

- **#14231** — Transport DDP pluggable (MERGED) — SockJS, faye, ws, uWebSockets.js
- **#14235** — Serializer DDP pluggable (OPEN) — EJSON + CBOR experimental

### Appendix

| Document | Contenu |
|---|---|
| [appendix-testing-implications.md](appendix-testing-implications.md) | Consequences potentielles du bundle ESM sur la strategie de test (conditionnel au proto) |

## Sources communaute

- [What if Meteor was created in 2025](https://forums.meteor.com/t/what-if-meteor-was-created-in-2025/63566)
- [Has Anyone Tried to Run Their Meteor Build with Bun.js?](https://forums.meteor.com/t/has-anyone-tried-to-run-their-meteor-build-with-bun-js/59287)
- [Bun and Meteor](https://forums.meteor.com/t/bun-and-meteor/60483)
- [GitHub Discussion #12812 — Bun support](https://github.com/meteor/meteor/discussions/12812)

## Evolution du dossier

Ce dossier est vivant. Toute decouverte, spike, benchmark ou discussion pertinente doit etre documentee ici.
