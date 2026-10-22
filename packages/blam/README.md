# BLAM — Benchmark of LLM Agent Mishaps

**A failure taxonomy, labeled dataset, and reproducible benchmark for LLM
agent fleets operating on shared repositories.**

Agent fleets now write to shared git repositories at fleet scale — work
graphs assign items, merge ladders integrate branches, one-writer leases
guard files. The failure modes of this arrangement are documented nowhere:
no peer-reviewed study covers parallel agents on shared git repos, merge
ladders, or worktree coordination. MAST catalogued chat-style multi-agent
systems; nothing covers the control-plane setting. BLAM fills that gap
with three artifacts:

1. **The CRASH taxonomy** — five top-level failure classes: **C**oncurrency
   races, **R**ecovery gaps, **A**lignment drift, **S**tate poisoning,
   **H**andoff failures (`docs/taxonomy.md`).
2. **A labeled incident dataset** — real incidents from a production
   single-machine fleet (sanitized), JSONL + JSON Schema + a labeling CLI,
   under a written multi-annotator protocol with agreement statistics
   (`schema/`, `dataset/`, `docs/labeling-protocol.md`).
3. **BLAM-bench** — deterministic, LLM-optional benchmark suites in
   `bench/`. Runnable today: the consult policy suite and the paired-arm
   eval suite (exact commands + limits in `bench/README.md`). The
   five-scenario CRASH suite (S1-S5: registry lag, crashed-merge debris,
   commit-into-live-merge, vanish-rename, unenforced norms) is specified
   there but has no harnesses yet — it will score detection, recovery,
   data-loss prevention, and false-block rate against a control-plane
   adapter.

**Status:** consult + paired bench suites are runnable and deterministic;
the additive live paired runner accepts a task, agent command, and private
validation command. Its integration test uses a stand-in, not a live model;
the CRASH S1-S5 scenario suite is spec-only — no scenario harness exists
yet. Dataset: 13 validated seed incidents, growing via the labeling
protocol.

## Why LLM-optional matters

Every scenario in BLAM-bench triggers its failure condition with _scripted
lane stand-ins_ — plain processes that reproduce the race deterministically.
No model calls needed to score a control plane's coordination robustness.
LLM-in-the-loop variants (sycophancy, alignment drift) are additive, not
required. This makes the benchmark CI-runnable, cheap, and reproducible —
the three properties agent benchmarks habitually lack.

## The five CRASH classes

|       | Class             | Seed examples                                                                                                            |
| ----- | ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **C** | Concurrency races | branch registered before lane entry; pid reuse defeats liveness check; check-then-act on renamed branch                  |
| **R** | Recovery gaps     | debris blocks abort; silent-failure (`run()` ignoring exit codes); unguarded `-D`; fix shipped but daemon never reloaded |
| **A** | Alignment drift   | spec misread; sycophancy cascade; unsafe defaults; over-spawning                                                         |
| **S** | State poisoning   | commit concludes a foreign live merge; debris falsely fails the _next_ branch; stale path guess retires nothing          |
| **H** | Handoff failures  | unverified signature trust; norms without enforcement (METR-style); context telephone                                    |

Full definitions, subclasses, decision tree: `docs/taxonomy.md`.

## Quick start

```bash
bun install
bun tools/label.ts validate dataset/incidents.jsonl   # schema-check the dataset
bun tools/label.ts list                                # summary by class
bun test                                               # all package tests (164)
bun bench/consult/harness.ts                           # consult policy suite
bun bench/paired/harness.ts                            # paired-arm eval suite
```

## Repo layout

    docs/       taxonomy, labeling protocol, metrics, condense spec +
                compression research
    schema/     JSON Schema for incident records
    dataset/    incidents.jsonl (sanitized real incidents) + format doc
    bench/      scenario harness + reproducible failure scenarios
    tools/      labeling CLI + agreement statistics
    paper/      outline + venue ranking (outline.md)

## License

Code: [Fleet Personal Use License 1.0](LICENSE), with personal use only and no
redistribution; commercial licensing is described in the [Fleet README](../../README.md#license).
Dataset: CC-BY-4.0 (see `dataset/README.md`).
