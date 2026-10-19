# Single-request governed demo take — W552.6 record

One user request now carries both the work ask and the explicit health
approval. The coordinator consults shared knowledge, records the approval
through the existing shared decision API as soon as the owned policy
decision exists, and dispatches governed lanes without a second prompt —
no later human interaction is simulated.

## Contract

- **Upfront approval**: the request text itself approves /health, /status
  and the outside-process reporter. The mother records it once (exactly
  one `answer-policy.ts --yes` call → HTTP 200 receipt →
  `approval-receipt.json` in the take dir).
- **Shared knowledge first**: the request directs
  `coord consult --best` over fleet facts; no expert or verified answer →
  use the pinned policy directly, never invent a reply.
- **Governed delegation**: two work items with disjoint ownership —
  implementation (server.ts, server.test.ts, health-reporter.json) and
  docs (README.md) — minted with durable mother provenance (`--by`), both
  dispatched through the installed `dispatch` CLI.
- **Honest evidence**: real tools, real tests, real commits integrated in
  the fixture; outside-process up/down proof via `verify-runtime.ts`;
  event-led silent capture through the existing caption exporter path.

## Kit surface (private, `.fleet/demos/ikea-recording/`)

- `live-kit.ts` modes: `prepare` → `policy-bridge` (loopback 8878) →
  `check-one-request` (prints the exact request text) →
  `terminal-one-request` (the demo run).
- Preflight validates 0600 settings, governed buckle route
  (`/w/<sid>`), and the pinned NAS policy manifest sha before any run.
- Fresh take lineage: `take-7-single`. Takes 1–6 remain preserved
  evidence for the two-prompt flow.

## Constraints discovered

- Answer/advise legs routed through the governed gateway need ≥500-token
  budgets: small `max_tokens` burns on thinking and returns empty content
  (W552.6.1 finding, repaired by validating final text instead of storing
  placeholders).
- The fresh policy manifest fetch needs the NAS route
  (`nas.threads.dk:22`); when down, `prepare` cannot complete — the take
  stays staged and the run is deferred, never faked with a stale pin.

## Status 2026-10-19

`take-7-single` prepared and preflight green. NAS route restored; the
fresh manifest fetch returned sha256 `35bcd840…` — the exact pinned pin,
so no stale pin was needed. Headless lane staged the kit in /tmp (absolute
lane-auth import), ran `prepare`, and re-pointed the baked staging paths
(`repo-policy.json` keyFile, `readiness.json` fixture,
`mother-settings.json` `SUSPENDERS_REPO_POLICY_CONFIG`) to the real take
dir before syncing it into `.fleet/demos/ikea-recording/take-7-single/`.

Preflight evidence (2026-10-19): `check-one-request` exits 0 with the
governed sid `2b2c803c…`, project scoped to the take fixture, request
text 1505 chars, `launchesClaude: false`; a policy-bridge smoke instance
served the pinned manifest on loopback 8878 (sha match) and was stopped —
the owner starts the long-running bridge for the run. The take is
runnable: owner opens a clean terminal and pastes the `check-one-request`
request ONCE (`terminal-one-request`).
