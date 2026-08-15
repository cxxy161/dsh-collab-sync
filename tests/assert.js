/**
 * 轻量断言。
 */
let failures = 0

export function ok(condition, label) {
  if (!condition) {
    failures += 1
    throw new Error(`ASSERT FAILED: ${label}`)
  }
}

export function eq(actual, expected, label) {
  if (actual !== expected) {
    failures += 1
    throw new Error(`ASSERT FAILED: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

export function throws(fn, pattern, label) {
  try {
    fn()
  } catch (error) {
    if (pattern && !pattern.test(String(error?.message ?? error))) {
      failures += 1
      throw new Error(`ASSERT FAILED: ${label} — error did not match ${pattern}: ${String(error)}`)
    }
    return
  }
  failures += 1
  throw new Error(`ASSERT FAILED: ${label} — expected throw, none happened`)
}

export function countFailures() {
  return failures
}
