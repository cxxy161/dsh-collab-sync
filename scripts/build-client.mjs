#!/usr/bin/env node
/**
 * dsh-collab-sync — 客户端模块构建脚本
 *
 * 把 `src/client.js`（假定作用域内有 React）与 react UMD（自包含副本）内联为
 * `lib/client.js`（ModuleLoader 格式）。无其他构建依赖（node 内置即可）。
 *
 * 用法：node scripts/build-client.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// 解析 react UMD（沿 node_modules 向上查找，可命中 dsh 安装目录）
let reactUmd = null
try {
  const reactPkg = require.resolve('react/package.json', { paths: [ROOT] })
  reactUmd = readFileSync(join(dirname(reactPkg), 'umd/react.production.min.js'), 'utf8')
} catch {
  /* 构建时缺失则回退到运行时 require('react')（若 loader 支持） */
}
if (reactUmd === null) {
  console.error('build-client: cannot resolve react UMD from node_modules')
  process.exit(1)
}

const src = readFileSync(join(ROOT, 'src/client.js'), 'utf8')

const wrapper = `/**
 * dsh-collab-sync — 客户端模块（构建产物，勿手改；源码见 src/client.js）
 * 由 scripts/build-client.mjs 生成：内联 react UMD + src/client.js。
 */
window.__ModuleLoader__.load({
	id: 'dsh-collab-sync',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
${reactUmd}
		const React = module.exports;
		module.exports = {};
		exports = module.exports;
${src}
		return module.exports;
	},
});
`

mkdirSync(join(ROOT, 'lib'), { recursive: true })
writeFileSync(join(ROOT, 'lib/client.js'), wrapper)
console.log(`build-client: lib/client.js written (${(wrapper.length / 1024).toFixed(0)} KiB)`)
