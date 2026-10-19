# Buckle cross-dialect bridge parity — W883 decision (2026-10-19)

Evidence: `docs/litellm-behind-buckle-review.md` F4–F6 (a7bb5889). All four
hops re-verified against `packages/buckle/src` at the cited lines on the
W883 branch (base 41a3f1fa). This memo frames the owner decision
translate-vs-reject per field; code facts are current as of this date.

## F4-a — `response_format`/json_schema (openai client → anthropic upstream)

Current (`adapters/tools.ts:351-360`, `OPENAI_DEGRADE`): dropped with a
warning. An openai-wire client asking for structured output silently gets
free-form text — honest-by-warning, contract-breaking in effect. (Any
UNLISTED field rejects the hop outright — reject-verbose-then-skip.)

| Option | Effect | Cost/risk |
| ------ | ------ | --------- |
| Reject-verbose (remove from DEGRADE) | 400 naming `response_format`; cross-dialect legs stop serving structured-output requests | Smallest change; turns silently-wrong into loud-fail |
| Translate → anthropic `output_format` json_schema | Real structured output on supporting models | New bridge surface; model-dependent 400s; feature availability varies per upstream family |
| Tool-injection translation (forced tool w/ input_schema) | Works on any tool-capable model | Response unwrap (tool_use → text) + streaming unwrap; largest surface |

**Lane recommendation: reject-verbose now** (honest, one-line + test);
revisit translation only when a real openai-dialect consumer needs
structured output over an anthropic upstream.

## F4-b — reasoning deltas (`thinking_delta` ↔ `reasoning_content`)

Current: dropped + `warnOnce` both directions (`tools.ts:929-931`
anthropic-upstream thinking_delta → openai client; `tools.ts:649-651`
openai-upstream reasoning_content → anthropic client).

| Option | Effect | Cost/risk |
| ------ | ------ | --------- |
| Status quo (drop) | openai-dialect clients never see reasoning | GLM is always-think; openai clients stay blind to it |
| Translate thinking_delta → `delta.reasoning_content` | Additive de-facto field; unknown-field clients ignore it | Low: additive stream delta only |
| Translate reasoning_content → anthropic thinking blocks | claude-CLI clients render thinking natively | Synthesized thinking blocks have no signature; replayed into history they can 400 on native anthropic legs (signature validation with tools), and inbound history must then strip them for openai wires |

**Lane recommendation: adopt the openai-client direction** (thinking_delta
→ reasoning_content — additive, low risk); **hold the anthropic-client
direction** until the signature-replay/history-echo hazard is designed
away.

## F4-c — synthesized `max_tokens: 4096` (openai client omits it)

Current (`bridge.ts:31,61`): silent synthesis — anthropic wire requires
`max_tokens`, openai wire permits omission. `max_completion_tokens` is
already aliased first (`bridge.ts:56-58`), so only true omission hits 4096.

| Option | Effect | Cost/risk |
| ------ | ------ | --------- |
| Keep 4096 + emit TransformWarning | Unchanged ceiling, no longer silent | Truncation window unchanged |
| Raise to 16384 + warning | 4× headroom; honest-degrade per bridge contract | Still a silent-shape constant, but warned |
| Catalog-derived per-model max | Exact per-model ceilings | `adapters/catalog-table.ts` carries no max-output data — mints a new catalog feature for a rare path |
| Reject when omitted | — | Illegal: omission is valid openai wire. **Rejected.** |

**Lane recommendation: raise to 16384 + TransformWarning** (honest degrade
now); catalog-derived ceilings only if truncation is ever observed in the
wild.

## F6 — upstream 429/5xx bodies replaced

Current (`router.ts:256-291`, `adapters/errors.ts:232-245`,
`handlers.ts:604-624`): 429 rebuilt into a dialect-correct envelope that
already preserves the provider's message text + code + retry-after
(`errorMessage` keeps upstream text, `errors.ts:190-194`); ratelimit
headers renamed `x-upstream-ratelimit-*` (budget-attribution law — the 429
is the upstream's budget, never buckle's); exhausted ladders answer a
generic 502 `no_route` problem+json — the provider's 5xx body never passes.

| Option | Effect | Cost/risk |
| ------ | ------ | --------- |
| Status quo | Dialect-correct, budget-unambiguous; 429 detail already survives | Exhaustion is opaque: no upstream status/message in the 502 |
| Raw pass-through | — | Breaks dialect contract + budget attribution. **Rejected.** |
| Keep rebuild; enrich exhausted-502 with last upstream status+message | Ladder exhaustion becomes diagnosable | Small: seam is `handlers.ts:604-606` + the exhaustion error text the router composes |

**Lane recommendation: keep the rebuild, enrich the exhausted 502** with
the last upstream status + message (`upstream: "<status> <message>"` in
the problem detail).

## Recommended package (for the owner ruling)

1. `response_format`: reject-verbose (leave DEGRADE) — F4-a.
2. Reasoning deltas: translate `thinking_delta` → `reasoning_content`
   (openai-client direction only) — F4-b.
3. `max_tokens`: synthesize 16384 + warning instead of silent 4096 — F4-c.
4. Errors: keep dialect rebuild + `x-upstream-ratelimit-*`; enrich the
   exhausted 502 with last-hop status+message — F6.

Implementation of any accepted row is follow-up work (new items), not
part of this decision.
