#!/usr/bin/env bash
# dsh-collab-sync — 放宽 dsh webserver 的 host 校验（幂等，可重复执行）。
#
# 解决的问题：原生 dsh 的 webserver host schema 只允许 127.0.0.1 / 0.0.0.0，
# 且 web-startup 把 `--host 0.0.0.0` 当使用错误拒绝。本脚本把 host 校验放宽为
# z.string() 并移除 CLI 守卫，之后任意 bind IP（如指定局域网 IP）都能用。
#
# 注意：插件默认已通过 bundle patch 把 bind 设为 0.0.0.0（全部接口），
# 无需本脚本即可多 IP 访问；只有需要「指定 IP」绑定时才需要跑一次。
set -euo pipefail

resolve_webserver() {
  local pkg
  pkg="$(node -e "try{console.log(require.resolve('@deepseek-ai/dsh-host-webserver/package.json',{paths:[process.cwd()]}))}catch(e){}" 2>/dev/null || true)"
  if [ -n "$pkg" ]; then
    echo "$(dirname "$pkg")/lib/index.js"
    return
  fi
  if [ -n "${DSH_INSTALL:-}" ]; then
    echo "$DSH_INSTALL/@deepseek-ai/dsh-host-webserver/lib/index.js"
    return
  fi
  echo ""
}

resolve_startup() {
  local pkg
  pkg="$(node -e "try{console.log(require.resolve('@deepseek-ai/dsh-web-app/package.json',{paths:[process.cwd()]}))}catch(e){}" 2>/dev/null || true)"
  if [ -n "$pkg" ]; then
    echo "$(dirname "$pkg")/lib/startup.js"
    return
  fi
  if [ -n "${DSH_INSTALL:-}" ]; then
    echo "$DSH_INSTALL/@deepseek-ai/dsh-web-app/lib/startup.js"
    return
  fi
  echo ""
}

WEBSERVER="$(resolve_webserver)"
STARTUP="$(resolve_startup)"
patched=0

if [ -z "$WEBSERVER" ] || [ ! -f "$WEBSERVER" ]; then
  echo "setup-bind: cannot locate dsh-host-webserver (set DSH_INSTALL or run from the dsh install dir)" >&2
  exit 1
fi

if grep -q 'z.union(\[z.const("127.0.0.1"), z.const("0.0.0.0")\])\].*required()\|z\.union(\[z\.const("127\.0\.0\.1"), z\.const("0\.0\.0\.0")\]\)' "$WEBSERVER"; then
  sed -i 's/z\.union(\[z\.const("127\.0\.0\.1"), z\.const("0\.0\.0\.0")\])\.required()/z.string().required()/' "$WEBSERVER"
  patched=1
fi

if [ -n "$STARTUP" ] && [ -f "$STARTUP" ] && grep -q 'options.host === "0.0.0.0"' "$STARTUP"; then
  sed -i '/options.host === "0.0.0.0"/d' "$STARTUP"
  patched=1
fi

if [ "$patched" -eq 1 ]; then
  echo "[dsh-collab-sync] host schema widened to z.string() — 重启 dsh 后支持任意 bind IP"
else
  echo "[dsh-collab-sync] already widened (no change)"
fi
