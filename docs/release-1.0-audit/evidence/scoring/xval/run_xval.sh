#!/bin/sh
# Cross-validates sim/khsim.py (policy B) against the real scheduler code of this repository.
# Copies backend/ to a scratch directory, appends the audit test module to the COPY of jobs.rs,
# runs it in the build-tools image with its own target directory, then compares the logs.
# Usage (from the repository root): sh docs/release-1.0-audit/evidence/scoring/xval/run_xval.sh <scratch-dir>
set -eu
repo=$(pwd)
here="$repo/docs/release-1.0-audit/evidence/scoring/xval"
scratch=${1:?scratch dir}
rm -rf "$scratch/backend" && mkdir -p "$scratch/out"
cp -r "$repo/backend" "$scratch/backend"
rm -rf "$scratch/backend/target"
cp "$here/audit_xval.rs" "$scratch/backend/src/audit_xval.rs"
printf '\n#[cfg(test)]\n#[path = "audit_xval.rs"]\nmod audit_xval;\n' >> "$scratch/backend/src/jobs.rs"
python3 "$here/xval.py" make "$scratch/out"
run() {
  docker run --rm --user "$(id -u):$(id -g)" -e CARGO_HOME=/workspace/work/check/cargo \
    -e CARGO_TARGET_DIR=/workspace/work/check/target-score -e "$1" -e "${2:-UNUSED=1}" -v "$repo":/workspace -v "$scratch":/xval \
    -w /xval/backend keyhunter-build-tools:local sh -c "cargo test --locked --offline --lib $3 -- --nocapture --test-threads=1"
}
for name in binding loose errors; do
  run "XVAL_IN=/xval/out/$name.json" "XVAL_OUT=/xval/out/$name.rust.jsonl" audit_xval_replay
done
run "XVAL_BUDGET_OUT=/xval/out/budget_counts.json" "" audit_budget_test_counts
cp "$scratch/out/"*.json "$scratch/out/"*.jsonl "$here/results/" 2>/dev/null || true
python3 "$here/xval.py" compare "$scratch/out"
