# dsh-collab-sync

单后端、多终端无缝同步协作插件 —— 面向 DeepSeek Harness（dsh）Web GUI。

> Single-backend, multi-terminal collaboration for the DeepSeek Harness Web GUI.

## 核心亮点（重中之重）

1. **远程设备也能用设置页** —— 修复 dsh 原生 bug：非 `127.0.0.1` 来源（LAN /
   tailnet / 手机）打开「设置 → 插件」等页面**一片空白**。根因是客户端把远程
   来源的设置作用域判为 `memory/unavailable`；本插件把三处回环门禁改为
   `host`，远程设备可正常读写设置（`scripts/setup-bind.sh` 幂等应用，服务端
   `trustedHosts` 放行配套）。
2. **设置页内直接调整开放范围** —— 「设置 → 开放 IP / 协作」卡片：选
   「全部接口 0.0.0.0 / 仅本机 / 指定 IP」+ 额外信任主机，保存到
   `~/.dsh/.env`，重启生效。这是多设备共同工作的**总开关**：一个后端、所有
   IP 可达、浏览器经 mux 实时同步。

## 为什么开发这个插件

做多终端协作（电脑 + 手机 + 多台设备同时操作同一个 dsh）时，踩到过一个真实的坑：

- 为了让 tailnet / 局域网都能访问，曾同时跑**两个 dsh web 实例**（各自绑定一个 IP），
  它们**并发追加写同一份 `~/.dsh/sessions/**/session.jsonl.zstd`**；
- dsh 会话日志是"追加式 + 事件 seq 严格连续"的 Zstd/JSONL 文件，seq 由各进程
  **内存中的日志长度**独立分配；
- 两个进程同时追加 → seq 分叉/重复 → 官方读取端报
  **`corrupt session log: seq gap in committed region`** → 整个会话历史无法加载，
  只能手工拆帧、删冲突分支、按"两帧 Zstd"规范重拼文件救回。

复盘后的结论：**"同步"才是正解，锁只是保险丝。**

- dsh 原生的实时同步机制（mux 广播）要求**所有终端连同一个后端进程**——单进程
  天然持锁、永不冲突、永不当人；
- 插件把"多 IP 指向同一个后端"（`0.0.0.0` 绑定 + 信任主机配置）做成显式控制面；
- 单写者锁只负责挡住"第二个进程"这个病根，并且**写路径守卫永不阻断你的回合**
  （锁异常时响亮告警、跳过落盘，而不是让对话失败）；
- 对已经损坏的历史日志，启动时**自动扫描修复**（选最长连续分支重建 + 备份），
  你不再需要手工拆文件。

## 解决什么问题

多个终端（电脑/手机浏览器）同时开着同一个 dsh WebUI 协作时：

- **防损坏**：多个 dsh 进程并发追加写同一个会话日志 → seq 分叉损坏。本插件用
  **单写者锁**从根上禁止并发写：第一个后端成为写者，其余后端**自动降级为只读
  跟随者**（不崩、不抢锁、不写）；`mode: writer` 下第二实例快速失败。
- **自修复**：启动时自动扫描全部会话日志，对损坏文件执行「选最长连续分支 →
  重建合法两帧 Zstd → 原子替换 + 原件备份 `.corrupt.bak`」。
- **写路径兜底**：每次落盘前校验锁身份；锁异常时**告警并跳过落盘**（回合不失败、
  文件不损坏）。
- **多终端感知**：设置页「开放 IP / 协作」分区（监听范围、信任主机、写者诊断、
  修复统计、强制重置锁逃生舱）。
- **多 IP 多端访问**：原生 dsh 拒绝 `--host 0.0.0.0`，本插件让 webserver 支持
  全部接口绑定（`DSH_WEB_BIND=0.0.0.0`），tailnet / LAN / 本机所有 IP 可达
  同一个后端。

> 说明：单后端下跨端**实时同步**本身由 dsh 自带的 mux 广播承担（每个浏览器都会
> 收到全部 `session/event`）。本插件负责把它变成安全、可感知、可自愈的形态。

## 安装

前提：已按官方方式安装 DeepSeek Harness（`npm i -g @deepseek-ai/dsh`，`dsh`
为官方 CLI）。本插件**不依赖任何自定义启动脚本**。

### 方式 A：git clone + 官方装配（推荐，持久，需重启）

```bash
git clone https://github.com/cxxy161/dsh-collab-sync.git
dsh plugin --profile web add ./dsh-collab-sync
# 重启 dsh web
```

`package.json` 声明了 `dsh.bundle.patch`，`dsh plugin add` 会自动把它加入
`dsh.profile.bundles`，重启后由 profile 层装配。

### 方式 B：运行时注入（免重启）

