/**
 * 单写者锁测试。
 */
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { hostname } from 'node:os'
import { WriterLock } from '../lib/lock.js'
import { makeTempDir } from './fixtures.js'
import { ok, eq } from './assert.js'
function makeLock(dir, overrides = {}) {
  return new WriterLock({
    root: dir,
    mode: 'auto',
    staleAfterMs: 5000,
    heartbeatMs: 100000, // 测试中不触发心跳重写
    logger: { warn() {}, info() {} },
    ...overrides,
  })
}

export async function testAcquireAndRelease() {
  const dir = makeTempDir()
  const lock = makeLock(dir)
  const acquired = lock.acquire()
  ok(acquired.ok, 'lock acquired')
  ok(lock.isWriter, 'is writer')
  ok(existsSync(lock.path), 'lock file exists')
  ok(lock.canWrite().ok, 'can write (no throw)')
  lock.release()
  ok(!lock.isWriter, 'released')
  ok(!existsSync(lock.path), 'lock file removed on release')
  rmSync(dir, { recursive: true, force: true })
}

export async function testConflictFailsFast() {
  const dir = makeTempDir()
  const first = makeLock(dir)
  ok(first.acquire().ok, 'first acquires')
  const second = makeLock(dir)
  const result = second.acquire()
  eq(result.ok, false, 'second cannot acquire')
  eq(result.reason, 'conflict', 'conflict reason')
  ok(result.holder.pid === process.pid, 'holder reported')
  ok(!second.isWriter, 'second is not writer')
  const verdict = second.canWrite()
  eq(verdict.ok, false, 'second refuses to write')
  ok(/写者锁被 pid/.test(verdict.message ?? ''), 'conflict message (中文报错)')
  first.release()
  rmSync(dir, { recursive: true, force: true })
}

export async function testStaleLockStolen() {
  const dir = makeTempDir()
  mkdirSync(dir, { recursive: true })
  // 模拟陈旧锁：死 pid + 心跳过期
  const stale = {
    token: 'dead-token',
    pid: 99999999,
    hostname: hostname(),
    startedAt: Date.now() - 60000,
    heartbeatAt: Date.now() - 60000,
    version: 1,
  }
  writeFileSync(join(dir, '.dsh-collab-writer.lock'), JSON.stringify(stale))
  const lock = makeLock(dir)
  const result = lock.acquire()
  ok(result.ok, 'stale lock stolen')
  ok(result.stolen, 'stolen flag')
  ok(lock.isWriter, 'now writer')
  lock.release()
  rmSync(dir, { recursive: true, force: true })
}

export async function testReadonlyNeverWrites() {
  const dir = makeTempDir()
  const lock = makeLock(dir, { mode: 'readonly' })
  const result = lock.acquire()
  eq(result.ok, false, 'readonly does not acquire')
  eq(result.reason, 'readonly', 'reason readonly')
  ok(!existsSync(join(dir, '.dsh-collab-writer.lock')), 'no lock file written')
  const verdict = lock.canWrite()
  eq(verdict.ok, false, 'readonly refuses write')
  eq(verdict.reason, 'readonly', 'reason readonly')
  ok(/只读跟随者无法写入/.test(verdict.message ?? ''), 'readonly message (中文报错)')
  rmSync(dir, { recursive: true, force: true })
}

export async function testStolenTokenGuard() {
  const dir = makeTempDir()
  const lock = makeLock(dir)
  ok(lock.acquire().ok, 'acquired')
  // 外部替换锁文件（模拟被偷锁）
  writeFileSync(
    join(dir, '.dsh-collab-writer.lock'),
    JSON.stringify({ token: 'other', pid: 1, hostname: 'other', startedAt: Date.now(), heartbeatAt: Date.now(), version: 1 }),
  )
  const verdict = lock.canWrite()
  eq(verdict.ok, false, 'write refused after lock stolen')
  eq(verdict.reason, 'stolen', 'reason stolen')
  ok(/已被替换或丢失/.test(verdict.message ?? ''), 'stolen message (中文报错)')
  // 释放时不应误删他人的锁
  lock.release()
  ok(existsSync(join(dir, '.dsh-collab-writer.lock')), 'other lock untouched')
  rmSync(dir, { recursive: true, force: true })
}

export async function testDegradeToReadonlyOnConflict() {
  const dir = makeTempDir()
  const first = makeLock(dir)
  ok(first.acquire().ok, 'first acquires')
  const second = makeLock(dir)
  const result = second.acquire()
  eq(result.ok, false, 'second cannot acquire')
  eq(result.reason, 'conflict', 'conflict reason')
  second.degrade()
  eq(second.status().mode, 'readonly', 'degraded to readonly')
  eq(second.status().degraded, true, 'degraded flag set')
  ok(!second.isWriter, 'not writer after degrade')
  // 写者仍存活：降级实例尝试晋升 → 返回冲突（不写、不损坏、不抛错）
  const verdict = second.canWrite()
  eq(verdict.ok, false, 'live conflict fails non-throwing')
  ok(/写者锁被 pid/.test(verdict.message ?? ''), 'conflict message (中文报错)')
  first.release()
  rmSync(dir, { recursive: true, force: true })
}

export async function testSelfHealReacquireOnWrite() {
  const dir = makeTempDir()
  const lock = makeLock(dir)
  ok(lock.acquire().ok, 'acquired')
  lock.release() // 模拟锁丢失（中断的重载/外部清理）
  ok(!lock.isWriter, 'lock released')
  ok(lock.canWrite().ok, 'self-heal: re-acquires on demand (no throw)')
  ok(lock.isWriter, 're-acquired on demand')
  lock.release()
  rmSync(dir, { recursive: true, force: true })
}

export async function testDegradedFollowerSelfPromotesOnWrite() {
  const dir = makeTempDir()
  const first = makeLock(dir)
  ok(first.acquire().ok, 'first acquires')
  const second = makeLock(dir)
  eq(second.acquire().ok, false, 'second conflict')
  second.degrade()
  first.release() // 写者退出，锁释放
  ok(second.canWrite().ok, 'degraded follower promotes on demand')
  ok(second.isWriter, 'degraded follower promoted on demand')
  eq(second.status().degraded, false, 'degraded flag cleared')
  second.release()
  rmSync(dir, { recursive: true, force: true })
}

export async function testLiveConflictFailsNonThrowing() {
  const dir = makeTempDir()
  const first = makeLock(dir)
  ok(first.acquire().ok, 'first acquires')
  const second = makeLock(dir)
  ok(!second.acquire().ok, 'second conflict')
  second.degrade()
  const verdict = second.canWrite()
  eq(verdict.ok, false, 'live conflict fails non-throwing')
  ok(/写者锁被 pid/.test(verdict.message ?? ''), 'conflict message (中文报错)')
  first.release()
  rmSync(dir, { recursive: true, force: true })
}
