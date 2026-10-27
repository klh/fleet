# Disposition — W1107.1.1.1.2 branch (decant ingest.ts decomposition)

Deleted 2026-10-24 per restructure-proposal-2026-10-23.md Amendment B (C83
adjudication, adopted): the decant upstream tree stays pristine — any future
rebase requires a pinned upstream SHA + patch inventory + conformance tests
BEFORE the rebase. Branch W1107.1.1.1.2 rewrote upstream-owned bytes with no
owner amendment to `packages/decant/FLEET.md`, so the disposition is DELETE.

## The law it violated

`packages/decant/FLEET.md` ("The seam"): `src/ingest.ts` stays BYTE-PURE;
fleet changes live in `fleet/` only; upstream files carry W950 seam edits in
exactly three CLI/watch boundary files. The branch instead split
`src/ingest.ts` (1981 lines on main) into new `src/` files — a rewrite of
upstream-owned bytes. The branch changed no FLEET.md, and no owner amendment
exists on main.

## Patch inventory (recorded BEFORE deletion)

Branch `suspenders/W1107.1.1.1.2`, tip `86e195e995d76c79fc82185f6b524e1fdace8d97`
(work-graph result_sha of the closed item W1107.1.1.1.2), never pushed to
origin (ls-remote: absent), never merged to main. Base:
`95e83862530cca080e709c214a339e8868d14175` (merge-base with main at deletion).
Two commits:

- `5b11bf31653abc941795c232c68dc5e6ae85b9b6` — checkpoint decant ingest.ts
  decomposition (985+480+530+6 lines)
- `86e195e995d76c79fc82185f6b524e1fdace8d97` — drop ingest.ts import unused
  after the split (biome)

Diff 95e83862..86e195e9 (5 files, +1030/−1010):

| file | delta |
| --- | --- |
| `packages/decant/src/ingest.ts` | 1981 → 984 lines (−1010) |
| `packages/decant/src/ingest-derived.ts` | +480 (new) |
| `packages/decant/src/ingest-write.ts` | +530 (new) |
| `packages/decant/src/ingest-revision.ts` | +6 (new) |
| `packages/decant/fleet/after-sync.ts` | +1 |

Upstream pin unchanged: dosu-ai/decant `v0.11.0`, vendored 2026-10-19 (W950).

## Recovery

The shas above stay valid in this repo's object db while reflogs persist
(git default ~90 days). Snapshot tag `archive/parked/W1107.1.1.1.2` — cut
2026-10-24 (W1272) at the tip before the branch deletion, satisfying the C85
recoverable-snapshot condition (open-handle proof: no worktree on the branch,
absent from origin, the work graph holds result_sha `86e195e9` as a sha, not
a ref) — now pins the tip permanently. Regenerate the patch text:

    git format-patch 95e83862530cca080e709c214a339e8868d14175..archive/parked/W1107.1.1.1.2

If the decomposition is ever wanted, it must be re-landed under the
Amendment B preconditions (pinned upstream SHA + patch inventory +
conformance tests first) or as fleet-layer code in `fleet/` — never as a
rewrite of upstream bytes.
