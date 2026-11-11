# syntax=docker/dockerfile:1.7
FROM docker.io/library/docker:29.9.3-cli@sha256:2357639ad1ea7d0194134bf3292622fd4e562483966ed674e5d7c945b5f3b28d AS docker-cli
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS build
WORKDIR /fleet
COPY source/ ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY recipe/ packages/suspenders/deploy/host/
COPY recipe/probe.ts packages/suspenders/deploy/healthcheck/probe.ts
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
ADD --checksum=sha256:948a5572ecda216e97995657888ba3431a7068c8e1d27a7e7f70683d5b382c33 https://api.github.com/repos/docker/cli/tarball/v29.9.3 /tmp/docker-cli-source.tar.gz
RUN mkdir /docker-cli-source && tar -xzf /tmp/docker-cli-source.tar.gz -C /docker-cli-source --strip-components=1
RUN bun packages/suspenders/deploy/host/bundle.ts

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
ARG SOURCE_COMMIT
ARG RECIPE_COMMIT
ARG VERSION
LABEL org.opencontainers.image.source="https://github.com/klh/fleet" \
      org.opencontainers.image.revision="$SOURCE_COMMIT" \
      org.opencontainers.image.version="$VERSION" \
      io.klh.fleet.seed.family="supervisor" \
      io.klh.fleet.supervisor.role="host" \
      io.klh.fleet.supervisor.service="runner-control" \
      io.klh.fleet.recipe.commit="$RECIPE_COMMIT" \
      io.klh.fleet.checkpoint.continuity="unwired"
COPY --from=build /runtime/ /opt/fleet/
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
USER 1000:1000
WORKDIR /opt/fleet
ENTRYPOINT ["bun", "/opt/fleet/runner-control.js"]
