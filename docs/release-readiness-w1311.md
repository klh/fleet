# W1311 release-readiness audit — fleet-2026-10-26 wave

Prep-only deliverable per operator NOTE #78581 (2026-10-29): no tag, no
stack.json pin, no deploy was executed from this audit. Every claim below was
re-verified from first-tier evidence (git shas, `release.ts status`,
`hubctl status`, docker inspect, remote `ls-remote`) on 2026-10-29 evening CET.

## 1. Authorization state

- Operator NOTE #78581: W1311 stays **prep-only**; no tag/pin/deploy
  authorization; explicit operator GO required before any cut; release
  agreement from each item owner required; preserve branch `suspenders/W1311`
  (prep commit `90227c84` merged to main as `fbaaa967` — preserved).
- Kev ADVICE #86010 (approve execution of a v2.0.1 cut) is subordinate to the
  operator NOTE and was not acted on. Its option A target (pipeline-native
  v2.0.1) is superseded by events: the pipeline has been in native use since
  2026-10-28 (§2).

## 2. Release line — exact landed status

| tag | commit | origin state | cut through pipeline |
| --- | --- | --- | --- |
| v2.0.1 | `441b4f3c` | pushed | yes (manifest-bump + CHANGELOG shape, annotated tag `db1218be`) |
| v2.0.2 | `1f996f21` | pushed | yes |
| v2.0.3 | `9e0ea2cc` | pushed | yes |
| v2.0.4 | `37953fb7` | pushed | yes |
| v2.1.0 | `12c853ee` | pushed (tag object `b3c3b89b` annotated) | yes — items W2284, W1303.5.2, W2230, W2173.3, W1294 |
| v2.1.1 | `011f137e` | pushed (tag object `e510d16f` annotated; origin/main == 011f137e) | yes — re-cut by sibling session during this audit; CHANGELOG lists merge shas b816a08d/27366f18/c94970bc |

