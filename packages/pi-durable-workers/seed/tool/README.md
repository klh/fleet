# Experimental tool seed

This independent OCI tool family starts from a pinned Bun base, with pinned
Speedy utilities. It carries Bun, not Pi or another AI runtime. The build context
admits only Dockerfile and tools.json. No Fleet source, dependencies, credentials,
model configuration, journals, judges or host sockets enter the context.

Only Bun is a claimed language toolchain. Python, Rust, Go and Node development
profiles require separately tested derived images. This OCI image is not a boot
bundle and provides no KVM or guest boot claim.

At repo root run `bun install --frozen-lockfile --ignore-scripts`. From this
directory run `bun --bun playwright test --config playwright.config.ts`.
Commit source first, then `bun build.ts build 0.1.0-experimental.w2988`.
The builder refuses dirty tool source, labels the exact commit and probes each
tool under read-only rootfs, UID 1000, no network and dropped capabilities.

Publication uses existing Docker authentication: push the version tag, inspect
the actual registry digest, verify package visibility is private and repository
linkage is klh/fleet, pull by digest, and probe that digest again. Never infer
private visibility from authentication alone. ToolDescriptorSchema defines the
Flock handoff. Artifact versions are independent of Fleet's package version.
Experimental publication does not imply source integration or a stable release.

Published version: `0.1.0-experimental.w2988`. Use the immutable image in
`descriptor.json`; its source is commit `17585b556a07befb8b1114d05d78a2c09db92029`.
`publication.json` records the digest-pinned pull, isolated tool/identity probes,
and filename audit of all eleven saved OCI image layers. `packages.tsv` records
the actual Debian inventory. The layer audit checks names, not arbitrary binary
content. The allowlisted build context and pinned clean parent supply the
dependency boundary; no Pi dependency installation runs in any layer.

`registry.json` preserves the initial private package snapshot before linkage.
`registry-linked.json` verifies the package remains private and now links to
`klh/fleet`. Publication and these receipts are experimental; source review
and integration are separate steps. Keep the published version tag unchanged.

The base and direct utilities are pinned; transitive Debian packages resolve
from live repositories. Record dpkg inventory and layer evidence for the actual
published digest; this recipe alone does not establish byte-for-byte rebuilds.
