# W2911 — re-rebase of suspenders/W2851 onto the current main lineage

Parked/W2851 (32 commits, 1406 files) carries the chord + pi-durable
vendoring PLUS the fleet-knowledge-vendor layer (`tests/fleet-knowledge-vendor.e2e.ts`),
the p1 pin re-stamp, and the W2844 content as its ancestor. The merge ladder
refused the original branch; this re-rebase lands it on origin/main
64348ea6 in a /private/tmp worktree (mount-sync-immune tree).

## Merges

- **Merge 1 — parked/W2851: CLEAN.** The ladder's merge-tree failure did not
  reproduce against the current main. bun.lock auto-merged (36,623 → 60,151).
- **Merge 2 — suspenders/W2902 (fork-exemption stack): CLEAN.** Zero
  conflicts — the W2851 lineage already carries the citizenship union shape,
  so the buckle conflict from the W2909 case did not recur. Verified: the
  hand row (`/repo-policy/manifest || /v1/workers`) sits at the top of
  allowOf with the registry-derived block below. bun.lock auto-merged
  (60,151 → 67,640).

## Accommodations

- The stack's FORKS carve-out covers chord + pi-durable: the vendored
  `*.test.ts` corpora ride exempt through the W1294 ratchet; count sits
  exactly at the 570 pin (framework guard green).
- W902 wall-clock law: this lineage predates the W2909 panel fix — the
  fleet-authored `pi-extensions/fleet-awareness/panel.ts` still rendered a
  bare `toLocaleTimeString()`. Same dualShort fix applied here (law guards
  green after).
- The buckle W914 endpoint-registry suites do NOT exist in this lineage (its
  own history dropped them) — nothing forced a port and adding them would be
  scope creep; the existing connect-egress-citizenship suite proves the
  touched surface (6 green).

## Proofs

- root: law-guards 14 green; import-law + knob-registry green (combined run
  after the W902 fix); test-framework + import-resolution bun guards green
  at pin; buckle citizenship suite green.
- qlty on-save gates passed on the touched file; scrub clean.
- Record at docs/design/w2911-w2851-re-rebase.md; pushed as suspenders/W2911.
