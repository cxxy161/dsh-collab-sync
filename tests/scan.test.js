/**
 * 帧扫描与严格校验测试。
 */
import { scanZstdFrames, analyzeLines, decodeLine, repairEventLines } from '../lib/repair.js'
import { buildValidLog, buildCorruptLog, compressFrame, eventLine } from './fixtures.js'
import { ok, eq, throws } from './assert.js'

export async function testScanFrames() {
  const buf = buildValidLog({ id: 's1', count: 10 })
  const { frames } = scanZstdFrames(buf)
  eq(frames.length, 2, 'valid log has 2 frames')
  eq(frames[1].end, buf.length, 'last frame ends at buffer end')
  ok(frames[0].start === 0, 'first frame starts at 0')
  eq(frames[1].start, frames[0].end, 'frames are contiguous')
}

export async function testTornTail() {
  const buf = buildValidLog({ id: 's2', count: 5 })
  const torn = Buffer.concat([buf, Buffer.from([0x28, 0xb5, 0x2f])])
  const { frames, tornStart } = scanZstdFrames(torn)
  eq(frames.length, 2, 'complete frames still located')
  eq(tornStart, frames[1].end, 'torn tail starts after last complete frame')
}

export async function testBadMagic() {
  const bad = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x00, 0x00, 0x00])
  throws(() => scanZstdFrames(bad), /invalid frame magic/, 'bad magic rejected')
}

export async function testReservedDescriptorBit() {
  const buf = Buffer.from(buildValidLog({ id: 's3', count: 3 }))
  buf[4] |= 0x08 // descriptor 保留位
  throws(() => scanZstdFrames(buf), /reserved frame-header bit/, 'reserved bit rejected')
}

export async function testAnalyzeValid() {
  const buf = buildValidLog({ id: 's4', count: 7 })
  const { frames } = scanZstdFrames(buf)
  // 手工解压拼行再走 analyzeLines（与 repairFile 内部路径一致）
  const { zstdDecompressSync } = await import('node:zlib')
  const plaintext = frames
    .map((f) => zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8'))
    .join('')
  const lines = plaintext.split('\n')
  lines.pop()
  const analysis = analyzeLines(lines)
  ok(analysis.ok, 'valid log analyzes clean')
  eq(analysis.eventCount, 7, 'event count matches')
  eq(analysis.header.id, 's4', 'header parsed')
}

export async function testAnalyzeCorrupt() {
  const buf = buildCorruptLog()
  const { zstdDecompressSync } = await import('node:zlib')
  const { frames } = scanZstdFrames(buf)
  const plaintext = frames
    .map((f) => zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8'))
    .join('')
  const lines = plaintext.split('\n')
  lines.pop()
  const analysis = analyzeLines(lines)
  ok(!analysis.ok, 'corrupt log flagged')
  eq(analysis.issue.expected, 10, 'first strict gap at seq 10')
  eq(analysis.issue.got, 5, 'got seq 5 (rollback of competing branch)')
}

export async function testRepairEventLinesKeepsLongerBranch() {
  // prefix 0..4, A=5..9, B=5..12 → 保留 B（分叉点 run 更长），丢弃 A
  const buf = buildCorruptLog()
  const { zstdDecompressSync } = await import('node:zlib')
  const { frames } = scanZstdFrames(buf)
  const plaintext = frames
    .map((f) => zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8'))
    .join('')
  const lines = plaintext.split('\n')
  lines.pop()
  const result = repairEventLines(lines.slice(1))
  ok(result.changed, 'repair changed the log')
  ok(result.kept !== null, 'repair produced kept lines')
  // 校验连续性
  let idx = 0
  for (const text of result.kept) {
    const dec = decodeLine(text)
    if (dec.first !== idx) throw new Error(`seq gap at ${idx}: got ${dec.first}`)
    idx += dec.count
  }
  eq(idx, 13, 'contiguous 0..12 after repair')
  // 内容：B 分支（5..12）保留，A 分支（5..9）被丢弃
  const keptText = result.kept.join('\n')
  ok(keptText.includes('msg-B-5'), 'B branch kept')
  ok(!keptText.includes('msg-A-5'), 'A branch dropped')
}

export async function testCleanLinesUnchanged() {
  const lines = []
  for (let i = 0; i < 5; i++) lines.push(eventLine(i))
  const result = repairEventLines(lines)
  eq(result.changed, false, 'clean lines untouched')
  eq(result.kept.length, 5, 'all lines kept')
}
