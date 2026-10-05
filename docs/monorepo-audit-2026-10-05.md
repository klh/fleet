# Monorepo setup audit — W422.12 (2026-10-05, read-only)

Owner standard: "enterprise class, no hacky stuff". Verdict: 2 P0, 5 P1,
6 P2. Full evidence with file:line in the work-graph item; this doc is the
durable summary. Hardening items minted as W422.13–.17 + W422-CI.

## P0 — enterprise-blocking

1. **Dead CI at the root.** Workflows exist only at
   `packages/suspenders/.github/workflows/` + `packages/speedy/.github/` —
   GitHub Actions reads workflows ONLY from the repo-root `.github/`, so
   zero CI runs on the monorepo. The suspenders ci.yml is genuinely good
   (installer round-trip, idempotency, 12-entrypoint parse-check) — and dead.
2. **Installed harness cannot resolve the blam import.** install.sh copies
   only suspenders subdirs (install.sh:49-52); the W367.2/.4 board imports
   (`../../../blam/src/condense/tiers.ts`) resolve in-repo but NOT in the
   installed prefix (`~/.claude/hooks/blam` absent) — board condense is
   silently broken at runtime there. Same class already bit once
   (W183.1/W300 local-llm sibling patch, install.sh:45-48).

## P1

3. **Workspace split-brain.** Root package.json declares
   `workspaces: ["packages/*"]` but local/, speedy/, local-llm/ have no
   package.json; no root bun.lock while buckle+suspenders carry their own;
   only buckle has a tsconfig — cross-package relative imports are the only
   mechanism (4 production/dev lines enumerated; no cycles).
4. **hub-compose defaults point at ARCHIVED push-dead repos**
   (hub-compose.yaml:107/37/205 `github.com/klh/{suspenders,buckle,belt}.git`);
   a profile without `repos:` silently deploys dead code.
5. **Tracked runtime state.** packages/local/.fleet/{lanes.json,brief-autow1.md}
   - packages/speedy/.workgraph.jsonl are in the index while .gitignore
     covers exactly those paths. (.gitleaksignore: 594 rows, ~justified, but
     append-only per-sha duplication = bloat.)
6. **Docs drift ×5.** AGENTS.md vs CLAUDE.md diff lines: speedy 669,
   suspenders 123, belt 79, blam 70, local 56; buckle has no AGENTS.md,
   root has none. The heartbeat.ts-class drift exists 5 more times.
7. **Versioning gap.** Zero git tags, zero CHANGELOGs; version drift
   (root 2.0.0 vs packages 0.1.0–1.0.0); engines floors inconsistent;
   buckle package.json lacks a license field despite its LICENSE file.

## P2

8. Machine-state leaks: belt/bin/gateway.ts:11 `HOME ?? "/Users/kk"`;
   suspenders/spikes/w86 has real LAN IPs (192.168.1.73, nas.threads.dk).
9. Stale dirs: suspenders examples/ (near-dead), pages/ (8 files linking
   the archived suspenders repo), spikes/ w86.
10. Test layout: KOSHER — the scratch-port lesson is applied and documented;
    watch item only (hub-locate.test.ts binds a real scratch serve).

## Hardening items minted

- W422-CI (P0): root .github/workflows over packages/* — matrix test +
  parse-check + installer round-trip.
- W422.13 (P0): install.sh ships blam alongside local-llm (AFTER W422.4's
  install.sh edit lands — same file).
- W422.5 (P1): real workspace wiring — manifests for local/speedy/local-llm,
  one root lockfile, path aliases replacing relative imports.
- W422.14 (P1): hub-compose default repo URLs → fleet; fail-loud on missing
  profile repos.
- W422.15 (P1): single-source package docs + CI drift guard.
