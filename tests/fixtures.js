/**
 * 测试夹具：生成合法/损坏的会话日志（Zstd 两帧结构，与官方写入格式一致）。
 */
import { constants, zstdCompressSync } from 'node:zlib'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const ZSTD_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

export function compressFrame(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'), ZSTD_OPTIONS)
}

export function eventLine(seq, tag = 'user') {
  return JSON.stringify({
    type: 'user/message',
    seq,
    time: 1700000000000 + seq,
    data: { content: `msg-${tag}-${seq}`, source: { kind: 'user' } },
  })
}

export function headerLine(id = 'test-session') {
  return JSON.stringify({ type: 'session', version: 0, id, createdAt: 1700000000000, delegationDepth: 0 })
}

/** 构造一个合法会话日志：header 帧 + 事件帧。 */
export function buildValidLog({ id, count, start = 0 }) {
  const h = headerLine(id)
  const events = []
  for (let i = start; i < start + count; i++) events.push(eventLine(i))
  return Buffer.concat([
    compressFrame(`${h}\n`),
    compressFrame(`${events.join('\n')}\n`),
  ])
}

/**
 * 构造损坏日志：header + 公共前缀 + 冲突段 A + 冲突段 B（seq 重叠回跳），
 * 每段独立成帧 —— 复刻「两实例并发追加」的产物。
 * @param {{prefix?:number, aStart?:number, aEnd?:number, bStart?:number, bEnd?:number, id?:string}} opts
 */
export function buildCorruptLog(opts = {}) {
  const { prefix = 5, aStart = 5, aEnd = 9, bStart = 5, bEnd = 12, id = 'test-session' } = opts
  const h = headerLine(id)
  const prefixEvents = []
  for (let i = 0; i < prefix; i++) prefixEvents.push(eventLine(i))
  const aEvents = []
  for (let i = aStart; i <= aEnd; i++) aEvents.push(eventLine(i, 'A'))
  const bEvents = []
  for (let i = bStart; i <= bEnd; i++) bEvents.push(eventLine(i, 'B'))
  return Buffer.concat([
    compressFrame(`${h}\n`),
    compressFrame(`${prefixEvents.join('\n')}\n`),
    compressFrame(`${aEvents.join('\n')}\n`),
    compressFrame(`${bEvents.join('\n')}\n`),
  ])
}

/** 创建临时目录。 */
export function makeTempDir(prefix = 'dsh-collab-test-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

export { join }
