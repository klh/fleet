# Experimental Buckle service seed

Fleet produces `ghcr.io/klh/fleet/buckle-seed`; deployment repositories derive
their own images from its immutable digest. `ServiceSeedDescriptorV1Schema`
in seed-contract.ts is the versioned handoff: family=service, service=buckle,
producer/build metadata, separate runtime source and recipe commits, published
architectures, and separately observed runtime smoke platforms.

The pinned Bun 1.4.4-slim base supports amd64 and arm64. The builder stages a
git archive of the exact source commit and reads recipe blobs by recipe commit.
Untracked data and .git never enter the context. Source/dependencies stay in the
build stage; the final stage copies only audited runtime bundles, an empty
upstream base, license notices and runtime-closure.json. Bench/judge/eval/test
inputs are rejected by the bundle audit. No deployment routes, keys, journals
or operator files are baked. Source mutation after staging cannot change bytes.

Preserved entry paths:

- `/fleet/packages/buckle/src/server.ts` (default entrypoint)
- `/fleet/packages/suspenders/deploy/healthcheck/probe.ts` (override entrypoint
  to `bun` for one-shot or `--listen` sidecar use)

Supply operator policy/upstreams/prefs/account policy through read-only mounts
and their existing BUCKLE_* environment contracts. Mint credentials outside the
image; pass them through a private runtime env file. Keep `/data` writable for
SQLite and `/tmp` writable for ephemeral state, with read-only root and UID1000.
Public status is not authenticated inference. Missing credentials leave the
governance gate enabled and protected requests denied; disabling governance on
a non-loopback bind is refused. The baked upstream base has zero model groups,
so it advertises no model and cannot perform successful inference without rows.

This is basic packaged service compatibility, not proof of every optional
feature. Operator configs, enterprise overlays and bin/operations CLIs are not
included. Full Fleet/third-party license notices are retained under `/fleet`.
Private publication grants no additional license rights. Stable release/tag
integration and deployment acceptance are separate from this experiment.

From the repository root, after committing the recipe:

```
bun packages/buckle/deploy/build.ts --source f12f82bd8523dd4701c53d5335d154d651e56601 --version 0.1.0-experimental.w2989 --mode build
bun --bun playwright test --config packages/buckle/deploy/playwright.config.ts --project=unit
bun --bun playwright test --config packages/buckle/deploy/playwright.config.ts --project=container
```

Container tests use isolated synthetic upstreams and minted temporary secrets,
fresh tmpfs SQLite, exact endpoint allowlists and both platform variants.
`BUCKLE_SEED_TEST_IMAGE` selects the published digest; `BUCKLE_SEED_TEST_PLATFORM`
can select one platform. Tests cover catalog/authentication, zero-egress denial,
incremental SSE with terminal usage, UID1000/fresh database, one-shot and
listening health-probe modes, neutral/no-fallback behavior and unkeyed denial.
Bridge aliases classify as cloud in current Buckle, so only this isolated
fixture uses allow_cloud:true with a fixed provider/group allowlist and local
residency claim. Production preferences are not changed.

`--mode publish` requires the GH API to confirm private visibility and klh/fleet
linkage before pushing; it requests BuildKit SBOM and maximum provenance.
Verify the actual published index, per-platform attestations and digest-pinned
runtime checks before marking those descriptor evidence fields verified.
Earlier negative observations are retained in negative-history.json.

Published experiment: [service descriptor](releases/0.1.0-experimental.w2989.json)
and [verification receipt](releases/0.1.0-experimental.w2989.receipt.json).
The immutable index contains amd64 and arm64 manifests with linked SBOM and
provenance attestations; both published platform variants passed the packaged
API/control tests. The receipt records synthetic upstreams and Docker-host
context, not native amd64 hardware or full production feature acceptance.
Recording these receipts does not rebuild the image or move its published tag.
