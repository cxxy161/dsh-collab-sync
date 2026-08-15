/**
 * dsh-collab-sync — 会话日志修复器
 *
 * 复刻官方读取端的严格语义（seq 全局连续 + 第一帧恰好一行 header），对损坏的
 * `session.jsonl.zstd` / `session.jsonl` 执行「选最长连续分支 → 重建合法两帧
 * Zstd → 原子替换 + 原件备份」。
 *
 * 与官方写入参数的兼容性：帧压缩使用 `zstdCompressSync(input, { params:
 * { [constants.ZSTD_c_checksumFlag]: 1 } })`（与 dsh-session-persistence-jsonl
 * 的 `compressZstdFrame` 一致）。
 */
import {
  constants,
  zstdCompressSync,
  zstdDecompressSync,
} from 'node:zlib'
import { decodeStorageRecord } from '@deepseek-ai/dsh-session'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export const ZSTD_MAGIC = 0xfd2fb528
export const SESSION_FILE_NAMES = new Set(['session.jsonl.zstd', 'session.jsonl'])

const ZSTD_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

// ── zstd 帧定位（复刻 dsh-session-persistence-jsonl 的 scanZstdFrames）─────

/**
 * 定位完整 Zstd 帧的字节区间（不解压）。EOF 落在帧内时返回 tornStart。
 * @param {Buffer} buffer
 * @param {number} maxFrames
 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

/** 解压一个完整帧（校验和错误会抛）。 */
export function decompressFrame(buffer) {
  return zstdDecompressSync(buffer)
}

/** 压缩一帧（带内容校验和，与官方写入参数一致）。 */
export function compressFrame(plaintext) {
  return zstdCompressSync(Buffer.from(plaintext, 'utf8'), ZSTD_OPTIONS)
}

// ── 行解码与严格校验 ────────────────────────────────────────────────────────

/**
 * 解析一行 JSONL 为事件信息。
 * @returns {{first:number|null, count:number, contiguous:boolean, error?:string}}
 */
export function decodeLine(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return { first: null, count: 0, contiguous: false, error: 'unparsable-json' }
  }
  let events
  try {
    events = decodeStorageRecord(value)
  } catch (error) {
    return { first: null, count: 0, contiguous: false, error: `decode:${String(error)}` }
  }
  if (!Array.isArray(events) || events.length === 0) {
    return { first: null, count: 0, contiguous: false, error: 'empty-record' }
  }
  const first = events[0]?.seq
  if (!Number.isInteger(first) || first < 0) {
    return { first: null, count: 0, contiguous: false, error: 'bad-seq' }
  }
  let contiguous = true
  for (let i = 0; i < events.length; i++) {
    if (events[i].seq !== first + i) {
      contiguous = false
      break
    }
  }
  return { first, count: events.length, contiguous }
}

/** 校验 header 行是否为合法会话头（不校验全字段，避免误伤未来版本）。 */
export function parseHeaderLine(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (
    value !== null &&
    typeof value === 'object' &&
    value.type === 'session' &&
    typeof value.id === 'string' &&
    typeof value.version === 'number'
  ) {
    return value
  }
  return null
}

/**
 * 逐行严格扫描（与官方 SessionLogScanner 同语义）。
 * @returns {{ok:boolean, header:object|null, headerLine:string|null,
 *           eventLines:string[], eventCount:number, issue?:object}}
 */
export function analyzeLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return { ok: false, header: null, headerLine: null, eventLines: [], eventCount: 0, issue: { type: 'empty' } }
  }
  const headerLine = lines[0]
  const header = parseHeaderLine(headerLine)
  if (header === null) {
    return { ok: false, header: null, headerLine, eventLines: lines.slice(1), eventCount: 0, issue: { type: 'bad-header' } }
  }
  const eventLines = lines.slice(1)
  let index = 0
  for (let lineNo = 0; lineNo < eventLines.length; lineNo++) {
    const dec = decodeLine(eventLines[lineNo])
    if (dec.error !== undefined || dec.first === null || dec.first !== index) {
      return {
        ok: false,
        header,
        headerLine,
        eventLines,
        eventCount: index,
        issue: {
          type: 'seq-gap',
          line: lineNo + 2,
          expected: index,
          got: dec.first,
        },
      }
    }
    index += dec.count
  }
  return { ok: true, header, headerLine, eventLines, eventCount: index }
}

