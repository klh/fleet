# REVIEW.md — suspenders (control plane)

What failure looks like here: **it stops enforcing.** A gate that silently
no-ops (missing `.qlty/`, an escaped env knob, a swallowed catch) is worse
than a crash — the fleet keeps landing with the referee asleep. Second
failure mode: the work graph lies (claim/lease/sha mismatches merge the
wrong thing or strand lanes).

Paths to skip on routine review: `docs/` (decision records — check the
decision, not the prose), generated board bundles, vendored snapshots.

High-risk paths (tier high, 2 humans): `hooks/gates/`, `hooks/lib/scrub*.ts`,
`deploy/`, `install.sh`, `.githooks/`, `tests/law-guards.test.ts`, anything
that writes governor.db schema or spawns lanes with keys.

Nit cap: **3 per review.** Past that, fix the class (an AGENTS.md line, a
biome rule, a gate), not the instance.

Evidence is **file:line against the candidate tree** — never "looked fine."
For gate changes, cite the test that fails without the change (coverage
proof); for deferrals, the loop.log line.
