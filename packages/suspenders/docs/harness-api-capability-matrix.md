# Harness API capability matrix

W455 (feeds W454 starter sessions + forked lane starts). Per-executor
API surfaces we could expose as catalog rows, knobs, or starter
primitives. Compiled 2026-10-07.

## Verification legend

- **VERIFIED** — fetched from primary docs during this item; exact param
  names and URLs below were read from the live page.
- **LEAD** — primary docs unreachable from this lane (web allowlist was
  Anthropic-domains-only; NEED_DECISION #25436). Written from model
  knowledge, NOT verified. Treat as a lead, never a fact; re-verify
  against the named doc before any W454 prototyping.

## Executor matrix

| Executor | Prompt caching | Session resume/fork | Batch | Structured outputs | Background mode | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Claude (Anthropic) | Explicit `cache_control` breakpoints + TTL knob (VERIFIED) | CLI `--resume --fork-session` (VERIFIED) | Message Batches API, −50% (VERIFIED) | `output_config.format` json_schema GA; CLI `--json-schema` (VERIFIED) | CLI `--bg` background sessions (VERIFIED) | complete |
| Codex / OpenAI | Auto prefix caching, no user TTL control; `prompt_cache_key` hint (LEAD) | `codex resume` / `exec resume`; Responses `previous_response_id` chaining (LEAD) | Batch API −50% (LEAD) | `text.format` json_schema, strict mode (LEAD) | `background: true` + polling/webhooks (LEAD) | LEAD-only |
| Copilot CLI | No user-facing cache control documented; premium-request multipliers instead (LEAD) | Session semantics undocumented in reach (LEAD) | none known (LEAD) | none known (LEAD) | n/a (LEAD) | LEAD-only |
| Gemini | Explicit `cachedContents` resource + TTL; storage billed/h (LEAD) | CLI session storage, no documented fork (LEAD) | `batches.create` −50% (LEAD) | `responseSchema` + `responseMimeType` (LEAD) | Batch-as-background (LEAD) | LEAD-only |
| Grok / x.ai | Automatic prefix caching, discount on cached input tokens (LEAD) | Official CLI absent; community `grok-dev` (VERIFIED community, W296) | none known (LEAD) | OpenAI-shape `response_format` (LEAD) | n/a (LEAD) | LEAD-only |

## Claude executor — verified detail

Sources (fetched 2026-10-07):

- Prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Batch processing: https://platform.claude.com/docs/en/build-with-claude/batch-processing
- CLI reference: https://code.claude.com/docs/en/cli-reference
- Structured outputs (SDK): https://code.claude.com/docs/en/agent-sdk/structured-outputs
- API structured outputs + MCP connector + env vars: rows verified by
  the executor's doc-fetch pass against platform.claude.com /
  code.claude.com pages (mcp-connector under
  /docs/en/agents-and-tools/mcp-connector).

### Prompt caching (API)

- `cache_control: {"type":"ephemeral"}` attaches to blocks in `tools`,
  `system`, `messages[].content` — prefix order tools → system →
  messages; up to **4 breakpoints** per request.
- Top-level request-level `cache_control` = automatic mode; system
  picks the last cacheable block and slides it forward.
- TTL: default **5m** (refreshed free on use). 1h:
  `{"type":"ephemeral","ttl":"1h"}`; longer TTL must precede shorter.
- Pricing: 5m write **1.25x**, 1h write **2x**, read **0.1x** base
  input (Fable 5.1 / Mythos 5.1 read **0.025x**, Opus 5.5 **0.05x**).
- Min cacheable: 512–4096 tokens by model (512 on current 5.x
  frontier); below threshold silently uncached.
- Hit mechanics: writes happen only AT the breakpoint; reads walk
  back up to **20 blocks**; 100% byte-identical prefix required; a
  change at one level invalidates it and everything after
  (tool_choice / effort / images → messages too).
- Batch: caching multipliers stack with the batch discount; no
  pre-warming inside batches (`max_tokens: 0` rejected); use 1h TTL
  for batch-shared context.

### Sessions (CLI) — the W454 fork primitives

- `--resume <id|name|transcript.jsonl>` — resume by session ID, name,
  or transcript path.
- `--fork-session` — with `--resume`/`--continue`: reuse the original
  history under a NEW session id. This is exactly the forked-lane
  primitive W454 wants.
- `--session-id <uuid>` — pin the sid of a new conversation.
- `--continue` — most recent session in cwd.
- Cache-relevant starter flags: `--exclude-dynamic-system-prompt-sections`
  (moves per-user context out of the system prompt → first user
  message, for cross-user cache reuse) and the
  `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` split marker in custom prompts
  (static part above the line stays cached, v2.1.275+).
- `--bare` for fast scripted starts; `--settings <file>` for per-lane
  settings (dispatch already does this).

### Headless / harness flags (verified selection)

`-p`, `--output-format text|json|stream-json`, `--input-format
stream-json`, `--include-partial-messages`, `--forward-subagent-text`,
`--max-turns`, `--max-budget-usd`, `--json-schema '<schema>'` (print
mode), `--mcp-config` + `--strict-mcp-config`, `--tools`,
`--allowedTools`, `--disallowedTools`, `--permission-mode`,
`--permission-prompts none`, `--effort low|medium|high|xhigh|max`,
`--fallback-model a,b`, `--system-prompt[-file]` /
`--append-system-prompt[-file]`, `--betas`.
Env: `ANTHROPIC_BASE_URL` (belt/buckle front), `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`,
`ANTHROPIC_DEFAULT_HAIKU_MODEL` (replaces the deprecated
`ANTHROPIC_SMALL_FAST_MODEL`), `CLAUDE_CODE_MAX_OUTPUT_TOKENS`.

### Other API capabilities worth exposing (verified)

- **MCP connector**: `mcp_servers[]: {type:"url", name, url,
  authorization_token}` on the Messages API — server-side MCP without
  a local process; beta header `mcp-client-2025-11-20`.
- **Context editing** (beta `context-management-2025-06-27`):
  `clear_tool_uses_…`, `clear_thinking_…`, `compact_…` — server-side
  history bounding, relevant to W454's "bounded history".
- **Memory tool** (`memory_20250818`), **effort** (`output_config.effort`),
  **1M context** (no header on current models), **fine-grained tool
  streaming** (`eager_input_streaming`).
- **Message Batches**: ≤100k requests / 256 MB per batch; results when
  all requests end or 24h (expiry, unbilled expired requests); poll +
  `results_url` .jsonl; no webhooks.

## Codex / OpenAI — LEADS, verify before use

Codex CLI 0.158.0 is installed locally (brew cask). Verify against
developers.openai.com/codex and platform.openai.com docs.

- Responses API conversation state: `previous_response_id` chains
  server-side history; a new response referencing an old response_id
  is a fork. Requires `store: true` — a problem for our gate posture
  unless using encrypted-reasoning stateless carryover
  (`include: ["reasoning.encrypted_content"]`).
- Prompt caching is automatic prefix-based (1024-token multiples,
  ~50–90% input discount on cached tokens, usage at
  `prompt_tokens_details.cached_tokens`); `prompt_cache_key` steers
  routing for hit affinity. No user TTL, no explicit breakpoints.
- Background mode: `background: true` → poll `GET /responses/{id}`,
  webhooks on completion, cancel verb.
- Structured outputs: `text.format: {type:"json_schema", strict:true}`.
- CLI: `codex exec` headless, `codex resume`, `--json`, config.toml
  `model_providers` with custom `base_url` + `wire_api`
  ("responses"|"chat") — the gateway seam for buckle.
- Batch API −50%, 24h window.

## Copilot CLI — LEADS

Verify against docs.github.com Copilot CLI pages.

- No user-facing prompt-cache control; cost model is premium-request
  multipliers per model tier, not tokens. Caching upstream (if any) is
  transparent to the user.
- BYOK / model gateway exists for Copilot Enterprise; bypasses
  premium requests on some plans — verify current plan gating.
- CLI: `copilot` with `--resume`/`--continue`-style session flags,
  `--allow-all-tools`/`--allow-tool`/`--deny-tool`, `--model`, MCP
  config, GitHub auth. Hook surface documented in
  `docs/cli-surface-survey.md` §3 (W296).

## Gemini — LEADS

Verify against ai.google.dev.

- **Explicit context caching** — unique among the four: a separate
  `cachedContents` resource (`POST …/cachedContents`) with
  `ttl` (e.g. `"3600s"`) or `expire_time`, storage billed per hour per
  1M tokens, referenced by later requests via `cachedContent` name.
  Minimum cacheable tokens per model; system prompt + tools can be
  part of the cached resource. This is the strongest starter-prefix
  primitive of any non-Anthropic provider IF the lead holds.
- Batch mode −50% via `batches.create`; 24h target.
- Structured output: `responseMimeType: "application/json"` +
  `responseSchema` (subset); `thinkingConfig` (budget, includeThoughts).
- CLI: `-p`, `--output-format json`, `--approval-mode`, settings.json
  in `~/.gemini/`, custom endpoint auth — verify whether a custom
  base_url can point at buckle.

## Grok / x.ai — LEADS

Verify against docs.x.ai.

- Automatic prefix caching on OpenAI-compatible chat completions;
  discount on cached input tokens surfaced in usage (lead:
  `cached_prompt_text_tokens`). No explicit control, no TTL.
- `search_parameters` server-side Live Search (per-source pricing);
  server-side tools; no documented agents/session API.
- No official x.ai CLI; the community `grok-dev` CLI's hook surface is
  documented in `docs/cli-surface-survey.md` §4 (W296, verified there
  against the cloned repo).

## Integration sketches

### Catalog rows (buckle `src/adapters/catalog-table.ts`)

- x.ai: add as a tier-3 `openai-compat` catalog row with explicit
  `adapter_config` (auth shape: `XAI_API_KEY` name only). Its API is
  OpenAI-shaped; no family adapter needed.
- Gemini: catalog already carries vertex family. Explicit caching is a
  resource API (create/manage cache objects), NOT a per-request field —
  cannot ride the openai-compat catch-all; would need a vertex-family
  adapter extension before W454 can use it.
- Copilot: not a catalog row — it is an upstream (GitHub gateway with
  GitHub auth), not a raw provider endpoint. Model via upstreams.yaml
  if pursued at all.
- Codex/OpenAI: openai-compat family already covers the wire; the
  Responses-state knobs live in the codex CLI config, not the gateway.

### Knobs (operator surfaces — routing-policy.yaml / belt aids)

- `cache-align.ttl`: extend buckle `src/align.ts` to emit
  `{"type":"ephemeral","ttl":"1h"}` for starter-prefix requests. 1h
  writes cost 2x vs 1.25x — only worth it when lane idle gaps exceed
  ~4 minutes (5m expiry) but reuse is likely (dispatch bursts).
- `batch.lanes`: menial/extract lanes (bulk condense, harvest) are the
  natural Message Batches consumers — −50%, no interactivity. Needs a
  buckle pipeline branch that batches instead of streaming.
- `structured-output.contracts`: dispatch briefs that expect a machine
  verdict can pass `--json-schema` to `claude -p` (and the SDK
  `outputFormat`) instead of prose-regex parsing final lines.
- `context-editing`: the `compact_20260112` server-side edit is a
  cleaner bounded-history mechanism for long lanes than client-side
  truncation (beta header; verify pricing before adopting).

### Starters (W454 primitives, Claude first)

- Fork: keep one versioned starter session per lane class
  (`claude --settings <lane-file> --resume <starter-id>
  --fork-session` → new sid, shared history, per-lane bksk_ key in the
  settings file, never in the history).
- Cache: starter transcript is byte-stable → the 0.1x read path. Append
  lane identity AFTER the shared prefix; never inside it
  (align.ts W237 layout law already enforces system → packet →
  volatile).
- Cross-user reuse: `--exclude-dynamic-system-prompt-sections` +
  `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` so different lanes hitting the
  same starter still share the static prefix.
- Bounded history: `--max-turns`, `--max-budget-usd`, and (API-level)
  context-editing edits bound the fork's lifetime.

## Open decision

NEED_DECISION #25436: LEAD-only sections need either a lane with a
broader web allowlist or owner-pasted docs. Until then W454 phase 1
benchmarks should proceed Claude-only (all its primitives are
verified) and treat the rest as survey rows.
