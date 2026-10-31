# One image serves the API and the built SPA (ADR 0001).
FROM oven/bun:1.4 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.4 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile --production
COPY apps/api apps/api
COPY --from=build /app/apps/web/dist apps/web/dist
EXPOSE 3000
CMD ["bun", "apps/api/src/server.ts"]
