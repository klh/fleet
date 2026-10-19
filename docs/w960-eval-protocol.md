# W960 — held-out harness-improvement eval protocol

Record of the pinned evaluation protocol for the W958 Propose-Probe-Compose
run (mission W960). This doc records decisions only; task statements and
judges stay private in machine-local runtime config.

## Pins

- Starter under evaluation: `lane-orientation` (fleet, version 0 = no
  promoted artifact; both arms ride the built-in base orientation, the
  candidate adds the composed guidance on top).
- Model + route: `glm-5.3-flash` via the belt router :4000 (complexity-routed
  swarm, the standard lane route — both arms identical, so the pairing is
  fair). Editor POSTs the same route directly.
- Executor: the claude CLI lane recipe (`-p --output-format json`,
  `--allowedTools`/`acceptEdits`, W228 model grammar via a 0600
  `--settings` pin at
  `~/.claude/local-llm/blam/w960/executor-settings.json`), plus a bench
  contract line (`--append-system-prompt`) forbidding commits/coord/CLIs.
- Corpus: 130 held-out tasks = 10 curated families x 13 deterministic
  instances (cfg-create, edit-seeded, bugfix, transform, extract, multifile,
  script-io, implement-from-spec, md-doc, rename-refactor), all against the
  fleet repo frozen at the curation-time main head
  (9d2ddb902f46b6603933f9758e6006a3c9cf59ff). Every task has a private judge
  (hidden I/O pairs or byte-exact expectations); F3 planted bugs are
  auto-verified to fail their hidden cases.
- Judge self-test: every judge must reject an empty artifact dir AND accept
  a synthesized correct artifact (131/131 green before the run).
- Steps: 2 propose+probe+compose rounds; per-execution timeout 10 min;
  output dir `~/.claude/local-llm/blam/w960/runs` (outside every evaluated
  repo; 0700; manifests 0600).
- Gate: the BLAM promotion gate (minReps 130, zero correctness regression,
  measured tokens/minutes lift with sign agreement) — a winner is activated
  ONLY on `promotion.promote = true` with the report inspected.

## Operating conditions

- The full run is model-backed (260+ executor executions, est. 9-14 h
  sequential) and is POWER-GATED: it launches only with the Mac on AC
  (owner directive 2026-10-19: hold model-backed benchmarking until AC).
- A 3-task smoke manifest (same pins, steps 1) validates the pipeline
  before the full run; it is also model-backed and waits for AC.

## Artifacts (machine-local, never committed)

- `~/.claude/local-llm/blam/w960/manifest-w960.json` (full), `manifest-smoke.json`
  (smoke), `editor.ts` (route wrapper), `executor-settings.json` (0600 route pin),
  `runs/<runId>/report.json` per run. Improvement log:
  `.fleet/starter-registry/improvements/lane-orientation.jsonl` (runtime).
