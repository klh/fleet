# AGENTS.md — blam package law

The fleet-wide lane protocol (plan-first, shatter judgment, gates, done,
inbox/narration) is single-sourced in the repo-root AGENTS.md § Lane
protocol. This file carries blam package law. Blam gate detail: `bun test`
on the tools (validator + stats).

## BLAM-specific doctrine

- Dataset records MUST validate before commit:
  `bun tools/label.ts validate dataset/incidents.jsonl`.
- Sanitization is a hard rule — no real names of private projects, no
  personal paths, no credentials in any record, scenario, or paper text.
- The CRASH letters are the taxonomy: Concurrency races, Recovery gaps,
  Alignment drift, State poisoning, Handoff failures. New subclasses go in
  `docs/taxonomy.md` FIRST, then the dataset.
- The benchmark's core property is **LLM-optional**: a scenario that needs
  a model call to reproduce belongs in the additive track, not the core
  bench.

Repo doctrine (quality bar) lives in Package law below.

---

## Package law

A failure taxonomy + labeled dataset + reproducible benchmark for LLM
agent fleets on shared repositories. Companion discourse: the CRASH
taxonomy (Concurrency races, Recovery gaps, Alignment drift, State
poisoning, Handoff failures).

## Repo doctrine

- **qlty is the quality tool**; `.qlty/` is committed; biome owns code
  formatting; prettier owns markdown only. Read `.qlty/qlty.toml` before
  the first write.
- **All tooling is TypeScript run by Bun** — typed args, no shell scripts.
  Heavy ops go to native CLI tools launched with argument arrays.
- **New files via Write; edits via Edit** (unique anchor) or mechanical
  transforms (sd/ast-grep). Never generate file content through the shell.
- Verify with real command output before claiming anything works.
- Dataset records must validate against `schema/incident.schema.json`
  before commit (`bun tools/label.ts validate`).
- Sanitization is a hard rule: no real repo names of private projects, no
  personal paths, no credentials, no client data in any dataset record or
  scenario. See `docs/labeling-protocol.md` § sanitization.
