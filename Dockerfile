FROM oven/bun:1.4.2 AS build

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

FROM oven/bun:1.4.2 AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --from=build /app/dist ./dist

EXPOSE 3000

CMD ["bun", "run", "start:container"]
