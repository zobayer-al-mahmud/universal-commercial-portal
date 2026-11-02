# UCP production image — Next.js 14 + Playwright Chromium (headless backend
# automation). Base image carries Chromium + all its system/font deps, matched to
# the installed Playwright version (1.49.1).
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app
ENV NODE_ENV=production

# Install dependencies first (better layer caching).
COPY package.json package-lock.json* ./
RUN npm ci

# App source + build.
COPY . .
RUN node node_modules/prisma/build/index.js generate \
 && node node_modules/next/dist/bin/next build

# Expose Playwright's bundled Chromium at a stable path our CDP launcher resolves
# (src/server/automation/browser-launch.ts looks for /usr/bin/chromium).
RUN ln -sf "$(node -e "console.log(require('playwright').chromium.executablePath())")" /usr/bin/chromium

# Headless backend browser; persistent data lives on a mounted volume (see
# docker-compose.yml): STORAGE_ROOT and the SQLite DB.
ENV PORT=3300 \
    AUTOMATION_BROWSER_ENGINE=chromium \
    AUTOMATION_HEADLESS=true \
    AUTOMATION_BROWSER_PATH=/usr/bin/chromium \
    STORAGE_ROOT=/data/storage \
    DATABASE_URL=file:/data/ucp.db

EXPOSE 3300

# Container healthcheck hits the app's own /api/health (DB ping).
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3300/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Apply migrations (idempotent) then start. See docker-entrypoint.sh.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3300"]