// ── 分叉裁决：选「最终 seq 最大；并列取内容最少；再并列取更早」的分支 ─────

/**
 * 在损坏区域中挑选最佳连续续接。
 * 裁决顺序：最终 seq 最大 → 分叉点处文件连续 run 最长 → 纳入行数最少
 * （避免混入被覆盖分支的重复内容）→ 文件位置更早。
 * @param {{first:number|null,count:number,contiguous:boolean}[]} decs
 * @param {number} startIdx 期望的起始 seq
 * @returns {{idx:number, run:number, chosen:Set<number>}|null}
 */
function bestContinuation(decs, startIdx) {
  const candidates = []
  for (let i = 0; i < decs.length; i++) {
    if (decs[i].first === startIdx && decs[i].contiguous && decs[i].error === undefined) candidates.push(i)
  }
  if (candidates.length === 0) return null
  let best = null
  for (const p of candidates) {
    let idx = startIdx
    const chosen = new Set()
    let run = 0
    for (let q = p; q < decs.length; q++) {
      const d = decs[q]
      if (d.first === idx && d.contiguous && d.error === undefined) {
        chosen.add(q)
        idx += d.count
        if (run === q - p) run += 1 // 仅统计从 p 起的文件序连续段
      }
    }
    const better =
      best === null ||
      idx > best.idx ||
      (idx === best.idx && run > best.run) ||
      (idx === best.idx && run === best.run && chosen.size < best.chosen.size) ||
      (idx === best.idx && run === best.run && chosen.size === best.chosen.size && p < best.p)
    if (better) best = { idx, run, chosen }
  }
  return best
}

/**
 * 修复事件行：保留最长连续分支，丢弃被覆盖的重复/损坏行。
 *
 * 分叉点检测：先贪心接受 first===idx 的行；遇到 first < idx（seq 回跳/重复，
 * 即另一分支从这里开始）时，分叉点 = first；遇到 first > idx（缺口）时，
 * 分叉点 = idx。冲突区域 = 所有 first >= 分叉点的行（含被贪心误收的竞争分支）。
 * @param {string[]} eventLines 不含 header 的事件行
 * @returns {{kept:string[]|null, dropped:string[], changed:boolean, reason?:string}}
 */
export function repairEventLines(eventLines) {
  // 1) 贪心扫描，定位首个异常与分叉点
  const decsAll = eventLines.map(decodeLine)
  let idx = 0
  let firstAnomaly = -1
  let forkPoint = null
  for (let i = 0; i < decsAll.length; i++) {
    const d = decsAll[i]
    if (d.error !== undefined || d.first === null || d.first !== idx) {
      firstAnomaly = i
      forkPoint = d.first !== null && d.first < idx ? d.first : idx
      break
    }
    idx += d.count
  }
  if (firstAnomaly === -1) return { kept: eventLines, dropped: [], changed: false }

  // 2) 冲突区域起点：异常行位置 与 最早 first>=分叉点的行 取更早
  let regionStart = firstAnomaly
  for (let i = 0; i < decsAll.length; i++) {
    if (decsAll[i].first !== null && decsAll[i].first >= forkPoint) {
      regionStart = Math.min(regionStart, i)
      break
    }
  }
  const prefix = eventLines.slice(0, regionStart)
  const region = eventLines.slice(regionStart)
  const decs = decsAll.slice(regionStart)

  const best = bestContinuation(decs, forkPoint)
  if (best === null || best.idx <= forkPoint) {
    return { kept: null, dropped: [], changed: false, reason: 'no-continuation' }
  }
  const kept = [...prefix]
  const dropped = []
  for (let i = 0; i < region.length; i++) {
    if (best.chosen.has(i)) kept.push(region[i])
    else dropped.push(region[i])
  }
  // 3) 最终严格校验（只校验事件行连续性）
  let v = 0
  for (const text of kept) {
    const dec = decodeLine(text)
    if (dec.error !== undefined || dec.first === null || dec.first !== v) {
      return { kept: null, dropped: [], changed: false, reason: `validation-failed@${v}` }
    }
    v += dec.count
  }
  return { kept, dropped, changed: true, droppedCount: dropped.length }
}

