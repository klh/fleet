FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS build
WORKDIR /fleet
COPY source/ ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY bundle.ts packages/buckle/deploy/bundle.ts
RUN bun packages/buckle/deploy/bundle.ts

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
ARG SOURCE_COMMIT
ARG RECIPE_COMMIT
ARG SEED_VERSION
LABEL org.opencontainers.image.title="fleet/buckle-seed" \
 org.opencontainers.image.source="https://github.com/klh/fleet" \
 org.opencontainers.image.revision=$SOURCE_COMMIT \
 org.opencontainers.image.version=$SEED_VERSION \
 org.opencontainers.image.description="Experimental reusable Buckle service seed; operator configuration required" \
 org.opencontainers.image.licenses="LicenseRef-Fleet-Personal-Use-1.0" \
 io.klh.seed.family="service" io.klh.seed.service="buckle" \
 io.klh.seed.recipe.revision=$RECIPE_COMMIT
COPY --from=build /runtime/ /fleet/
RUN mkdir /data && chown bun:bun /data
ENV BUCKLE_BIND=0.0.0.0 BUCKLE_DB=/data/buckle.db HOME=/tmp
USER bun
WORKDIR /fleet
EXPOSE 4101
ENTRYPOINT ["bun", "/fleet/packages/buckle/src/server.ts"]
