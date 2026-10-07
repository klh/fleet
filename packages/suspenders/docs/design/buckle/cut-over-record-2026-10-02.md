# W144 cut-over record — 2026-10-02 (W202)

Status: **PREP COMPLETE — LABEL SWAP PENDING APPROVAL** (NEED_DECISION
#4191). The owner GO (fact `finding.w144-cutover-go`, 2026-10-02) authorizes
the cut-over conditional on a settled board; the board settled at ~14:40
(0 live claims, 0 red-team events, wave landed) but the lane's `launchctl`
calls are permission-blocked, so the process swap did not execute.

> Integrated 2026-10-07 (W413) from branch `parked/W202` — the only copy
> lived on that branch. The scripted swap below was never executed; see the
> outcome section at the bottom for what actually shipped.

## What is banked and verified

- Owner GO recorded as a fact with its conditions: settled board, red team
  between windows, :4100 state known; shadow-week 7-day doctrine waived
  (day-1 evidence passed ~20x margins).
- **Guard lift** — buckle branch `suspenders/W202` @ `471cafd`: 4100 is
  allowed ONLY with `BUCKLE_ALLOW_4100=1` in the serving env (the live
  label carries it; every other source still refuses). 206/206 tests green,
  qlty clean.
- **Final bench capture** (row 7): n=600 at 2026-10-02 14:37,
  `buckle/.worktrees/W202/shadow/final-bench-w202.jsonl` — all four gate
  scenarios pass (p50 0.085–0.374 ms, p95 0.297–0.935 ms), byte identity
  100%, LiteLLM baseline honestly `available=false` (the :4100 openai
  route was still 500ing pre-swap).
- **Ops staged** in `buckle/.worktrees/W202/ops/`:
  `com.klh.buckle.gateway.plist` (port 4100, `BUCKLE_ALLOW_4100=1`,
  `BUCKLE_AUTH=off` for belt-posture continuity — any posture upgrade is a
  separate owner decision, W188/W191 are on the graph) and
  `buckle-live-upstreams.yaml` (operator override: the Claude Code ids ride
  the :4000 local shim; the committed pool keeps its env-gated dormant
  anthropic rows from W206).
- Runbook rows 5–7 closed on the evidence (buckle
  `docs/cut-over-runbook.md` on branch `suspenders/W202`), plus a
  cut-over-state section pointing at this record.

## The swap (one approval away)

    launchctl bootout gui/501/com.belt.gateway
    launchctl bootstrap gui/501 \
      /Volumes/Sensitive/github/klh/buckle/.worktrees/W202/ops/com.klh.buckle.gateway.plist
    # verify: GET :4100/status → service=buckle, then a claude -p smoke
    #   ANTHROPIC_BASE_URL=http://127.0.0.1:4100 claude -p --model claude-haiku-4-5 \
    #   "Reply with exactly: w144-e2e-ok"

Rollback = reverse swap on ANY failed check (bootout the buckle label,
re-bootstrap com.belt.gateway); client config never changed. Belt stays
installed as fallback, never deleted. Post-verify: monitor window, belt.env
stub comment, work done + finding fact.

## Execution-block detail

The lane attempted the bootout three ways (direct, post-NEED_DECISION
re-check, alternative-interface hunt — belt dashboard is read-only, belt
repo ships no label-swap CLI, no sanctioned suspenders helper). All three
hit the lane's permission wall; no fleet path grants launchctl to a lane.
The window risk: the next fan-out wave re-opens the board; the capsule at
@autow202 carries the exact resume steps.

## Outcome (verified 2026-10-07, W413)

The scripted swap never ran. The plan was superseded by a different
deployment, not completed:

- **:4100 is still LiteLLM.** The `com.belt.gateway` plist is a LiteLLM
  wrapper (`belt/bin/gateway.ts` execs `litellm --config
~/.claude/local-llm/litellm.yaml --port 4100`), so the FastAPI-shaped
  responses on :4100 (`{"detail":"Not Found"}` on /status, Swagger UI on /,
  litellm `auth_error` on /v1/messages) come from LiteLLM itself — not belt
  and not buckle.
- **Buckle's guard inverted.** Current buckle `src/server.ts` hard-codes
  `SHADOW_PORT = 4101` and `FORBIDDEN_PORT = 4100`: buckle now REFUSES
  :4100 from any source by design — the W202 "4100 allowed with
  `BUCKLE_ALLOW_4100=1`" lift is gone from main. Buckle's live address is
  :4101, permanently.
- **The real cut-over: buckle-spoke on :4101.** The
  `com.suspenders.buckle-spoke` plist (installed 2026-10-07, KeepAlive)
  serves buckle on :4101. Verified live: `GET :4101/status` →
  `{"service":"buckle","healthy":true}`, 1550 requests banked, heavy
  per-lane `/w/<sid>/v1/messages` traffic.
- Net posture (matches the stack CLAUDE.md ports list): belt gateway :4000
  · LiteLLM :4100 · buckle spoke :4101. Agent configs pointing at :4100
  still hit LiteLLM; lanes ride buckle via the :4101 front
  (`/w/<sid>/v1/messages`).

The one-approval-away swap section above is retained verbatim as the
historical record; do not execute it — :4100 stays LiteLLM unless the owner
re-opens the port question as a new decision.
