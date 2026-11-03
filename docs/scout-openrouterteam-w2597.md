# OpenRouterTeam org scout — W2597 (2026-11-03)

Owner ask: review the 39 OpenRouterTeam repos; is anything worth LIFTING
into fleet? Focus: agent, routing, skill, MCP, harnesses. Method: shallow
clones under `.tmp-scout/` (read-only, never ran their code), README +
core-module reads, license check per repo (GitHub API `license.spdx_id` +
LICENSE files + package.json `license` field). Judge against: fleet already
has it (cite), license-clean (MIT/Apache lift code, none = pattern only),
TS/Bun/zod/Lit fit, cross-package import law.

## Verdict table (decision-grade)

| Repo | Verdict | What / where / effort |
| --- | --- | --- |
| **typescript-agent** (37★, `@openrouter/agent`, Apache-2.0 via package.json, no root LICENSE file) | **ADAPT** | `lib/doom-loop.ts` (~1.5k lines): deterministic doom-loop detector — RFC 8785 JCS-canonicalized SHA-256 fingerprints of tool calls, round-scoped streaks (fan-out of N identical calls in one round counts once), per-call streaks inside varying rounds, graduated ladder observe→steer→escalate→block→stop, persisted state across save/resume, detection never the cause of failure. Fleet analog `packages/suspenders/hooks/lib/gates/runaway.ts` (W830/W1079: back-to-back same-tool same-args, fail-streak, USD cap) has the REPEAT rung but none of: round-scoped fan-out identity, per-call evidence, text-repetition/text-streak detectors, steer/escalate actions, cross-pause persistence. Effort: pattern-adopt semantics into the runaway gate (~2-3 days); JCS canonicalization is the tricky bit — Bun has no RFC 8785 built-in, would need a small canonicalizer (~80 lines) or the `canonicalize` npm dep. No code copy (license risk: package.json says Apache-2.0 but no LICENSE file in-tree = keep it pattern-only). |
| **benchmark-harness** (24★, Apache-2.0, pushed today, Bun + `bun test`) | **LIFT (select)** | Two things. (1) `toolcall-schema-fuzz` benchmark: schema-aware tool-call fuzzing (arb/ generators, discovery/, regressions.json as a checked-in regression corpus, stability tracker) — directly transplantable to fleet as a buckle adapter conformance suite: fuzz JSON-Schemas at our `packages/buckle/src/adapters/tools.ts` + dialect translators, catch translation drift the way `regressions.json` catches theirs. Fits `*.e2e.ts` law, Bun, TS. Effort ~3-5 days to port the fuzz generators (schema arb/, realistic/ rewriter) without the OpenRouter API dependency. (2) `results/parquet-stream-writer.ts` + `atif-schema.ts`: streaming Parquet result emission + an Agent-Trace Interchange Format schema — relevant if blam ever publishes decision-grade artifacts beyond JSON (currently `packages/blam/` emits its own schema). Effort ~2 days; only worth it when blam needs interchange. Their runner/run-spec cost-approval discipline (`--dry-run` → `--approve-cost-usd`, measured cost rates before scaling) is the pattern our benchmarks decision-grade law already encodes — no lift. |
| **Switchyard** (2★, Apache-2.0, fork=true of NVIDIA-NeMo/Switchyard, Rust + Python) | **ADAPT** | Not an OpenRouter original — a fork of NVIDIA's router kept for the routing-profile TOMLs (`benchmark/routing-profiles/*.toml`: staged/escalation/classifier routes over efficient+capable pairs). Escalation algorithm semantics (`crates/libsy/src/algorithms/escalation.rs`): call efficient → judge its OUTPUT with an LLM → escalate to capable only on N consecutive escalate verdicts (latch state), context-window/transport errors fall through to capable with typed reason codes. W2593 (model=kev sentinel) is our analog; the LATCH (N-consecutive-confirmation before switching tiers, sticky once confirmed) and typed reason-code fallback are the two semantics worth folding into the kev sentinel design. Rust → no code lift; upstream is `NVIDIA-NeMo/Switchyard` if we ever want the source. Effort: 1 design note into W2593, zero code. |
| **skills** (310★, no license — repo or per-skill) | **SKIP code / ADAPT distribution pattern** | 17 skills, all OpenRouter-API-specific (models/analytics/stt/tts/images/oauth) — zero fleet relevance as content; fleet's `skills/` catalog + `npx skills add klh/fleet` hash-pin (W1472) already covers catalog+install. The ADAPT bit: they ship Claude-Code plugin-marketplace + `gh skill install` + Cursor-remote-rule faces from ONE catalog — our skills-agents registry already does the equivalent; their README confirms the `gh skill install OpenRouterTeam/skills` UX works as a third face if we ever want it. No license = no copying skill files verbatim. |
| **ai-sdk-provider** (694★, Apache-2.0) | **SKIP** | Vercel AI SDK provider surface — model-metadata handling (hundreds of models, pricing/context) is genuinely well-done (`src/chat`+`src/schemas`), but fleet consumes providers via buckle adapters + `upstreams.json` machine conf, not an AI-SDK app. The e2e/ `issue-*.test.ts` per-quirk regression naming convention is a nice pattern we already practice (our `*.e2e.ts` suite names quirks inline). Revisit ONLY if a fleet consumer app adopts the Vercel SDK. |
| **search-benchmarks** (2★, MIT) | **SKIP** | Thin runner + parquet trajectory viewer over the benchmark-harness (pinned by commit). Fleet has no search-API eval need; blam's mishap-shape is different. The commit-pinned-harness-dependency discipline (never patch upstream, bump the pin) is already our vendored-decant doctrine. |
| **terraform-provider-openrouter** (11★, MIT) | **ADAPT (later)** | Full IaC surface for API keys, guardrails, workspaces, BYOK, observability destinations — resource + data-source pairs, acceptance tests. Maps exactly onto the enterprise klh-remote tier (W422): if enterprise customers manage buckle `bksk_` lane keys / guardrail policies as IaC, this repo is the reference shape (resource-per-entity + `_sdk.go` split). Not actionable until klh-remote ships its public API. Zero code now; bookmark as design reference. |
| **sign-in-with-openrouter** (12★, MIT) | **SKIP** | OAuth PKCE templates + sign-in components + skills. Fleet auth is machine-conf + minted keys; no user-facing OAuth surface. Relevant only the day fleet gets a human login face; `~/.claude/docs/cli-auth-interaction-lessons.md` already covers our CLI auth learnings. |
| **go-agent / python-agent** (11★ Apache-2.0 / 7★ NOASSERTION) | **SKIP** | Port siblings of typescript-agent (go-agent even carries `PORTING.md` — same API cross-language). Fleet lanes are TS/Bun; the multi-port conformance-vector idea (shared `tests/vectors/*.json` so every port proves identical semantics) is the one pattern worth remembering if fleet ever ships a second-language client. |
| **typescript-sdk / python-sdk / go-sdk** (266/172/72★, Apache-2.0) | **SKIP** | Plain API wrappers over the OpenRouter REST surface. Buckle already speaks both wire dialects natively (`packages/buckle/src/adapters/`). Reference value only. |

