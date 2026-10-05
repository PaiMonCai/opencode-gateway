# opencode-gateway container image.
#
# Layout: one throw-away stage installs production dependencies from the
# lockfile, the runtime stage adds the OpenCode CLI and the entrypoint. The
# process starts as root only long enough to reconcile PUID/PGID and volume
# ownership, then drops to the unprivileged `node` account (see entrypoint.sh).

# --- dependency stage -------------------------------------------------------
# Kept on its own so editing the source does not re-run `npm ci`.
FROM node:24-slim AS dependencies
WORKDIR /stage
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# --- runtime stage ----------------------------------------------------------
FROM node:24-slim

# gosu is used by the entrypoint to drop privileges; curl backs the health
# check; git is expected by OpenCode when it works on a project. They come from
# the distribution instead of a downloaded binary so the image has a single,
# auditable source of packages.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git gosu \
    && rm -rf /var/lib/apt/lists/*

# The managed backend is the OpenCode CLI (OPENCODE_PATH=opencode).
# Keep the runtime version aligned with @opencode-ai/sdk and the direct-client
# fingerprint. Runtime/plugin contracts can change between OpenCode releases, so
# rebuilding the same gateway commit must not silently pull a newer CLI.
ARG OPENCODE_VERSION=1.18.34
RUN npm install --global --no-audit --no-fund "opencode-ai@${OPENCODE_VERSION}" \
    && npm cache clean --force

WORKDIR /home/node/project
COPY . .
COPY --from=dependencies /stage/node_modules ./node_modules

COPY entrypoint.sh /usr/local/bin/opencode-gateway-entrypoint
RUN chmod 0755 /usr/local/bin/opencode-gateway-entrypoint

# The two OpenCode directories are expected to be volumes. Creating them here,
# owned by node, means a freshly created named volume inherits that ownership
# instead of landing as root. The parent directories are created explicitly and
# owned too: the CLI has to be able to mkdir XDG state next to `share`.
RUN install -d -m 0755 \
        /home/node/.local \
        /home/node/.local/share \
        /home/node/.local/state \
        /home/node/.config \
    && install -d -m 0755 \
        /home/node/.local/share/opencode \
        /home/node/.config/opencode \
    && chown -R node:node /home/node/.local /home/node/.config /home/node/project

# Container-side defaults for the gateway's own switches. Each one is a normal
# environment variable and can be overridden at run time; the full list lives in
# docs/*/configuration.md.
ENV OPENCODE_PROXY_PORT=10000 \
    BIND_HOST=0.0.0.0 \
    OPENCODE_PATH=opencode \
    OPENCODE_PROXY_MANAGE_BACKEND=true \
    OPENCODE_DISABLE_TOOLS=true \
    OPENCODE_USE_ISOLATED_HOME=false \
    OPENCODE_PROXY_PROMPT_MODE=standard \
    OPENCODE_PROXY_OMIT_SYSTEM_PROMPT=false \
    OPENCODE_PROXY_STORAGE_CLEANUP=off \
    OPENCODE_PROXY_OPS=health \
    OPENCODE_PROXY_REQUEST_TIMEOUT_MS=180000 \
    OPENCODE_PROXY_DEBUG=false \
    PUID=1000 \
    PGID=1000

EXPOSE 10000

# Equivalent to the compose health check; it runs inside the container so it
# keeps working when the published host port differs from OPENCODE_PROXY_PORT.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${OPENCODE_PROXY_PORT}/health" || exit 1

ENTRYPOINT ["/usr/local/bin/opencode-gateway-entrypoint"]
CMD ["node", "index.js"]
