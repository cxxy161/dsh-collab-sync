/**
 * dsh-collab-sync — 单写者锁（跨进程互斥）
 *
 * 同一 `$DSH_HOME/sessions` 只允许一个 dsh 进程写会话日志。锁文件带心跳，
 * 崩溃/断电后按「心跳陈旧 + PID 探活」判定是否可偷锁，避免第二个后端并发
 * append 同一个 session.jsonl.zstd 造成 seq 分叉损坏。
 */
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export const LOCK_FILE_NAME = '.dsh-collab-writer.lock'

/** POSIX 探活：进程存在返回 true；EPERM（存在但无权信号）也算存活。 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** 尽力而为的进程退出清理（进程被 kill -9 时由心跳陈旧逻辑接管）。 */
const exitHooks = new WeakSet()

export class WriterLock {
  constructor(options) {
    this.root = options.root
    this.mode = options.mode ?? 'auto'
    this.staleAfterMs = options.staleAfterMs ?? 15000
    this.heartbeatMs = options.heartbeatMs ?? 5000
    this.logger = options.logger ?? console
    this.port = options.port ?? null
    this.path = join(this.root, LOCK_FILE_NAME)
    this.token = randomUUID()
    this.owned = false
    this.timer = null
    this.holder = null
    this.degraded = false
  }

  get isWriter() {
    return this.owned
  }

  /**
   * 锁冲突时降级为只读跟随者（不持锁、不写）。
   * 调用后 assertCanWrite() 按 readonly 语义拒绝写入。
   */
  degrade() {
    this.mode = 'readonly'
    this.degraded = true
  }

  /**
   * 获取写者锁。同步执行（apply 阶段快速失败）。
   * @returns {{ok:true, stolen?:boolean}|{ok:false, reason:string, holder?:object, path?:string}}
   */
  acquire() {
    if (this.mode === 'readonly' || this.mode === 'off') {
      return { ok: false, reason: this.mode }
    }
    mkdirSync(this.root, { recursive: true })
    try {
      this.#create()
      this.#installExitHook()
      return { ok: true }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const inspected = this.#inspect()
      if (inspected.live) {
        return {
          ok: false,
          reason: 'conflict',
          holder: inspected.payload,
          path: this.path,
        }
      }
      // 陈旧锁：改名后重建（原子偷锁）
      this.#steal(inspected)
      this.#create()
      this.#installExitHook()
      return { ok: true, stolen: true }
    }
  }

  /** 释放锁（仅当仍是自己的 token 时删除）。 */
  release() {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (!this.owned) return
    this.owned = false
    try {
      if (this.#ownsToken()) unlinkSync(this.path)
    } catch (error) {
      this.logger.warn?.(`dsh-collab-sync: lock release failed: ${String(error)}`)
    }
  }

  /**
   * Per-write guard: this process must own the writer lock before appending.
   * Self-heals: if the lock was lost (reload glitch, stale cleanup, degraded
   * follower being actively used), re-acquire it on demand. Only a LIVE
   * conflicting writer makes the write fail — loudly, never silently corrupting.
   */
  assertCanWrite() {
    if (this.mode === 'off') throw new Error('dsh-collab-sync: disabled (mode=off)')
    if (!this.owned) {
      // Self-heal: try to become the writer on demand.
      // A degraded auto-follower (not an explicit mode=readonly) may promote itself.
      const prevMode = this.mode
      if (this.mode === 'readonly' && this.degraded) this.mode = 'auto'
      const result = this.acquire()
      if (!result.ok) {
        this.mode = prevMode
        if (result.reason === 'readonly') {
          throw new Error(
            'dsh-collab-sync: read-only follower refuses to write the shared session log ' +
              '(mode=readonly); send messages from the writer instance instead',
          )
        }
        const holder = result.holder ?? {}
        throw new Error(
          `dsh-collab-sync: writer lock is held by pid ${holder.pid ?? '?'} @ ${holder.hostname ?? '?'}` +
            (holder.port ? ` (port ${holder.port})` : '') +
            '; refusing to append the session log (single-writer contract)',
        )
      }
      this.degraded = false
      this.logger.info?.('dsh-collab-sync: promoted to writer on demand (lock re-acquired)')
    }
    if (!this.#ownsToken()) {
      throw new Error(
        'dsh-collab-sync: writer lock was replaced or stolen; refusing to append the session log ' +
          'to avoid sequence divergence',
      )
    }
  }

  /** 供 /collab/api/status 与工具使用的快照。 */
  status() {
    return {
      mode: this.mode,
      owned: this.owned,
      degraded: this.degraded,
      path: this.path,
      holder: this.#readPayload(),
    }
  }

  #payload(now) {
    return {
      token: this.token,
      pid: process.pid,
      hostname: hostname(),
      startedAt: now,
      heartbeatAt: now,
      port: this.port,
      version: 1,
    }
  }

  #create() {
    const fd = openSync(this.path, 'wx')
    try {
      const now = Date.now()
      this.holder = this.#payload(now)
      writeFileSync(fd, JSON.stringify(this.holder))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    this.owned = true
    this.#startHeartbeat()
  }

  #startHeartbeat() {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = setInterval(() => {
      if (!this.owned) return
      try {
        const now = Date.now()
        this.holder = this.#payload(now)
        writeFileSync(this.path, JSON.stringify(this.holder))
      } catch (error) {
        this.logger.warn?.(`dsh-collab-sync: lock heartbeat failed: ${String(error)}`)
      }
    }, this.heartbeatMs)
    // 心跳不阻止进程退出
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  #installExitHook() {
    if (exitHooks.has(this)) return
    exitHooks.add(this)
    process.on('exit', () => {
      try {
        if (this.owned && this.#ownsToken()) unlinkSync(this.path)
      } catch {
        /* 退出路径尽力而为 */
      }
    })
  }

  #readPayload() {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8'))
    } catch {
      return null
    }
  }

  #ownsToken() {
    const payload = this.#readPayload()
    return payload !== null && payload.token === this.token
  }

  /** 判定锁是否被「活着」的持有者占用。 */
  #inspect() {
    const payload = this.#readPayload()
    const now = Date.now()
    if (payload === null) return { payload: null, live: false }
    const heartbeatAt = typeof payload.heartbeatAt === 'number' ? payload.heartbeatAt : 0
    const sameHost = payload.hostname === hostname()
    const pidAliveNow = sameHost && pidAlive(payload.pid)
    const heartbeatFresh = now - heartbeatAt <= this.staleAfterMs
    const live = pidAliveNow || heartbeatFresh
    return { payload, live }
  }

  #steal(inspected) {
    try {
      renameSync(this.path, `${this.path}.stale-${Date.now()}`)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    this.logger.warn?.(
      'dsh-collab-sync: stole stale writer lock' +
        (inspected?.payload ? ` from ${inspected.payload.pid}@${inspected.payload.hostname}` : ''),
    )
  }
}
