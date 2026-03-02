# ---- base (with pnpm) ----
FROM ghcr.io/railwayapp/nixpacks:ubuntu-1745885067 AS base
WORKDIR /app

RUN sudo apt-get update && sudo apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libgbm1 libasound2t64 \
    libpangocairo-1.0-0 libxss1 libgtk-3-0 libxshmfence1 libglu1 chromium curl wget \
    && sudo rm -rf /var/lib/apt/lists/*

COPY pnpm-lock.yaml package.json pnpm-workspace.yaml* ./

# ---- deps (install devDeps) ----
FROM base AS deps
RUN --mount=type=cache,target=/root/.local/share/pnpm/store/v3 \
    pnpm install --frozen-lockfile --prod=false

# ---- build ----
FROM deps AS build
COPY . .
RUN pnpm build
RUN pnpm prune --prod

# ---- runtime ----
FROM ghcr.io/railwayapp/nixpacks:ubuntu-1745885067 AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN sudo apt-get update && sudo apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libgbm1 libasound2t64 \
    libpangocairo-1.0-0 libxss1 libgtk-3-0 libxshmfence1 libglu1 chromium curl wget \
    && sudo rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

CMD ["node", "dist/index.js"]