使用 [dsh-super-injector](https://github.com/yjh051108/dsh-super-injector)：

```
dev_inject_plugin dir=/path/to/dsh-collab-sync
```

### 卸载

- 方式 A：`dsh plugin --profile web remove dsh-collab-sync` 后重启。
- 方式 B：`dev_uninject_plugin match=dsh-collab-sync`。

## 配置

插件行（bundle patch 默认值）：

```yaml
- insert:
    - id: dsh-collab-sync
      name: dsh-collab-sync
      config:
        mode: auto            # auto|writer|readonly|off
        lockStaleAfterMs: 15000
        heartbeatMs: 5000
        repairOnBoot: true
        repairBackupSuffix: '.corrupt.bak'
        presence: true
```

| 配置 | 说明 |
|---|---|
| `mode: auto` | 尝试持锁；锁被存活实例占用 → **自动降级为只读跟随者**（不崩、不抢锁、不写） |
| `mode: writer` | 必须成为写者；锁冲突 → 启动快速失败（严格单后端） |
| `mode: readonly` | 不持锁、不修复，所有写入被守卫拒绝（只读跟随） |
| `mode: off` | 完全禁用 |
| `lockStaleAfterMs` | 锁心跳陈旧阈值（跨机共享 sessions 目录时调大） |
| `repairOnBoot` | 启动时全量扫描并修复损坏日志 |
| `presence` | 开启 `/collab/*` 路由与设置页协作分区 |

## 多 IP 多端访问（0.0.0.0 绑定）

- **默认**：webserver `host` 优先级为
  `命令行 --host > 环境变量 DSH_WEB_BIND > 127.0.0.1`（安全回退，不擅自开放
  全部接口）。
- **设置入口**：dsh 设置页 → **「开放 IP / 协作」** 分区（客户端插件注册）——
  选择「全部接口 0.0.0.0 / 仅本机 127.0.0.1 / 指定 IP」，填写额外信任主机，
  保存到 `~/.dsh/.env`（`DSH_WEB_BIND` / `DSH_WEB_EXTRA_TRUSTED`），
  **重启 dsh web 后生效**（不触发热重载，避免路由丢失/断连）。
  这是开放多 IP 的**显式控制面**：选 0.0.0.0 后 tailnet / LAN / 本机 IP 全部
  可达同一个后端。
- **指定 IP 绑定**：原生 host schema 只允许 127.0.0.1/0.0.0.0，需要先运行一次
  `scripts/setup-bind.sh`（幂等）把校验放宽为 `z.string()`；设置页会在未放宽时
  给出提示。绑定 0.0.0.0 时本机所有局域网 IP 自动进入 `trustedHosts`（dsh 自带
  的 LAN 推导），无需额外配置。
- **多实例兼容（不崩、不损坏）**：若同 `DSH_HOME` 下起了多个 `dsh web`
  （如每个 IP 一个实例），第一个实例为**写者**，其余自动降级为**只读跟随者**
  —— 服务 UI、拒绝写入，从根上杜绝并发写损坏。
- **推荐形态**：多 IP 指向**同一个**后端（0.0.0.0），浏览器经 mux 实时同步；
  只读跟随者之间不做进程内事件推送，视图为磁盘已落盘状态。

## 使用

- 开放 IP / 协作：设置页 → 「开放 IP / 协作」分区（监听范围、信任主机、写者诊断、修复统计、强制重置写者锁）。
- 状态 JSON：`GET /collab/api/status`；绑定信息：`GET /collab/api/bind`。
- Agent 工具：
  - `collab_status` —— 查看写者/在线终端/修复统计
  - `collab_repair` —— 修复指定 `sessionId`/`path`，或不带参数全量扫描

## 会话日志修复

- 触发时机：后端启动（`repairOnBoot`）、`collab_repair` 工具、`POST /collab/api/repair`、
  会话被读取前（守卫自动确保）。
- 备份：损坏原件保留为 `<file>.corrupt.bak`（已存在则加序号）。
- 无法裁决（如多个分支平分秋色）时保守跳过并记录，不删除任何数据。
- live 会话不会被修复（避免与内存状态分叉）；重启后端即可。

## 故障排查

| 现象 | 处理 |
|---|---|
| 第二个后端启动显示「降级为只读跟随者」 | 正常：自动降级，不写日志；写者身份见设置页「开放 IP / 协作」或 `/collab/api/status`。需要实时同步请改用单后端 0.0.0.0 |
| 锁异常卡住解不开 | 设置页「开放 IP / 协作」底部「强制重置写者锁」逃生舱（确认其他后端已停止后使用），无需再关插件 |
| 第二个后端（`mode: writer`）启动报「another dsh instance already owns session root」 | 严格单后端模式：停掉运行中的实例，或换 `DSH_HOME`，或改回 `mode: auto`/`readonly` |
| 日志 `corrupt session log: seq gap in committed region` | 运行 `collab_repair` 或重启后端（启动扫描自动修复）；原件在 `.corrupt.bak` |
| 设置页无「开放 IP / 协作」分区 | 需重启 dsh（客户端清单在启动时扫描装配） |
| 跨机器共享 `~/.dsh`（NFS） | 调大 `lockStaleAfterMs`，心跳仍按各自机器时钟 |

## 开发

```bash
node tests/run-all.js             # 单元回归（帧扫描/分叉修复/锁/绑定）
node scripts/build-client.mjs     # 修改 src/client.js 后重建 lib/client.js（内联 react）
```

宿主纯 JS；客户端（设置页卡片）由 `src/client.js` + `scripts/build-client.mjs`
构建为 `lib/client.js`（内联 react，安装无需构建）。运行时依赖
`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-host-webserver`
与 Node 内置 `node:zlib`（zstd）。

## License

MIT
