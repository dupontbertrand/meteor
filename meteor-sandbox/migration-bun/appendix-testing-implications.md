# Appendix — Testing Implications of an ESM Server Bundle

**Status :** Note stratégique — conséquence potentielle du bundle ESM, pas un chantier immédiat.
**Prérequis :** Le proto ESM fonctionne (`meteor build --format=esm` produit des modules importables).

---

## Si le bundle ESM marche, les tests se simplifient

Des modules serveur réellement importables rendent possibles :

- **Tests unitaires serveur avec `bun:test` / `node:test`** — importer une méthode, l'appeler, assert. Pas besoin de démarrer un serveur Meteor complet pour tester une fonction.
- **Moins de dépendance à Tinytest / test drivers** — le test runner est le runtime lui-même, pas un package Meteor.
- **Séparation unit / integration / e2e plus claire** — unit = import direct, integration = serveur démarré, e2e = Playwright.

```js
// Exemple : test unitaire d'une method (possible seulement avec des modules ESM importables)
import { test, expect } from 'bun:test';
import { createTask } from '../imports/methods/tasks.mjs';

test('createTask valide le texte', () => {
  expect(() => createTask({ text: '' })).toThrow();
  expect(() => createTask({ text: 'Hello' })).not.toThrow();
});
```

## Ce qui resterait nécessaire

- **Playwright** pour les tests browser réels (happy-dom/jsdom ne couvrent pas tout)
- **Tests d'intégration avec serveur démarré** pour les flux DDP / publications / auth
- **Helpers de bootstrap/contexte** pour les tests qui ont besoin d'un contexte utilisateur, d'un DDP invocation context, ou d'une base test — "moins besoin de démarrer tout Meteor" ≠ "plus jamais besoin"
- **Tests de réactivité client** — même avec un store pluggable, la propagation des changements et les effets sur le client doivent être testés

## Ce qui pourrait être challengé plus tard

| Brique actuelle | Pourquoi la challenger | Remplacement possible |
|---|---|---|
| Tinytest | Test framework custom de 2012 | `bun:test` / `node:test` / Vitest |
| Test drivers (packages) | Bridge Tinytest → browser, complexité inutile | Playwright direct |
| `meteor test-packages` | Démarre un serveur complet pour du unitaire | Import direct + runner natif |

## Ce qui ne change pas

- E2E = Playwright (pas Meteor-spécifique, pas de changement)
- Tests d'intégration = serveur + client DDP (le protocole ne change pas)
- CI = même matrice, juste le runner qui change

## Dépendance

Tout ceci est conditionnel au succès du proto ESM. Si le bundle ESM ne produit pas des modules importables, cette vision reste hypothétique.
