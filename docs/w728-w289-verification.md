# W728 — W289 re-mint verification record

The item asked for three gaps "verified still open 2026-10-12 on f2f5602a".
All three landed before this lane ran, in commit 4206ca1f (2026-10-15):

1. **parseDirect object shape** — `directBaseOf`
   (packages/belt/bin/router-policy.ts) accepts the emitted
   `{alias: {url: ...}}` rows from `EMITTERS.direct()` beside the legacy
   `alias: <url>` strings; non-loopback rows throw in both shapes.
2. **RegistryEntry operational fields** — `healthPath` / `launchdLabel` /
   `logPath` on every row (packages/belt/bin/registry.ts); specialists carry
   `/v1/models` + the swarm launchd label + `SWARM_LOG`, kev carries
   `/health` + `com.belt.kev`, `probePathFor` rides `healthPath`.
3. **dashboard /registry.json** — dashboard.ts serves the same
   `registryResponse(req)` body (200 + ETag, 304 on if-none-match) as the
   router shim.

Verified on branch head: `bun test test/w289-registry-one-source.test.ts`
in packages/belt → **10 pass / 0 fail** (35 expect calls). The suite is the
landing evidence; no product code changed here.
