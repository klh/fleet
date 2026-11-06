# W2779.1 — DRY disposition: fleet ↔ fleet-knowledge dual inventory

The W2779 audit of duplicated knowledge surfaces across `fleet` (private)
and `fleet-knowledge` (icomdev, BSL, public). Each row names the ONE home
and the executor. Boundary law (seam contract,
`packages/suspenders/docs/knowledge-seam.md` @ 2819157e, branch
`suspenders/W2779`): **share rule DATA format, never code** — the
BSL/public vs private repo line forbids code imports either way.

## Rows

| # | dup | fleet side | fk side | one home | executor | status |
|---|-----|-----------|---------|----------|----------|--------|
| 1 | KNOWLEDGE_PRECEDENCE preamble (verbatim ×2) | `hooks/lib/knowledge/knowledge.ts:501` · `buckle/src/preseed.ts:100` (ported copy) | (arrives with substrate move) | fk substrate, served over the `/search` `preamble` field | W2779.2 | **fleet half landed** (W2779.1): buckle consumes the served preamble; a preamble-less response = honest outage skip, no bare packet |
| 2 | SQL guardrails | `hooks/lib/knowledge/knowledge-query.ts` (`executeKnowledgeSql`: SELECT/WITH lint, table allowlist, LIMIT, ro handle) | `src/answer/plan.ts` (`validatePlanSql`/`wrapPlanSql`/`executePlan`: single-SELECT lint, LIMIT wrap, ro worker, 500ms budget) | fk guardrails ARE the serving face | W2779.2 (move) → W2779.3 (fleet callers retarget) | pending |
| 3 | secret/scrub rule vocabularies | `hooks/lib/gates/scrub.ts` (`BUILTIN_RULES` + denylist) | `src/core/secret-filter.ts` (gitleaks.toml + redaction) | shared RULE DATA format, one vocabulary — never code | W2779.2 (scrub rides fk secret-filter per seam ownership table) | pending |
| 4 | two knowledge MCP servers, both direct-DB | `suspenders hooks/bin/knowledge-mcp.ts` (`read_knowledge`) · `belt bin/mcp-knowledge.ts` (`knowledge_search`) | — | one server in fk; harness `mcpServers` entry retargets | W2779.2 (serve) / W2779.3 (wire) | pending |
| 5 | fk web/serving has no launchd + health sidecar | pattern: `deploy/healthcheck/probe.ts` + services.yaml rows (owner law: health is outside-process) | `src/web/server.ts` (no sidecar) | fk-native host guard + probe sidecar when fk becomes the sink | W2779.2 | pending |
| 6 | decant vendored in both repos | `packages/decant/` (W950 pin, v0.11.0) | `fleet-knowledge/decant/` (same snapshot) | byte-pure BY DESIGN — no code DRY; pin docs cross-reference | — (discipline only) | **landed** (W2779.1): both `FLEET.md` pin docs name each other |

## Row 1 detail (landed here)

The precedence clause (W103) existed verbatim in two code homes. The
`/search` face already served it (`hooks/bin/knowledge-api.ts:397`,
`preamble: KNOWLEDGE_PRECEDENCE`); buckle now consumes that field instead
of carrying a port (`buckle/src/preseed.ts`):

- `renderPacket(domain, rows, preamble)` — the clause is packet data, not
  a vendored constant.
- `Preseeder.search()` returns `{hits, preamble}`; a response with hits
  but no preamble → `skipped/outage` — a packet may not emit knowledge
  without the clause (the injection arm-C refusal artifact).
- Regression: `buckle/test/aids.test.ts` "W2779.1: response without
  preamble → outage skip, no bare packet".

When W2779.2 moves the substrate, the clause's single definition moves
with it; `hooks/rules/fleet-knowledge.md` keeps its quoted copy as
documentation prose (it quotes the clause by design; a doc quote is not a
code home).

## Row 6 detail (discipline)

Both vendored snapshots pin `dosu-ai/decant v0.11.0` (W950 curations).
Byte-purity is the posture — re-sync happens only at a new upstream tag,
independently per repo, re-applying each side's seam edits. The two pin
docs now name each other so a re-pinner on either side finds the twin.
