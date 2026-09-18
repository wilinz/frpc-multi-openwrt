'use strict';
'require view';
'require form';
'require uci';
'require rpc';
'require poll';
'require dom';
'require fs';

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

var CONFDIR = '/etc/frpc/';

// 各实例配置文件内容, load 时预读, 保存后同步更新
var confs = {};
// 本次保存是否改动了配置文件(文件不走 UCI, 要手动 reload)
var confChanged = false;
// 保存后 form.Map 会重新渲染, 轮询只注册一次
var polling = false;
var lastStatus = null;

function confPath(sid) {
	return CONFDIR + sid + '.toml';
}

function renderStatus(sid) {
	var inst = lastStatus && lastStatus.frpc && lastStatus.frpc.instances,
	    i = inst ? inst[sid] : null;

	if (i && i.running)
		return E('span', { 'style': 'color:#16a34a; font-weight:600' }, _('运行中') + ' (PID ' + i.pid + ')');
	return E('span', { 'style': 'color:#dc2626; font-weight:600' },
		uci.get('frpc', sid, 'enabled') == '1' ? _('未运行') : _('已停用'));
}

function refreshStatus() {
	return callServiceList('frpc').then(function (res) {
		lastStatus = res;
		document.querySelectorAll('[data-frpc-status]').forEach(function (el) {
			dom.content(el, renderStatus(el.getAttribute('data-frpc-status')));
		});
	});
}

return view.extend({
	load: function () {
		return Promise.all([
			callServiceList('frpc'),
			uci.load('frpc').then(function () {
				return Promise.all(uci.sections('frpc', 'instance').map(function (s) {
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
				return callInitAction('frpc', 'reload');
		});
	},

	render: function (data) {
		var m, s, o;

		lastStatus = data[0];

		m = new form.Map('frpc', _('frp 客户端'),
			_('每个实例是一个独立的客户端进程，配置文件保存在 /etc/frpc/实例名.toml。') + ' ' +
			_('保存后改动过的实例会自动重启。'));

		s = m.section(form.TypedSection, 'instance', _('实例'));
		s.anonymous = false;
		s.addremove = true;
		s.addbtntitle = _('添加实例');

		o = s.option(form.DummyValue, '_status', _('状态'));
		o.renderWidget = function (section_id) {
			if (!polling) {
				polling = true;
				poll.add(refreshStatus, 5);
			}
			return E('div', { 'data-frpc-status': section_id }, renderStatus(section_id));
		};

		o = s.option(form.Flag, 'enabled', _('启用'));
		o.rmempty = false;

		o = s.option(form.TextValue, '_conf', _('配置文件'));
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

		return m.render();
	}
});
