/**
 * dsh-collab-sync — 客户端模块（浏览器侧）
 *
 * 在 dsh 设置页注册「开放 IP / 协作」分区：绑定范围（0.0.0.0 / 127.0.0.1 /
 * 指定 IP）、额外信任主机、强制重置写者锁逃生舱。数据经宿主路由
 * `/collab/api/bind`、`/collab/api/lock` 读写。
 *
 * 纯 JS 实现（ModuleLoader 格式），无需构建；由 dsh.client 清单装配。
 */
window.__ModuleLoader__.load({
	id: 'dsh-collab-sync',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const inject = ['slots'];

		function el(tag, cls, text) {
			const e = document.createElement(tag);
			if (cls) e.className = cls;
			if (text !== void 0) e.textContent = text;
			return e;
		}

		const styles = `
.dcs-page{font-family:ui-monospace,monospace;font-size:12px;line-height:1.6;padding:6px 2px;max-width:720px}
.dcs-page h3{margin:0 0 10px;font-size:13px}
.dcs-group{margin:0 0 14px}
.dcs-label{display:block;padding:8px 10px;border:1px solid var(--theme-border,#333);border-radius:8px;margin-bottom:6px;cursor:pointer}
.dcs-label.sel{border-color:var(--theme-accent,#4a9eff);background:rgba(74,158,255,.08)}
.dcs-label input{margin-right:8px}
.dcs-input,.dcs-textarea{width:100%;background:var(--theme-input-bg,#111);color:var(--theme-text,#ddd);border:1px solid var(--theme-border,#333);border-radius:6px;padding:7px 9px;font:inherit;margin-top:4px;box-sizing:border-box}
.dcs-textarea{min-height:56px;resize:vertical}
.dcs-row{display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap}
.dcs-btn{background:var(--theme-accent,#4a9eff);color:#fff;border:none;border-radius:6px;padding:7px 16px;cursor:pointer;font:inherit}
.dcs-btn:disabled{opacity:.45;cursor:not-allowed}
.dcs-btn.danger{background:transparent;border:1px solid #d33;color:#d33}
.dcs-muted{color:var(--theme-text-secondary,#888);font-size:11px}
.dcs-status{margin-top:10px;padding:9px 11px;border-radius:8px;white-space:pre-wrap;font-size:11px;display:none}
.dcs-status.ok{display:block;background:rgba(46,204,113,.12);border:1px solid rgba(46,204,113,.4)}
.dcs-status.err{display:block;background:rgba(231,76,60,.12);border:1px solid rgba(231,76,60,.5)}
.dcs-table{width:100%;border-collapse:collapse;font-size:11px;margin-top:6px}
.dcs-table td{padding:4px 8px;border-bottom:1px solid var(--theme-border,#222)}
.dcs-table td:first-child{color:var(--theme-text-secondary,#888);width:130px}
`;

		function apply(ctx) {
			ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
				name: 'settings.section',
				id: 'collab-sync-bind',
				order: 60,
				label: () => '开放 IP / 协作',
				component: () => ({
					render() {
						const style = document.createElement('style');
						style.textContent = styles;
						const page = el('div', 'dcs-page');
						const h = el('h3', undefined, '开放 IP / 绑定（dsh-collab-sync）');
						page.append(style, h);

						// ── 监听范围 ──
						const group = el('div', 'dcs-group');
						const radios = [
							{ v: '0.0.0.0', t: '全部接口 0.0.0.0 —— tailnet / LAN / 本机所有 IP 可访问' },
							{ v: '127.0.0.1', t: '仅本机 127.0.0.1 —— 只允许本机浏览器' },
							{ v: '__custom__', t: '指定 IP' },
						];
						const inputs = {};
						for (const r of radios) {
							const lab = el('label', 'dcs-label');
							const inp = document.createElement('input');
							inp.type = 'radio';
							inp.name = 'dcs-host';
							inp.value = r.v;
							inputs[r.v] = inp;
							lab.append(inp, document.createTextNode(r.t));
							lab.addEventListener('click', () => {
								for (const l of group.querySelectorAll('.dcs-label')) l.classList.remove('sel');
								lab.classList.add('sel');
								custom.style.display = r.v === '__custom__' ? 'block' : 'none';
							});
							group.append(lab);
						}
						const custom = el('input', 'dcs-input');
						custom.placeholder = '例如 192.168.1.50';
						custom.style.display = 'none';
						group.append(custom);
						page.append(group);

						// ── 额外信任主机 ──
						const trusted = el('textarea', 'dcs-textarea');
						trusted.placeholder = '每行一个 host 或 host:port，例如\n100.64.0.2\ndsh.example.com';
						const trustGroup = el('div', 'dcs-group');
						trustGroup.append(
							el('div', 'dcs-muted', '额外信任主机（绑定 0.0.0.0 时本机 IP 自动受信任）：'),
							trusted,
						);
						page.append(trustGroup);

						// ── 当前生效 ──
						const cur = el('div');
						const table = el('table', 'dcs-table');
						table.innerHTML = '<tr><td>当前绑定</td><td class="v-host">-</td></tr>' +
							'<tr><td>端口</td><td class="v-port">-</td></tr>' +
							'<tr><td>自动信任 LAN</td><td class="v-lan">-</td></tr>';
						cur.append(el('div', 'dcs-muted', '当前生效：'), table);
						page.append(cur);

						// ── 操作 ──
						const status = el('div', 'dcs-status');
						const save = el('button', 'dcs-btn', '保存（重启后生效）');
						const reset = el('button', 'dcs-btn danger', '强制重置写者锁');
						const ops = el('div', 'dcs-row');
						ops.append(save, reset, el('span', 'dcs-muted', '保存写入 ~/.dsh/.env，重启 dsh web 生效'));
						page.append(ops, status);

						const setStatus = (text, isErr) => {
							status.textContent = text;
							status.className = 'dcs-status ' + (isErr ? 'err' : 'ok');
						};

						const load = () => {
							fetch('/collab/api/bind')
								.then((r) => r.json())
								.then((d) => {
									if (!d.ok) return;
									const q = (s) => cur.querySelector(s);
									q('.v-host').textContent = d.host || '-';
									q('.v-port').textContent = String(d.port ?? '-');
									q('.v-lan').textContent = (d.lanAddresses || []).join('、') || '（无）';
									const curHost = d.host || '127.0.0.1';
									if (curHost === '0.0.0.0' || curHost === '127.0.0.1') {
										inputs[curHost].checked = true;
										for (const l of group.querySelectorAll('.dcs-label')) l.classList.toggle('sel', l.contains(inputs[curHost]));
									} else {
										inputs['__custom__'].checked = true;
										custom.style.display = 'block';
										custom.value = curHost;
									}
									if (d.saved) {
										trusted.value = (d.saved.extraTrustedHosts || []).join('\n');
									}
								})
								.catch(() => {});
						};

						save.addEventListener('click', () => {
							let host = '0.0.0.0';
							for (const key of Object.keys(inputs)) if (inputs[key].checked) host = key;
							if (host === '__custom__') host = custom.value.trim();
							if (!host) { setStatus('请选择或填写监听地址', true); return; }
							const extra = trusted.value.split(/\n/).map((s) => s.trim()).filter(Boolean);
							save.disabled = true;
							setStatus('保存中…', false);
							fetch('/collab/api/bind', {
								method: 'POST',
								headers: { 'content-type': 'application/json' },
								body: JSON.stringify({ host, extraTrustedHosts: extra }),
							}).then((r) => r.json()).then((d) => {
								setStatus(d.ok ? (d.message || '已保存') : (d.error || JSON.stringify(d)), !d.ok);
							}).catch((e) => setStatus('保存失败: ' + String(e), true))
								.finally(() => { save.disabled = false; });
						});

						reset.addEventListener('click', () => {
							if (!confirm('确认强制重置写者锁？仅当其他后端已停止时使用。')) return;
							reset.disabled = true;
							fetch('/collab/api/lock', {
								method: 'POST',
								headers: { 'content-type': 'application/json' },
								body: JSON.stringify({ action: 'reset' }),
							}).then((r) => r.json()).then((d) => {
								setStatus(d.ok ? (d.message || '已重置') : (d.error || JSON.stringify(d)), !d.ok);
							}).catch((e) => setStatus('重置失败: ' + String(e), true))
								.finally(() => { reset.disabled = false; });
						});

						load();
						const timer = window.setInterval(load, 5000);
						return { dispose: () => window.clearInterval(timer) };
					},
				}),
			})), 'dsh-collab-sync: settings section');
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
