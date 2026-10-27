// W1249 scanner — moved to packages/suspenders/hooks/lib/import-graph.ts
// (W1302.4: the done-gate's diff-scoped reach-in ratchet shares ONE scanner;
// repo-root consumers keep their import path via this re-export).
export * from "../../packages/suspenders/hooks/lib/import-graph.ts";
