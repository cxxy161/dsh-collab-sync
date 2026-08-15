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

resolve_pkg() {
  local pkg
  pkg="$(node -e "try{console.log(require.resolve('@deepseek-ai/$1/package.json',{paths:[process.cwd()]}))}catch(e){}" 2>/dev/null || true)"
  if [ -n "$pkg" ]; then
    echo "$(dirname "$pkg")/$2"
    return
  fi
  if [ -n "${DSH_INSTALL:-}" ]; then
    echo "$DSH_INSTALL/@deepseek-ai/$1/$2"
    return
  fi
  echo ""
}

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

# ── 远程(非回环)来源的浏览器也能读写设置页 ────────────────────────────────
# 原客户端把非回环 origin 的设置作用域判为 memory/unavailable → 插件配置页空白。
# 此段把三处客户端门禁改为 host（与 patch-dsh.sh 服务端 trustedHosts 放行一致）。
UI_SETTINGS="$(resolve_pkg dsh-client-ui-settings lib/client.js)"
UI_SETTINGS_GENERAL="$(resolve_pkg dsh-client-ui-settings-general lib/client.js)"
UI_SETTINGS_MODELS="$(resolve_pkg dsh-client-ui-settings-models lib/client.js)"
for f in "$UI_SETTINGS" "$UI_SETTINGS_MODELS"; do
  if [ -n "$f" ] && [ -f "$f" ] && grep -q 'connection.isLoopback ? "host" : "memory"' "$f"; then
    sed -i 's|connection\.isLoopback ? "host" : "memory"|"host" /* dsh-collab-sync: remote settings enabled */|' "$f"
    patched=1
  fi
done
if [ -n "$UI_SETTINGS_GENERAL" ] && [ -f "$UI_SETTINGS_GENERAL" ] && grep -q 'connection.isLoopback ? new SettingsDocumentStore(connection.api) : void 0' "$UI_SETTINGS_GENERAL"; then
  sed -i 's|connection\.isLoopback ? new SettingsDocumentStore(connection\.api) : void 0|new SettingsDocumentStore(connection.api) /* dsh-collab-sync: remote settings enabled */|' "$UI_SETTINGS_GENERAL"
  patched=1
fi

if [ "$patched" -eq 1 ]; then
  echo "[dsh-collab-sync] host schema widened + remote settings enabled — 重启 dsh 后生效"
else
  echo "[dsh-collab-sync] already widened (no change)"
fi
