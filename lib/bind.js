/**
 * dsh-collab-sync — 开放 IP / 绑定管理
 *
 * 原生 dsh 对 webserver 的 host 校验很窄（z.union 仅允许 127.0.0.1/0.0.0.0，
 * CLI 还拒绝 `--host 0.0.0.0`）。本插件：
 *  - bundle patch 把 webserver 默认 bind 改为 0.0.0.0（全部接口，多 IP 多端访问）；
 *  - 运行时探测并放宽 host schema（z.string()），让「指定 IP」绑定也能通过；
 *  - `/collab/settings` 配置页把绑定选择写回 profile 补丁（cordis.patch.yml），
 *    include 插件热重载后 webserver 行即时重绑。
 */
import * as yaml from 'js-yaml'
import z from '@deepseek-ai/schemastery'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { homedir } from 'node:os'
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const JS_TAG = 'tag:yaml.org,2002:js'

/** 复刻 dsh-app-boot 的 `!!js` YAML 类型（load/dump 双向往返）。 */
export function createJsYaml() {
  const JsExpr = new yaml.Type(JS_TAG, {
    kind: 'scalar',
    resolve: (data) => typeof data === 'string',
    construct: (data) => ({ __jsExpr: data }),
    predicate: (value) => value instanceof Object && '__jsExpr' in value,
    represent: (data) => data.__jsExpr,
  })
  return yaml.JSON_SCHEMA.extend(JsExpr)
}

export function loadPatch(path) {
  const schema = createJsYaml()
  const text = readFileSync(path, 'utf8')
  const parsed = yaml.load(text, { schema })
  return Array.isArray(parsed) ? parsed : []
}

export function savePatch(path, entries) {
  const schema = createJsYaml()
  const text = yaml.dump(entries, { schema, noRefs: true, lineWidth: 120 })
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** 重写前保留原文件备份（.collab-bak-<ts>）。 */
export function backupPatch(path) {
  if (!existsSync(path)) return null
  const backup = `${path}.collab-bak-${Date.now()}`
  writeFileSync(backup, readFileSync(path))
  return backup
}

/** 按 id 更新顶层行（config 键级合并，保留未知字段），不存在则追加。 */
export function upsertRow(entries, id, patch) {
  const existing = entries.find((entry) => entry && typeof entry === 'object' && !Array.isArray(entry) && entry.id === id)
  if (existing !== undefined) {
    if (patch.config !== undefined && existing.config !== undefined && typeof existing.config === 'object') {
      existing.config = { ...existing.config, ...patch.config }
    } else {
      for (const [key, value] of Object.entries(patch)) existing[key] = value
    }
    return existing
  }
  const row = { id, ...patch }
  entries.push(row)
  return row
}

/** 默认 $DSH_HOME（与 dsh-home-paths 一致）。 */
export function defaultDshHome() {
  const env = process.env.DSH_HOME
  return env !== undefined && env.trim().length > 0 ? env : join(homedir(), '.dsh')
}

/**
 * 定位 profile 补丁文件：优先 web 的，其次扫描含本插件 id 的，
 * 再其次第一个存在的 profile 补丁。
 */
export function findProfilePatch(home = defaultDshHome()) {
  const profilesDir = join(home, 'profiles')
  const candidates = []
  const web = join(profilesDir, 'web', 'cordis.patch.yml')
  if (existsSync(web)) candidates.push(web)
  try {
    for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'web') continue
      const candidate = join(profilesDir, entry.name, 'cordis.patch.yml')
      if (existsSync(candidate)) candidates.push(candidate)
    }
  } catch {
    /* profiles 目录不存在 */
  }
  for (const candidate of candidates) {
    try {
      if (readFileSync(candidate, 'utf8').includes('dsh-collab-sync')) return candidate
    } catch {
      /* 继续 */
    }
  }
  return candidates[0] ?? web
}

/**
 * 探测 webserver host schema 是否已放宽（z.string）。
 * 用非回环地址试校验：narrow（union）拒绝 → false；widened → true。
 */
export function isHostSchemaWidened() {
  try {
    const result = WebServer.Config['~standard']?.validate({ host: '203.0.113.9', port: 1 })
    return !(result?.issues && result.issues.length > 0)
  } catch {
    return false
  }
}

/** 运行时放宽 webserver host schema 为 z.string（幂等）。 */
export function widenHostSchema() {
  if (isHostSchemaWidened()) return false
  WebServer.Config = z.object({
    host: z.string().required(),
    port: z.natural().max(65535).required(),
  })
  return true
}

/** 构造 webserver 行的绑定 override（config 部分）。 */
export function webserverBindRow(host) {
  return {
    id: 'webserver',
    config: {
      host,
      port: { __jsExpr: 'ctx.webStartup?.port ?? 3080' },
    },
  }
}

/** 构造 connection 行的 trustedHosts override（有额外主机时才写）。 */
export function connectionTrustRow(extraTrustedHosts) {
  const extras = (extraTrustedHosts ?? []).filter((h) => typeof h === 'string' && h.length > 0)
  if (extras.length === 0) return null
  const literal = JSON.stringify(extras)
  return {
    id: 'connection',
    config: {
      trustedHosts: { __jsExpr: `[...(ctx.webRuntime?.trustedHosts ?? []), ...${literal}]` },
    },
  }
}

/**
 * 应用绑定配置：写入 profile 补丁（热重载生效）。
 * @returns {{ok:boolean, patchPath:string, changed:string[], message:string, needsRestart:boolean}}
 */
export function applyBindConfig({ host, extraTrustedHosts, patchPath, logger = console }) {
  const path = patchPath ?? findProfilePatch()
  const backup = backupPatch(path)
  const entries = existsSync(path) ? loadPatch(path) : []
  const changed = []
  upsertRow(entries, 'webserver', { config: webserverBindRow(host).config })
  changed.push('webserver')
  const trustRow = connectionTrustRow(extraTrustedHosts)
  if (trustRow !== null) {
    upsertRow(entries, 'connection', { config: trustRow.config })
    changed.push('connection')
  } else {
    const idx = entries.findIndex((entry) => entry?.id === 'connection')
    if (idx !== -1) {
      entries.splice(idx, 1)
      changed.push('connection(removed)')
    }
  }
  savePatch(path, entries)
  logger.info?.(`dsh-collab-sync: bind config written to ${path} (${changed.join(', ')})`)
  return {
    ok: true,
    patchPath: path,
    changed,
    backup,
    message: `已写入 ${path}；热重载生效中，若未生效请重启 dsh web`,
    needsRestart: false,
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
 */
export function createBindHandler({ ctx, logger = console }) {
  return (req, res) => {
    const respond = (code, body) => {
      const text = JSON.stringify(body)
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(text)
    }
    if (req.method === 'GET') {
      respond(200, { ok: true, ...effectiveBindStatus(ctx), patchPath: findProfilePatch() })
      return
    }
    if (req.method !== 'POST') {
      respond(405, { ok: false, error: 'method not allowed' })
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
        const host = typeof parsed.host === 'string' && parsed.host.length > 0 ? parsed.host : '0.0.0.0'
        const extra = Array.isArray(parsed.extraTrustedHosts) ? parsed.extraTrustedHosts : []
        // 先放宽 schema，再写补丁 → 热重载重校验能通过
        const widened = widenHostSchema()
        const result = applyBindConfig({ host, extraTrustedHosts: extra, logger })
        respond(200, { ok: true, ...result, schemaWidened: widened })
      } catch (error) {
        respond(500, { ok: false, error: String(error) })
      }
    })
  }
}
