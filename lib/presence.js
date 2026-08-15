/**
 * dsh-collab-sync — 多终端在线感知（presence hub + SSE 流 + 状态 JSON）
 */
import { URL } from 'node:url'

const ACTIVITY_HISTORY_LIMIT = 50
const ACTIVITY_BROADCAST_MIN_MS = 2000
const SSE_PING_MS = 15000

/** SSE 响应头。 */
export function sseHeaders() {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  }
}

function sseFrame(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  } catch {
    /* 连接已关闭 */
  }
}

export class PresenceHub {
  constructor(options = {}) {
    this.logger = options.logger ?? console
    this.peers = new Map() // terminalId -> peer
    this.activity = []
    this.lastActivityAt = 0
    this.lastBroadcastAt = 0
    this.getWriterStatus = options.getWriterStatus ?? (() => null)
  }

  /** 当前在线终端列表（不含内部 res）。 */
  list() {
    return [...this.peers.values()].map(({ terminalId, label, connectedAt, lastSeenAt }) => ({
      terminalId,
      label,
      connectedAt,
      lastSeenAt,
    }))
  }

  snapshot() {
    return {
      peers: this.list(),
      writer: this.getWriterStatus(),
      activity: [...this.activity],
    }
  }

  /**
   * 注册一个终端连接（SSE）。`res` 关闭时自动注销并广播 peer/left。
   */
  register(terminalId, label, res) {
    const now = Date.now()
    const previous = this.peers.get(terminalId)
    const peer = {
      terminalId,
      label: label?.slice(0, 64) || 'terminal',
      connectedAt: previous?.connectedAt ?? now,
      lastSeenAt: now,
      res,
    }
    this.peers.set(terminalId, peer)
    sseFrame(res, 'snapshot', this.snapshot())
    if (previous === undefined) {
      this.broadcast('peer/joined', {
        terminalId: peer.terminalId,
        label: peer.label,
        connectedAt: peer.connectedAt,
      })
    } else {
      this.broadcast('peer/changed', { terminalId: peer.terminalId, label: peer.label })
    }
    res.on('close', () => {
      if (this.peers.get(terminalId) === peer) {
        this.peers.delete(terminalId)
        this.broadcast('peer/left', { terminalId })
      }
    })
    return peer
  }

  /** 向所有在线终端广播一帧。 */
  broadcast(event, data) {
    for (const peer of this.peers.values()) sseFrame(peer.res, event, data)
  }

  /** 记录并（节流）广播一次活动（如 session/event）。 */
  onActivity(kind = 'session/event') {
    const now = Date.now()
    this.lastActivityAt = now
    this.activity.push({ at: now, kind })
    if (this.activity.length > ACTIVITY_HISTORY_LIMIT) this.activity.shift()
    if (now - this.lastBroadcastAt >= ACTIVITY_BROADCAST_MIN_MS) {
      this.lastBroadcastAt = now
      this.broadcast('activity', { at: now, kind })
    }
  }
}

/**
 * `GET /collab/presence?terminal=<id>&label=<name>` SSE 路由处理器。
 */
export function createPresenceRoute(hub) {
  return (req, res) => {
    const parsed = new URL(req.url ?? '/', 'http://dsh.internal')
    const terminalId = parsed.searchParams.get('terminal') ?? `anon-${Math.random().toString(36).slice(2, 10)}`
    const label = parsed.searchParams.get('label') ?? 'browser'
    res.writeHead(200, sseHeaders())
    res.flushHeaders?.()
    hub.register(terminalId, label, res)
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n')
      } catch {
        /* 连接已关闭 */
      }
    }, SSE_PING_MS)
    if (typeof ping.unref === 'function') ping.unref()
    res.on('close', () => clearInterval(ping))
  }
}

/**
 * `GET /collab/api/status` JSON 路由处理器。
 */
export function createStatusHandler({ getWriterStatus, hub, getRepairs, getBind }) {
  return (_req, res) => {
    const body = JSON.stringify({
      ok: true,
      version: 1,
      writer: getWriterStatus(),
      peers: hub.list(),
      activity: { lastAt: hub.lastActivityAt, recent: [...hub.activity].slice(-10) },
      repairs: getRepairs(),
      bind: typeof getBind === 'function' ? getBind() : null,
      now: Date.now(),
    })
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  }
}

/**
 * `POST /collab/api/repair` JSON 路由处理器：触发一次全量修复扫描。
 */
export function createRepairHandler({ scan }) {
  return (_req, res) => {
    let result
    try {
      result = scan()
    } catch (error) {
      result = { ok: false, error: String(error) }
    }
    const body = JSON.stringify({ ok: true, ...result })
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  }
}
