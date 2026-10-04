#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$ROOT/.runtime/node/bin:$ROOT/.runtime/uv:$PATH"
export UV_PYTHON_INSTALL_DIR="${UV_PYTHON_INSTALL_DIR:-$ROOT/.runtime/python}"
NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || { printf '%s\n' '먼저 bash install.sh를 실행하세요.' >&2; exit 1; }
exec "$NODE" "$ROOT/run.mjs" "$@"
