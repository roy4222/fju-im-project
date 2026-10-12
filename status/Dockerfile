# syntax=docker/dockerfile:1
#
# 開發者後台映像（設計方案 §3.6）：ghcr.io/roy4222/fju-status:<完整 SHA> 與 :main。
# build context 是 status/ 這一層（獨立專案，不在 pnpm workspace）。同一個映像三種入口：
#   status-web   → node server.js                     （Next standalone，預設 CMD）
#   collector    → node collector/collect.mjs --loop 600（S-3）
#   docker-proxy → node proxy/docker-proxy.mjs          （S-4）
# 另有安裝第 7b 步用的計數假 origin：node verify-origin.mjs（S-1）。
# collector/、proxy/ 在各自的票合併前可能是空的，映像照樣建得起來。

FROM node:22.23.2-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --ignore-workspace --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p collector proxy && pnpm --ignore-workspace run build

FROM node:22.23.2-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S nextjs -G nodejs

# Next standalone 產物（含它自己 trace 出來的 node_modules）；standalone 不含 static，要自己複製。
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
# 另外兩種入口與驗證用 origin：都是零依賴的 Node 腳本，原樣放進來。
COPY --from=build --chown=nextjs:nodejs /app/collector ./collector
COPY --from=build --chown=nextjs:nodejs /app/proxy ./proxy
COPY --from=build --chown=nextjs:nodejs /app/verify-origin.mjs ./verify-origin.mjs

# 預設非 root；collector 需要 root＋DAC_READ_SEARCH 時由 compose 指定 user（§3.1，S-4）。
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
