/**
 * 文件级修复测试：repairFile / scanSessionsRoot / createEnsureRepaired。
 */
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  scanZstdFrames,
  decompressFrame,
  repairFile,
  scanSessionsRoot,
  createEnsureRepaired,
  analyzeLines,
  readHeaderLine,
} from '../lib/repair.js'
import { buildValidLog, buildCorruptLog, makeTempDir } from './fixtures.js'
import { ok, eq } from './assert.js'

export async function testRepairFileClean() {
  const dir = makeTempDir()
  const path = join(dir, 'session.jsonl.zstd')
  writeFileSync(path, buildValidLog({ id: 'clean-1', count: 20 }))
  const report = repairFile(path)
  eq(report.status, 'clean', 'healthy file is clean')
  eq(report.detail.eventCount, 20, '20 events')
  ok(!existsSync(path + '.corrupt.bak'), 'no backup for clean file')
  rmSync(dir, { recursive: true, force: true })
}

export async function testRepairFileCorrupt() {
  const dir = makeTempDir()
  const path = join(dir, 'session.jsonl.zstd')
  const original = buildCorruptLog({ id: 'corrupt-1' })
  writeFileSync(path, original)

  const report = repairFile(path)
  eq(report.status, 'repaired', 'corrupt file repaired')
  ok(report.detail.backupPath.endsWith('.corrupt.bak'), 'backup created')
  ok(existsSync(report.detail.backupPath), 'backup exists on disk')
  ok(Buffer.compare(readFileSync(report.detail.backupPath), original) === 0, 'backup is byte-identical original')

  // 修复后文件：两帧、帧1 恰一行 header、seq 连续
  const bytes = readFileSync(path)
  const { frames } = scanZstdFrames(bytes)
  eq(frames.length, 2, 'rebuilt file has exactly 2 frames')
  const frame1 = decompressFrame(bytes.subarray(frames[0].start, frames[0].end)).toString('utf8')
  ok(frame1.endsWith('\n') && frame1.indexOf('\n') === frame1.length - 1, 'frame 1 is exactly one header line')
  const plaintext = decompressFrame(bytes.subarray(frames[1].start, frames[1].end)).toString('utf8')
  const lines = [frame1.slice(0, -1), ...plaintext.split('\n').filter((l) => l.length > 0)]
  const analysis = analyzeLines(lines)
  ok(analysis.ok, 'repaired file passes strict scan')
  eq(analysis.eventCount, 13, 'events 0..12 (5 prefix + B 5..12)')
  ok(analysis.header.id === 'corrupt-1', 'header id intact')
  rmSync(dir, { recursive: true, force: true })
}

export async function testRepairFileIdempotent() {
  const dir = makeTempDir()
  const path = join(dir, 'session.jsonl.zstd')
  writeFileSync(path, buildCorruptLog({ id: 'corrupt-2' }))
  const first = repairFile(path)
  eq(first.status, 'repaired', 'first repair')
  const second = repairFile(path)
  eq(second.status, 'clean', 'second pass is clean (idempotent)')
  rmSync(dir, { recursive: true, force: true })
}

export async function testScanRoot() {
  const dir = makeTempDir()
  // 一个健康 + 一个损坏
  mkdirSync(join(dir, 'proj-a', 'session-aaa'), { recursive: true })
  mkdirSync(join(dir, 'proj-a', 'session-bbb'), { recursive: true })
  writeFileSync(join(dir, 'proj-a', 'session-aaa', 'session.jsonl.zstd'), buildValidLog({ id: 'aaa', count: 3 }))
  writeFileSync(join(dir, 'proj-a', 'session-bbb', 'session.jsonl.zstd'), buildCorruptLog({ id: 'bbb' }))
  // 旧备份文件不应被扫描
  writeFileSync(join(dir, 'proj-a', 'session-bbb', 'session.jsonl.zstd.corrupt.bak'), Buffer.from('x'))

  const { stats, index, reports } = scanSessionsRoot(dir)
  eq(stats.scanned, 2, 'scanned 2 session logs (backup skipped)')
  eq(stats.clean, 1, '1 clean')
  eq(stats.repaired, 1, '1 repaired')
  eq(index.get('aaa'), join(dir, 'proj-a', 'session-aaa', 'session.jsonl.zstd'), 'index maps aaa')
  eq(index.get('bbb'), join(dir, 'proj-a', 'session-bbb', 'session.jsonl.zstd'), 'index maps bbb')
  ok(reports.every((r) => r.status === 'clean' || r.status === 'repaired'), 'all reports healthy/repaired')
  rmSync(dir, { recursive: true, force: true })
}

export async function testEnsureRepairedMemoized() {
  const dir = makeTempDir()
  const path = join(dir, 'session.jsonl.zstd')
  writeFileSync(path, buildCorruptLog({ id: 'memo-1' }))
  const ensure = createEnsureRepaired({ root: dir, backupSuffix: '.corrupt.bak', logger: { warn() {} } })
  const boot = ensure.boot()
  eq(boot.stats.repaired, 1, 'boot repaired 1')
  const r1 = ensure.ensure('memo-1')
  eq(r1.status, 'clean', 'post-boot ensure is clean')
  const r2 = ensure.ensure('memo-1')
  eq(r2.status, 'clean', 'memoized')
  eq(ensure.ensure('does-not-exist').status, 'absent', 'unknown id absent')
  rmSync(dir, { recursive: true, force: true })
}

export async function testReadHeaderLine() {
  const dir = makeTempDir()
  const path = join(dir, 'session.jsonl.zstd')
  writeFileSync(path, buildValidLog({ id: 'header-1', count: 2 }))
  const line = readHeaderLine(path)
  ok(line !== null && line.includes('"header-1"'), 'header line readable from zstd')
  rmSync(dir, { recursive: true, force: true })
}
