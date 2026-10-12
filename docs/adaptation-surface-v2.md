# Adaptation surface v2 (W235) — the seams per finding.w233-adaptation-review

2026-10-11, lane autow235-p98b319584008df14, branch `suspenders/W235`.

The post-model-review law: in-process seams do not enforce security —
auth lives at the proxy (signed identity), residency at locked core
rules, overlays behind allowlist + digest + handshake. Five units landed
on `packages/buckle` (+ one Caddy fragment line):

## The five seams

1. **Typed hook points** — `src/gov/adaptation.ts`: FOUR hooks
   (authenticate / authorize / audit / budget), not generic middleware.
   SSO resolves identity ONLY on a missing credential (presented-but-invalid
   stays 401 — W173 never-downgrade law); scopes come ONLY from the
   role→scope map pinned at registration (validated against ALL_SCOPES);
   authorize/budget hooks may only DENY after the core checks; the audit
   tap adds to the denied-audits-too stream; registration after core auth,
   malformed surfaces throw at boot.
2. **Locked residency floors** — `src/gov/residency.ts`:
   `RESIDENCY_FLOOR` compiled into core (the loosest legal posture; no
   env/layer can loosen — a loosening throws at boot). Tighten-only
   resolution (env `BUCKLE_RESIDENCY_{REGIONS,LOCALITY,TELEMETRY}`,
   overlay inputs); group tags carry `region:`/`locality:` claims;
   enforcement is structural (candidate-table rows outside the resolved
   policy never become healthy — the flashx data-absence precedent);
   telemetry egress defaults OFF.
3. **Signed identity headers** — `src/gov/identity-headers.ts`: SSO
   happens at the Caddy proxy; buckle trusts only SIGNED identity
   (`X-KLH-Identity` + `X-KLH-Identity-Sig`, buckle-sso-v1 HMAC,
   constant-time compare, replay window ± skew, strict claims shape).
   Reference signer + ready-made authenticate hook exported; the
   enterprise overlay owns the real SSO service. `packages/local`
   fragments copy the signed pair next to Remote-* (klh-local
   exposureLines).
4. **Signed/allowlisted overlay loading** — `src/gov/overlay-loader.ts`:
   `KLH_OVERLAY_DIR` must sit under an allow-listed root (symlink-
   resolved; `/etc/klh/overlays` + `/usr/local/lib/klh/overlays` default,
   `KLH_OVERLAY_ALLOW` extends), strict manifest, entry sha256
   refuse-on-mismatch, operator pin `KLH_OVERLAY_SHA256`, protocol
   handshake against `OVERLAY_PROTOCOL_VERSION` (fail-closed),
   log-at-startup; `boot()` loads the overlay BEFORE startServer —
   refusal is fatal, unset = solo. Overlay-declared endpoints pass
   `BUCKLE_EGRESS_ALLOW` (§5) at load. CI fixture overlay
   (`test/fixtures/overlay/`) proves the full path in CI.
5. **Peer/overlay endpoint egress law** — `src/adapters/egress.ts`:
   `validatePeerEndpoint` — https-only (loopback http), no credentials,
   host in `BUCKLE_EGRESS_ALLOW`, checked at overlay load.

## Verify

- `cd packages/buckle && bun test` — 496/0 (includes the five new suites:
  gov-adaptation 13, gov-residency 7, gov-overlay-loader 7, gov-identity-headers 5).
- `bun test packages/local/bin/klh-local.test.ts` — 22/0 (signed copy_headers fragment).

## Not in this scope (explicit deltas)

- Belt `registry.d` peer-file schema validation: no registry.d consumer
  exists in belt today (grep-verified); the buckle-side peer egress law
  covers the dropped-peer-file exfiltration vector at the overlay seam.
  If belt peers grow a loader, the same `validatePeerEndpoint` law
  applies there.
- Tamper-evident append-only audit stream: LANDED W703 — `auth_events`
  carries `prev_hash`/`row_hash` (sha256 chain, `packages/buckle/src/gov/audit-chain.ts`);
  verify verb `GET /v1/admin/audit/verify[?head=<hex>]` (edit/remove/reorder
  detected; a removed TAIL needs the pinned head). Retention-compatible (W174
  archive-before-delete): a pruned prefix re-anchors, reported `anchored`.
  `route_audit` (mutable by design: outcome UPDATEs) is not chained. Telemetry
  enablement knobs: still follow-up work.
- Docker e2e overlay-ON/solo validation: the W234-docker item's job.
