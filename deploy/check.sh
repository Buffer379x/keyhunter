#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# Shipped migrations stay byte-identical (CODE-15): see backend/migrations/SHA256SUMS.
(cd backend/migrations && sha256sum -c --quiet SHA256SUMS)
docker build -f deploy/Dockerfile.tools -t keyhunter-build-tools:local .
docker run --rm --user "$(id -u):$(id -g)" \
  -e CARGO_HOME=/workspace/work/check/cargo \
  -e CARGO_TARGET_DIR=/workspace/work/check/target \
  -v "$PWD":/workspace -w /workspace/backend keyhunter-build-tools:local \
  sh -c 'cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked && cargo build --locked --examples'
cd frontend
npm ci --no-audit --no-fund
npm run lint
npm run knip
npm run format:check
npm run typecheck:tests
npm run build
npm test
