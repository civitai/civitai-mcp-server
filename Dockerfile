# syntax=docker/dockerfile:1

# ---- Build stage ----
FROM node:20-alpine AS build
WORKDIR /app

# Enable pnpm via corepack.
RUN corepack enable

# Install deps (with dev deps) using the lockfile for reproducibility.
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

# Build TypeScript -> dist.
COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

# Prune to production deps only.
RUN pnpm prune --prod

# ---- Runtime stage ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    PORT=3100

# Copy built app + production node_modules.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Ship the pullable CLI script (served at GET /cli). dist/index.js resolves it
# relative to itself (../scripts) and via process.cwd() (/app/scripts).
COPY scripts ./scripts

# Run as the built-in non-root node user.
USER node

EXPOSE 3100

# Liveness/readiness: hit /healthz (no upstream calls).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
