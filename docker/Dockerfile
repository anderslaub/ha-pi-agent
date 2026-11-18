# pi + va-bridge for Home Assistant, headless.
# Build from the repository root:  docker build -f docker/Dockerfile -t pi-va-bridge .
FROM node:24-bookworm-slim

# Unpinned on purpose: staying current (security fixes) matters more here than reproducible builds.
# Set PI_VERSION to pin pi. "latest" is only re-resolved when the layer is rebuilt:
#   docker compose build --pull --no-cache
ARG PI_VERSION=latest

# OS updates, and tools pi likes to have (search, git, scripting). Add your own to taste.
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep fd-find python3 tini \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

# The latest npm, then pi itself
RUN npm install -g npm@latest \
 && npm install -g "@earendil-works/pi-coding-agent@${PI_VERSION}" \
 && npm cache clean --force

# The va-bridge pi package. It uses the globally installed pi as its SDK, so both are always the same version.
COPY package.json README.md LICENSE /opt/va-bridge/
COPY bridge/src /opt/va-bridge/bridge/src
RUN mkdir -p /opt/va-bridge/node_modules/@earendil-works \
 && ln -s "$(npm root -g)/@earendil-works/pi-coding-agent" /opt/va-bridge/node_modules/@earendil-works/pi-coding-agent
COPY docker/entrypoint.sh /usr/local/bin/va-bridge-entrypoint
# "docker exec -it <container> pi" runs pi as the node user (root would leave root-owned files in ~/.pi)
COPY docker/pi-as-node.sh /usr/local/sbin/pi
# Fallback prompt when no docker/SYSTEM.md is mounted (compose mounts yours)
COPY docker/SYSTEM.md.example /opt/va-bridge/docker/

# The entrypoint starts as root only to fix folder ownership, then runs everything as the "node" user with
# uid/gid PUID/PGID (default 1000), so files in the workspace belong to your host user.
# pi's state (logins, settings, packages, sessions) lives in /home/node/.pi: give it a volume.
ENV HOME=/home/node \
    PI_BRIDGE_HOST=0.0.0.0 \
    PI_BRIDGE_PORT=8787 \
    PI_BRIDGE_CWD=/workspace
RUN mkdir -p /home/node/.pi/agent && chown -R node:node /home/node/.pi
WORKDIR /workspace
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -fsS -H "Authorization: Bearer ${PI_BRIDGE_TOKEN}" "http://127.0.0.1:${PI_BRIDGE_PORT}/v1/health" >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "va-bridge-entrypoint"]
CMD ["node", "/opt/va-bridge/bridge/src/cli.ts"]
