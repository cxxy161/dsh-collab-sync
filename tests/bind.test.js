/**
 * 开放 IP / 绑定管理测试。
 */
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  createJsYaml,
  loadPatch,
  savePatch,
  upsertRow,
  applyBindConfig,
  isHostSchemaWidened,
  widenHostSchema,
  webserverBindRow,
  connectionTrustRow,
} from '../lib/bind.js'
import { makeTempDir } from './fixtures.js'
import { ok, eq } from './assert.js'

export async function testJsYamlRoundTrip() {
  const y = createJsYaml()
  const { load, dump } = await import('js-yaml')
  const value = [
    { id: 'webserver', config: { host: '0.0.0.0', port: { __jsExpr: 'ctx.webStartup?.port ?? 3080' } } },
    { insert: [{ id: 'x', name: 'y', config: {} }] },
  ]
  const text = dump(value, { schema: y, noRefs: true })
  const parsed = load(text, { schema: y })
  eq(parsed.length, 2, 'two top-level rows')
  eq(parsed[0].id, 'webserver', 'row id preserved')
  eq(parsed[0].config.host, '0.0.0.0', 'host preserved')
  ok(parsed[0].config.port && parsed[0].config.port.__jsExpr === 'ctx.webStartup?.port ?? 3080', '!!js expression round-trips')
  eq(parsed[1].insert[0].name, 'y', 'insert row preserved')
}

export async function testUpsertRow() {
  const entries = [{ id: 'existing', config: { a: 1 } }]
  upsertRow(entries, 'existing', { config: { b: 2 } })
  eq(entries[0].config.b, 2, 'updated existing row config')
  eq(entries[0].config.a, 1, 'existing config merged')
  upsertRow(entries, 'new-row', { config: { c: 3 } })
  eq(entries.length, 2, 'new row appended')
  eq(entries[1].id, 'new-row', 'new row id')
}

export async function testApplyBindConfig() {
  const dir = makeTempDir()
  const patchPath = join(dir, 'cordis.patch.yml')
  writeFileSync(patchPath, '# comment\n- insert:\n    - id: seeview\n      name: x\n')
  const result = applyBindConfig({ host: '0.0.0.0', extraTrustedHosts: ['100.64.0.2'], patchPath, logger: { info() {} } })
  eq(result.ok, true, 'applied')
  ok(result.backup !== null && existsSync(result.backup), 'backup created')
  const entries = loadPatch(patchPath)
  const ws = entries.find((e) => e?.id === 'webserver')
  ok(ws !== undefined, 'webserver row written')
  eq(ws.config.host, '0.0.0.0', 'host written')
  ok(ws.config.port.__jsExpr.includes('ctx.webStartup'), 'port expression written')
  const conn = entries.find((e) => e?.id === 'connection')
  ok(conn !== undefined, 'connection row written when extras exist')
  ok(conn.config.trustedHosts.__jsExpr.includes('100.64.0.2'), 'extra trusted host in expression')
  const seeview = entries.find((e) => e?.insert)
  ok(seeview !== undefined && seeview.insert[0].id === 'seeview', 'existing insert preserved')
  rmSync(dir, { recursive: true, force: true })
}

export async function testApplyBindConfigNoExtras() {
  const dir = makeTempDir()
  const patchPath = join(dir, 'cordis.patch.yml')
  writeFileSync(patchPath, '[]\n')
  applyBindConfig({ host: '127.0.0.1', extraTrustedHosts: [], patchPath, logger: { info() {} } })
  const entries = loadPatch(patchPath)
  eq(entries.some((e) => e?.id === 'connection'), false, 'no connection row when no extras')
  eq(entries.some((e) => e?.id === 'webserver'), true, 'webserver row still written')
  rmSync(dir, { recursive: true, force: true })
}

export async function testSchemaProbeAndWiden() {
  // 当前安装已放宽（z.string）→ probe 应返回 true，widen 应幂等不崩
  const widened = isHostSchemaWidened()
  ok(typeof widened === 'boolean', 'probe returns boolean')
  const changed = widenHostSchema()
  ok(changed === false || changed === true, 'widen returns flag')
  ok(isHostSchemaWidened() === true, 'schema now widened')
}

export async function testRowBuilders() {
  const ws = webserverBindRow('0.0.0.0')
  eq(ws.id, 'webserver', 'webserver row id')
  eq(ws.config.host, '0.0.0.0', 'webserver host')
  const trust = connectionTrustRow(['a', 'b', ''])
  ok(trust !== null, 'trust row built')
  ok(trust.config.trustedHosts.__jsExpr.includes('"a"'), 'extras in expression')
  eq(connectionTrustRow([]), null, 'no row when empty')
  eq(connectionTrustRow(['']), null, 'no row when all empty')
}
