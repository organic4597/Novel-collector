#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
[[ "$(uname -s)" == Linux ]] || { printf '%s\n' 'Linux에서 실행하세요.' >&2; exit 1; }
[[ -f "$ROOT/run.mjs" && -f "$ROOT/package-lock.json" ]] || { printf '%s\n' '릴리스 소스 ZIP을 먼저 압축 해제하세요.' >&2; exit 1; }
privileged() { if [[ "$(id -u)" == 0 ]]; then "$@"; else sudo -n "$@"; fi; }
if ! command -v curl >/dev/null || ! command -v tar >/dev/null || ! command -v xz >/dev/null; then
  if command -v apt-get >/dev/null; then privileged apt-get update; privileged apt-get install -y curl ca-certificates tar xz-utils;
  elif command -v dnf >/dev/null; then privileged dnf install -y curl ca-certificates tar xz;
  elif command -v yum >/dev/null; then privileged yum install -y curl ca-certificates tar xz;
  else printf '%s\n' 'curl·tar·xz를 준비할 수 있는 패키지 관리자가 필요합니다.' >&2; exit 1; fi
fi
NODE="$(command -v node || true)"
[[ ! -x "$ROOT/.runtime/node/bin/node" ]] || NODE="$ROOT/.runtime/node/bin/node"
if [[ -z "$NODE" ]] || ! "$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0])>=22?0:1)'; then
  case "$(uname -m)" in x86_64) ARCH=x64;; aarch64|arm64) ARCH=arm64;; *) printf '%s\n' 'x64/arm64 Linux가 필요합니다.' >&2; exit 1;; esac
  mkdir -p "$ROOT/.runtime"
  TEMP="$(mktemp -d "$ROOT/.runtime/node-install.XXXXXX")"
  trap 'rm -rf -- "$TEMP"' EXIT
  curl --fail --location --proto '=https' --tlsv1.2 https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$TEMP/SHASUMS256.txt"
  LINE="$(grep -E " node-v22\.[0-9]+\.[0-9]+-linux-$ARCH\.tar\.xz$" "$TEMP/SHASUMS256.txt")"
  [[ -n "$LINE" ]] || { printf '%s\n' '공식 Node 패키지를 찾지 못했습니다.' >&2; exit 1; }
  FILE="${LINE##* }"
  curl --fail --location --proto '=https' --tlsv1.2 "https://nodejs.org/dist/latest-v22.x/$FILE" -o "$TEMP/$FILE"
  (cd "$TEMP" && printf '%s\n' "$LINE" | sha256sum -c -)
  tar -xJf "$TEMP/$FILE" -C "$TEMP"
  [[ ! -e "$ROOT/.runtime/node" ]] || mv -- "$ROOT/.runtime/node" "$ROOT/.runtime/node.old.$(date +%s)"
  mv -- "$TEMP/${FILE%.tar.xz}" "$ROOT/.runtime/node"
  NODE="$ROOT/.runtime/node/bin/node"
fi
export PATH="$ROOT/.runtime/node/bin:$ROOT/.runtime/uv:$PATH"
"$NODE" "$ROOT/tools/install-runtime.mjs" "$@"
