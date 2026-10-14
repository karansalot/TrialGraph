#!/usr/bin/env bash
# Creates the project-local toolchain (Python 3.12 + PostgreSQL + PostGIS) in .tools/env
# using micromamba. Nothing is installed outside this repository.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MM="$ROOT/.tools/bin/micromamba"
if [ ! -x "$MM" ]; then
  mkdir -p "$ROOT/.tools"
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) PLAT=osx-arm64 ;; Darwin-x86_64) PLAT=osx-64 ;;
    Linux-x86_64) PLAT=linux-64 ;; Linux-aarch64) PLAT=linux-aarch64 ;;
    *) echo "unsupported platform"; exit 1 ;;
  esac
  curl -sL "https://micro.mamba.pm/api/micromamba/$PLAT/latest" | tar -xj -C "$ROOT/.tools" bin/micromamba
fi
export MAMBA_ROOT_PREFIX="$ROOT/.tools/mamba"
[ -d "$ROOT/.tools/env" ] || "$MM" create -y -p "$ROOT/.tools/env" -f "$ROOT/environment.yml"
"$ROOT/.tools/env/bin/pip" install -q -e "$ROOT/backend[dev]"
echo "toolchain ready: $ROOT/.tools/env"
