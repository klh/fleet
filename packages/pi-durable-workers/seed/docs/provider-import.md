# Provider-native import of the Pi Durable seed (W2958)

The seed build (`bun run seed:build` from `packages/pi-durable-workers`)
produces exactly one artifact pair from ONE manifest — `seed/manifest.json`:

1. **OCI baseline** — `klh/pi-durable-seed:<version>`, digest-pinned in the
   manifest as `runtime_image` (`name@sha256:<64hex>`). The runner references
   the image in exactly this form (the same lookup `checkDesktopImage`
   performs at preflight), so the pin in the manifest is the pin the host
   resolves — no translation layer.
2. **Provider-native import** — documented here; the same manifest drives it.

## What the manifest binds

- `base_image` — the exact oven/bun digest the runner prereqs pin; one base
  for host preflight and seed build, drift impossible.
- `seed.digest` — canonical sha256 over the staged payload file set
  (path-sorted `{path, sha256}` canonical JSON). The runner host recomputes
  this algorithm at admit (`desktop/seed.ts`) and refuses drift.
- `policy.digest` — canonical sha256 over the executor limits JSON in the
  executor's key order (`canonicalPolicyDigest`). `start` refuses a spec
  stamped with a different digest.
- `sbom` — per-file sha256 + size for every staged file (including the
  minimal vendored `@klh/buckle` log face); `deps` records resolved dep
  versions.
- `source.revision` + `dirty` — the git revision the payload was built from.

## Docker-native runners (Docker Desktop, Linux hosts)

No import needed — the image is already in the local daemon store after the
build. For a DIFFERENT host:

```sh
docker save klh/pi-durable-seed:<version> -o pi-durable-seed.oci.tar
# on the target host:
docker load -i pi-durable-seed.oci.tar
```

`docker save` emits an OCI-layout archive; `manifest.json` travels WITH it
(same commit, same digests). After `load`, verify the digest pin still
resolves:

```sh
docker image inspect --format '{{.Id}}' klh/pi-durable-seed@sha256:<digest>
```

## OCI-native runtimes (podman, containerd, nerdctl)

The saved archive imports directly:

```sh
# containerd / nerdctl
ctr images import pi-durable-seed.oci.tar
# podman
podman load -i pi-durable-seed.oci.tar
```

Run the container under the SAME contract the fleet executor imposes —
read-only rootfs, dropped caps, no-new-privileges, unprivileged uid pair,
network none, tmpfs `/tmp` + `/workspace`, seed bundle read-only at `/seed`
(see `seed/payload/Dockerfile` header and the executor
`lib/runners/desktop/docker-executor.ts`). Any runtime that cannot express
this contract is not a carrier for the seed.

## Bootable-disk route (microVM backend, W2959+)

The same OCI image converts to a bootable rootfs without changing the
payload — unpack the image's rootfs into an ext4 image and boot it with a
VM that mounts the same three surfaces (ro rootfs, tmpfs, seed volume):

```sh
docker create --name seed-rootfs klh/pi-durable-seed:<version>
docker export seed-rootfs | tar -C <staging-dir> -xf -   # rootfs tree
docker rm seed-rootfs
# then mkfs.ext4 the tree into seed.ext4 (or build a FAT+EXT pair for
# Firecracker/cloud-hypervisor with a Linux kernel pin) and boot with:
#   - root fs mounted READ-ONLY (ro rootfs is part of the policy digest)
#   - a writable tmpfs at /tmp and /workspace (the per-run overlay)
#   - the seed bundle volume mounted read-only at /seed
```

The manifest's `seed.digest` and `policy.digest` bind UNCHANGED — the disk
image is the same payload bytes; a provider that hashes the disk records the
disk digest alongside the manifest (an extension field, never a replacement).

## Azure/provider-hosted import (Phase 1 prerequisite)

W2958 explicitly does NOT write to any cloud. When the Phase 1 APIM/Buckle
inference path is verified (W2937 evidence, W2783 owner gate), the import is
provider-native: push the OCI image to the provider's registry from the
machine that holds `manifest.json`, then reference the pushed digest in the
provider's runner profile. The pin remains `name@sha256:<digest>` — registry
push does not change the image config digest.

## Arch note for the W2960 matched comparison

The seed is built for `linux/amd64` (W2958 requirement). On Apple Silicon,
Docker Desktop runs amd64 under Rosetta — measured readiness timings are
emulation-affected. For a matched comparison, build BOTH arms for the SAME
architecture and record both digests; the OpenHands arm pins exist per-arch
in W2960 (`f5495beb…` arm64 smoke, `ec7ed86f…` amd64).
