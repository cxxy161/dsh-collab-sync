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

## [0.1.1] - 2026-08-15

### Fixed
- **写路径自愈**：`assertCanWrite` 在锁丢失（中断的热重载/外部清理）或降级
  跟随者被实际使用时，按需自动重新取锁晋升为写者；仅在存在**存活写者**时才
  拒绝写入（英文报错并附写者 pid/端口）。彻底消除「writer lock is not held」
  导致的操作阻塞。
- 全部报错/日志消息改为英文（面板/配置页 UI 保持中文）。
- 协作面板与配置页互链、beacon 徽标、面板「打开主 GUI」均改为**当前标签页
  覆盖**，不再新开标签页。

## [0.1.2] - 2026-08-15

### Changed
- **报错/日志全部改为中文**（面板与配置页 UI 保持中文）。
- **配置页保存改为写 `~/.dsh/.env`（DSH_WEB_BIND / DSH_WEB_EXTRA_TRUSTED），
  重启后生效**——不再改写 profile 补丁、不再触发热重载重绑，彻底解决
  「点击保存没有任何反应」（之前热重载重绑会丢路由/断连，导致页面无响应）。
- 新增 **「强制重置写者锁」逃生舱**（`/collab/api/lock` + 设置页按钮）：
  锁异常卡死时一键重置并重新获取，不再需要卸载/关闭插件。

### Fixed
- 写路径守卫在锁被替换/丢失时给出中文报错并自愈（按需重新取锁）。

## [0.1.3] - 2026-08-15

### Fixed
- **远程(非回环)来源的设置页空白**：dsh 客户端把非回环 origin 的设置作用域
  判为 `memory/unavailable`，导致「设置 → 插件 → 插件配置」在 LAN/tailnet IP
  下空白。`scripts/setup-bind.sh` 现在会（幂等）把三处客户端门禁改为 `host`：
  `dsh-client-ui-settings`（插件配置）、`dsh-client-ui-settings-general`
  （打开配置文件）、`dsh-client-ui-settings-models`（模型欢迎条）。
  服务端侧由 `patch-dsh.sh` 的 `trustedHosts` 放行已配套（须两者同时生效）。
