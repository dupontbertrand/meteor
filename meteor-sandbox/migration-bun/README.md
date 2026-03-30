# Meteor Runtime Modernization — Full Dossier

All research and analysis on Meteor server runtime modernization, Bun support, and the long-term architectural vision.

## Big Picture

The real challenge is not "Meteor on Bun". It is **"Meteor with a standard server bundle format, capable of running on multiple modern runtimes."**

Bun is not the goal — it is a **revelator** of the current runtime's technical debt (vm.runInThisContext, Reify, Module.prototype patching, boot.js). The central lever is the **ESM bundler**: if `meteor build` emits real ESM modules, the runtime reduces to `node index.mjs` or `bun index.mjs`.

### The 3 Levels of This Dossier

1. **Concrete prototype** — Can we make the bundler emit an ESM bundle?
2. **Structural abstractions** — Transport, serializer, store, observe, HTTP: pluggable interfaces
3. **Meteor 2026 vision** — What would we challenge if we redesigned Meteor today?

## Documents

### Synthesis Documents (March 2026)

| Document | Scope | Status |
|---|---|---|
| [meteor-esm-bundle-prototype.md](meteor-esm-bundle-prototype.md) | Concrete prototype: `meteor build --format=esm` | Spec ready, spike to do |
| [meteor-runtime-capability-model.md](meteor-runtime-capability-model.md) | Architecture: capability map, 5 pluggable interfaces | Reference document |
| [meteor-2026-vision.md](meteor-2026-vision.md) | Broad vision: Minimongo, TinyBase, PWA, Capacitor, package audit | Vision document |

### Previous Analyses (March 2026)

| Document | Content |
|---|---|
| [meteor-bun-deno-migration-assessment.md](meteor-bun-deno-migration-assessment.md) | Feasibility study Node→Bun/Deno, subsystem-by-subsystem audit, 10 blockers |
| [meteor-bun-deno-built-bundle-spike-plan.md](meteor-bun-deno-built-bundle-spike-plan.md) | Detailed spike plan: execution chain main.js → runtime.js → boot.js |
| [meteor-runtime-modernization-analysis.md](meteor-runtime-modernization-analysis.md) | Strategic analysis: preserve vs redesign matrix, 4 architectural candidates |
| [meteor-runtime-modernization-analysis-fr.md](meteor-runtime-modernization-analysis-fr.md) | French version of the above analysis |
| [meteor-clean-slate-runtime-evaluation-fr.md](meteor-clean-slate-runtime-evaluation-fr.md) | Clean-slate evaluation: modernizing legacy vs parallel new path |
| [meteor-modernization-clarified-plan-fr.md](meteor-modernization-clarified-plan-fr.md) | Clarified 3-layer plan (A/B/C) with corrections from previous passes |

## Related PRs

- **#14231** — Pluggable DDP transport (MERGED) — SockJS, faye, ws, uWebSockets.js
- **#14235** — Pluggable DDP serializer (OPEN) — EJSON + CBOR experimental

### Appendix

| Document | Content |
|---|---|
| [appendix-testing-implications.md](appendix-testing-implications.md) | Potential consequences of ESM bundling on the testing strategy (conditional on prototype) |

## Community Sources

- [What if Meteor was created in 2025](https://forums.meteor.com/t/what-if-meteor-was-created-in-2025/63566)
- [Has Anyone Tried to Run Their Meteor Build with Bun.js?](https://forums.meteor.com/t/has-anyone-tried-to-run-their-meteor-build-with-bun-js/59287)
- [Bun and Meteor](https://forums.meteor.com/t/bun-and-meteor/60483)
- [GitHub Discussion #12812 — Bun support](https://github.com/meteor/meteor/discussions/12812)

## Dossier Evolution

This dossier is a living document. Any relevant discovery, spike, benchmark, or discussion should be documented here.
