# =====================================================================
# Multi-stage build. Final image contains only production dependencies
# and compiled JS — no TypeScript compiler, no dev dependencies, no
# source .ts files. This keeps the deployed image smaller and reduces
# attack surface (nothing to accidentally execute/inspect that isn't
# needed at runtime).
#
# IMPORTANT: this project depends on `canvas` (via chartjs-node-canvas)
# for chart rendering, which ships a self-contained prebuilt native
# binary that bundles Cairo/Pango/etc. as its own .so files — it only
# needs a glibc-based OS (NOT Alpine/musl) with a matching Node ABI to
# work out of the box, no system -dev packages required for the binary
# itself. Verified by inspecting node_modules/canvas's actual linked
# libraries during development: it only depends on glibc-level
# libraries (libc, libm, libstdc++, libpthread) that any Debian-based
# Node image already provides. This is why both stages use `slim`
# (Debian-based) images, never `alpine`.
#
# Fonts are the one thing NOT bundled: a bare `node:slim` image has no
# fonts and no fontconfig config at all, which causes chart labels to
# render blank/garbled rather than erroring loudly — a silent
# production bug, not a crash. `fontconfig` + `fonts-dejavu-core` are
# installed explicitly in the runtime stage to prevent that. This was
# verified during development by actually rendering a chart and
# visually confirming legible axis labels and legend text.
# =====================================================================

# ---------------------------------------------------------------------
# Stage 1: install all dependencies (including dev) and compile TS -> JS
# ---------------------------------------------------------------------
FROM node:20-slim AS builder

WORKDIR /app

# Install dependencies first, separately from copying source, so
# Docker's layer cache is reused across builds unless package*.json
# actually changed — meaningfully speeds up rebuilds when only source
# files change.
COPY package.json package-lock.json ./
RUN npm ci

# CACHE_BUST is set at deploy time to force a fresh build when source
# files change. Without it, Docker's layer cache may reuse stale layers.
ARG CACHE_BUST
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------
# Stage 2: production runtime — only prod deps + compiled dist/
# ---------------------------------------------------------------------
FROM node:20-slim AS runtime

# fontconfig + a real font family are required for chartjs-node-canvas
# to render legible text (axis labels, legend) — see the comment block
# above. ca-certificates is required for outbound HTTPS calls to
# Supabase/Telegram/Discord/WhatsApp/Groq/Notion, all of which this
# server talks to. curl is installed only to power the HEALTHCHECK
# below; everything here is intentionally minimal, not a kitchen-sink
# image.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      fontconfig \
      fonts-dejavu-core \
      ca-certificates \
      curl \
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -f

WORKDIR /app

# Run as a non-root user. Node's official images already ship a "node"
# user (uid 1000) — reuse it instead of inventing a new one.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
EXPOSE 10000

USER node

# Mirrors this project's existing UptimeRobot/Render health-check
# target (see src/server.ts's /healthz route) so `docker ps` and
# container orchestrators can detect a genuinely wedged process, not
# just "the port is open."
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:${PORT:-10000}/healthz || exit 1

CMD ["node", "dist/server.js"]
