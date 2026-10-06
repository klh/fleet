// registry.ts — RETIRED as a source (W465): the ONE runtime model inventory
// is belt's packages/belt/bin/registry.ts (richer: alias/contextTokens/
// EXTERNAL/registryEntries + the W271 emitter reads it; the openai-review
// duplication finding lands here). This module survives only as a re-export
// so the kit's relative imports (./registry.ts inside spawner.ts/swarm.ts)
// keep one obvious path. Port↔model pairs exist ONLY in belt's registry;
// change a model THERE and every consumer follows.
export * from "../belt/bin/registry.ts";
