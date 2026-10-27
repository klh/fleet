// src/index.ts — the `.` barrel: the README's bare `import ... from
// "@klh/telemetry"` face (W2173.4: the exports map had no "." entry, so the
// documented form resolved to nothing). Re-exports every contract module;
// the per-module subpath exports stay the canonical import surface.
export * from "./hop-contract.ts";
export * from "./http-trace.ts";
export * from "./prefer-header.ts";
export * from "./remote-traces.ts";
export * from "./trace-log.ts";
export * from "./transport-evidence.ts";
