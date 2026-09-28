# local (klh-local)

One command per local service on macOS: Caddy site fragments + mDNS `-P`
claims + registry (bin/klh-local.ts), status GUI at bar.local :7792
(bin/dashboard.ts). Serves suspenders.local and belt.local. Companions:
suspenders (control plane), belt (LLM fleet), speedy-claude (config layer).

## qlty Quality Doctrine

qlty is THE quality tool; `.qlty/` must exist or the governor's on-write
gate silently no-ops. Three moments: (1) on-write — the suspenders post-files
gate runs qlty-fmt + fast lint and blocks with the diff inline; (2) pre-merge
— `qlty fmt` + `qlty check --fix` on staged files; (3) on-stop — the evidence
gate, not lint.

**SPEC FIRST: read `.qlty/qlty.toml` and the biome rule set BEFORE the first
write here, then code to the spec.** Never emit flagged patterns and let the
gate catch them — recurring offenders: non-null `!` (noNonNullAssertion),
string `+ "\n"` concat (useTemplate), comma operator, unused vars/imports,
use-before-declaration. biome owns code formatting; prettier owns markdown
only — never enable both on code (they deadlock).
