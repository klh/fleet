# Tool-only context: this directory, never the Fleet or Pi source tree.
FROM --platform=linux/amd64 oven/bun:1@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895
ARG SOURCE_COMMIT
ARG TOOL_VERSION
LABEL org.opencontainers.image.title="fleet/tool-seed" \
 org.opencontainers.image.source="https://github.com/klh/fleet" \
 org.opencontainers.image.revision=$SOURCE_COMMIT \
 org.opencontainers.image.version=$TOOL_VERSION \
 io.klh.seed.family="tool"
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
COPY tools.json /opt/tool-seed/tools.json
ENV HOME=/tmp TMPDIR=/tmp
WORKDIR /workspace
USER 1000:1000
CMD ["bun", "--version"]
