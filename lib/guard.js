/**
 * dsh-collab-sync — 写路径守卫
 *
 * 在不修改任何 dsh 包源码的前提下，对 `sessionPersistence` 服务实例做受控包装：
 * - `appendBatch`：每次实际落盘前调用 `canWrite()`（单写者锁校验），
 *   readonly/锁丢失时返回失败并跳过落盘，杜绝并发写导致的 seq 分叉损坏；
 * - `prepare` / `load` / `readFrom`：先 `ensureRepaired(id)` 再委托，
 *   保证任何会话读取前其日志文件已修复。
 *
 * 热重载安全：同一服务实例被重复安装时先恢复原始方法再重新包装
 * （防止旧闭包引用已释放的锁导致 reload 后误拒写）。
 */

const GUARD_STATE = new WeakMap()

/**
 * @param {object} ctx cordis 上下文
 * @param {{canWrite:()=>({ok:boolean,reason?:string,message?:string}), ensure:(id:string)=>object}} hooks
 */
export function installGuard(ctx, hooks) {
  ctx.inject(['sessionPersistence'], (injected) => {
    const svc = injected.sessionPersistence
    if (svc === undefined || svc === null) return

    // 热重载：先恢复上一次包装
    const prev = GUARD_STATE.get(svc)
    if (prev !== undefined) {
      for (const [method, wrappedFn] of prev.wrapped) {
        if (svc[method] === wrappedFn) svc[method] = prev.original.get(method)
      }
      GUARD_STATE.delete(svc)
    }

    const original = new Map()
    const wrapped = new Map()

    const origAppendBatch = svc.appendBatch?.bind(svc)
    if (typeof origAppendBatch === 'function') {
      original.set('appendBatch', origAppendBatch)
      const fn = async (...args) => {
        const verdict = hooks.canWrite()
        if (!verdict.ok) {
          ctx.logger?.warn?.(`${verdict.message ?? 'dsh-collab-sync: 写者锁校验未通过'}; 本次落盘已跳过`)
          return
        }
        return origAppendBatch(...args)
      }
      wrapped.set('appendBatch', fn)
      svc.appendBatch = fn
    }

    for (const method of ['prepare', 'load', 'readFrom']) {
      const orig = svc[method]?.bind(svc)
      if (typeof orig !== 'function') continue
      original.set(method, orig)
      const fn = async (...args) => {
        const sessionId = args[0]
        if (typeof sessionId === 'string') {
          try {
            hooks.ensure(sessionId)
          } catch (error) {
            ctx.logger?.warn?.(`dsh-collab-sync: 会话 ${sessionId} 读取前的修复检查失败: ${String(error)}`)
          }
        }
        return orig(...args)
      }
      wrapped.set(method, fn)
      svc[method] = fn
    }

    GUARD_STATE.set(svc, { original, wrapped })
  })
}
