# @klh/chord — fork provenance

Fork of [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/chord),
vendored into fleet per owner decision 2026-11-09 (pi-durable is experimental —
"API changes without notice" — and the fleet line builds inside its territory:
pi-durable-workers extension, wake primitives, budget guards; W2888).

- **Upstream snapshot:** `ea1cfcc4c8e8` (main, committed 2026-11-09T09:02:23Z), upstream version 1.5.0
- **License:** MIT © Mario Zechner — preserved verbatim in `LICENSE.upstream`; this fork remains MIT and keeps upstream attribution
- **Changes vs upstream at vendoring time:** none (pristine snapshot); `package.json` rewritten to fleet conventions (`@klh/*`, source-first exports, private, bun engines)
- **Siblings NOT vendored: `pi-schema`, `pi-telemetry` resolve from npm, pinned `1.5.0`.
- **Tests:** upstream ships a vitest suite (`test/`, `test-workers/`); fleet runs `bun test` — the vitest suite is NOT wired into fleet CI yet (follow-up; acceptance for the fork itself was an import smoke)
- **Diverge policy:** fleet changes land in-tree with `// [klh-fork]` markers; rebase onto upstream releases deliberately, diffing our markers first
- **Consumers:** W2888 (pi-durable-workers extension) — vendored because upstream durable resolves chord as a WORKSPACE package; npm chord 1.5.0 lacks ./json and ./watch that durable@ea1cfcc imports
