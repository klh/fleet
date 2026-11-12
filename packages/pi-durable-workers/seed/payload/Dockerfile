# seed/payload/Dockerfile — W2958: the reproducible Pi Durable seed image.
# Build context = a STAGED payload dir (seed/build.ts stages it): package
# manifest + lockfile + src/ + seed/ + vendor/@klh/buckle minimal face.
# The image carries NO credentials, NO transcripts, NO repo checkout and
# NO git history — only the pinned runtime and its declared dependencies.
#
# Base pin: the exact oven/bun digest the desktop runner prereqs pin
# (hooks/lib/runners/desktop/prereqs.ts DESKTOP_RUNNER_IMAGE). One base
# digest for host preflight and seed build — drift is impossible.
FROM --platform=linux/amd64 oven/bun:1@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895

LABEL org.opencontainers.image.title="klh/pi-durable-seed" \
	org.opencontainers.image.description="Pinned Pi Durable seed runtime for the fleet runner (W2958)" \
	org.opencontainers.image.source="https://github.com/klh/fleet" \
	org.opencontainers.image.vendor="klh"

ENV NODE_ENV=production \
	TMPDIR=/tmp \
	HOME=/tmp

WORKDIR /opt/pi-durable-workers

# Dependency layer: frozen lockfile, production faces only, no lifecycle
# scripts. The vendored @klh/buckle face MUST precede the install — the
# lockfile binds it as a file: dependency. The staged lockfile is
# generated from the payload's exact pins and recorded in the manifest
# SBOM — reproducibility is digest-audited.
COPY package.json bun.lock ./
COPY vendor ./vendor
RUN bun install --production --frozen-lockfile --ignore-scripts

# Required tool: git. The runner seals patch-bearing runs through git
# commits (BLAM fixture contract); the slim base ships none. Installed
# from the base image's own debian release, no recommendations, index
# pruned; the RESOLVED version is recorded in the manifest deps list.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git \
	&& rm -rf /var/lib/apt/lists/*

# Payload: the extension source, the readiness probe, the policy contract.
COPY src ./src
COPY seed/readiness.ts ./seed/readiness.ts
COPY seed/policy.json ./seed/policy.json

# The runner executor passes --user 1000:1000 with read-only rootfs,
# cap-drop ALL, no-new-privileges and network none; the default user
# matches so standalone runs are equally unprivileged. No VOLUME — the
# per-run writable surface is executor tmpfs (/tmp, /workspace) only,
# and the seed bundle mounts read-only at /seed.
USER 1000:1000

CMD ["bun", "run", "seed/readiness.ts"]
