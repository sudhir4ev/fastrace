#!/usr/bin/env bash
# Clean rebuild of the C++ sidecar (and optionally Rust crates).
#
# SchemaEmbed.h is generated at CMake *configure* time from schema/schema.sql.
# A plain `cmake --build` after a branch switch / schema_version bump can leave
# a stale embed (e.g. store writes v4 while Rust expects v3). This script always
# reconfigures from a fresh build tree.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WITH_RUST=0
WIPE_DUCKDB=0
BUILD_DIR="${FASTRACE_BUILD_DIR:-build}"

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

  Clean CMake configure + build of fastrace_parse (and native libs/tests).

Options:
  --rust          Also cargo clean + cargo test for crates/
  --wipe-duckdb   Delete *.duckdb / *.duckdb.wal under .source/ and \$BUILD_DIR
  --build-dir DIR CMake build directory (default: build, or FASTRACE_BUILD_DIR)
  -h, --help      Show this help

Examples:
  $(basename "$0")
  $(basename "$0") --wipe-duckdb
  $(basename "$0") --rust --wipe-duckdb
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rust) WITH_RUST=1 ;;
    --wipe-duckdb) WIPE_DUCKDB=1 ;;
    --build-dir)
      BUILD_DIR="${2:?--build-dir requires a path}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

SCHEMA_VER="$(sed -n 's/^-- schema_version: \([0-9][0-9]*\).*/\1/p' schema/schema.sql | head -1)"
if [[ -z "$SCHEMA_VER" ]]; then
  echo "error: could not read schema_version from schema/schema.sql" >&2
  exit 1
fi

wipe_dir() {
  local dir="$1"
  [[ -e "$dir" ]] || return 0
  # FetchContent checkouts can leave read-only .git objects that block rm -rf.
  chmod -R u+w "$dir" 2>/dev/null || true
  rm -rf "$dir"
}

echo "==> clean build dir: $BUILD_DIR"
wipe_dir "$BUILD_DIR"

# Accidental second tree from `cmake -S native -B native/build` (wrong source root).
if [[ -d native/build ]]; then
  echo "==> removing stale native/build"
  wipe_dir native/build
fi

if [[ "$WIPE_DUCKDB" -eq 1 ]]; then
  echo "==> wiping *.duckdb under .source/ and $BUILD_DIR"
  find .source "$BUILD_DIR" -type f \( -name '*.duckdb' -o -name '*.duckdb.wal' \) -print -delete 2>/dev/null || true
fi

echo "==> cmake configure + build (expect schema_version=$SCHEMA_VER)"
cmake -S . -B "$BUILD_DIR"
cmake --build "$BUILD_DIR"

PARSE_BIN="$BUILD_DIR/native/cli/fastrace_parse"
EMBED_H="$BUILD_DIR/native/store/generated/SchemaEmbed.h"

if [[ ! -x "$PARSE_BIN" ]]; then
  echo "error: missing $PARSE_BIN" >&2
  exit 1
fi

EMBEDDED="$(sed -n 's/.*kSchemaVersion = "\([0-9][0-9]*\)".*/\1/p' "$EMBED_H" | head -1)"
if [[ "$EMBEDDED" != "$SCHEMA_VER" ]]; then
  echo "error: SchemaEmbed.h has schema_version=$EMBEDDED, expected $SCHEMA_VER" >&2
  exit 1
fi

BIN_VER="$(strings "$PARSE_BIN" | grep -E '^-- schema_version: [0-9]+$' | head -1 | awk '{print $NF}')"
if [[ "$BIN_VER" != "$SCHEMA_VER" ]]; then
  echo "error: $PARSE_BIN embeds schema_version=$BIN_VER, expected $SCHEMA_VER" >&2
  exit 1
fi

echo "==> ok: $PARSE_BIN (schema_version=$SCHEMA_VER)"

if [[ "$WITH_RUST" -eq 1 ]]; then
  echo "==> cargo clean + test (crates/)"
  cargo clean --manifest-path crates/Cargo.toml
  cargo test --manifest-path crates/Cargo.toml
fi

echo "==> clean build finished"
