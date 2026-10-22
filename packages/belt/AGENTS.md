# AGENTS.md — belt package law

The fleet-wide lane protocol (plan-first, shatter judgment, gates, done,
inbox/narration) is single-sourced in the repo-root AGENTS.md § Lane
protocol. This file carries belt package law.

## Protocol

Point at the root: the fleet-wide lane protocol is single-sourced in the
repo-root AGENTS.md § Lane protocol. Belt adds nothing to it.

## LLM routing

Owner directive 2026-09-29: ASK BELT what LLMs are available before
dispatching LLM work — `bun bin/remotes.ts check` (liveness) or
`bun bin/remotes.ts discover` (DNS-SD). Cloud is fastest for most items and
stays the default; use the remote/local machines (NAS ollama, the local
swarm) to refine a prompt or plan, for long-running background tasks, or as
fallback when cloud is down. The optimization target is SPEED, not cost.
Details: docs/multi-machine.md.

---

## Package law

Local LLM fleet: MLX specialists (bin/registry.ts = single source of truth),
deterministic router :4000, dashboard :7791, bench rig. Install deploys to
~/.claude/local-llm/. Companions: suspenders (control plane), klh/local
(Caddy .local services), speedy (config layer).

## LLM Routing Doctrine

Single source: § LLM routing above.

## qlty Quality Doctrine

The fleet-wide law (root AGENTS.md § Laws) applies; belt specifics: the
on-write gate runs qlty-fmt + fast lint and blocks with the diff inline;
on-stop — the evidence gate, not lint.

## UI law

The fleet-wide law (root AGENTS.md § Laws) applies; belt adds:
`document.createElement` only inside web components (lit).
