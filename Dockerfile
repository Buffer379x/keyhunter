# syntax=docker/dockerfile:1
# Base images are pinned by tag and digest (SEC-10). To update: pick the new tag, `docker pull <tag>`, read the digest with
# `docker image inspect <tag> --format '{{index .RepoDigests 0}}'` and replace both here; Dependabot proposes the same.
FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS frontend
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM rust:1.100.0-bookworm@sha256:ade39a710ef85f3506cffcfec3e8a24ba090badef1dff2fb798f71d878833fea AS backend
WORKDIR /build/backend
COPY backend/ ./
RUN --mount=type=cache,target=/usr/local/cargo/registry cargo build --release --locked

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 keyhunter \
    && useradd --uid 10001 --gid keyhunter --no-create-home --shell /usr/sbin/nologin keyhunter \
    && mkdir -p /app/frontend /data /config \
    && chown -R 10001:10001 /app /data /config
COPY --from=backend /build/backend/target/release/keyhunter /app/keyhunter
COPY --from=frontend /build/frontend/dist/ /app/frontend/
COPY --chmod=0755 deploy/docker-entrypoint.sh /app/docker-entrypoint
ENV KEYHUNTER_BIND=0.0.0.0:3000 \
    KEYHUNTER_DATA_DIR=/data \
    KEYHUNTER_FRONTEND_DIR=/app/frontend \
    RUST_LOG=keyhunter=info
USER 10001:10001
LABEL org.opencontainers.image.version="1.0.1" \
      org.opencontainers.image.source="https://github.com/Buffer379x/keyhunter" \
      org.opencontainers.image.title="KeyHunter"
WORKDIR /app
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD ["/app/docker-entrypoint", "--healthcheck"]
ENTRYPOINT ["/app/docker-entrypoint"]
