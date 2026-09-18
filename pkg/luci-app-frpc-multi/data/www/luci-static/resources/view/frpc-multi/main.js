'use strict';
'require view';
'require form';
'require uci';
'require rpc';
'require poll';
'require dom';
'require fs';
'require ui';

var callServiceList = rpc.declare({
	object: 'service',
	method: 'list',
	params: [ 'name' ],
	expect: { '': {} }
});

var callInitAction = rpc.declare({
	object: 'luci',
	method: 'setInitAction',
	params: [ 'name', 'action' ],
	expect: { result: false }
});

// 已暂存(保存了但没应用)的 UCI 改动, 按配置名分组
var callUciChanges = rpc.declare({
	object: 'uci',
	method: 'changes',
	expect: { changes: {} }
});

var CONF = 'frpc-multi';
var CONFDIR = '/etc/frpc-multi/';
var LOG_LINES = 500;

var CSS = [
	'.frpc-instance { border: 1px solid rgba(128,128,128,.3); border-radius: 4px; margin-bottom: 8px }',
	'.frpc-instance > summary { display: flex; align-items: center; gap: 16px; padding: 8px 12px; cursor: pointer; list-style: none }',
	'.frpc-instance > summary::-webkit-details-marker { display: none }',
	'.frpc-instance > summary::before { content: "\\25B8"; opacity: .6 }',
	'.frpc-instance[open] > summary::before { content: "\\25BE" }',
	'.frpc-instance > summary > strong { min-width: 120px }',
	'.frpc-instance > summary > .frpc-actions { margin-left: auto; display: flex; gap: 6px }',
	'.frpc-instance[open] > summary { border-bottom: 1px solid rgba(128,128,128,.3) }',
	'.frpc-instance > .cbi-section-node { padding: 8px 0 }',
	'.frpc-row { min-height: 30px; display: flex; align-items: center; gap: 6px }',
	// 值列是 flex 子项, 默认最小宽度等于内容宽度, 不换行的长日志会把它撑出容器并挤到下一行
	'.frpc-instance .cbi-value-field { min-width: 0 }',
	// 日志面板配色全部取主题变量, 与输入框/文本框同一套边框和底色, 暗色主题也跟着变
	'.frpc-logpanel { box-sizing: border-box; width: 100%; border: 1px solid var(--border-color-medium, #ccc); border-radius: 3px; background: var(--background-color-high, #fff); overflow: hidden }',
	'.frpc-logbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 6px 8px;' +
		' background: var(--background-color-medium, #f5f5f5); border-bottom: 1px solid var(--border-color-low, #e5e5e5) }',
	'.frpc-logbar select, .frpc-logbar input[type=search] { width: auto }',
	'.frpc-logbar input[type=search] { width: 200px }',
	'.frpc-logbar label { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; white-space: nowrap }',
	'.frpc-logbar .frpc-logcount { margin-left: auto; color: var(--text-color-medium, #777); white-space: nowrap }',
	'.frpc-logbody { height: 360px; min-height: 120px; resize: vertical; overflow: auto; padding: 4px 0;' +
		' font-family: monospace; line-height: 1.7; color: var(--text-color-highest, #000) }',
	'.frpc-logline { display: flex; gap: 12px; padding: 0 8px; white-space: pre }',
	'.frpc-logbody.wrap .frpc-logline { white-space: pre-wrap; word-break: break-all }',
	'.frpc-logline:hover { background: var(--background-color-medium, #f5f5f5) }',
	'.frpc-logline > .t, .frpc-logline > .src { flex: none; color: var(--text-color-medium, #777) }',
	'.frpc-logline > .lv { flex: none; width: 5ch }',
	'.frpc-logline > .msg { flex: 1 1 auto; min-width: 0 }',
	'.frpc-logline.lv-I > .lv { color: var(--primary-color-high, #1976d2) }',
	'.frpc-logline.lv-D > .lv, .frpc-logline.lv-T > .lv { color: var(--text-color-medium, #777) }',
	'.frpc-logline.lv-W { background: color-mix(in srgb, var(--warn-color-high, #efbd0b) 14%, transparent) }',
	'.frpc-logline.lv-W > .lv { font-weight: 700 }',
	'.frpc-logline.lv-E { background: color-mix(in srgb, var(--error-color-high, #f62b12) 10%, transparent) }',
	'.frpc-logline.lv-E > .lv, .frpc-logline.lv-E > .msg { color: var(--error-color-medium, #e8210d); font-weight: 700 }',
	'.frpc-logline mark { background: color-mix(in srgb, var(--warn-color-high, #efbd0b) 45%, transparent); color: inherit }',
	'.frpc-logempty { padding: 24px; text-align: center; color: var(--text-color-medium, #777); white-space: normal }'
].join('\n');

