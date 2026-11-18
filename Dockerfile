FROM oven/bun:1.4.4 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.4 AS runtime
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY sql ./sql
USER bun

FROM runtime AS api
EXPOSE 4000
CMD ["bun", "src/apps/api.ts"]

FROM runtime AS ws
EXPOSE 4001
CMD ["bun", "src/apps/ws.ts"]

FROM runtime AS worker
CMD ["bun", "src/apps/worker.ts"]

FROM runtime AS feed
CMD ["bun", "src/apps/feed.ts"]
