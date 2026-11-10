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

# Speedy is built into the payload. Debian versions and the upstream
# Amber archive digest are verified at build time.
ADD --checksum=sha256:fcf828a849e601ac20402709ef9f6c4700295a53b6aa90078ff6ca606b27faa9 https://github.com/dalance/amber/releases/download/v0.6.1/amber-v0.6.1-x86_64-lnx.zip /tmp/amber.zip
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		git=1:2.47.3-0+deb13u1 ripgrep=14.1.1-1+b4 fd-find=10.2.0-1+b5 \
		bat=0.25.0-2+b2 sd=1.0.0-3+b6 jq=1.7.1-6+deb13u4 \
		fzf=0.60.3-1+b2 eza=0.21.0-1+b1 unzip=6.0-29+deb13u1 \
	&& unzip -p /tmp/amber.zip ambr > /usr/local/bin/ambr \
	&& chmod 0755 /usr/local/bin/ambr \
	&& ln -s /usr/bin/fdfind /usr/local/bin/fd \
	&& ln -s /usr/bin/batcat /usr/local/bin/bat \
	&& rm -rf /var/lib/apt/lists/* /tmp/amber.zip
ENV PI_DURABLE_SEED_SPEEDY=1

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
