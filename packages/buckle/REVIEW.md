# REVIEW.md — buckle (LLM gateway)

What failure looks like here: **it leaks, overcharges, or routes wrong.** A
key scope wider than intended, a per-lane mint path that leaves orphans, a
quota wall retried for weeks (`retryDelayS`), a hop that drops a stream
mid-SSE — each is a money or availability incident, not a style issue.
Second failure mode: the auth chain degrades silently (root→admin→`bksk_`
verification falling back to permissive).

Paths to skip on routine review: `src/eval/` harness data, vendored adapters
(changed only when bumping), `docs/`.

High-risk paths (tier high, 2 humans): `src/gov/` (keys, scopes, minting,
admin, middleware), `server.ts` listen/bind, denylist and token surfaces,
any new env that carries a secret. Agent approval never fills a slot here.

Nit cap: **3 per review.** Past that, the class goes to a gate or biome.

Evidence is **file:line against the candidate tree** — never "looked fine."
Wire changes cite the served response (probe the full client shape, not a
partial field); key changes cite the mint/verify/revoke cycle including the
revocation.
