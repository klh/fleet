# REVIEW.md — belt (dashboard/gateway)

What failure looks like here: **the dashboard lies or dies.** A board that
renders stale governor.db state as live, a metric that silently reads 0 on
error, a Lit component that swallows a handler failure into `this.err` —
each turns the fleet's one visibility surface into fiction. Second failure
mode: UI law breaks (`innerHTML`, string-chunk DOM) reintroduced through a
"small port".

Paths to skip on routine review: `bench/arena/` byte-sealed task trees
(hashes pinned in MANIFEST.json), vendored bundles, `docs/`.

High-risk paths (tier high, 2 humans): router-shim `:4000` request routing,
`bin/cloud-gateway.ts`, anything touching key resolution or the escalate
env. Board HTML is medium-tier product — but `innerHTML` there is a
blocker regardless of tier.

Nit cap: **3 per review.** Style past that goes to biome, not the thread.

Evidence is **file:line against the candidate tree** — never "looked fine."
GUI changes verify against the LIVE surface (headless render, real data);
cite the observed output, not the code path alone.
