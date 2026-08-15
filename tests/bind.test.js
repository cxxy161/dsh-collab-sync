/**
 * 开放 IP / 绑定管理测试（env 文件方案）。
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  defaultDshHome,
  bindEnvPath,
  readBindEnv,
  applyBindEnv,
  isHostSchemaWidened,
} from '../lib/bind.js'
import { makeTempDir } from './fixtures.js'
import { ok, eq } from './assert.js'

export async function testEnvRoundTrip() {
  const dir = makeTempDir()
  const path = bindEnvPath(dir)
  writeFileSync(path, '# 注释行\nSOME_KEY=keep-me\nDSH_WEB_BIND=192.168.1.50\n')
  const result = applyBindEnv({ host: '0.0.0.0', extraTrustedHosts: ['100.64.0.2', 'dsh.example.com'], home: dir })
  eq(result.ok, true, 'applied')
  eq(result.message.includes('重启 dsh web 后生效'), true, 'message mentions restart')
  const text = readFileSync(path, 'utf8')
  ok(text.includes('# 注释行'), 'comment preserved')
  ok(text.includes('SOME_KEY=keep-me'), 'other keys preserved')
  ok(text.includes('DSH_WEB_BIND=0.0.0.0'), 'bind updated')
  ok(text.includes('DSH_WEB_EXTRA_TRUSTED=100.64.0.2,dsh.example.com'), 'extras written')
  const read = readBindEnv(dir)
  eq(read.host, '0.0.0.0', 'read host')
  eq(read.extraTrustedHosts.length, 2, 'read extras')
  rmSync(dir, { recursive: true, force: true })
}

export async function testEnvUpsertIdempotent() {
  const dir = makeTempDir()
  writeFileSync(bindEnvPath(dir), 'DSH_WEB_BIND=127.0.0.1\n')
  applyBindEnv({ host: '0.0.0.0', home: dir })
  applyBindEnv({ host: '192.168.1.50', home: dir })
  const lines = readFileSync(bindEnvPath(dir), 'utf8').split('\n').filter(Boolean)
  eq(lines.filter((l) => l.startsWith('DSH_WEB_BIND=')).length, 1, 'no duplicate keys')
  eq(readBindEnv(dir).host, '192.168.1.50', 'latest wins')
  rmSync(dir, { recursive: true, force: true })
}

export async function testEnvMissingFile() {
  const dir = makeTempDir()
  const read = readBindEnv(dir)
  eq(read.host, '', 'empty host when no env')
  eq(read.extraTrustedHosts.length, 0, 'no extras when no env')
  const result = applyBindEnv({ host: '0.0.0.0', extraTrustedHosts: [], home: dir })
  eq(result.ok, true, 'creates env file')
  ok(readFileSync(bindEnvPath(dir), 'utf8').includes('DSH_WEB_BIND=0.0.0.0'), 'file created')
  eq(readBindEnv(dir).extraTrustedHosts.length, 0, 'empty extras stays empty')
  rmSync(dir, { recursive: true, force: true })
}

export async function testQuotedValues() {
  const dir = makeTempDir()
  writeFileSync(bindEnvPath(dir), 'DSH_WEB_BIND="10.0.0.1"\n')
  eq(readBindEnv(dir).host, '10.0.0.1', 'quoted value unquoted on read')
  rmSync(dir, { recursive: true, force: true })
}

export async function testSchemaProbe() {
  const widened = isHostSchemaWidened()
  ok(typeof widened === 'boolean', 'probe returns boolean')
}

export async function testDefaultHome() {
  const home = defaultDshHome()
  ok(home.length > 0 && home.startsWith('/'), 'home is absolute')
}