// 各实例配置文件内容, load 时预读, 保存后同步更新
var confs = {};
// 本次保存是否改动了配置文件(文件不走 UCI, 要手动 reload)
var confChanged = false;
// 保存后 form.Map 会重新渲染, 轮询只注册一次
var polling = false;
var lastStatus = null;
// 展开着的实例; 存进 sessionStorage, 改名刷新页面后仍保持展开
var opened = loadOpened();

function loadOpened() {
	try {
		return JSON.parse(sessionStorage.getItem('frpc-multi-opened')) || {};
	} catch (e) {
		return {};
	}
}

function setOpened(sid, open) {
	if (open)
		opened[sid] = true;
	else
		delete opened[sid];
	try {
		sessionStorage.setItem('frpc-multi-opened', JSON.stringify(opened));
	} catch (e) {}
}

function confPath(sid) {
	return CONFDIR + sid + '.toml';
}

function notifyError(e) {
	ui.addNotification(null, E('p', {}, e.message || String(e)), 'error');
}

function renderStatus(sid) {
	var inst = lastStatus && lastStatus[CONF] && lastStatus[CONF].instances,
	    i = inst ? inst[sid] : null;

	if (i && i.running)
		return E('span', { 'style': 'color:#16a34a; font-weight:600' }, _('Running') + ' (PID ' + i.pid + ')');
	return E('span', { 'style': 'color:#dc2626; font-weight:600' },
		uci.get(CONF, sid, 'enabled') == '1' ? _('Not running') : _('Disabled'));
}

function refreshStatus() {
	return callServiceList(CONF).then(function (res) {
		lastStatus = res;
		document.querySelectorAll('[data-frpc-status]').forEach(function (el) {
			dom.content(el, renderStatus(el.getAttribute('data-frpc-status')));
		});
	});
}

// 系统日志一行形如 "Fri Sep 18 12:01:43 2026 daemon.info frpc-main[123]: <msg>"
// frpc 的消息又形如 "2026-09-18 04:01:43.837 [I] [client/service.go:332] ...";
// 时间取系统日志的本地时间, frpc 自带的 UTC 时间戳和颜色码去掉
var SYSLOG_LEVEL = { emerg: 'E', alert: 'E', crit: 'E', err: 'E', warn: 'W', notice: 'I', info: 'I', debug: 'D' };
var LEVEL_NAME = { T: 'TRACE', D: 'DEBUG', I: 'INFO', W: 'WARN', E: 'ERROR' };
var LEVEL_RANK = { T: 0, D: 0, I: 1, W: 2, E: 3 };

function parseLogLine(l) {
	var m = l.match(/^\w+ (\w+ +\d+ [\d:]+) \d+ \w+\.(\w+) [^:]+: (.*)$/), msg, f;
	if (!m)
		return { t: '', lv: 'I', src: '', msg: l, raw: l };
	// 颜色码的 ESC 字节会被 logd 吞掉, 只剩 "[1;34m" 这样的残片, 两种都去掉
	msg = m[3].replace(/\x1b?\[[0-9;]+m/g, '')
		.replace(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+ /, '');
	f = msg.match(/^\[([TDIWE])\] (?:\[([^\]]+\.go:\d+)\] )?(.*)$/);
	return {
		t: m[1],
		lv: f ? f[1] : (SYSLOG_LEVEL[m[2]] || 'I'),
		src: f && f[2] ? f[2] : '',
		msg: f ? f[3] : msg,
		raw: m[1] + '  ' + msg
	};
}

// 每个实例的日志面板状态, 重新渲染表单后沿用
var logState = {};

function getLogState(sid) {
	return logState[sid] || (logState[sid] = {
		lines: [], text: null, level: 0, q: '', follow: true, wrap: false
	});
}

function highlight(text, q) {
	if (!q)
		return text;
	var out = [], lower = text.toLowerCase(), ql = q.toLowerCase(), i = 0, j;
	while ((j = lower.indexOf(ql, i)) >= 0) {
		out.push(text.substring(i, j), E('mark', {}, text.substr(j, q.length)));
		i = j + q.length;
	}
	out.push(text.substring(i));
	return out;
}