// ── 文件级修复 ──────────────────────────────────────────────────────────────

function fsyncFile(path) {
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function fsyncDir(dir) {
  try {
    const fd = openSync(dir, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    /* 目录 fsync 尽力而为（Windows 不支持） */
  }
}

function atomicReplace(tmpPath, targetPath, bytes) {
  writeFileSync(tmpPath, bytes)
  fsyncFile(tmpPath)
  renameSync(tmpPath, targetPath)
  const idx = targetPath.lastIndexOf('/')
  fsyncDir(idx > 0 ? targetPath.slice(0, idx) : '.')
}

function uniqueBackupPath(path, suffix) {
  if (!existsSync(path + suffix)) return path + suffix
  let n = 1
  while (existsSync(`${path}${suffix}.${n}`)) n += 1
  return `${path}${suffix}.${n}`
}

/** 读取文件首行（zstd 只解第一帧；plaintext 直接读首行）。 */
export function readHeaderLine(path) {
  const bytes = readFileSync(path)
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === ZSTD_MAGIC) {
    const { frames } = scanZstdFrames(bytes, 1)
    if (frames.length === 0) return null
    const plaintext = decompressFrame(bytes.subarray(frames[0].start, frames[0].end))
    const newline = plaintext.indexOf(10)
    if (newline === -1) return null
    return plaintext.subarray(0, newline).toString('utf8')
  }
  const newline = bytes.indexOf(10)
  if (newline === -1) return null
  return bytes.subarray(0, newline).toString('utf8')
}

/**
 * 修复单个会话日志文件。
 * @param {string} path
 * @param {{backupSuffix?:string, logger?:object}} options
 * @returns {{path:string, status:'clean'|'repaired'|'skipped'|'unrecoverable',
 *           detail?:object}}
 */
export function repairFile(path, options = {}) {
  const backupSuffix = options.backupSuffix ?? '.corrupt.bak'
  const logger = options.logger ?? console
  const bytes = readFileSync(path)
  const isZstd = bytes.length >= 4 && bytes.readUInt32LE(0) === ZSTD_MAGIC

  let plaintext
  let scan = null
  if (isZstd) {
    try {
      scan = scanZstdFrames(bytes)
    } catch (error) {
      return { path, status: 'unrecoverable', detail: { error: String(error) } }
    }
    const complete = scan.frames
    if (complete.length === 0) return { path, status: 'unrecoverable', detail: { error: 'no complete zstd frame' } }
    const parts = []
    for (const frame of complete) {
      let text
      try {
        text = decompressFrame(bytes.subarray(frame.start, frame.end))
      } catch (error) {
        return { path, status: 'unrecoverable', detail: { error: `frame decode: ${String(error)}` } }
      }
      parts.push(text)
    }
    plaintext = Buffer.concat(parts.map((p) => Buffer.from(p))).toString('utf8')
  } else {
    plaintext = bytes.toString('utf8')
  }

  const lines = plaintext.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  const analysis = analyzeLines(lines)
  if (!analysis.ok) {
    if (analysis.issue?.type === 'bad-header' || analysis.issue?.type === 'empty') {
      return { path, status: 'unrecoverable', detail: { issue: analysis.issue } }
    }
  }
  if (analysis.ok) {
    const torn = isZstd && scan?.tornStart !== undefined && scan.tornStart < bytes.length
    return {
      path,
      status: 'clean',
      detail: { eventCount: analysis.eventCount, tornTail: Boolean(torn) },
    }
  }

  // 存在 seq 缺口 → 分叉修复
  const result = repairEventLines(analysis.eventLines)
  if (result.kept === null) {
    return { path, status: 'skipped', detail: { reason: result.reason, issue: analysis.issue } }
  }

  const newEventText = `${result.kept.join('\n')}\n`
  let newBytes
  if (isZstd) {
    // header 帧 = 原始第一帧（解压后恰好一行 header，官方语义）；事件帧 = 新压缩
    const headerPlain = Buffer.concat([Buffer.from(analysis.headerLine), Buffer.from('\n')])
    const headerFrame = compressFrame(headerPlain.toString('utf8'))
    const eventFrame = compressFrame(newEventText)
    newBytes = Buffer.concat([headerFrame, eventFrame])
  } else {
    newBytes = Buffer.from(`${analysis.headerLine}\n${newEventText}`, 'utf8')
  }

  // 原子替换 + 备份
  try {
    const backupPath = uniqueBackupPath(path, backupSuffix)
    writeFileSync(backupPath, bytes)
    fsyncFile(backupPath)
    const tmp = `${path}.repairing-${process.pid}-${Date.now()}`
    atomicReplace(tmp, path, newBytes)
    return {
      path,
      status: 'repaired',
      detail: {
        issue: analysis.issue,
        keptEvents: countEvents(result.kept),
        droppedLines: result.dropped.length,
        droppedCount: result.droppedCount,
        backupPath,
      },
    }
  } catch (error) {
    return { path, status: 'unrecoverable', detail: { error: `replace failed: ${String(error)}` } }
  }
}

function countEvents(lines) {
  let n = 0
  for (const text of lines) {
    const dec = decodeLine(text)
    if (dec.error === undefined && dec.first !== null) n += dec.count
  }
  return n
}

/**
 * 递归扫描会话根目录，修复全部损坏日志并建立 id → 文件索引。
 * @param {string} root
 * @param {{backupSuffix?:string, logger?:object, isLive?:(id:string)=>boolean}} options
 * @returns {{stats:object, index:Map<string,string>, reports:object[]}}
 */
export function scanSessionsRoot(root, options = {}) {
  const stats = { scanned: 0, clean: 0, repaired: 0, skipped: 0, unrecoverable: 0 }
  const index = new Map()
  const reports = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!SESSION_FILE_NAMES.has(entry.name)) continue
      stats.scanned += 1
      try {
        const headerLine = readHeaderLine(full)
        const header = headerLine === null ? null : parseHeaderLine(headerLine)
        if (header !== null && !index.has(header.id)) index.set(header.id, full)
        if (header !== null && options.isLive?.(header.id)) {
          stats.skipped += 1
          reports.push({ path: full, status: 'skipped', detail: { reason: 'live-session' } })
          continue
        }
        const report = repairFile(full, options)
        reports.push(report)
        if (report.status === 'clean') stats.clean += 1
        else if (report.status === 'repaired') stats.repaired += 1
        else if (report.status === 'skipped') stats.skipped += 1
        else stats.unrecoverable += 1
      } catch (error) {
        stats.unrecoverable += 1
        reports.push({ path: full, status: 'unrecoverable', detail: { error: String(error) } })
      }
    }
  }
  mkdirSync(root, { recursive: true })
  walk(root)
  return { stats, index, reports }
}

