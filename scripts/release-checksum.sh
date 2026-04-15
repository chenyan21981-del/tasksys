#!/usr/bin/env bash
set -euo pipefail
OUT=${1:-SHA256SUMS}
find . -type f \
  ! -path './.git/*' \
  ! -name 'SHA256SUMS' \
  -print0 | sort -z | xargs -0 sha256sum > "$OUT"
echo "written: $OUT"
