/**
 * dsh-collab-sync — GUI presence beacon（浏览器侧）
 *
 * 经 webserver 官方 `tapIndex` 缝隙以 `<script src="/collab/beacon.js">` 注入
 * 每个 GUI 页面：上报终端在线状态，右下角显示「👥 N」徽标，点击打开协作面板。
 * 被 CSP 拦截或出错时静默降级，不影响 GUI 主流程。
 */

export function beaconScript() {
  return `(function () {
  'use strict';
  try {
    var KEY = 'dsh-collab-terminal-id';
    var LKEY = 'dsh-collab-terminal-label';
    var id = localStorage.getItem(KEY);
    if (!id) {
      id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('t-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36));
      localStorage.setItem(KEY, id);
    }
    var platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || 'browser';
    var label = localStorage.getItem(LKEY) || platform;
    var peers = [];

    var badge = document.createElement('div');
    badge.id = 'dsh-collab-badge';
    badge.setAttribute('title', 'dsh-collab-sync：在线终端 / 最近活动（点击打开协作面板）');
    badge.style.cssText = [
      'position:fixed', 'right:14px', 'bottom:14px', 'z-index:2147483000',
      'background:rgba(20,24,33,.92)', 'color:#d7dde6', 'border:1px solid #2ecc7188',
      'border-radius:20px', 'padding:6px 12px', 'font:12px/1.4 ui-monospace,monospace',
      'cursor:pointer', 'box-shadow:0 2px 12px rgba(0,0,0,.35)', 'user-select:none',
      'display:none', 'max-width:46vw', 'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis'
    ].join(';');
    badge.textContent = '\\uD83D\\uDC65 …';
    badge.addEventListener('click', function () { window.open('/collab/panel', '_blank'); });
    document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(badge); });
    if (document.body) document.body.appendChild(badge);

    function render() {
      if (!peers.length) { badge.style.display = 'none'; return; }
      var names = peers.map(function (p) { return p.label; }).slice(0, 5).join('、');
      badge.textContent = '\\uD83D\\uDC65 ' + peers.length + (names ? '  ' + names : '');
      badge.style.display = 'block';
    }

    var es = new EventSource('/collab/presence?terminal=' + encodeURIComponent(id) + '&label=' + encodeURIComponent(label));
    es.addEventListener('snapshot', function (e) {
      try { var d = JSON.parse(e.data); peers = d.peers || []; render(); } catch (err) {}
    });
    es.addEventListener('peer/joined', function (e) {
      try { var d = JSON.parse(e.data); if (d.terminalId !== id) { peers.push(d); render(); } } catch (err) {}
    });
    es.addEventListener('peer/left', function (e) {
      try { var d = JSON.parse(e.data); peers = peers.filter(function (p) { return p.terminalId !== d.terminalId; }); render(); } catch (err) {}
    });
    es.onerror = function () { /* EventSource 自动重连 */ };
  } catch (err) {
    /* CSP 或任何异常：静默降级，不影响 GUI */
  }
})();
`
}

/** 注入到 index.html </body> 前的标签。 */
export function beaconTag() {
  return '<script src="/collab/beacon.js" defer></script>'
}
