# W2908 — re-rebase of suspenders/W2843 (W914) onto the current main lineage

Parked/W2843 carried the W914 litellm-ops passthrough over the buckle front
plus the endpoint-registry citizenship evolution. This re-rebase lands it on
ad5ec868 in a /private/tmp worktree (mount-sync-immune tree), then folds the
W2902 fork-exemption stack on top, per the re-rebase queue recipe.

## Merge 1 — parked/W2843

- `src/citizenship.ts` resolved to the UNION: main's hand-declared
  `/v1/workers` row stays ABOVE the branch's W914 registry-derived block —
  main serves `/v1/workers`, but this lineage's endpoints registry has no row
  for it yet, so the registry path alone would drop it from Allow; the hand
  row keeps it correct while the registry catches up (comment in place at the
  seam). The branch's W914 `pending404` helper arrives with it: pending
  registrations 404 honestly instead of advertising methods the head refuses.
- `bun.lock` regenerated lockfile-only after the conflict resolution.
- Chord-fixture gitleaks suppressions re-blocked (below).

## Merge 2 — suspenders/W2902

Fork-exemption stack (FORKS/FORK_TREES, KNOWN_DEAD import-law pin, gitleaks
entries). Verified ancestor: this stack already carries the 008d1a70/W2943
lineage, so no separate stack merge is needed. `.gitleaksignore` resolved to
ours-superset; `bun.lock` regenerated again.

## Gitleaks accommodations

The 8-line chord block (provenance W2902/W2908): one
`packages/chord/test/node/http/upgrades.test.ts:generic-api-key:361` row and
six `packages/chord/test/schema/stored/archive.jsonl` rows. Lines inspected
before suppression: the upgrades row is the RFC 6455 spec's sample
Sec-WebSocket-Key echoed in a handshake test; the archive rows are synthetic
fixture UUIDs under `fixture.switch.owner`. No real key material.

## Test-framework ratchet (W1294)

The branch introduced two new legacy suites (`endpoints.test.ts`,
`litellm-ops.test.ts`), pushing the tracked `*.test.ts` count past the 570
pin. Ported to the tagged convention instead of re-pinning (shrink-only law):
`git mv` to `@unit.e2e.ts`, import swap `bun:test` → `@playwright/test`, and
the `describe(...)` wrappers unwrapped — the bun loader resolves
@playwright/test without a `describe` named export (probed undefined in both
the main checkout and the merge tree; repo convention is top-level `test()`
calls). All 20 endpoint-registry and litellm-ops cases ride green under the
buckle playwright config.

## Proofs

- buckle: citizenship + litellm-ops suites green; the two ported suites green.
- root: law-guards, import-law, knob-registry, test-framework (pin holds at 570) green.
- qlty clean on every touched file; scrub clean.
- Pushed as suspenders/W2908; this record is the closing product tail.
