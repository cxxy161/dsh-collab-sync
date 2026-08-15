#!/usr/bin/env bash
# dsh-collab-sync 发布脚本：打包 tgz + 创建 GitHub Release（需 gh CLI 已认证）。
# 用法：
#   scripts/release.sh [version]   # version 缺省读 package.json，如 0.1.0
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-$(node -p "require('./package.json').version")}"
NAME="dsh-collab-sync"

if ! command -v gh >/dev/null 2>&1; then
  echo "release: gh CLI not found (install GitHub CLI and run 'gh auth login')" >&2
  exit 1
fi

if [ ! -d .git ]; then
  echo "release: not a git repository" >&2
  exit 1
fi

echo "=== building tarball (v${VERSION}) ==="
TARBALL="${NAME}-v${VERSION}.tgz"
npm pack --pack-destination . >/dev/null
mv "${NAME}-${VERSION}.tgz" "$TARBALL"

echo "=== creating release v${VERSION} ==="
if gh release view "v${VERSION}" >/dev/null 2>&1; then
  echo "release: v${VERSION} already exists — uploading asset only" >&2
  gh release upload "v${VERSION}" "$TARBALL" --clobber
else
  gh release create "v${VERSION}" "$TARBALL" \
    --title "v${VERSION}" \
    --notes "dsh-collab-sync v${VERSION}

- 单写者锁：防多个 dsh 进程并发写同一会话日志（seq 分叉损坏）
- 会话日志自修复：启动扫描 + 两帧 Zstd 重建 + .corrupt.bak 备份
- 多终端感知：GUI beacon + /collab/panel 协作面板 + collab_status/repair 工具

安装：\`dsh plugin --profile web add <repo>\` 后重启，或使用 dsh-super-injector 运行时注入。"
fi

echo "=== done: $(gh release view "v${VERSION}" --json url -q .url) ==="
