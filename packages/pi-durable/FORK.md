# @klh/pi-durable — fork provenance

Fork of [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable),
vendored into fleet per owner decision 2026-11-09 (pi-durable is experimental —
"API changes without notice" — and the fleet line builds inside its territory:
pi-durable-workers extension, wake primitives, budget guards; W2888).

- **Upstream snapshot:** `ea1cfcc4c8e8` (main, committed 2026-11-09T09:02:23Z), upstream version 1.5.0
- **License:** MIT © Mario Zechner — preserved verbatim in `LICENSE.upstream`; this fork remains MIT and keeps upstream attribution
- **Changes vs upstream at vendoring time:** none (pristine snapshot); `package.json` rewritten to fleet conventions (`@klh/*`, source-first exports, private, bun engines)
- **@klh/chord IS vendored (see packages/chord/FORK.md — npm chord 1.5.0 lacks ./json + ./watch). Other siblings (`pi-ai`, `pi-schema`, `pi-telemetry`, `pi-codemode`) resolve from npm, pinned `1.5.0`
- **Tests:** upstream ships a vitest suite (`test/`, `test-workers/`); fleet runs `bun test` — the vitest suite is NOT wired into fleet CI yet (follow-up; acceptance for the fork itself was an import smoke)
- **Diverge policy:** fleet changes land in-tree with `// [klh-fork]` markers; rebase onto upstream releases deliberately, diffing our markers first
- **Consumers:** W2888 (pi-durable-workers extension), W2887 cockpit (task-graph surface)
