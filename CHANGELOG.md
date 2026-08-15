# Changelog

## [0.1.0] - 2026-08-15

### Added
- 单写者锁（`lib/lock.js`）：同一会话根目录只允许一个写者；心跳 + 陈旧偷锁 +
  快速失败；readonly / off 模式。
- 会话日志修复器（`lib/repair.js`）：复刻官方 Zstd 帧定位与严格 seq 校验；
  分叉裁决（最长连续分支）+ 两帧重建 + 原子替换 + `.corrupt.bak` 备份；
  `ensureRepaired` 幂等，live 会话跳过。
- 写路径守卫（`lib/guard.js`）：`appendBatch` 落盘前校验锁身份；
  `prepare/load/readFrom` 读取前确保已修复；热重载自动恢复再包装。
- 多终端感知：GUI beacon（tapIndex 注入）+ `/collab/panel` 协作面板 +
  `/collab/api/status` + `/collab/presence` SSE + `/collab/api/repair`。
- 多 IP 多端访问（`lib/bind.js` + `lib/settings.js`）：webserver 默认 bind
  `0.0.0.0`（bundle patch），运行时放宽 host schema 为 `z.string()`，
  `/collab/settings` 配置页（监听范围 + 额外信任主机，热重载重绑），
  `scripts/setup-bind.sh` 幂等放宽脚本。
- Agent 工具：`collab_status`、`collab_repair`。
- 测试套件（`tests/`，25 用例）与发布脚本（`scripts/release.sh`）。
