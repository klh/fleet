# W583 — watchdog parity inspects the resolved active generation (2026-10-11)

Mission (from the item): the watchdog's lib-parity check compared the
installed `scripts/lib` unconditionally. On a canonical generation install
the activated `bin/fleet-loop.ts` is a symlink into
`generation/.harness/packages/suspenders/hooks/bin`, whose imports resolve to
the generation's own `scripts/lib` — while the legacy sibling
`<prefix>/scripts/lib` sits unused. Any drift there was reported FAILED even
though the installed payload verified and its syntax build succeeded (false
FAILED, NEED_DECISION noise on a healthy generation).

**Resolution: landed 2026-10-07 as `1bfde4d` ("Check watchdog parity against
active resolved helper generation").** This record is the closure evidence —
the fix merged to main before this lane's dispatch, leaving an empty
baseline→head diff to close against.

Mechanics (`scripts/lib/dispatch-parity.ts`):

- entry = `<prefix>/bin/fleet-loop.ts`; missing entry still refuses parity.
- depths = { legacy `<prefix>/scripts/lib`,
  `resolve(dirname(realpathSync(entry)), "../../scripts/lib")` } — the real
  entry's resolved generation helper dir; canonical installs inspect the
  generation once, never the unused legacy sibling.
- Each repo helper must exist byte-identical in every EXISTING depth:
  stale legacy siblings are ignored, resolved-generation drift is reported.

Coverage (`test/dispatch-parity.test.ts`): canonical generation ignores
unused stale/absent legacy siblings; resolved helpers checked once with real
drift detected (stale bytes + missing); legacy flat installs keep sibling
coverage; missing entry refuses rather than hides dependency loss.

Verify (2026-10-11): `bun test test/dispatch-parity.test.ts
test/watchdog-verdict.test.ts test/watchdog-liveness.test.ts` → 13 pass /
0 fail; `qlty check` on the three files → no issues; live dry-run
`bun packages/suspenders/scripts/dispatch-watchdog.ts --dry-run` →
`lib-parity=ok loop-pid=47597`.
