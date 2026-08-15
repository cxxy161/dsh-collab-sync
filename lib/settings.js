/**
 * dsh-collab-sync — 开放 IP 配置页（/collab/settings）
 *
 * 宿主托管的配置页：选择监听范围（全部接口 0.0.0.0 / 仅本机 127.0.0.1 /
 * 指定 IP）、填写额外信任主机，保存后写入 profile 补丁并热重载重绑。
 */

export function settingsHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-collab-sync · 开放 IP 配置</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #0f1115; color: #d7dde6; font-size: 13px; line-height: 1.6; }
  header { padding: 14px 20px; border-bottom: 1px solid #232a36; display: flex; align-items: center; gap: 12px; }
  header h1 { font-size: 15px; margin: 0; }
  main { max-width: 720px; margin: 20px auto; padding: 0 16px; display: grid; gap: 18px; }
  section { background: #161b24; border: 1px solid #232a36; border-radius: 10px; padding: 14px 16px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: #8b96a8; margin: 0 0 12px; }
  label { display: block; padding: 8px 10px; border: 1px solid #232a36; border-radius: 8px; margin-bottom: 6px; cursor: pointer; }
  label.sel { border-color: #4a9eff; background: #4a9eff12; }
  input[type=radio] { margin-right: 8px; }
  input[type=text], textarea { width: 100%; background: #0f1115; color: #d7dde6; border: 1px solid #232a36; border-radius: 6px; padding: 8px 10px; font: inherit; margin-top: 4px; }
  textarea { resize: vertical; min-height: 60px; }
  .row { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
  button { background: #4a9eff; color: #fff; border: none; border-radius: 6px; padding: 8px 18px; cursor: pointer; font: inherit; }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button.danger { background: transparent; border: 1px solid #e74c3c; color: #e74c3c; }
  .muted { color: #8b96a8; font-size: 12px; }
  #status { margin-top: 10px; padding: 10px 12px; border-radius: 8px; white-space: pre-wrap; }
  #status.ok { background: #2ecc7112; border: 1px solid #2ecc7155; }
  #status.err { background: #e74c3c12; border: 1px solid #e74c3c55; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #1c222d; }
  th { color: #8b96a8; font-weight: 500; }
  a { color: #4a9eff; text-decoration: none; }
</style>
</head>
<body>
<header>
  <h1>dsh-collab-sync · 开放 IP 配置</h1>
  <span style="flex:1"></span>
  <a href="/collab/panel">协作面板</a>
</header>
<main>
  <section>
    <h2>监听范围（webserver bind）</h2>
    <label><input type="radio" name="host" value="0.0.0.0"> 全部接口 0.0.0.0 —— 本机所有 IP（含 tailnet/LAN）都可访问</label>
    <label><input type="radio" name="host" value="127.0.0.1"> 仅本机 127.0.0.1 —— 只允许本机浏览器</label>
    <label><input type="radio" name="host" value="__custom__"> 指定 IP —— 只监听该地址</label>
    <input type="text" id="custom-host" placeholder="例如 192.168.1.50" style="display:none">
    <div class="muted" id="schema-note"></div>
  </section>
  <section>
    <h2>额外信任主机（trustedHosts）</h2>
    <textarea id="trusted" placeholder="每行一个 host 或 host:port，例如&#10;100.64.0.2&#10;dsh.example.com"></textarea>
    <div class="muted">绑定 0.0.0.0 时本机所有 IP 自动受信任；此处补充远程域名/地址。</div>
  </section>
  <section>
    <h2>当前生效</h2>
    <table>
      <tr><th>绑定 host</th><td id="cur-host">-</td></tr>
      <tr><th>端口</th><td id="cur-port">-</td></tr>
      <tr><th>自动信任的局域网 IP</th><td id="cur-lan">-</td></tr>
      <tr><th>profile 补丁</th><td id="cur-patch">-</td></tr>
    </table>
    <div class="row">
      <button id="save">保存（重启后生效）</button>
      <span class="muted">保存到 ~/.dsh/.env，重启 dsh web 后生效；不会重写 profile 补丁</span>
    </div>
    <div id="status"></div>
  </section>

  <section>
    <h2>锁定异常逃生舱</h2>
    <p class="muted">遇到「写者锁被占用 / 只读跟随者」之类的报错时：<br>
      1. 先到 <a href="/collab/panel">协作面板</a> 看谁是写者（pid/端口），浏览器连到写者实例即可；<br>
      2. 若写者实例已停止但锁未释放，点下方按钮强制重置锁（删除锁文件并重新获取）。</p>
    <div class="row">
      <button id="reset-lock" class="danger">强制重置写者锁</button>
      <span class="muted">仅当确认其他后端已停止时使用</span>
    </div>
  </section>
</main>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id) }
  var status = $('status')
  var radios = document.querySelectorAll('input[name=host]')
  function load() {
    fetch('/collab/api/bind').then(function (r) { return r.json() }).then(function (d) {
      if (!d.ok) return
      $('cur-host').textContent = d.host || '-'
      $('cur-port').textContent = String(d.port ?? '-')
      $('cur-lan').textContent = (d.lanAddresses || []).join('、') || '（无）'
      $('cur-patch').textContent = d.patchPath || '-'
      $('schema-note').textContent = d.schemaWidened
        ? 'host schema 已放宽（z.string），支持任意 IP'
        : 'host 校验未放宽：指定 IP 绑定需先运行一次 scripts/setup-bind.sh（幂等），否则重启后不生效；0.0.0.0 无此限制'
      // 回显当前选择
      var cur = d.host || '0.0.0.0'
      var custom = null
      for (var i = 0; i < radios.length; i++) {
        if (radios[i].value === cur) { radios[i].checked = true; break }
        if (radios[i].value === '__custom__') custom = radios[i]
      }
      if (!cur.startsWith('127.') && !cur.startsWith('0.')) {
        custom.checked = true
        $('custom-host').style.display = 'block'
        $('custom-host').value = cur
      }
    }).catch(function () {})
  }
  radios.forEach(function (r) {
    r.addEventListener('change', function () {
      $('custom-host').style.display = r.value === '__custom__' ? 'block' : 'none'
    })
  })
  $('save').addEventListener('click', function () {
    var host = '0.0.0.0'
    for (var i = 0; i < radios.length; i++) if (radios[i].checked) host = radios[i].value
    if (host === '__custom__') host = $('custom-host').value.trim()
    if (!host) { status.className = 'err'; status.textContent = '请选择或填写监听地址'; return }
    var extra = $('trusted').value.split(/\n/).map(function (s) { return s.trim() }).filter(Boolean)
    var btn = $('save')
    btn.disabled = true
    status.className = 'ok'
    status.textContent = '保存中…'
    fetch('/collab/api/bind', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: host, extraTrustedHosts: extra }),
    }).then(function (r) { return r.json() }).then(function (d) {
      status.className = d.ok ? 'ok' : 'err'
      status.textContent = d.ok ? (d.message || '已保存') : (d.error || JSON.stringify(d))
    }).catch(function (e) {
      status.className = 'err'
      status.textContent = '保存失败: ' + String(e)
    }).finally(function () { btn.disabled = false })
  })
  $('reset-lock').addEventListener('click', function () {
    var btn = $('reset-lock')
    if (!confirm('确认强制重置写者锁？仅当其他后端已停止时使用。')) return
    btn.disabled = true
    fetch('/collab/api/lock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'reset' }),
    }).then(function (r) { return r.json() }).then(function (d) {
      status.className = d.ok ? 'ok' : 'err'
      status.textContent = d.ok ? (d.message || '已重置') : (d.error || JSON.stringify(d))
      setTimeout(load, 800)
    }).catch(function (e) {
      status.className = 'err'
      status.textContent = '重置失败: ' + String(e)
    }).finally(function () { btn.disabled = false })
  })
  load()
})()
</script>
</body>
</html>
`
}

/** `GET /collab/settings` 路由处理器。 */
export function createSettingsHandler() {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(settingsHtml())
  }
}
