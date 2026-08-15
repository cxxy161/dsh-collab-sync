/**
 * dsh-collab-sync — 协作面板页（/collab/panel）
 *
 * 纯静态 HTML + 内嵌 JS：通过 `/collab/api/status` 轮询 + `/collab/presence`
 * SSE 实时展示在线终端、写者身份、修复历史与最近活动。任何终端浏览器把面板
 * 开在第二个标签页即可当「协作监控台」。
 */

export function panelHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-collab-sync · 协作面板</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #0f1115; color: #d7dde6; font-size: 13px; line-height: 1.6; }
  header { padding: 14px 20px; border-bottom: 1px solid #232a36; display: flex; align-items: center; gap: 12px; }
  header h1 { font-size: 15px; margin: 0; }
  header .dot { width: 9px; height: 9px; border-radius: 50%; background: #555; display: inline-block; }
  header .dot.live { background: #2ecc71; box-shadow: 0 0 8px #2ecc7188; }
  main { max-width: 860px; margin: 20px auto; padding: 0 16px; display: grid; gap: 18px; }
  section { background: #161b24; border: 1px solid #232a36; border-radius: 10px; padding: 14px 16px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: #8b96a8; margin: 0 0 10px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  .card { background: #0f1115; border: 1px solid #232a36; border-radius: 8px; padding: 8px 12px; flex: 1 1 200px; }
  .card .k { color: #8b96a8; font-size: 11px; }
  .card .v { font-size: 14px; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #1c222d; }
  th { color: #8b96a8; font-weight: 500; font-size: 11px; }
  .tag { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; }
  .tag.writer { background: #2ecc7118; color: #2ecc71; }
  .tag.off { background: #f1c40f18; color: #f1c40f; }
  .tag.ro { background: #3498db18; color: #3498db; }
  .tag.peer { background: #9b59b618; color: #b07cc6; }
  #activity { max-height: 200px; overflow: auto; }
  #activity div { padding: 2px 0; border-bottom: 1px dashed #1c222d; color: #aab3c2; }
  #activity .at { color: #6b7688; margin-right: 8px; }
  a { color: #4a9eff; text-decoration: none; }
  .muted { color: #6b7688; }
  .empty { color: #6b7688; padding: 10px 0; }
  #reconnect { color: #f1c40f; display: none; }
</style>
</head>
<body>
<header>
  <span id="dot" class="dot"></span>
  <h1>dsh-collab-sync · 协作面板</h1>
  <span id="reconnect">连接断开，重连中…</span>
  <span style="flex:1"></span>
  <a href="/collab/settings">开放 IP 配置</a>
  <a href="/" target="_blank">打开主 GUI</a>
</header>
<main>
  <section>
    <h2>写者状态（单后端）</h2>
    <div class="row" id="writer"></div>
  </section>
  <section>
    <h2>在线终端 <span class="muted" id="peer-count"></span></h2>
    <table>
      <thead><tr><th>终端</th><th>标签</th><th>连接时间</th><th>最近活动</th></tr></thead>
      <tbody id="peers"></tbody>
    </table>
    <div id="peer-empty" class="empty">暂无在线终端 —— 打开主 GUI 后会自动出现（beacon）。</div>
  </section>
  <section>
    <h2>修复历史（会话日志）</h2>
    <div id="repairs" class="muted">尚未扫描。</div>
  </section>
  <section>
    <h2>最近活动</h2>
    <div id="activity" class="muted">暂无。</div>
  </section>
</main>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id) }
  var fmt = function (t) {
    if (!t) return '-'
    var d = new Date(t)
    return d.toLocaleTimeString('zh-CN', { hour12: false })
  }
  var esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }
  function render(status) {
    var w = status.writer
    $('writer').innerHTML = w && w.owned
      ? '<div class="card"><div class="k">模式</div><div class="v"><span class="tag writer">writer</span> ' + esc(w.mode) + '</div></div>' +
        '<div class="card"><div class="k">持有者 pid / host</div><div class="v">' + (w.holder ? esc(w.holder.pid + ' @ ' + w.holder.hostname) : '-') + '</div></div>' +
        '<div class="card"><div class="k">启动于</div><div class="v">' + (w.holder ? esc(fmt(w.holder.startedAt)) : '-') + '</div></div>'
      : w && w.mode === 'readonly'
        ? '<div class="card"><div class="k">模式</div><div class="v"><span class="tag ro">readonly</span></div></div><div class="card"><div class="k">说明</div><div class="v">只读跟随：不写会话日志</div></div>'
        : '<div class="card"><div class="k">模式</div><div class="v"><span class="tag off">' + esc(w ? w.mode : 'off') + '</span></div></div>'
    var peers = status.peers || []
    $('peer-count').textContent = '(' + peers.length + ')'
    $('peers').innerHTML = peers.map(function (p) {
      return '<tr><td><span class="tag peer">' + esc(p.terminalId.slice(0, 10)) + '</span></td><td>' + esc(p.label) + '</td><td>' + esc(fmt(p.connectedAt)) + '</td><td>' + esc(fmt(p.lastSeenAt)) + '</td></tr>'
    }).join('')
    $('peer-empty').style.display = peers.length ? 'none' : 'block'
    var r = status.repairs
    $('repairs').textContent = r && r.stats
      ? '扫描 ' + r.stats.scanned + ' · 健康 ' + r.stats.clean + ' · 已修复 ' + r.stats.repaired + ' · 跳过 ' + r.stats.skipped + ' · 失败 ' + r.stats.unrecoverable
      : '尚未扫描'
    var acts = (status.activity && status.activity.recent) || []
    $('activity').innerHTML = acts.map(function (a) {
      return '<div><span class="at">' + esc(fmt(a.at)) + '</span>' + esc(a.kind) + '</div>'
    }).join('') || '<div class="muted">暂无。</div>'
  }
  function load() {
    fetch('/collab/api/status').then(function (r) { return r.json() }).then(render).catch(function () {})
  }
  load()
  setInterval(load, 3000)
  var es = new EventSource('/collab/presence?terminal=panel-' + Math.random().toString(36).slice(2, 10) + '&label=panel')
  es.addEventListener('snapshot', function (e) { render(JSON.parse(e.data)) })
  ;['peer/joined', 'peer/changed', 'peer/left'].forEach(function (name) {
    es.addEventListener(name, function () { load() })
  })
  es.addEventListener('activity', function () { load() })
  es.onopen = function () { $('dot').className = 'dot live'; $('reconnect').style.display = 'none' }
  es.onerror = function () { $('dot').className = 'dot'; $('reconnect').style.display = 'inline' }
})()
</script>
</body>
</html>
`
}

/**
 * `GET /collab/panel` 路由处理器。
 */
export function createPanelHandler() {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(panelHtml())
  }
}
