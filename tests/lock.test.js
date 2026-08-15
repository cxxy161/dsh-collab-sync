/**
 * 单写者锁测试。
 */
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { hostname } from 'node:os'
import { WriterLock } from '../lib/lock.js'
import { makeTempDir } from './fixtures.js'
import { ok, eq, throws } from './assert.js'

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
  lock.assertCanWrite() // 不抛
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
  throws(() => second.assertCanWrite(), /refusing/, 'second refuses to write')
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
  throws(() => lock.assertCanWrite(), /read-only follower/, 'readonly refuses write')
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
  throws(() => lock.assertCanWrite(), /replaced\/stolen/, 'write refused after lock stolen')
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
  throws(() => second.assertCanWrite(), /read-only follower/, 'refuses write after degrade')
  first.release()
  rmSync(dir, { recursive: true, force: true })
}