function visibleLines(st) {
	var q = st.q.toLowerCase();
	return st.lines.filter(function (x) {
		return LEVEL_RANK[x.lv] >= st.level && (!q || x.raw.toLowerCase().indexOf(q) >= 0);
	});
}

function renderLogBody(sid) {
	var panel = document.querySelector('[data-frpc-log="' + sid + '"]');
	if (!panel)
		return;
	var st = getLogState(sid),
	    body = panel.querySelector('.frpc-logbody'),
	    lines = visibleLines(st);

	body.classList.toggle('wrap', st.wrap);
	dom.content(body, lines.length ? lines.map(function (x) {
		return E('div', { 'class': 'frpc-logline lv-' + x.lv }, [
			E('span', { 'class': 't' }, x.t),
			E('span', { 'class': 'lv' }, LEVEL_NAME[x.lv]),
			x.src ? E('span', { 'class': 'src' }, x.src) : '',
			E('span', { 'class': 'msg' }, highlight(x.msg, st.q))
		]);
	}) : E('div', { 'class': 'frpc-logempty' },
		st.text == null ? _('Loading…') : st.lines.length ? _('No matching log lines') : _('No logs yet')));

	panel.querySelector('.frpc-logcount').textContent =
		_('Showing %d of %d lines').format(lines.length, st.lines.length);
	if (st.follow)
		body.scrollTop = body.scrollHeight;
}

function refreshLog(sid) {
	if (!document.querySelector('[data-frpc-log="' + sid + '"]'))
		return Promise.resolve();
	return L.resolveDefault(fs.exec('/sbin/logread', [ '-e', '^frpc-' + sid + '\\[' ]), {}).then(function (res) {
		var st = getLogState(sid), text = res.stdout || '';
		// 内容没变就不重绘, 免得打断选中文字
		if (text === st.text)
			return;
		st.text = text;
		st.lines = text.split('\n').filter(function (l) { return l; }).slice(-LOG_LINES).map(parseLogLine);
		renderLogBody(sid);
	});
}

function downloadLog(sid) {
	var st = getLogState(sid),
	    blob = new Blob([ visibleLines(st).map(function (x) { return x.raw; }).join('\n') + '\n' ], { type: 'text/plain' }),
	    a = E('a', { 'href': URL.createObjectURL(blob), 'download': 'frpc-' + sid + '.log' });
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(a.href);
}

// 路由器多是 http 访问, 不是安全上下文, navigator.clipboard 不可用, 退回 execCommand
function copyLog(sid, btn) {
	var text = visibleLines(getLogState(sid)).map(function (x) { return x.raw; }).join('\n'),
	    done = function () {
		    btn.textContent = _('Copied');
		    window.setTimeout(function () { btn.textContent = _('Copy'); }, 1500);
	    };
	if (navigator.clipboard && window.isSecureContext)
		return navigator.clipboard.writeText(text).then(done);
	var ta = E('textarea', { 'style': 'position:fixed; opacity:0' }, text);
	document.body.appendChild(ta);
	ta.select();
	document.execCommand('copy');
	document.body.removeChild(ta);
	done();
}

