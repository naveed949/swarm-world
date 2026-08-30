ARG NODE_IMAGE=node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
FROM ${NODE_IMAGE} AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE} AS runtime

RUN apt-get update \
  && apt-get install --yes --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY docker/repository-entrypoint.sh ./docker/repository-entrypoint.sh
COPY docker/pi-sidecar-entrypoint.sh ./docker/pi-sidecar-entrypoint.sh
COPY docker/repository-dependencies-entrypoint.sh ./docker/repository-dependencies-entrypoint.sh
RUN chmod 0555 ./docker/repository-entrypoint.sh \
  ./docker/pi-sidecar-entrypoint.sh \
  ./docker/repository-dependencies-entrypoint.sh \
  && chown -R 10001:10001 /app

USER 10001:10001
ENTRYPOINT ["/app/docker/repository-entrypoint.sh"]
