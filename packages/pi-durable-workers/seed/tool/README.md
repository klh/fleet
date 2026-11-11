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

The base and direct utilities are pinned; transitive Debian packages resolve
from live repositories. Record dpkg inventory and layer evidence for the actual
published digest; this recipe alone does not establish byte-for-byte rebuilds.
