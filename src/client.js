/**
 * dsh-collab-sync — 客户端模块源码（构建输入，勿直接加载）
 *
 * 经 `scripts/build-client.mjs` 构建为 `lib/client.js`（内联 react UMD + 本文件）。
 * 本文件假定作用域内有 `React`（构建时注入）。
 *
 * 组件为 React **类组件**（无 hooks）：跨 React 实例（shell 的 React 与本模块
 * 内联的 React 副本）也能正常挂载/更新。
 */
const inject = ['slots']

function el(tag, cls, text) {
  return React.createElement(tag, { className: cls }, text)
}

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
`

class CollabBindCard extends React.Component {
  constructor(props) {
    super(props)
    this.state = {
      host: null,
      port: null,
      lan: [],
      savedHost: '',
      savedExtras: [],
      selHost: '0.0.0.0',
      custom: '',
      status: '',
      err: false,
    }
    this.customRef = React.createRef()
    this.trustedRef = React.createRef()
  }

  componentDidMount() {
    this.load()
    this._timer = window.setInterval(() => this.load(), 5000)
  }

  componentWillUnmount() {
    window.clearInterval(this._timer)
  }

  load() {
    fetch('/collab/api/bind')
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) return
        const cur = d.host || '127.0.0.1'
        this.setState({
          host: d.host,
          port: d.port,
          lan: d.lanAddresses || [],
          savedHost: d.saved?.host || '',
          savedExtras: d.saved?.extraTrustedHosts || [],
          selHost: cur === '0.0.0.0' || cur === '127.0.0.1' ? cur : '__custom__',
          custom: cur === '0.0.0.0' || cur === '127.0.0.1' ? '' : cur,
        })
      })
      .catch(() => {})
  }

  setStatus(text, isErr) {
    this.setState({ status: text, err: Boolean(isErr) })
  }

  save() {
    let host = this.state.selHost
    if (host === '__custom__') host = (this.customRef.current?.value || '').trim()
    if (!host) {
      this.setStatus('请选择或填写监听地址', true)
      return
    }
    const extra = (this.trustedRef.current?.value || '')
      .split(/\n/)
      .map((s) => s.trim())
      .filter(Boolean)
    this.setStatus('保存中…', false)
    fetch('/collab/api/bind', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host, extraTrustedHosts: extra }),
    })
      .then((r) => r.json())
      .then((d) => this.setStatus(d.ok ? d.message || '已保存' : d.error || JSON.stringify(d), !d.ok))
      .catch((e) => this.setStatus('保存失败: ' + String(e), true))
  }

  resetLock() {
    if (!window.confirm('确认强制重置写者锁？仅当其他后端已停止时使用。')) return
    fetch('/collab/api/lock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'reset' }),
    })
      .then((r) => r.json())
      .then((d) => this.setStatus(d.ok ? d.message || '已重置' : d.error || JSON.stringify(d), !d.ok))
      .catch((e) => this.setStatus('重置失败: ' + String(e), true))
  }

  render() {
    const s = this.state
    const field = (label, hint, children) =>
      React.createElement(
        'div',
        { className: 'dcs-field' },
        React.createElement('div', { className: 'dcs-flabel' }, label),
        hint ? React.createElement('p', { className: 'dcs-fhint' }, hint) : null,
        children,
      )
    const radio = (value, text) =>
      React.createElement(
        'label',
        {
          className: 'dcs-radio' + (s.selHost === value ? ' sel' : ''),
          key: value,
          onClick: () => this.setState({ selHost: value }),
        },
        React.createElement('input', {
          type: 'radio',
          name: 'dcs-host',
          value,
          checked: s.selHost === value,
          onChange: () => this.setState({ selHost: value }),
        }),
        text,
      )
    const customInput = React.createElement('input', {
      ref: this.customRef,
      className: 'dcs-input',
      defaultValue: s.custom,
      placeholder: '例如 192.168.1.50',
      style: { display: s.selHost === '__custom__' ? 'block' : 'none' },
    })
    const statusCls = 'dcs-status' + (s.status ? (s.err ? ' err' : ' ok') : '')
    return React.createElement(
      'div',
      { className: 'dcs-card' },
      React.createElement('style', { dangerouslySetInnerHTML: { __html: styles } }),
      React.createElement(
        'div',
        { className: 'dcs-head' },
        React.createElement('h3', { className: 'dcs-title' }, '开放 IP / 协作'),
        React.createElement('p', { className: 'dcs-desc' }, 'dsh-collab-sync：监听范围、额外信任主机与写者锁逃生舱'),
      ),
      React.createElement(
        'div',
        { className: 'dcs-body' },
        field(
          '监听范围（webserver bind）',
          null,
          React.createElement(
            'div',
            null,
            radio('0.0.0.0', '全部接口 0.0.0.0 —— tailnet / LAN / 本机所有 IP 可访问'),
            radio('127.0.0.1', '仅本机 127.0.0.1 —— 只允许本机浏览器'),
            radio('__custom__', '指定 IP'),
            customInput,
          ),
        ),
        field(
          '额外信任主机',
          '绑定 0.0.0.0 时本机 IP 自动受信任；此处补充远程域名/地址',
          React.createElement('textarea', {
            ref: this.trustedRef,
            className: 'dcs-textarea',
            defaultValue: s.savedExtras.join('\n'),
            placeholder: '每行一个 host 或 host:port，例如\n100.64.0.2\ndsh.example.com',
          }),
        ),
        field(
          '当前生效',
          null,
          React.createElement(
            'div',
            { className: 'dcs-meta' },
            '当前绑定 ',
            React.createElement('b', null, s.host || '-'),
            ' · 端口 ',
            React.createElement('b', null, s.port ?? '-'),
            ' · 自动信任 LAN ',
            React.createElement('b', null, s.lan.join('、') || '（无）'),
          ),
        ),
      ),
      React.createElement(
        'div',
        { className: 'dcs-footer' },
        React.createElement('p', { className: statusCls }, s.status),
        React.createElement(
          'button',
          { className: 'dcs-btn dcs-save', onClick: () => this.save() },
          '保存（重启后生效）',
        ),
        React.createElement(
          'button',
          { className: 'dcs-btn dcs-danger', onClick: () => this.resetLock() },
          '强制重置写者锁',
        ),
      ),
    )
  }
}

function apply(ctx) {
  ctx.effect(
    () =>
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register({
          name: 'settings.section',
          id: 'collab-sync-bind',
          order: 60,
          label: () => '开放 IP / 协作',
          component: CollabBindCard,
        }),
      ),
    'dsh-collab-sync: settings section',
  )
}

exports.apply = apply
exports.inject = inject