/**
 * 幂等的「确保已修复」：会话被读取前调用；同一 id 只修一次。
 * live 会话（内存中持有旧状态）跳过修复，避免与磁盘状态分叉。
 */
export function createEnsureRepaired({ root, backupSuffix, logger, isLive }) {
  let bootResult = null
  let index = new Map()
  const cache = new Map()
  const skipLive = (id) => (typeof isLive === 'function' ? isLive(id) : false)
  return {
    /** 启动扫描（只执行一次），返回统计与索引。 */
    boot() {
      if (bootResult !== null) return bootResult
      const result = scanSessionsRoot(root, { backupSuffix, logger, isLive: skipLive })
      index = result.index
      bootResult = result
      return result
    },
    /**
     * @param {string} sessionId
     * @returns {{status:'clean'|'repaired'|'skipped'|'unrecoverable'|'absent'}|null}
     */
    ensure(sessionId) {
      if (cache.has(sessionId)) return cache.get(sessionId)
      const path = index.get(sessionId)
      if (path === undefined) {
        cache.set(sessionId, { status: 'absent' })
        return cache.get(sessionId)
      }
      if (skipLive(sessionId)) {
        const report = { path, status: 'skipped', detail: { reason: 'live-session' } }
        cache.set(sessionId, report)
        return report
      }
      const report = repairFile(path, { backupSuffix, logger })
      cache.set(sessionId, report)
      return report
    },
  }
}
