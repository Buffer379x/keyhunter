# syntax=docker/dockerfile:1
# Base images are pinned by tag and digest (SEC-10). To update: pick the new tag, `docker pull <tag>`, read the digest with
# `docker image inspect <tag> --format '{{index .RepoDigests 0}}'` and replace both here; Dependabot proposes the same.
FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS frontend
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM rust:1.100.0-bookworm@sha256:ade39a710ef85f3506cffcfec3e8a24ba090badef1dff2fb798f71d878833fea AS backend
WORKDIR /build/backend
COPY backend/ ./
RUN --mount=type=cache,target=/usr/local/cargo/registry cargo build --release --locked \
    && mkdir -p /rootfs/app/frontend /rootfs/data /rootfs/config

# Distroless (SEC-05): glibc, CA certificates and the binary, no shell and no package manager. The start logic of the
# container (user checks, Unraid data preparation, privilege drop) is part of the binary: backend/src/container.rs.
FROM gcr.io/distroless/cc-debian13:latest@sha256:dac90a25ffe03ebaace90cda886b081e61ab6cd77ac47eda51f7bcc15c320765 AS runtime
COPY --from=backend --chown=10001:10001 /rootfs/ /
COPY --from=backend /build/backend/target/release/keyhunter /app/keyhunter
COPY --from=frontend /build/frontend/dist/ /app/frontend/
ENV KEYHUNTER_BIND=0.0.0.0:3000 \
    KEYHUNTER_DATA_DIR=/data \
    KEYHUNTER_FRONTEND_DIR=/app/frontend \
    RUST_LOG=keyhunter=info
USER 10001:10001
LABEL org.opencontainers.image.version="1.1.5" \
      org.opencontainers.image.source="https://github.com/Buffer379x/keyhunter" \
      org.opencontainers.image.title="KeyHunter"
WORKDIR /app
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD ["/app/keyhunter", "--health"]
ENTRYPOINT ["/app/keyhunter"]