function renderLogPanel(sid) {
	var st = getLogState(sid), body, follow, copyBtn;

	body = E('div', { 'class': 'frpc-logbody' + (st.wrap ? ' wrap' : '') });
	// 手动往上翻就暂停跟随, 翻回底部自动恢复
	body.addEventListener('scroll', function () {
		st.follow = body.scrollTop + body.clientHeight >= body.scrollHeight - 4;
		follow.checked = st.follow;
	});

	follow = E('input', { 'type': 'checkbox', 'checked': st.follow ? '' : null, 'change': function (ev) {
		st.follow = ev.target.checked;
		if (st.follow)
			body.scrollTop = body.scrollHeight;
	} });

	copyBtn = E('button', { 'class': 'cbi-button', 'click': function (ev) {
		ev.preventDefault();
		copyLog(sid, copyBtn);
	} }, _('Copy'));

	var panel = E('div', { 'class': 'frpc-logpanel', 'data-frpc-log': sid }, [
		E('div', { 'class': 'frpc-logbar' }, [
			E('select', { 'class': 'cbi-input-select', 'change': function (ev) {
				st.level = +ev.target.value;
				renderLogBody(sid);
			} }, [
				E('option', { 'value': '0', 'selected': st.level == 0 ? '' : null }, _('All levels')),
				E('option', { 'value': '2', 'selected': st.level == 2 ? '' : null }, _('Warnings and above')),
				E('option', { 'value': '3', 'selected': st.level == 3 ? '' : null }, _('Errors only'))
			]),
			E('input', { 'type': 'search', 'class': 'cbi-input-text', 'placeholder': _('Search'), 'value': st.q,
				'input': function (ev) {
					st.q = ev.target.value;
					renderLogBody(sid);
				} }),
			E('label', {}, [ follow, _('Follow') ]),
			E('label', {}, [ E('input', { 'type': 'checkbox', 'checked': st.wrap ? '' : null, 'change': function (ev) {
				st.wrap = ev.target.checked;
				renderLogBody(sid);
			} }), _('Wrap lines') ]),
			copyBtn,
			E('button', { 'class': 'cbi-button', 'click': function (ev) {
				ev.preventDefault();
				downloadLog(sid);
			} }, _('Download')),
			E('span', { 'class': 'frpc-logcount' })
		]),
		body
	]);

	// 面板插入页面后先用已有数据画一次, 新数据由轮询补上
	window.setTimeout(function () { renderLogBody(sid); }, 0);
	return panel;
}

function refreshAll() {
	return Promise.all([ refreshStatus() ].concat(Object.keys(opened).map(refreshLog)));
}

function restartInstance(sid) {
	return fs.exec('/etc/init.d/' + CONF, [ 'restart', sid ]).then(function () {
		// 等新进程起来再刷新, 否则拿到的还是空状态
		return new Promise(function (resolve) { window.setTimeout(resolve, 1000); });
	}).then(function () {
		return Promise.all([ refreshStatus(), refreshLog(sid) ]);
	}).catch(notifyError);
}

// 改名在路由器上一步完成(UCI 段名 + 配置文件 + reload), 不走暂存;
// 有未应用的 frpc 改动时拒绝, 否则那些改动还指着旧段名
function renameInstance(sid, name) {
	name = name.trim();
	if (name === sid)
		return Promise.resolve();
	if (!/^[A-Za-z0-9_]+$/.test(name))
		return Promise.resolve(notifyError(_('Instance names may only contain letters, digits and underscores')));

	return callUciChanges().then(function (changes) {
		if (changes[CONF] && changes[CONF].length)
			throw new Error(_('There are unapplied changes, save and apply them before renaming.'));
		return fs.exec('/usr/libexec/frpc-multi/rename', [ sid, name ]);
	}).then(function (res) {
		if (res.code !== 0)
			throw new Error({
				2: _('Instance names may only contain letters, digits and underscores'),
				3: _('Instance %s does not exist').format(sid),
				4: _('Instance %s already exists').format(name),
				5: _('%s already exists').format(confPath(name)),
				6: _('Failed to rename the UCI section')
			}[res.code] || (res.stderr || '').trim() || _('Rename failed'));
		if (opened[sid]) {
			setOpened(sid, false);
			setOpened(name, true);
		}
		window.location.reload();
	}).catch(notifyError);
}

