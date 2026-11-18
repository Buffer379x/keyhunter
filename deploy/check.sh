#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
docker build -f deploy/Dockerfile.tools -t keyhunter-build-tools:local .
docker run --rm --user "$(id -u):$(id -g)" \
  -e CARGO_HOME=/workspace/work/check/cargo \
  -e CARGO_TARGET_DIR=/workspace/work/check/target \
  -v "$PWD":/workspace -w /workspace/backend keyhunter-build-tools:local \
  sh -c 'cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked && cargo build --locked --examples'
cd frontend
npm ci --no-audit --no-fund
npm run build
npm test
