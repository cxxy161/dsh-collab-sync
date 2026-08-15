/**
 * 一键回归：node tests/run-all.js
 */
import { countFailures } from './assert.js'

const modules = ['./scan.test.js', './repair.test.js', './lock.test.js', './bind.test.js']

let passed = 0
const failures = []

for (const mod of modules) {
  const m = await import(mod)
  for (const [name, fn] of Object.entries(m)) {
    if (typeof fn !== 'function') continue
    try {
      await fn()
      passed += 1
      console.log(`  ok ${mod}::${name}`)
    } catch (error) {
      failures.push(`${mod}::${name} — ${error.message}`)
      console.error(`  FAIL ${mod}::${name} — ${error.message}`)
    }
  }
}

const totalFailures = failures.length + countFailures()
console.log(`\n${passed} passed, ${failures.length} failed`)
if (totalFailures > 0) process.exit(1)