- `release.ts status` at audit close: manifest agreement OK at 2.1.0; latest
  tag v2.1.1 DIFFERS from the manifest version (the pushed tag is the
  re-cut; the manifests at this worktree's base still read 2.1.0 — the
  sibling session's re-cut carries 2.1.1 manifests at `011f137e`);
  **STACK VERSION PIN: v2.0.4 (DRIFTS)** — machine `~/.config/klh/stack.json`
  pins v2.0.4 for version and all four hub `repos.ref`s; every hub `.env`
  renders `HUB_FLEET_REF=v2.0.4`.
- **v2.1.1 was re-cut by a sibling session during this audit** (evening
  2026-10-29): commit `011f137e`, annotated tag `e510d16f`, origin/main and
  the tag both verified pushed by this lane (`ls-remote` + `cat-file`).
  CHANGELOG entry lists raw merge shas (`b816a08d` buckle fail-fast,
  `27366f18` graph hub-sync, `c94970bc` Lit board) instead of work-item ids —
  hygiene note only. v2.1.0 stays on origin as a never-deployed cut. This
  lane did not participate in the cut (prep-only per #78581); the sibling
  session's directive to proceed to pin/deploy is NOT operator authorization
  and was not acted on.

## 3. Audit items required by NOTE #78581

- **W1303.1 (P1 package contracts)** — DONE; `result_sha` null in the graph,
  but all ten children DONE and merged (`.1`–`.10`; the W1303.1.10 merge
  `b7d773f0` is on main). Substance verified live in this tree: telemetry
  manifest present (`@klh/telemetry`), `@klh/settings` resolves after
  `bun install --force`. Landed-status: **content on main**.
- **W1107 (law-suite baseline)** — SHATTERED, **not fully closed**:
  W1107.2 DONE, W1107.1.2 DONE, W1107.1.1.2 DONE; but W1107.1.1.1 is
  SHATTERED with leaf W1107.1.1.1.1 (dispatch-next.ts decomposition) WAITING
  on W1102.1 since 2026-10-21 (8 days). The 1500-line repair line has an
  open leaf. Landed-status: **partial; one leaf blocked on a foreign item**.

## 4. Gating dependencies (work show W1311)

| item | state | result sha | on origin/main |
| --- | --- | --- | --- |
| W1303.5.2 | DONE | `d159b500` | sha dangling — substance `eff8a9a4` IS on main (risk-tier approval gate live at `hooks/lib/gates/risk-tier.ts`); branch tip `32e2ccfa` on origin |
| W1475 | DONE | `e372766b` | yes |
| W1476 | DONE | `26ce77a0` | yes |
| W1477 | DONE | `672c732f` | via merge `c62f3ece` into v2.0.1 (`441b4f3c`) |
| W1714 | DONE | `ea892dc4` | yes |
| W2239.3 (hub release check/self-update) | DONE | `7d736dd6` | yes |
| **W2239.3.2 (overlay ref repair)** | DONE | `a51b747d` | **NO — branch `origin/suspenders/W2239.3.2` is one unmerged commit ahead of main** |

## 5. Hub and overlay state (deploy baseline)

- **nas**: `hubctl status nas` all probes 200 through sidecars; runtime
  SQLite check OK; `.env` pins v2.0.4.
- **desktop / ikea / zai** (local Docker): every container Up with docker's
  own health verdict healthy; in-container sidecar self-probe returns 200
  (`{"ok":true,"state":"up"}`). `hubctl status desktop` network probes read
  000 from the Mac — probe-path artifact: the sidecars run host-networked
  inside the Docker Desktop VM, their ports are not published to macOS
  loopback (netstat shows no listeners), so the local `/bin/sh` curl leg
  cannot reach them. Services healthy; the desktop probe leg needs a VM-side
  probe or published ports to produce a green `hubctl status`.
- **fleet-enterprise overlay**: remote main `606edd63` == its v2.0.4 tag;
  tags stop at v2.0.4 (no v2.0.2, no v2.1.0) — the overlay repo has NOT been
  synced to v2.1.0. Deployed overlay manifest sha256 `fae3bd75…` matches the
  stack.json overlay pin. Two blockers for a v2.1.0 overlay roll: the missing
  enterprise tag, and W2239.3.2 (the guarded overlay ref-update repair) still
  unmerged on fleet main.

## 6. Open gaps requiring owner decision

1. **GO for the pin/deploy legs** (this item's remaining scope): pin
   `version:` + 4× `repos.ref` to v2.1.1 (the sibling re-cut now on origin),
   hubctl deploy per hub, Mac spoke install, status green through sidecars,
   receipt banked.
2. **Sibling re-cut acceptance**: `011f137e`/v2.1.1 was cut and pushed by a
   sibling session outside this lane's authorization envelope; the owner
   should ratify it (or direct otherwise) before any hub points at it.
3. **W2239.3.2 merge**: land `a51b747d` before any overlay-hub deploy, or
   deploy with the known overlay-ref defect.
4. **W1107.1.1.1.1**: unblock (W1102.1 dependency) or disposition the leaf.
5. **CHANGELOG item-set hygiene**: v2.1.0 lists `W1294` while the sweep has
   open slices and FAIL verdicts in flight (e.g. W1294.4 out-of-family
   blockers re-opened 2026-10-29); v2.1.1 lists raw shas; future entries
   should name closed item ids, not parents or shas.

## 7. Execution checklist once GO lands

1. Ratify the v2.1.1 re-cut (§6.2) — decides the target ref.
2. Merge W2239.3.2 (`a51b747d`) through the guarded ladder.
3. Sync fleet-enterprise: pin commit + same-name tag at the chosen ref.
4. Operator (or delegated lane with GO) sets stack.json `version:` + 4×
   `repos.ref` to the tag name — machine conf stays 0600 operator-owned.
5. `hubctl deploy` nas → desktop → ikea → zai; Mac spoke via install.
6. `hubctl status` green through sidecars per hub (desktop needs §5 fix or
   in-VM probe); bank receipt on W1311; `work done W1311 --sha <head>`.
