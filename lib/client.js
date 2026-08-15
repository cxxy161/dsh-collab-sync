/**
 * dsh-collab-sync — 客户端模块（浏览器侧）
 *
 * 在 dsh 设置页注册「开放 IP / 协作」分区卡片：绑定范围（0.0.0.0 / 127.0.0.1 /
 * 指定 IP）、额外信任主机、强制重置写者锁逃生舱。数据经宿主路由
 * `/collab/api/bind`、`/collab/api/lock` 读写。
 *
 * UI 使用 dsh 本体设计令牌（--dsw-alias-*），与设置页卡片/字段风格一致。
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

		// 对齐 dsh 设置页卡片/字段的设计令牌
		const styles = `
.dcs-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;max-width:760px;margin:0}
.dcs-head{padding:14px 16px 12px;display:flex;flex-direction:column;gap:4px}
.dcs-title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4;margin:0}
.dcs-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5;margin:0}
.dcs-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:4px 0 8px}
.dcs-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}
.dcs-field+.dcs-field{border-top:1px solid var(--dsw-alias-border-l2)}
.dcs-flabel{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}
.dcs-fhint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;margin:0}
.dcs-radio{display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:13px}
.dcs-radio input{margin:0}
.dcs-radio.sel{color:var(--dsw-alias-label-primary)}
.dcs-input,.dcs-textarea{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:7px 12px;font-size:13px;line-height:1.5;font-family:inherit;box-sizing:border-box;width:100%}
.dcs-input:focus-visible,.dcs-textarea:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.dcs-textarea{min-height:64px;resize:vertical}
.dcs-meta{font-size:12px;color:var(--dsw-alias-label-tertiary);padding:2px 0}
.dcs-meta b{color:var(--dsw-alias-label-secondary);font-weight:500}
.dcs-footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 16px;display:flex;flex-wrap:wrap}
.dcs-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.dcs-btn:disabled{opacity:.4;cursor:default}
.dcs-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.dcs-danger{border-color:var(--dsw-alias-label-error);color:var(--dsw-alias-label-error);background:transparent}
.dcs-status{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5;white-space:pre-wrap}
.dcs-status.ok{color:var(--dsw-alias-state-business-primary)}
.dcs-status.err{color:var(--dsw-alias-label-error)}
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

						const card = el('div', 'dcs-card');
						const head = el('div', 'dcs-head');
						head.append(
							el('h3', 'dcs-title', '开放 IP / 协作'),
							el('p', 'dcs-desc', 'dsh-collab-sync：监听范围、额外信任主机与写者锁逃生舱'),
						);
						const body = el('div', 'dcs-body');
						card.append(style, head, body);

						// ── 字段 1：监听范围 ──
						const f1 = el('div', 'dcs-field');
						f1.append(el('div', 'dcs-flabel', '监听范围（webserver bind）'));
						const radios = [
							{ v: '0.0.0.0', t: '全部接口 0.0.0.0 —— tailnet / LAN / 本机所有 IP 可访问' },
							{ v: '127.0.0.1', t: '仅本机 127.0.0.1 —— 只允许本机浏览器' },
							{ v: '__custom__', t: '指定 IP' },
						];
						const inputs = {};
						for (const r of radios) {
							const lab = el('label', 'dcs-radio');
							const inp = document.createElement('input');
							inp.type = 'radio';
							inp.name = 'dcs-host';
							inp.value = r.v;
							inputs[r.v] = inp;
							lab.append(inp, document.createTextNode(r.t));
							lab.addEventListener('click', () => {
								for (const l of f1.querySelectorAll('.dcs-radio')) l.classList.toggle('sel', l === lab);
								custom.style.display = r.v === '__custom__' ? 'block' : 'none';
							});
							f1.append(lab);
						}
						const custom = el('input', 'dcs-input');
						custom.placeholder = '例如 192.168.1.50';
						custom.style.display = 'none';
						f1.append(custom);
						body.append(f1);

						// ── 字段 2：额外信任主机 ──
						const f2 = el('div', 'dcs-field');
						const trusted = el('textarea', 'dcs-textarea');
						trusted.placeholder = '每行一个 host 或 host:port，例如\n100.64.0.2\ndsh.example.com';
						f2.append(
							el('div', 'dcs-flabel', '额外信任主机'),
							el('p', 'dcs-fhint', '绑定 0.0.0.0 时本机 IP 自动受信任；此处补充远程域名/地址'),
							trusted,
						);
						body.append(f2);

						// ── 字段 3：当前生效 ──
						const f3 = el('div', 'dcs-field');
						const meta = el('div', 'dcs-meta');
						meta.innerHTML = '当前绑定 <b class="m-host">-</b> · 端口 <b class="m-port">-</b> · 自动信任 LAN <b class="m-lan">-</b>';
						f3.append(el('div', 'dcs-flabel', '当前生效'), meta);
						body.append(f3);

						// ── 底部操作 ──
						const footer = el('div', 'dcs-footer');
						const status = el('p', 'dcs-status');
						const save = el('button', 'dcs-btn dcs-save', '保存（重启后生效）');
						const reset = el('button', 'dcs-btn dcs-danger', '强制重置写者锁');
						footer.append(status, save, reset);
						card.append(footer);

						const setStatus = (text, isErr) => {
							status.textContent = text;
							status.className = 'dcs-status ' + (isErr ? 'err' : 'ok');
						};

						const load = () => {
							fetch('/collab/api/bind')
								.then((r) => r.json())
								.then((d) => {
									if (!d.ok) return;
									card.querySelector('.m-host').textContent = d.host || '-';
									card.querySelector('.m-port').textContent = String(d.port ?? '-');
									card.querySelector('.m-lan').textContent = (d.lanAddresses || []).join('、') || '（无）';
									const curHost = d.host || '127.0.0.1';
									if (curHost === '0.0.0.0' || curHost === '127.0.0.1') {
										inputs[curHost].checked = true;
										for (const l of f1.querySelectorAll('.dcs-radio')) l.classList.toggle('sel', l.contains(inputs[curHost]));
									} else {
										inputs['__custom__'].checked = true;
										custom.style.display = 'block';
										custom.value = curHost;
									}
									if (d.saved) trusted.value = (d.saved.extraTrustedHosts || []).join('\n');
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
