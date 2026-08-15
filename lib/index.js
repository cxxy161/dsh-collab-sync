/**
 * dsh-collab-sync — 单后端多终端无缝同步协作插件
 *
 * 职责：
 *  1. 单写者锁：同一会话根目录只允许一个 dsh 进程写日志（防并发 append 损坏）；
 *  2. 会话日志自修复：启动时扫描并重建 seq 分叉的损坏日志（两帧 Zstd）；
 *  3. 写路径守卫：每次落盘前校验锁身份，锁丢失/readonly 拒绝写入；
 *  4. 多终端感知：设置页「开放 IP / 协作」分区 + /collab/panel 协作面板 + collab_status/repair 工具。
 *
 * 纯 JS 实现，不修改任何 dsh 包源码；经 cordis.patch.yml（bundle patch）装配。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { WriterLock } from './lock.js'
import { createEnsureRepaired, repairFile, scanSessionsRoot } from './repair.js'
import { installGuard } from './guard.js'
import {
  PresenceHub,
  createPresenceRoute,
  createStatusHandler,
  createRepairHandler,
} from './presence.js'
import { createPanelHandler } from './panel.js'
import { createBindHandler, createLockHandler, effectiveBindStatus } from './bind.js'

export const name = 'dsh-collab-sync'
export const version = '0.1.0'
export const inject = ['webServer']

const DEFAULTS = {
  mode: 'auto', // auto | writer | readonly | off
  lockStaleAfterMs: 15000,
  heartbeatMs: 5000,
  repairOnBoot: true,
  repairBackupSuffix: '.corrupt.bak',
  presence: true,
}

/** 默认会话根目录：$DSH_HOME/sessions（与 dshHomePath('sessions') 一致）。 */
function defaultSessionsRoot() {
  const env = process.env.DSH_HOME
  const home = env !== undefined && env.trim().length > 0 ? env : join(homedir(), '.dsh')
  return join(home, 'sessions')
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  if (cfg.mode === 'off') {
    ctx.logger?.info?.('dsh-collab-sync: disabled (mode=off)')
    return
  }
  const root = cfg.root !== undefined ? resolve(cfg.root) : defaultSessionsRoot()
  const logger = ctx.logger ?? console

  // ── 1) 单写者锁 ────────────────────────────────────────────────────────────
  const lock = new WriterLock({
    root,
    mode: cfg.mode,
    staleAfterMs: cfg.lockStaleAfterMs,
    heartbeatMs: cfg.heartbeatMs,
    logger,
    port: ctx.webServer?.port ?? null,
  })
  const acquired = lock.acquire()
  if (!acquired.ok) {
    if (acquired.reason === 'readonly') {
      logger.info?.('dsh-collab-sync: 只读跟随者模式 —— 不获取写者锁')
    } else if (acquired.reason === 'conflict') {
      const holder = acquired.holder ?? {}
      if (cfg.mode === 'writer') {
        // Strict single-backend mode: a second writer fails fast.
        throw new Error(
          `dsh-collab-sync: 另一个 dsh 实例已持有会话根目录的写者锁 ${acquired.path}\n` +
            `  持有者: pid ${holder.pid ?? '?'} @ ${holder.hostname ?? '?'}，启动于 ${holder.startedAt ?? '?'}` +
            (holder.port ? `，端口 ${holder.port}` : '') +
            `\n单写者约束（mode=writer）：同一会话只能由一个 dsh 进程写入。` +
            `请停止运行中的实例、更换 DSH_HOME，或改用 mode: auto / readonly。`,
        )
      }
      // Default (auto): degrade to a read-only follower — no crash, no lock
      // steal, no writes. Compatible with multi-IP multi-instance deployments.
      lock.degrade()
      logger.warn?.(
        `dsh-collab-sync: 写者锁被 pid ${holder.pid ?? '?'} @ ${holder.hostname ?? '?'}` +
          (holder.port ? `（端口 ${holder.port}）` : '') +
          ' 持有 —— 本实例降级为只读跟随者（服务 UI、拒绝写入）。\n' +
          '  收到消息时跟随者可按需晋升为写者；若仍被占用会给出中文提示。\n' +
          '  实时多端同步推荐：只运行一个后端并绑定 0.0.0.0（见 设置 → 开放 IP / 协作）。',
      )
    }
  }
  ctx.effect(() => () => lock.release(), 'dsh-collab-sync: writer lock')

  // ── 2) 会话日志修复器（只由写者执行；live 会话跳过修复）───────────────────
  const ensureRepaired = createEnsureRepaired({
    root,
    backupSuffix: cfg.repairBackupSuffix,
    logger,
    isLive: (id) => ctx.get('sessions')?.get(id) !== undefined,
  })
  let bootRepairs = { stats: null, reports: [] }
  if (cfg.repairOnBoot && lock.isWriter) {
    bootRepairs = ensureRepaired.boot()
    const s = bootRepairs.stats
    logger.info?.(`dsh-collab-sync: 启动扫描 — 共 ${s.scanned}，健康 ${s.clean}，已修复 ${s.repaired}，跳过 ${s.skipped}，失败 ${s.unrecoverable}`)
  }

  // ── 3) 写路径守卫（appendBatch 拒写 + 读取前修复）─────────────────────────
  installGuard(ctx, {
    canWrite: () => lock.canWrite(),
    ensure: (sessionId) => ensureRepaired.ensure(sessionId),
  })

  // ── 4) 多终端感知：presence hub（hub 始终存在，供工具/路由使用）────────────
  const hub = new PresenceHub({
    logger,
    getWriterStatus: () => lock.status(),
  })
  if (cfg.presence) {
    const disposers = []
    const register = (route) => {
      disposers.push(ctx.webServer.register(route))
    }
    register({
      kind: 'exact',
      path: '/collab/api/status',
      handler: createStatusHandler({
        getWriterStatus: () => lock.status(),
        hub,
        getRepairs: () => ({ stats: bootRepairs.stats, reports: bootRepairs.reports.slice(-20) }),
        getBind: () => effectiveBindStatus(ctx),
      }),
    })
    register({ kind: 'exact', path: '/collab/presence', handler: createPresenceRoute(hub) })
    register({ kind: 'exact', path: '/collab/panel', handler: createPanelHandler() })
    register({
      kind: 'exact',
      path: '/collab/api/bind',
      handler: createBindHandler({ ctx, logger }),
    })
    register({
      kind: 'exact',
      path: '/collab/api/lock',
      handler: createLockHandler({ lock, logger }),
    })
    register({
      kind: 'exact',
      path: '/collab/api/repair',
      handler: createRepairHandler({ scan: () => ensureRepaired.boot() }),
    })

    // 活动感知：session/event → 广播 activity
    const offEvent = ctx.on('session/event', () => hub.onActivity('session/event'))
    ctx.effect(
      () => () => {
        for (const dispose of disposers) dispose()
        offEvent()
      },
      'dsh-collab-sync: routes + activity',
    )
  }

  // ── 5) agent 工具 ──────────────────────────────────────────────────────────
  const collabState = () => ({
    version,
    mode: cfg.mode,
    writer: lock.status(),
    root,
    peers: hub.list(),
    repairs: bootRepairs.stats,
  })
  ctx.inject(['tools'], (toolsCtx) => {
    const registerTool = (tool) => {
      toolsCtx.effect(() => toolsCtx.tools.register(tool), `dsh-collab-sync: ${tool.name}`)
    }
    registerTool(
      defineTool({
        name: 'collab_status',
        description:
          '查看 dsh-collab-sync 多终端协作状态：单写者锁持有者（pid/host/端口）、在线终端列表、会话日志修复统计。',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        execute: () => JSON.stringify(collabState(), null, 2),
      }),
    )
    registerTool(
      defineTool({
        name: 'collab_repair',
        description:
          '修复损坏的 dsh 会话日志（seq 分叉）。不传参数 = 全量扫描并修复；传 sessionId 或 path = 修复单个会话日志。返回修复报告。',
        parameters: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: '会话 id（可选）' },
            path: { type: 'string', description: '日志文件绝对路径（可选）' },
          },
          additionalProperties: false,
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        execute: (args = {}) => {
          if (typeof args.path === 'string' && args.path.length > 0) {
            return JSON.stringify(repairFile(args.path, { backupSuffix: cfg.repairBackupSuffix, logger }), null, 2)
          }
          if (typeof args.sessionId === 'string' && args.sessionId.length > 0) {
            const live = ctx.get('sessions')?.get(args.sessionId) !== undefined
            if (live) return JSON.stringify({ status: 'skipped', reason: '会话正在使用中；请在后端重启后修复' }, null, 2)
            return JSON.stringify(ensureRepaired.ensure(args.sessionId), null, 2)
          }
          const result = scanSessionsRoot(root, {
            backupSuffix: cfg.repairBackupSuffix,
            logger,
            isLive: (id) => ctx.get('sessions')?.get(id) !== undefined,
          })
          return JSON.stringify({ stats: result.stats, reports: result.reports }, null, 2)
        },
      }),
    )
  })
}
