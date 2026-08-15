# dsh-collab-sync 架构

## 目标形态

**单后端 + 多终端**：只有一个 dsh 进程（web 后端）写会话日志；所有终端浏览器连
这个后端。任何一端的消息/审批/工具调用经 `events.mux` 广播给所有客户端，终端间
**无缝切换**。

## 三层职责

```
┌─────────────────────────────────────────────────────────────┐
│ ① 单写者锁 lock.js    同一会话根只允许一个写者（防 seq 分叉）  │
│ ② 修复器 repair.js    启动扫描 + 两帧 Zstd 重建 + 备份        │
│ ③ 写路径守卫 guard.js  落盘前校验锁身份，读取前确保已修复      │
├─────────────────────────────────────────────────────────────┤
│ ④ 多终端感知 设置页「开放 IP / 协作」分区 + /collab/panel      │
│    - 客户端模块注册设置分区（绑定/信任/强制重置锁）             │
│    - /collab/api/status + SSE presence + 协作面板             │
│    - collab_status / collab_repair agent 工具                 │
└─────────────────────────────────────────────────────────────┘
```

## 为什么事件广播不重造

`dsh-client-connection` 为每个浏览器维持 mux 流（WS/SSE），
`dsh-host-apiproxy` 的 `events.mux` 把全局 `session/event`、`question/requested`
推给**所有**已连接客户端；`respond` 是全局 RPC。单后端下跨端实时同步是既有能力，
插件只补「感知」与「安全」。

## 关键机制（对应 dsh 源码）

| 事实 | 位置 |
|---|---|
| seq = log.length（内存分配） | `@deepseek-ai/dsh-session` `Session#logEvent` |
| 每批一个 Zstd 帧追加写 | `@deepseek-ai/dsh-session-persistence-jsonl` `appendLines` |
| 严格读取校验 `seq === index` | 同包 `SessionLogScanner.consumeEventLine` |
| 帧1必须恰一行 header | 同包 `assertZstdHeaderFrame` |
| 帧定位算法 | 同包 `scanZstdFrames`（本插件复刻） |
| 帧压缩参数 | `zstdCompress(..., {params:{ZSTD_c_checksumFlag:1}})`（本插件复刻） |
| 行解码 | `@deepseek-ai/dsh-session` `decodeStorageRecord`（直接复用） |

## 分叉修复语义

两进程并发 append 同一日志 → 文件内出现两个 seq 区间重叠的分支（如
A=36245..38473 与 B=36245..148012）。修复：

1. 贪心扫描定位**分叉点**：首个 `first < idx`（seq 回跳）行，其 `first` 即分叉点；
   冲突区域 = 所有 `first >= 分叉点` 的行。
2. 对冲突区域每个候选（`first === 分叉点` 的行）模拟续接：贪心接受后续
   `first === 当前 idx` 的行（允许跳过竞争分支行）。
3. 裁决：**最终 seq 最大 → 分叉点处文件连续 run 最长 → 纳入行数最少（避免混入
   被覆盖分支的重复内容）→ 文件位置更早**。保留胜者，丢弃其余。
4. 重建为两帧（header 帧 + 事件帧），原子替换，原件备份 `.corrupt.bak`，
   再跑一遍严格校验。

## 单写者锁

- 锁文件 `<sessionsRoot>/.dsh-collab-writer.lock`，内容
  `{token, pid, hostname, startedAt, heartbeatAt, port, version}`。
- `openSync(path,'wx')` 排他创建；每 5s 心跳重写（`unref` 定时器）。
- 冲突（`mode: auto`，默认）：第二个实例**自动降级为只读跟随者** —— 不抢锁、
  不写、继续服务 UI（`/collab/api/status` 显示 `degraded: true` 与写者身份），
  兼容"多 IP 各起一个实例"的部署而不再崩溃；`mode: writer` 下才快速失败。
- 陈旧：心跳超过 `lockStaleAfterMs`（默认 15s）或 PID 死亡 → 改名 `.stale-*` 偷锁。
- 释放：dispose 时 token 匹配才删除；`process.on('exit')` 兜底。

## 多 IP 绑定（0.0.0.0 支持）

- 原生 dsh：webserver host schema 只允许 127.0.0.1/0.0.0.0，且 CLI 拒绝
  `--host 0.0.0.0`。
- 插件 bundle patch 覆盖 webserver 行（**必须同时带出 host+port**，patch 语义是
  整体替换 config）：`命令行 --host > DSH_WEB_BIND > 127.0.0.1`。
- `/collab/settings` 配置页把选择写回 profile 补丁（`!!js` 表达式经 js-yaml
  自定义 schema 往返），include 热重载后 webserver 行重绑；写前自动备份
  `.collab-bak-<ts>`。
- 指定 IP：运行时探测 host schema，窄（union）时放宽为 `z.string()`（幂等）；
  持久生效需 `scripts/setup-bind.sh` 一次（重启后新进程同样放宽）。

## 写路径守卫

对 `sessionPersistence` 服务实例做受控包装（不改源码，热重载自动恢复再包装）：

- `appendBatch`：每次落盘前 `assertCanWrite()` —— readonly / 未持锁 / 锁被替换
  时抛错拒写（宁可大声失败，不再静默损坏）。
- `prepare` / `load` / `readFrom`：先 `ensureRepaired(id)` 再委托。

## 端点

| 路径 | 说明 |
|---|---|
| `GET /collab/api/status` | JSON：写者/在线终端/修复统计 |
| `GET /collab/presence` | SSE：snapshot + peer/joined|changed|left + activity |
| `GET /collab/panel` | 协作面板 HTML |
| `GET/POST /collab/api/bind` | 绑定/信任配置（设置页客户端卡片使用） |
| `POST /collab/api/lock` | 强制重置写者锁（逃生舱） |
| `POST /collab/api/repair` | 触发一次全量修复扫描 |

## 安全边界

`/collab/*` 与 GUI 同信任姿态（无鉴权）；status 暴露的 pid/port 与后端启动打印
一致。LAN 部署的认证/隔离由 bind 与防火墙负责，不在插件内做。
