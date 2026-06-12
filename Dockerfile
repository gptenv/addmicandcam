FROM node:24-bookworm-slim

# LLM Telepresence Browser Lab - production container for GCP Cloud Run, Docker, etc.
# Playwright/Chromium + ffmpeg + espeak-ng are baked in during build.
# See docs/ for architecture and limitations.
#
# Cloud Run notes:
# - Requires at least 2Gi memory + 2 CPU (browser sessions are resource heavy).
# - Uses --no-sandbox + --disable-dev-shm-usage (already in launch args).
# - /data is ephemeral (per-instance). Use Secret Manager for ADMIN_TOKEN.
# - Set PORT (Cloud Run does this automatically). PUBLIC_BASE_URL recommended.

WORKDIR /app

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PORT=3000 \
    HOST=0.0.0.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    dumb-init \
    espeak-ng \
    ffmpeg \
    fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* tsconfig.json tsconfig.base.json vitest.config.ts ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/media/package.json packages/media/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json

RUN npm install
RUN npx playwright install --with-deps chromium

COPY . .
RUN npm run build

EXPOSE 3000

# Use dumb-init for proper signal handling (SIGTERM for Cloud Run graceful shutdown).
CMD ["dumb-init", "node", "apps/server/dist/index.js"]
