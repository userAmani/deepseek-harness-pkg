#!/usr/bin/env bash
#
# 本地构建私有 Harness 运行时（仅当前平台）。
#
# 参数与 .github/workflows/build-private-harness.yml 的 workflow_dispatch 输入一一对应，
# 默认值也保持一致，避免本地与 CI 产出的 channels/stable/latest.json 字段漂移。
# 唯一有意的差异：本地只能构建当前平台，因此固定传 --allow-partial。

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 与 workflow inputs 对齐的默认值
HARNESS_DIR="../deepseek-harness"   # ≈ inputs.harness_repository / harness_ref 的本地对应物
RUNTIME_VERSION=""                  # ≈ inputs.runtime_version（留空则取 Harness 源码 apps/cli 的版本）
MINIMUM_DESKTOP_VERSION="0.6.8"     # = inputs.minimum_desktop_version 的 default
NODE_VERSION="22.22.0"              # = env.NODE_VERSION
BUILD_OUT="dist/private-runtime"    # = --output dist/private-runtime
PREFIX="/harness"                   # = --prefix /harness

usage() {
  cat <<'EOF'
用法: build-runtime.sh [选项]

  --harness <路径>                    Harness 源码目录（默认 ../deepseek-harness）
  --runtime-version <SemVer>          写入运行时的版本；默认取 Harness 源码 apps/cli/package.json
  --minimum-desktop-version <SemVer>  兼容的最低桌面端版本（action 默认 0.6.8）
  --node-version <版本>               目标 Node.js 版本（默认 22.22.0）
  --output <目录>                     构建输出目录（默认 dist/private-runtime）
  --prefix <URL 前缀>                 清单中的资源路径前缀（默认 /harness）
  -h, --help                          显示本帮助
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --harness)                 HARNESS_DIR="${2:?--harness 需要一个值}"; shift 2 ;;
    --runtime-version)         RUNTIME_VERSION="${2:?--runtime-version 需要一个值}"; shift 2 ;;
    --minimum-desktop-version) MINIMUM_DESKTOP_VERSION="${2:?--minimum-desktop-version 需要一个值}"; shift 2 ;;
    --node-version)            NODE_VERSION="${2:?--node-version 需要一个值}"; shift 2 ;;
    --output)                  BUILD_OUT="${2:?--output 需要一个值}"; shift 2 ;;
    --prefix)                  PREFIX="${2:?--prefix 需要一个值}"; shift 2 ;;
    -h | --help)               usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# 未显式指定版本时，从 Harness 源码里真正的 @deepseek-ai/dsh 包读取，
# 保证清单版本与实际打包进运行时的版本永远一致（默认写死会导致两者漂移）。
if [[ -z "$RUNTIME_VERSION" ]]; then
  CLI_PKG="$HARNESS_DIR/apps/cli/package.json"
  if [[ ! -f "$CLI_PKG" ]]; then
    echo "找不到 $CLI_PKG，请用 --runtime-version 显式指定版本" >&2
    exit 1
  fi
  RUNTIME_VERSION="$(node -e \
    'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).version)' \
    "$CLI_PKG")"
  [[ -n "$RUNTIME_VERSION" ]] || { echo "无法从 $CLI_PKG 读取版本" >&2; exit 1; }
fi

echo "Harness 源码 : $HARNESS_DIR"
echo "运行时版本   : $RUNTIME_VERSION"
echo "最低桌面版本 : $MINIMUM_DESKTOP_VERSION"
echo "Node 版本    : $NODE_VERSION"
echo

pnpm run build:private-harness -- \
  --harness "$HARNESS_DIR" \
  --output "$BUILD_OUT" \
  --version "$RUNTIME_VERSION" \
  --node-version "$NODE_VERSION"

BUILD_ID="$(date +%Y%m%d.%H%M)"

node scripts/generate-local-release.mjs \
  --artifacts "$BUILD_OUT/artifacts" \
  --output "$BUILD_OUT/upload" \
  --version "$RUNTIME_VERSION" \
  --build-id "$BUILD_ID" \
  --minimum-desktop-version "$MINIMUM_DESKTOP_VERSION" \
  --prefix "$PREFIX" \
  --allow-partial
