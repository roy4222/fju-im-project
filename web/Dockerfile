# syntax=docker/dockerfile:1
#
# app、worker、migrate 共用這一個映像（契約 05 §1：ghcr.io/<owner>/fju-web:<sha>）。
#   app     → node web/server.js（Next standalone）
#   worker  → S02-06 換上真的到期工作迴圈
#   migrate → node web/scripts/migrate.mjs（需要 pg 與 drizzle-orm，所以另外裝 production 依賴）

FROM node:22.23.2-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable

# 全部依賴：build 要用（next、typescript…）。
FROM base AS deps
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY web/package.json web/package.json
RUN pnpm install --frozen-lockfile --filter @fju/web...

# 只有 production 依賴：migrate 腳本在 runtime 需要 pg 與 drizzle-orm。
FROM base AS proddeps
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY web/package.json web/package.json
RUN pnpm install --frozen-lockfile --prod --filter @fju/web...

FROM base AS build
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/web/node_modules ./web/node_modules
COPY . .
# 版本資訊在 build 時固定進映像，/api/health 直接回這兩個值（契約 05 §1）。
ARG GIT_COMMIT=unknown
ARG APP_VERSION=0.0.0
ENV GIT_COMMIT=$GIT_COMMIT APP_VERSION=$APP_VERSION
RUN pnpm -C web build

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S nextjs -G nodejs

# Next standalone 產物（含它自己 trace 出來的 node_modules）。
COPY --from=build --chown=nextjs:nodejs /repo/web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /repo/web/.next/static ./web/.next/static

# migrate 服務要用的東西：純 SQL、執行腳本，以及 production 依賴。
COPY --from=build --chown=nextjs:nodejs /repo/web/drizzle ./migrate/web/drizzle
COPY --from=build --chown=nextjs:nodejs /repo/web/scripts/migrate.mjs ./migrate/web/scripts/migrate.mjs
COPY --from=proddeps --chown=nextjs:nodejs /repo/node_modules ./migrate/node_modules
COPY --from=proddeps --chown=nextjs:nodejs /repo/web/node_modules ./migrate/web/node_modules

# Next 的 standalone 追蹤在 pnpm 的 .pnpm 佈局下會漏掉 @swc/helpers 的 esm/ 子目錄
# （只複製到被 trace 到的少數檔案），啟動時就會 MODULE_NOT_FOUND。
# 這裡把完整的套件補回 next 自己的 node_modules。next 的目錄名帶 hash，所以用萬用字元。
COPY --from=proddeps /repo/node_modules/.pnpm/@swc+helpers@0.5.23/node_modules/@swc/helpers /opt/swc-helpers
RUN set -eux; \
    found=0; \
    for dir in /app/node_modules/.pnpm/next@*/node_modules/@swc; do \
      [ -d "$dir" ] || continue; \
      rm -rf "$dir/helpers"; \
      cp -R /opt/swc-helpers "$dir/helpers"; \
      found=1; \
    done; \
    [ "$found" = 1 ]; \
    rm -rf /opt/swc-helpers; \
    chown -R nextjs:nodejs /app/node_modules/.pnpm

ARG GIT_COMMIT=unknown
ARG APP_VERSION=0.0.0
ENV GIT_COMMIT=$GIT_COMMIT APP_VERSION=$APP_VERSION

USER nextjs
EXPOSE 3000
CMD ["node", "web/server.js"]