return view.extend({
	load: function () {
		return Promise.all([
			callServiceList(CONF),
			uci.load(CONF).then(function () {
				return Promise.all(uci.sections(CONF, 'instance').map(function (s) {
					var sid = s['.name'];
					return L.resolveDefault(fs.trimmed(confPath(sid)), '').then(function (c) {
						confs[sid] = c;
					});
				}));
			})
		]);
	},

	handleSave: function (ev) {
		confChanged = false;
		return this.super('handleSave', [ ev ]).then(function () {
			if (confChanged)
				return callInitAction(CONF, 'reload');
		});
	},

	render: function (data) {
		var m, s, o;

		lastStatus = data[0];

		m = new form.Map(CONF, _('FrpcMulti'),
			_('Each instance runs as a separate client process with its config file at /etc/frpc-multi/&lt;name&gt;.toml.') + ' ' +
			_('Instances whose settings changed are restarted automatically on save.'));

		s = m.section(form.TypedSection, 'instance', _('Instances'),
			_('The instance name may only contain letters, digits and underscores, and also names its config file.'));
		s.anonymous = false;
		s.addremove = true;
		s.addbtntitle = _('Add instance');
		s.renderSectionAdd = function () {
			var el = form.TypedSection.prototype.renderSectionAdd.apply(this, arguments),
			    input = el.querySelector('.cbi-section-create-name');
			if (input)
				input.placeholder = _('Instance name, e.g. office');
			return el;
		};
		s.handleAdd = function (ev, name) {
			setOpened(name, true);
			return form.TypedSection.prototype.handleAdd.apply(this, arguments);
		};
		// 每个实例折叠成一行: 名称 + 状态 + 操作, 点开才显示设置和日志
		s.renderContents = function (cfgsections, nodes) {
			var sectionEl = E('div', { 'id': 'cbi-' + CONF + '-instance', 'class': 'cbi-section' }, [
				E('h3', {}, this.title),
				E('div', { 'class': 'cbi-section-descr' }, this.description)
			]);

			cfgsections.forEach(L.bind(function (sid, i) {
				var del = ui.createHandlerFn(this, 'handleRemove', sid),
				    restart = ui.createHandlerFn(this, restartInstance, sid);

				// 按钮在 summary 里, 阻止默认行为免得顺带折叠/展开
				function inSummary(fn) {
					return function (ev) { ev.preventDefault(); return fn(ev); };
				}

				sectionEl.appendChild(E('details', {
					'class': 'frpc-instance',
					'open': opened[sid] ? '' : null,
					'toggle': function (ev) {
						setOpened(sid, ev.target.open);
						if (ev.target.open)
							refreshLog(sid);
					}
				}, [
					E('summary', {}, [
						E('strong', {}, sid),
						E('span', { 'data-frpc-status': sid }, renderStatus(sid)),
						E('div', { 'class': 'frpc-actions' }, [
							E('button', {
								'class': 'cbi-button cbi-button-action',
								'disabled': (this.map.readonly || uci.get(CONF, sid, 'enabled') != '1') ? '' : null,
								'click': inSummary(restart)
							}, _('Restart')),
							E('button', {
								'class': 'cbi-button cbi-button-remove',
								'disabled': this.map.readonly || null,
								'click': inSummary(del)
							}, _('Delete'))
						])
					]),
					E('div', {
						'id': 'cbi-' + CONF + '-' + sid,
						'class': 'cbi-section-node',
						'data-section-id': sid
					}, nodes[i])
				]));
			}, this));

			if (!cfgsections.length)
				sectionEl.appendChild(E('em', {}, _('No instances yet')));
			sectionEl.appendChild(this.renderSectionAdd());
			dom.bindClassInstance(sectionEl, this);

			if (!polling) {
				polling = true;
				poll.add(refreshAll, 5);
			}
			return sectionEl;
		};

		o = s.option(form.DummyValue, '_name', _('Name'));
		o.renderWidget = function (section_id) {
			var input = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': section_id }),
			    btn = E('button', {
				    'class': 'cbi-button cbi-button-apply',
				    'click': ui.createHandlerFn(this, function () {
					    return renameInstance(section_id, input.value);
				    })
			    }, _('Rename'));
			return E('div', { 'class': 'frpc-row' }, [ input, btn ]);
		};
		o.description = _('Renaming takes effect immediately and renames the config file too.');

		o = s.option(form.Flag, 'enabled', _('Enable'));
		o.rmempty = false;

		o = s.option(form.TextValue, '_conf', _('Config file'));
		o.rows = 24;
		o.wrap = 'off';
		o.monospace = true;
		o.placeholder = 'serverAddr = "x.x.x.x"\nserverPort = 7000\n...';
		o.cfgvalue = function (section_id) {
			return confs[section_id] || '';
		};
		o.write = function (section_id, value) {
			value = (value || '').replace(/\r\n/g, '\n').trim();
			return fs.write(confPath(section_id), value ? value + '\n' : '').then(function () {
				confs[section_id] = value;
				confChanged = true;
			});
		};
		o.remove = function (section_id) {
			return this.write(section_id, '');
		};

		// 放在表单行里, 左边沿与配置文件框对齐
		o = s.option(form.DummyValue, '_log', _('Log'));
		o.renderWidget = function (section_id) {
			return renderLogPanel(section_id);
		};

		return m.render().then(function (node) {
			// 已展开的实例在插入页面后立刻拉一次日志, 不等第一轮轮询
			window.setTimeout(refreshAll, 0);
			return E([ E('style', {}, CSS), node ]);
		});
	}
});
