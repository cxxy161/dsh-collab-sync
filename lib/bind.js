/**
 * dsh-collab-sync — 开放 IP / 绑定管理
 *
 * 原生 dsh 对 webserver 的 host 校验很窄（CLI 拒绝 `--host 0.0.0.0`，schema
 * 默认只允许 127.0.0.1/0.0.0.0）。本插件：
 *  - bundle patch 把 webserver host 表达式改为
 *    `命令行 --host > DSH_WEB_BIND > 127.0.0.1`，并把 connection 的 trustedHosts
 *    扩展为「web-runtime 推导 + DSH_WEB_EXTRA_TRUSTED」；
 *  - `/collab/settings` 配置页把绑定选择写入 `$DSH_HOME/.env`
 *    （DSH_WEB_BIND / DSH_WEB_EXTRA_TRUSTED），**重启 dsh web 后生效**——
 *    不触碰 profile 补丁，避免热重载重绑导致路由丢失/连接中断。
 */
import { homedir } from 'node:os'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'

/** 默认 $DSH_HOME（与 dsh-home-paths 一致）。 */
export function defaultDshHome() {
  const env = process.env.DSH_HOME
  return env !== undefined && env.trim().length > 0 ? env : join(homedir(), '.dsh')
}

/** $DSH_HOME/.env 路径（launcher 的 loadLayeredEnv 会读取它）。 */
export function bindEnvPath(home = defaultDshHome()) {
  return join(home, '.env')
}

/**
 * 解析 .env 中的绑定配置（不修改）。
 * @returns {{host:string, extraTrustedHosts:string[], path:string}}
 */
export function readBindEnv(home = defaultDshHome()) {
  const path = bindEnvPath(home)
  let host = ''
  let extraTrustedHosts = []
  try {
    const text = readFileSync(path, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
      if (!match) continue
      const [, key, raw] = match
      let value = raw
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      if (key === 'DSH_WEB_BIND') host = value
      else if (key === 'DSH_WEB_EXTRA_TRUSTED') {
        extraTrustedHosts = value.split(',').map((s) => s.trim()).filter(Boolean)
      }
    }
  } catch {
    /* .env 不存在 */
  }
  return { host, extraTrustedHosts, path }
}

/**
 * 把绑定配置写入 $DSH_HOME/.env（保留其他行与注释，键级 upsert）。
 * @returns {{ok:boolean, path:string, host:string, extraTrustedHosts:string[], message:string}}
 */
export function applyBindEnv({ host, extraTrustedHosts = [], home = defaultDshHome() }) {
  const path = bindEnvPath(home)
  const extras = extraTrustedHosts.filter((h) => typeof h === 'string' && h.trim().length > 0)
  let lines = []
  try {
    lines = readFileSync(path, 'utf8').split(/\r?\n/)
  } catch {
    /* 新文件 */
  }
  const set = (key, value) => {
    const entry = `${key}=${value}`
    let found = false
    for (let i = 0; i < lines.length; i++) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(lines[i])
      if (match && match[1] === key) {
        lines[i] = entry
        found = true
        break
      }
    }
    if (!found) lines.push(entry)
  }
  set('DSH_WEB_BIND', host)
  set('DSH_WEB_EXTRA_TRUSTED', extras.join(','))
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  mkdirSync(home, { recursive: true })
  writeFileSync(path, lines.join('\n') + '\n')
  return {
    ok: true,
    path,
    host,
    extraTrustedHosts: extras,
    message: `已保存到 ${path}。重启 dsh web 后生效（当前进程不受影响）。`,
  }
}

/**
 * 探测 webserver host schema 是否已放宽（z.string）。
 * 用非回环地址试校验：窄（union）→ false；已放宽 → true。
 */
export function isHostSchemaWidened() {
  try {
    const result = WebServer.Config['~standard']?.validate({ host: '203.0.113.9', port: 1 })
    return !(result?.issues && result.issues.length > 0)
  } catch {
    return false
  }
}

/** 当前生效的绑定/信任状态。 */
export function effectiveBindStatus(ctx) {
  const webRuntime = ctx.get('webRuntime')
  return {
    host: ctx.webServer?.host ?? null,
    port: ctx.webServer?.port ?? null,
    schemaWidened: isHostSchemaWidened(),
    lanAddresses: webRuntime?.lanAddresses ?? [],
    trustedHosts: webRuntime?.trustedHosts ?? [],
  }
}

/**
 * `GET/POST /collab/api/bind` 路由处理器。
 * GET：当前生效值 + 已保存的 .env 配置 + schema 状态。
 * POST：写入 $DSH_HOME/.env（重启生效），不触发热重载。
 */
export function createBindHandler({ ctx, logger = console }) {
  return (req, res) => {
    const respond = (code, body) => {
      const text = JSON.stringify(body)
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(text)
    }
    if (req.method === 'GET') {
      respond(200, {
        ok: true,
        ...effectiveBindStatus(ctx),
        saved: readBindEnv(),
      })
      return
    }
    if (req.method !== 'POST') {
      respond(405, { ok: false, error: '方法不允许' })
      return
    }
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 65536) req.destroy()
    })
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}')
        const host = typeof parsed.host === 'string' && parsed.host.length > 0 ? parsed.host : '127.0.0.1'
        const extra = Array.isArray(parsed.extraTrustedHosts) ? parsed.extraTrustedHosts : []
        const result = applyBindEnv({ host, extraTrustedHosts: extra })
        logger.info?.(`dsh-collab-sync: 绑定配置已写入 ${result.path}（${host}），重启后生效`)
        respond(200, { ok: true, ...result, needsRestart: true })
      } catch (error) {
        respond(500, { ok: false, error: `保存失败: ${String(error)}` })
      }
    })
  }
}

/**
 * `POST /collab/api/lock` 路由处理器：锁定异常逃生舱。
 * body: {action: 'reset'} → 强制重置写者锁并重新获取。
 */
export function createLockHandler({ lock, logger = console }) {
  return (req, res) => {
    const respond = (code, body) => {
      const text = JSON.stringify(body)
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(text)
    }
    if (req.method !== 'POST') {
      respond(405, { ok: false, error: '方法不允许' })
      return
    }
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 65536) req.destroy()
    })
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}')
        if (parsed.action !== 'reset') {
          respond(400, { ok: false, error: '未知操作' })
          return
        }
        const result = lock.forceReset()
        if (result.ok) {
          logger.warn?.('dsh-collab-sync: 用户通过设置页强制重置了写者锁')
          respond(200, { ok: true, message: '写者锁已重置并重新获取。若其他后端仍在运行，请停止它们以免再次冲突。' })
        } else {
          respond(409, { ok: false, error: `重置失败: ${result.reason}` })
        }
      } catch (error) {
        respond(500, { ok: false, error: `重置失败: ${String(error)}` })
      }
    })
  }
}
