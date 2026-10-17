#!/usr/bin/env bash
# How long a change takes to reach a running server and to pass the checks an
# agent runs between edits. Each step touches one server source file first,
# so it measures the rebuild a one-line change costs, not a no-op.
#
#   scripts/bench-iteration.sh [label]   → prints a table, appends to
#                                          target/bench/iteration.tsv
set -euo pipefail
cd "$(dirname "$0")/.."
label="${1:-$(git rev-parse --short HEAD)}"
mkdir -p target/bench
out=target/bench/iteration.tsv
[ -f "$out" ] || printf 'when\tlabel\tstep\tseconds\n' >"$out"

time_step() {
    local step="$1"
    shift
    local start end
    start=$(perl -MTime::HiRes=time -e 'printf "%.3f", time')
    "$@" >/dev/null 2>&1 || { echo "$step failed: $*" >&2; return 1; }
    end=$(perl -MTime::HiRes=time -e 'printf "%.3f", time')
    local seconds
    seconds=$(echo "$end - $start" | bc)
    printf '%-34s %8.1f s\n' "$step" "$seconds"
    printf '%s\t%s\t%s\t%s\n' "$(date +%FT%T)" "$label" "$step" "$seconds" >>"$out"
}

if [ -d apps/server ]; then
    # The TypeScript server: no compile step, so a change costs a restart.
    server_file=apps/server/src/server.ts
    touch "$server_file"
    time_step "typecheck (server)" bun run --cwd apps/server typecheck
    time_step "tests (server)" bun run --cwd apps/server test
    time_step "server start to /api/health" scripts/bench-start.sh
    # The native addon only rebuilds when Rust changes.
    touch crates/edit-native/src/lib.rs
    time_step "native addon rebuild (1 file)" just native
fi

if [ -d crates/edit ]; then
    export CARGO_TARGET_DIR="$PWD/target/check" CARGO_BUILD_BUILD_DIR="$PWD/target/check-build"
    file=crates/edit/src/cloud.rs
    cargo check -q -p edit 2>/dev/null || true
    touch "$file"
    time_step "cargo check -p edit (1 file)" cargo check -q -p edit
    touch "$file"
    time_step "cargo clippy -p edit (1 file)" cargo clippy -q -p edit --all-targets
    touch "$file"
    time_step "cargo test -p edit build (1 file)" cargo test -q -p edit --no-run
    dir="${EDIT_BUILD_DIR:-$HOME/edit-build}"
    touch "$file"
    time_step "serve binary rebuild (1 file)" env CARGO_TARGET_DIR="$dir/target" CARGO_BUILD_BUILD_DIR="$dir/build" \
        cargo build -q --profile serve -p edit --no-default-features
fi