Skipped without reads (external forks / personal assistants / docs / lists,
per brief): make-real, hermes-llava, open-webui, opik, ai (Vercel fork),
mindcraft, cdp-agentkit, amica, lux, llama-stack-evals, SnitchScript,
open-deep-research + deepclaude (CoT-trace UIs — only interesting if belt
ever surfaces reasoning traces to the board; not now), fern-platform,
markdown-wasm, cc-test-mastra, nanoclaw/openclaw, persona-hub,
multimedia-explorer, awesome-openrouter, openrouter-examples(+python),
docs, .github, openrouter-tool-check (3★ tool-presence probe — subsumed by
our adapter conformance tests).

## Recommended actions (priority order)

1. **doom-loop semantics → runaway gate** (typescript-agent ADAPT): add
   round-scoped streak identity + steer/escalate rungs to
   `hooks/lib/gates/runaway.ts`. This is the single highest-value find: it
   addresses exactly the lane pathologies in fleet memory (lexer
   zero-width hang, orphan workers, retry walls) with a deterministic,
   transcript-pure design. Mint as `work add` when picked up.
2. **toolcall-schema-fuzz port → buckle conformance suite** (benchmark-harness
   LIFT-select): fuzz JSON-Schema tool defs through buckle's dialect
   translation; checked-in regression corpus (their `regressions.json`
   shape). Pairs with the existing adapter tests.
3. **Switchyard latch + reason codes → W2593 kev sentinel design note**
   (ADAPT, ~1 paragraph, zero code).
4. Bookmark terraform-provider as the klh-remote IaC reference (W422 era).
5. Nothing else. The org is mostly SDK/eval/docs surface; buckle + suspenders
   already cover the routing/agent-core ground their originals touch.

Licenses verified 2026-11-03 via `gh api orgs/OpenRouterTeam/repos`
(`license.spdx_id`) + in-tree LICENSE files. Two Apache-2.0 claims verified
only by package.json (typescript-agent has no LICENSE file at repo root —
treat as pattern-source, not copy-source; benchmark-harness ships a real
Apache-2.0 LICENSE and is lift-clean with attribution).
