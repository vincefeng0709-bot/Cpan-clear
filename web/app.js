'use strict';
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const token = $('meta[name="spacewell-token"]').content;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths = {
  clean: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m3 0-1 13a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 7m4 4v7m4-7v7"/>',
  analyze: '<path d="M4 19h16M6 15V9m6 6V4m6 11v-5"/>',
  move: '<path d="M3 6h7l2 2h9v12H3zM7 14h10m-3-3 3 3-3 3"/>',
  history: '<path d="M3 11a9 9 0 1 1 2 7M3 4v7h7m2-5v6l4 2"/>',
  disk: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 14h18m-4 2h1m-5 0h1"/>',
  scan: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M7 12h10"/>',
  arrow: '<path d="M4 12h15m-5-5 5 5-5 5"/>',
  back: '<path d="m13 5-7 7 7 7M6 12h14"/>',
  folder: '<path d="M3 6h7l2 2h9v12H3z"/>',
  file: '<path d="M14 3H5v18h14V8zM14 3v5h5M8 13h8m-8 4h6"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  export: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  external: '<path d="M14 3h7v7m0-7L10 14M10 5H3v16h16v-7"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  compare: '<path d="M8 3v18m8-18v18M3 8l5-5 5 5m-2 8 5 5 5-5"/>',
  refresh: '<path d="M20 11A8 8 0 1 0 18.9 16M20 4v7h-7"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.file}</svg>`;
const fmt = n => n == null ? '未统计' : n >= 1073741824 ? `${(n/1073741824).toFixed(2)} GiB` : n >= 1048576 ? `${(n/1048576).toFixed(1)} MiB` : n >= 1024 ? `${(n/1024).toFixed(1)} KiB` : `${n} B`;
const gib = n => (n/1073741824).toFixed(1);
const base = p => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const titles = {clean:['清理中心','缓存与临时文件已分类列出，可一键移入回收站；个人文件在空间分析中勾选处理。'],analyze:['空间分析','逐层浏览目录与全部大文件，勾选后批量移入回收站或永久删除。'],history:['操作记录','每次清理、删除与迁移的结果都在这里；已转移文件可恢复。'],move:['跨盘迁移','把不常用的大目录复制校验后转移到其他磁盘，释放 C 盘空间。']};
const jobLabels = {scan:'扫描本地存储', move:'跨盘迁移', clean:'转移至恢复区', restore:'恢复文件', recycle:'移入回收站', junk:'一键清理', purge:'永久删除'};
const statusLabels = {done:'已完成', error:'部分失败', cancelled:'已取消', running:'执行中', restoring:'恢复中', restored:'已恢复', restore_error:'恢复未完成', interrupted:'上次中断'};
const state = {view:'clean', summary:null, junk:null, drive:'C:\\', path:'C:\\', scope:null, revision:0, query:'', offset:0, sort:'size', analyzeTab:'folders', historyTab:'operations', min:0, files:[], browse:null, request:0, lastJob:'', plan:null, recyclePlan:null, batchPaths:[], pendingRender:false, lastScroll:0, jobDismissed:false};
const selectedFiles = new Map();
// 每个区域最后一次实际写入 DOM 的数据指纹：轮询回来数据没变就跳过写入，
// 界面保持静止，只有数据真正变化时才重画对应区块。
const painted = {head:'', nav:'', job:'', clean:'', cleanOps:'', analyzeToolbar:'', analyzeBody:'', history:'', move:''};
function setText(el, text) { if (el && el.textContent !== text) el.textContent = text; }
function resetPainted() {painted.clean=painted.cleanOps=painted.analyzeToolbar=painted.analyzeBody=painted.history=painted.move='';}
async function api(path, data) {
  const res = await fetch('/api/'+path, {method:data === undefined?'GET':'POST', headers:{'X-Spacewell-Token':token, ...(data === undefined?{}:{'Content-Type':'application/json'})}, body:data === undefined?undefined:JSON.stringify(data)});
  const value = await res.json();
  if (!res.ok) throw new Error(value.error || '操作失败');
  return value;
}
function toast(text, error=false) { const node=document.createElement('div');node.className='toast'+(error?' error':'');node.textContent=text;$('#toasts').append(node);setTimeout(()=>node.remove(),error?9000:4500); }
function notice(text, warning=false) {return `<div class="notice ${warning?'warning':''}">${icon('info')}<span>${text}</span></div>`;}
function button(label, action, extra='', cls='') {return `<button class="button ${cls}" data-action="${action}" ${extra}>${label}</button>`;}
function empty(title, text) {return `<div class="empty">${icon('info')}<h3>${title}</h3><p>${text}</p></div>`;}
function loading() {return '<div class="loading-screen"><div class="spinner"></div><p>正在读取…</p></div>';}
const colors=['#6f9373','#9eb598','#c4d2b8','#bcae85','#d5c8a9','#93b5aa','#b9ccc5','#d7ddd0'];
function route(view) {location.hash=view;}
async function refresh() {
  const [summary, junk] = await Promise.all([api('summary'), api('junk').catch(() => null)]);
  const previous = state.summary?.snapshot;
  state.summary = summary; state.junk = junk; state.revision = summary.revision;
  if (!state.scope || previous !== summary.snapshot) {
    state.scope = summary.roots[0] || state.drive;
    state.path = folderScope() ? state.scope : (summary.roots[0] || state.drive);
    state.offset = 0;
    state.drive = summary.volumes.find(v => state.scope.toLowerCase().startsWith(v.path.toLowerCase()))?.path || state.drive;
  }
  const stamp = summary.live_updated || summary.finished;
  setText($('#scan-time'), stamp ? '数据更新 ' + new Date(stamp).toLocaleString('zh-CN',{hour12:false}) : '');
  const badge = $('.local-badge');
  const badgeText = summary.monitor?.status === 'limited' ? '自动更新受限' : '自动更新已开启';
  if (badge.textContent !== badgeText) badge.textContent = badgeText;
  badge.title = summary.monitor?.message || '';
  renderJob(summary.job);
}
function folderScope() {return !!state.scope && !/^[a-z]:[\\/]*$/i.test(state.scope);}
function inScope(path) {const scope=(folderScope()?state.scope:state.drive).toLowerCase().replace(/[\\/]+$/,'');return path.toLowerCase()===scope||path.toLowerCase().startsWith(scope+'\\');}
// 磁盘可用空间的原始字节数每次请求都在抖动；指纹只取磁盘卡片显示的 0.1 GiB 档位，
// 显示没变化就不重建工具栏，避免整页重画。
function volumeKey() {return JSON.stringify(state.summary.volumes.map(v=>[v.path, gib(v.free), Math.round(v.used/v.total*100)]));}
function navigate() {state.view=location.hash.slice(1) in titles?location.hash.slice(1):'clean';state.query='';state.offset=0;resetPainted();render();}
function driveOptions(selected=state.drive, all=false) {return (all?'<option value="">全部磁盘</option>':'')+state.summary.volumes.map(v=>`<option value="${esc(v.path)}" ${v.path===selected?'selected':''}>${esc(v.path)} · ${fmt(v.free)} 可用</option>`).join('');}
function render() {
  if (!state.summary) return;
  const [title, subtitle] = titles[state.view];
  if (painted.head !== title) {
    painted.head = title;
    $('#crumb').textContent = title; $('#page-title').textContent = title; $('#page-subtitle').textContent = subtitle;
  }
  if (painted.nav !== state.view) {
    painted.nav = state.view;
    $('#navigation').innerHTML = Object.entries(titles).map(([v, t]) => `<button class="nav-item ${v===state.view?'active':''}" data-action="nav" data-view="${v}" title="${t[0]}">${icon(v)}<span>${t[0]}</span></button>`).join('');
  }
  const handlers = {clean:renderClean, analyze:renderAnalyze, history:renderHistory, move:renderMove};
  Promise.resolve(handlers[state.view]()).catch(e => {resetPainted(); $('#content').innerHTML = empty('读取遇到问题', esc(e.message)); toast(e.message, true);});
}
function driveStrip() {
  return `<div class="drive-strip" id="drive-strip">${state.summary.volumes.map(v => {
    const n = v.used / v.total * 100;
    return `<button class="drive-chip ${v.path===state.drive?'active':''}" data-action="drive" data-path="${esc(v.path)}"><span class="chip-label">${esc(v.path.slice(0,2))} 盘</span><span class="chip-free"><strong>${gib(v.free)}</strong> GiB 可用</span><span class="chip-bar"><i class="${n>90?'danger':''}" style="width:${n}%"></i></span></button>`;
  }).join('')}</div>`;
}
function recyclePanel(info) {
  if (!info) return '<div class="recycle-stat"><strong>未知</strong><span>暂时无法读取回收站统计</span></div>';
  if (!info.count) return '<div class="recycle-stat"><strong>空</strong><span>回收站没有文件</span></div>';
  return `<div class="recycle-stat"><strong>${fmt(info.bytes)}</strong><span>${info.count.toLocaleString()} 个项目 · 清空后彻底释放空间</span></div>`;
}
function junkCards() {
  const junk = state.junk;
  if (!junk || junk.status === 'idle' || junk.status === 'scanning') return '<div class="muted-line">正在统计常见缓存与临时文件，几秒内完成…</div>';
  if (junk.status === 'error') return empty('无法统计垃圾文件', esc(junk.message || '未知错误'));
  const groups = new Map();
  for (const c of junk.categories) { if (!groups.has(c.group)) groups.set(c.group, []); groups.get(c.group).push(c); }
  return [...groups].map(([group, cats]) => `<div class="junk-group"><h3>${esc(group)}</h3>${cats.map(junkCard).join('')}</div>`).join('');
}
function junkCard(c) {
  const cleanable = c.risk === 'safe' && c.bytes > 0;
  return `<div class="junk-row"><div class="junk-main"><strong>${esc(c.name)}</strong><span>${esc(c.desc)}</span></div><div class="junk-side"><span class="amount">${fmt(c.bytes)}</span><span class="muted">${c.files.toLocaleString()} 个文件${c.incomplete?' · 部分跳过':''}</span>${cleanable?button('一键清理','junk-clean',`data-category="${esc(c.id)}"`,'small primary'):(c.bytes>0?button('查看明细','junk-detail',`data-category="${esc(c.id)}"`,'small soft'):'<span class="tag neutral">无内容</span>')}</div></div>`;
}
async function renderClean() {
  const request = ++state.request;
  const junk = state.junk;
  const key = JSON.stringify([state.drive, volumeKey(), !!state.summary.snapshot, junk]);
  if (painted.clean !== key) { painted.clean = key; painted.cleanOps = ''; $('#content').innerHTML = `${driveStrip()}${!state.summary.snapshot?notice('尚未完整扫描磁盘。垃圾清理与大文件功能现在即可使用；完整扫描可为目录浏览提供体积数据。'):''}<div class="clean-grid"><section class="panel junk-panel"><div class="panel-head"><div><h2>垃圾文件分类</h2><p>${junk?.generated?'统计于 '+new Date(junk.generated).toLocaleString('zh-CN',{hour12:false}):'常见缓存与临时文件 · 只读统计'}</p></div>${junk?.status==='scanning'?'<div class="spinner small"></div>':''}</div><div class="junk-list">${junkCards()}</div><div class="tiny-note">一键清理把缓存内容移入 Windows 回收站，可随时恢复；正在使用的文件自动跳过，浏览器运行时建议先关闭浏览器。</div></section><aside class="panel recycle-panel"><div class="panel-head"><h2>回收站</h2></div>${recyclePanel(junk?.recycle)}<div class="panel-foot">${button('清空回收站','recycle-empty','','danger-soft')}${button('打开回收站','system','data-system="recycle"','soft')}</div><div class="tiny-note">移入回收站的文件仍占用磁盘空间，清空回收站后才会真正释放。</div></aside></div><div class="section-heading"><h2>最近操作</h2><button class="text-button" data-action="nav" data-view="history">全部记录 ${icon('arrow')}</button></div><div id="recent-ops">${loading()}</div>`; }
  try {
    const rows = await api('history');
    if (request !== state.request || state.view !== 'clean') return;
    const opsKey = JSON.stringify(rows.slice(0, 4));
    if (painted.cleanOps === opsKey) return;
    painted.cleanOps = opsKey;
    if ($('#recent-ops')) $('#recent-ops').innerHTML = rows.length ? `<div class="mini-history">${rows.slice(0, 4).map(historyRow).join('')}</div>` : '<div class="muted-line">暂无操作记录</div>';
  } catch (e) { if ($('#recent-ops')) $('#recent-ops').innerHTML = `<div class="muted-line">${esc(e.message)}</div>`; }
}
function fileTable(rows, operations=true) {
  if (!rows.length) return empty('没有匹配的项目','试试其他目录或筛选条件。');
  const total = [...selectedFiles.values()].reduce((a,b)=>a+b,0);
  return `<div class="batch-bar"><label><input type="checkbox" id="select-page" aria-label="全选当前页" ${rows.filter(r=>!r.linked).length&&rows.filter(r=>!r.linked).every(r=>selectedFiles.has(r.path))?'checked':''}> 全选当前页</label><span id="selection-count">已选 ${selectedFiles.size} 项 · ${fmt(total)}</span>${button('移入回收站','batch-recycle',selectedFiles.size?'':'disabled','small primary')}${button('永久删除','batch-purge',selectedFiles.size?'':'disabled','small danger-soft')}${selectedFiles.size?button('取消选择','clear-selection','','small'):''}</div><div class="table-wrap"><table><thead><tr><th class="check-cell">选择</th><th>文件 / 目录</th><th>体积</th><th>类型</th><th class="right-align">操作</th></tr></thead><tbody>${rows.map(r=>`<tr class="${selectedFiles.has(r.path)?'is-selected':''}"><td class="check-cell"><input type="checkbox" class="file-check" aria-label="选择 ${esc(r.name||base(r.path))}" data-path="${esc(r.path)}" data-bytes="${r.bytes||0}" ${selectedFiles.has(r.path)?'checked':''} ${r.linked?'disabled':''}></td><td><div class="file-cell"><span class="file-icon ${r.directory?'folder':''}">${icon(r.directory?'folder':'file')}</span><div><button class="plain file-name" title="${esc(r.path)}" data-action="${r.directory&&!r.linked?'explore':'details'}" data-path="${esc(r.path)}">${esc(r.name||base(r.path))}</button><span class="file-path" title="${esc(r.path)}">${esc(r.path)}</span></div></div></td><td class="amount">${fmt(r.bytes)}${r.incomplete?'<br><span class="tag neutral">统计不完整</span>':''}</td><td><span class="tag ${r.linked?'warn':'neutral'}">${r.linked?'链接 / 受限':r.directory?'文件夹':'文件'}</span></td><td><div class="row-actions"><button class="text-button" data-action="open" data-path="${esc(r.path)}" title="在资源管理器中选中">定位 ${icon('external')}</button>${operations?`<button class="text-button" data-action="details" data-path="${esc(r.path)}">管理 ${icon('arrow')}</button>`:`<button class="text-button" data-action="explore" data-path="${esc(r.path)}">查看 ${icon('arrow')}</button>`}</div></td></tr>`).join('')}</tbody></table></div>`;
}
function analyzeToolbar(tab) {
  return `<div class="toolbar"><div class="segmented"><button data-action="analyze-tab" data-tab="folders" class="${tab==='folders'?'active':''}">目录浏览</button><button data-action="analyze-tab" data-tab="large" class="${tab==='large'?'active':''}">大文件</button></div><select class="select" id="drive-select" aria-label="磁盘">${driveOptions()}</select><div class="search-field">${icon('search')}<input class="field" id="query" value="${esc(state.query)}" placeholder="搜索${tab==='folders'?'当前目录':'大文件路径'}…" aria-label="搜索"></div>${tab==='large'?`<select id="size-select" class="select" aria-label="最小文件大小"><option value="0">所有体积</option><option value="104857600" ${state.min===104857600?'selected':''}>100 MiB 以上</option><option value="1073741824" ${state.min===1073741824?'selected':''}>1 GiB 以上</option><option value="5368709120" ${state.min===5368709120?'selected':''}>5 GiB 以上</option></select>`:''}</div>`;
}
function analyzeFoldersBody(data) {
  const sum = data.chart.reduce((a,r)=>a+r.bytes,0) || 1;
  return `<div class="path-bar"><button class="icon-button" data-action="up" title="上一级" aria-label="上一级">${icon('back')}</button><input id="path-input" aria-label="当前目录，输入后回车" value="${esc(data.path)}"><button class="text-button" data-action="open" data-path="${esc(data.path)}">资源管理器 ${icon('external')}</button></div>${data.chart.length?`<div class="mini-chart" aria-label="子目录相对体积">${data.chart.slice(0,8).map((r,i)=>`<button class="chart-tile" data-action="explore" data-path="${esc(r.path)}" title="${esc(r.path)} · ${fmt(r.bytes)}" style="flex:${Math.max(.06,r.bytes/sum)};background:${colors[i]}"><strong>${esc(base(r.path))}</strong><span>${fmt(r.bytes)}</span></button>`).join('')}</div>`:''}<section class="panel">${fileTable(data.items)}<div class="table-footer"><span>${data.total.toLocaleString()} 项 · 目录体积随文件变化自动更新</span><div>${button('上一页','prev','','small')}${button('下一页','next',state.offset+100>=data.total?'disabled':'','small')}</div></div></section>`;
}
function analyzeLargeBody(data) {
  return notice(`当前范围 ${esc(folderScope()?state.scope:state.drive)} · 保存最多 2,000 个大文件，匹配 ${data.items.length} 项。体积大不代表可以删除，请先确认文件用途。`)+`<section class="panel">${fileTable(data.items.slice(state.offset,state.offset+100))}<div class="table-footer"><span>按体积从大到小 · ${data.items.length} 项</span><div>${button('上一页','prev','','small')}${button('下一页','next',state.offset+100>=data.items.length?'disabled':'','small')}</div></div></section>`;
}
// 指纹只取界面显示的字段：字节的原始数值抖动几十 KB 在 GiB 显示里毫无变化，
// 未显示的 modified 时间戳也一直在变；按显示值取指纹才能在数据微动时保持 DOM 静止。
const displayRow = r => [r.path, r.name||'', r.directory?1:0, r.linked?1:0, r.incomplete?1:0, fmt(r.bytes)];
async function renderAnalyze() {
  const request = ++state.request;
  const tab = state.analyzeTab;
  const toolbarKey = JSON.stringify([tab, state.drive, state.query, state.min, volumeKey()]);
  let data;
  if (tab === 'folders') {
    data = await api(`browse?path=${encodeURIComponent(state.path)}&q=${encodeURIComponent(state.query)}&offset=${state.offset}&sort=${state.sort}`);
    if (request !== state.request || state.view !== 'analyze') return;
    state.browse = data;
  } else {
    const scopeParam = folderScope() ? state.scope : '';
    data = await api(`files?drive=${encodeURIComponent(state.drive)}&scope=${encodeURIComponent(scopeParam)}&q=${encodeURIComponent(state.query)}&min=${state.min}`);
    if (request !== state.request || state.view !== 'analyze') return;
    state.files = data.items;
  }
  const body = tab === 'folders' ? analyzeFoldersBody(data) : analyzeLargeBody(data);
  const page = tab === 'folders'
    ? {path: data.path, total: data.total, chart: data.chart.map(displayRow), items: data.items.map(displayRow)}
    : {length: data.items.length, page: data.items.slice(state.offset, state.offset+100).map(displayRow)};
  const bodyKey = JSON.stringify([toolbarKey, state.scope, state.offset, page]);
  if (painted.analyzeBody === bodyKey && $('#analysis-body')) return;
  painted.analyzeBody = bodyKey;
  // 写入发生在 await 之后，先记下正在输入的框，写入后把焦点和光标还回去。
  const focusId = document.activeElement && ['query','path-input'].includes(document.activeElement.id) ? document.activeElement.id : '';
  if (painted.analyzeToolbar !== toolbarKey || !$('#analysis-body')) {
    painted.analyzeToolbar = toolbarKey;
    $('#content').innerHTML = `${analyzeToolbar(tab)}<div id="analysis-body">${body}</div>`;
  } else {
    $('#analysis-body').innerHTML = body;
  }
  if (focusId) {const el=document.getElementById(focusId);if(el){el.focus();el.setSelectionRange(el.value.length,el.value.length);}}
}
function recCard(r) {
  const allowed = r.policy?.allowed;
  return `<article class="recommendation"><span class="file-icon ${r.kind==='file'?'':'folder'}">${icon(r.kind==='file'?'file':'folder')}</span><div><h3>${esc(base(r.path))}<span class="tag ${allowed?'blue':'neutral'}">${esc(r.category)}</span></h3><span class="file-path">${esc(r.path)}</span><p>${esc(r.action)}</p></div><div><span class="amount">${fmt(r.bytes)}</span><div class="rec-actions">${allowed?button('预览迁移','plan-form',`data-mode="move" data-path="${esc(r.path)}"`,'small soft'):button('查看说明','details',`data-path="${esc(r.path)}"`,'small')}</div></div></article>`;
}
function renderMove() {
  ++state.request;
  const key = JSON.stringify([state.drive, state.scope, volumeKey(), state.summary.recommendations]);
  if (painted.move === key) return;
  painted.move = key;
  const rows = state.summary.recommendations.filter(r=>r.category==='迁移候选'&&inScope(r.path));
  $('#content').innerHTML = notice('迁移会逐文件复制并核验内容，然后移除源文件。源空目录保留，不自动修改应用配置；模型迁移前请退出对应应用。')+`<div class="toolbar"><select class="select" id="drive-select" aria-label="源磁盘">${driveOptions()}</select><span style="flex:1"></span>${button(icon('folder')+' 选择其他目录','custom-move','','soft')}</div><div class="section-heading"><h2>适合规划迁移的数据</h2><span>根据已知目录用途识别，执行前仍需核对</span></div><div class="recommendations">${rows.length?rows.map(r=>recCard(r)).join(''):empty('没有已识别的迁移候选','扫描 C 盘后查看建议，也可以手动选择受支持的个人资料目录。')}</div>`;
}
function historyRow(r) {
  const label = jobLabels[r.mode] || '操作';
  const warn = /error|interrupted/.test(r.status);
  if (r.id) {
    return `<article class="history-item"><div class="history-title"><h3>${icon(r.mode==='clean'?'clean':'move')} ${label} · ${esc(base(r.source))}</h3><span class="tag ${warn?'warn':''}">${statusLabels[r.status]||esc(r.status)}</span></div><div class="history-path">${esc(r.source)}<br>↳ ${esc(r.target)}</div><div class="history-foot"><div><p>${esc(r.time)} · 完成 ${r.completed} / ${r.count} 个文件 · ${fmt(r.moved_bytes)}</p><p>${esc(r.message||'')}</p></div><div class="row-actions">${button('查看目标','open',`data-path="${esc(r.target)}"`,'small')}${r.status!=='restored'?button('恢复原位置','restore-form',`data-id="${esc(r.id)}"`,'small soft'):''}</div></div></article>`;
  }
  return `<article class="history-item"><div class="history-title"><h3>${label}</h3><span class="tag ${warn?'warn':''}">${statusLabels[r.status]||esc(r.status)}</span></div><div class="history-foot"><p>${esc(r.time||'')} · ${esc(r.message||'')}</p></div></article>`;
}
function comparison(data) {if(!data?.rows?.length)return empty('尚无可比较的变化',esc(data?.message||'选择历史快照开始比较。'));return `<section class="panel"><div class="table-wrap"><table><thead><tr><th>目录</th><th>空间变化</th></tr></thead><tbody>${data.rows.map(r=>`<tr><td><span class="file-path" title="${esc(r.path)}">${esc(r.path)}</span></td><td class="comparison-size ${r.delta>0?'positive':'negative'}">${r.delta>0?'+':'−'}${fmt(Math.abs(r.delta))}</td></tr>`).join('')}</tbody></table></div></section>`;}
async function renderHistory() {
  const request = ++state.request;
  const tab = state.historyTab;
  let payload;
  if (tab === 'operations') payload = await api('history');
  else if (tab === 'snapshots') payload = await api('snapshots');
  else payload = await api('issues');
  if (request !== state.request || state.view !== 'history') return;
  const bodyKey = JSON.stringify([tab, payload, state.summary.snapshot, state.summary.comparison]);
  if (painted.history === bodyKey) return;
  painted.history = bodyKey;
  let body;
  if (tab === 'operations') {
    body = payload.length ? notice('恢复只处理原记录中的文件，遇到内容变化或同名冲突时停止，不会覆盖现有文件。')+`<div class="history-list">${payload.map(historyRow).join('')}</div>` : empty('还没有操作记录','从清理中心、空间分析或跨盘迁移开始；所有结果都会留在这里。');
  } else if (tab === 'snapshots') {
    body = notice('比较当前快照与所选历史快照。仅比较两次都完整读取的同名目录；父子目录相互包含，变化量不能相加。')+`<div class="toolbar"><select class="select" id="snapshot-select" aria-label="历史快照">${payload.map(r=>`<option value="${esc(r.name)}">${esc(r.name)}${r.name===state.summary.snapshot?' · 当前':''}</option>`).join('')}</select>${button('比较快照','compare','','soft')}</div><div id="comparison-results">${comparison(state.summary.comparison)}</div>`;
  } else {
    const names = {link_or_cloud:'链接 / 云占位', unreadable:'读取失败', excluded:'主动排除', volume_unreadable:'磁盘不可读'};
    body = notice('以下最多展示前 300 条问题样例。扫描不会提权、更改权限或下载云文件。')+`<section class="panel"><div class="summary-strip">${Object.entries(payload.counts).map(([k,n])=>`<div><small>${names[k]||esc(k)}</small><strong>${n.toLocaleString()}</strong></div>`).join('')}</div><div class="table-wrap"><table><thead><tr><th>路径</th><th>原因</th></tr></thead><tbody>${payload.items.map(r=>`<tr><td><span class="file-path" style="max-width:700px" title="${esc(r.path)}">${esc(r.path)}</span></td><td><span class="tag neutral">${names[r.kind]||esc(r.kind)}</span></td></tr>`).join('')}</tbody></table></div></section>`;
  }
  $('#content').innerHTML = `<div class="toolbar"><div class="segmented"><button data-action="history-tab" data-tab="operations" class="${tab==='operations'?'active':''}">操作记录</button><button data-action="history-tab" data-tab="snapshots" class="${tab==='snapshots'?'active':''}">快照对比</button><button data-action="history-tab" data-tab="issues" class="${tab==='issues'?'active':''}">扫描盲区</button></div></div><div id="history-body">${body}</div>`;
}
function modal(title, body, footer=''){$('#modal-content').innerHTML=`<div class="modal-head"><h2>${title}</h2><button class="icon-button" data-action="close" aria-label="关闭">${icon('close')}</button></div><div class="modal-body">${body}</div>${footer?`<div class="modal-foot">${button('取消','close')}${footer}</div>`:''}`;if(!$('#modal').open)$('#modal').showModal();}
async function details(path) {
  const policy = await api('policy?path='+encodeURIComponent(path));
  const rec = state.summary.recommendations.find(r=>r.path.toLowerCase()===path.toLowerCase());
  modal('查看与管理',`<div class="preview-path">${esc(path)}</div><p>${esc(rec?.action||policy.reason)}</p>${notice(policy.allowed?'操作前请关闭正在使用这些文件的应用。预览会重新读取文件清单，执行时再次核验。':'此位置不支持直接删除或转移。请使用系统管理入口，或先在资源管理器核对。',!policy.allowed)}<div class="toolbar">${button(icon('external')+' 在资源管理器中选中','open',`data-path="${esc(path)}"`)}${/memory\.dmp$/i.test(path)?button('Windows 磁盘清理','system','data-system="cleanup"','soft'):''}${!policy.allowed?button('应用管理','system','data-system="apps"','soft'):''}</div>`,policy.allowed?button('移入回收站','batch-recycle-one',`data-path="${esc(path)}"`,'soft')+button('预览跨盘迁移','plan-form',`data-mode="move" data-path="${esc(path)}"`,'primary'):'');
}
function planForm(path='',mode='move'){
  const targets=state.summary.volumes.filter(v=>!path.toLowerCase().startsWith(v.path.toLowerCase()));
  modal('规划跨盘迁移',`<p>选择源文件或目录，以及接收文件的磁盘。程序将建立独立目标目录，复制校验后移除源文件，不覆盖已有文件。</p><label for="source-input">源文件 / 目录</label><input class="field" id="source-input" type="text" value="${esc(path)}" placeholder="C:\\Users\\…\\Downloads\\旧文件.zip"><label for="target-input">目标磁盘 / 现有目录</label><input class="field" id="target-input" type="text" value="${esc(targets.find(v=>v.path.startsWith('E'))?.path||targets[0]?.path||'')}" list="target-list"><datalist id="target-list">${targets.map(v=>`<option value="${esc(v.path)}">${fmt(v.free)} 可用</option>`).join('')}</datalist>${notice('迁移后需自行切换应用的保存路径；恢复记录保存在本机 local-state 目录中。')}<input id="plan-mode" type="hidden" value="${mode}">`,button('生成操作预览','make-plan','','primary'));
}
async function makePlan(){
  const source=$('#source-input').value.trim(), target=$('#target-input').value.trim(), mode=$('#plan-mode').value;
  if(!source||!target)throw new Error('请填写源路径和目标目录');
  const plan=await api('plan',{source,target,mode});state.plan=plan;
  modal('确认本次迁移',`<p>下面是重新读取的文件清单摘要。预览有效期 10 分钟。</p><label>源位置</label><div class="preview-path">${esc(plan.source)}</div><label>迁移目标</label><div class="preview-path">${esc(plan.target)}</div><div class="modal-stats"><div><small>文件数量</small><strong>${plan.count.toLocaleString()}</strong></div><div><small>逻辑体积</small><strong>${fmt(plan.bytes)}</strong></div><div><small>目标剩余估算</small><strong>${fmt(plan.free-plan.bytes)}</strong></div></div>${notice('复制并校验后，源文件会被移除；源空目录保留。硬链接、压缩文件可能使实际释放量不同。发生错误时，已完成的部分可从操作记录恢复。',true)}<details><summary>查看文件样例（前 8 项）</summary>${plan.sample.map(p=>`<div class="preview-path">${esc(p)}</div>`).join('')}</details><label><input type="checkbox" id="confirm-operation">我已核对路径，已关闭使用这些文件的应用，确认迁移。</label>`,button('确认并开始','execute','disabled','primary'));
}
function scanForm(){modal('更新磁盘分析',`<p>扫描只读取文件元数据，不修改任何文件；垃圾清理不依赖完整扫描。可以随时取消并保留上次结果。</p><div class="scan-options">${state.summary.volumes.map(v=>`<label><input type="checkbox" name="scan-root" value="${esc(v.path)}" ${v.path===state.drive?'checked':''}>${esc(v.path)} · ${fmt(v.free)} 可用</label>`).join('')}</div><label for="scan-custom">或只扫描一个目录（填写后优先使用）</label><input type="text" id="scan-custom" class="field" value="${esc(folderScope()?state.scope:'')}" placeholder="例如 C:\\Users\\YourName\\Downloads"><p>完整磁盘扫描可能需要几分钟。联接点、云占位和无权限项会被跳过并记录。</p>`,button('开始扫描','start-scan','','primary'));}
function renderJob(job) {
  const panel=$('#job-panel');
  if(!job||job.status==='idle'){if(painted.job!=='idle'){painted.job='idle';panel.hidden=true;}return;}
  const running=job.status==='running';
  if(running)state.jobDismissed=false;
  const key=JSON.stringify([job, state.jobDismissed]);
  if(painted.job===key)return;
  painted.job=key;
  if(state.jobDismissed&&!running){panel.hidden=true;return;}
  panel.hidden=false;
  panel.innerHTML=`${running?'<div class="spinner"></div>':icon(job.status==='done'?'check':'info')}<div class="job-info"><strong>${jobLabels[job.kind]||'操作'} · ${running?(job.kind==='scan'?`${(job.files||0).toLocaleString()} 个文件 / ${(job.directories||0).toLocaleString()} 个目录`:`${job.done||0} / ${job.total||0} 项`):job.status==='done'?'完成':job.status==='cancelled'?'已取消':'遇到问题'}</strong><p title="${esc(job.message)}">${esc(job.message)}</p>${running&&job.total?`<div class="progress-track"><div style="width:${Math.min(100,job.done/Math.max(1,job.total)*100)}%"></div></div>`:''}</div>${running?button('停止','cancel','','small'):button('收起','dismiss-job','','small')}`;
  $('#scan-button').disabled=running;
}
async function waitJob() {
  for (;;) {
    const job = await api('job');
    if (job.status !== 'running') return job;
    await new Promise(r => setTimeout(r, 500));
  }
}
function batchLabel(kind) {return kind === 'recycle' ? '移入回收站' : '永久删除';}
function showBatchResult(kind, done, errors) {
  modal('批量处理结果', `<p><strong>${batchLabel(kind)} ${done} 项</strong>${errors.length?`，${errors.length} 项失败`:''}。</p>${errors.length?`<div class="recycle-list">${errors.slice(0,20).map(e=>`<p>${esc(e)}</p>`).join('')}</div>`:''}${kind==='recycle'?notice('可在 Windows 回收站恢复；清空回收站后彻底释放空间。'):''}`, kind==='recycle'?button('打开回收站','system','data-system="recycle"','soft'):'');
}
async function batchAll(kind) {
  const paths = state.batchPaths.slice();
  $('#modal').close();
  let done = 0; const errors = [];
  for (let i = 0; i < paths.length; i += 100) {
    const chunk = paths.slice(i, i+100);
    const plan = await api(kind+'-plan', {paths: chunk});
    await api(kind+'-execute', {id: plan.id, confirm: true});
    const job = await waitJob();
    if (job.result) { done += job.result.done.length; errors.push(...job.result.errors); }
    if (job.status === 'cancelled') { toast('已停止，剩余部分未处理'); break; }
  }
  selectedFiles.clear(); updateSelection();
  await refresh().catch(()=>{});
  showBatchResult(kind, done, errors);
}
async function previewRecycle(paths) {
  if (paths.length > 500) { state.batchPaths = paths; confirmBatchModal('recycle', paths); return; }
  const plan = await api('recycle-plan', {paths});
  state.recyclePlan = plan;
  modal('移入回收站', `<p>共 <strong>${plan.items.length} 项 · ${fmt(plan.bytes)}</strong>。文件夹包含其中全部内容。</p><div class="recycle-list">${plan.items.slice(0,50).map(i=>`<div><strong>${esc(base(i.path))}</strong><span>${esc(i.path)}</span><small>${fmt(i.bytes)}</small></div>`).join('')}</div>${plan.items.length>50?`<p class="muted-line">其余 ${plan.items.length-50} 项省略展示</p>`:''}${notice('移入回收站后可恢复；清空回收站后才彻底释放磁盘空间。')}`, button('确认移入回收站','confirm-recycle','','primary'));
}
async function previewPurge(paths) {
  if (paths.length > 500) { state.batchPaths = paths; confirmBatchModal('purge', paths); return; }
  const plan = await api('purge-plan', {paths});
  state.recyclePlan = plan;
  modal('永久删除', `<p>共 <strong>${plan.items.length} 项 · ${fmt(plan.bytes)}</strong>。<strong>此操作不进入回收站，删除后无法恢复。</strong></p><div class="recycle-list">${plan.items.slice(0,50).map(i=>`<div><strong>${esc(base(i.path))}</strong><span>${esc(i.path)}</span><small>${fmt(i.bytes)}</small></div>`).join('')}</div>${notice('建议先移入回收站观察几天，确认不再需要后再永久删除。', true)}<label><input type="checkbox" id="confirm-operation">我确认永久删除以上项目</label>`, button('确认永久删除','confirm-purge','disabled','danger'));
}
function confirmBatchModal(kind, items) {
  modal(`${batchLabel(kind)} ${items.length} 项`, `<p>数量超过单次上限（500 项），将自动分批执行（每批 100 项）。</p>${kind==='purge'?notice('永久删除不进入回收站，无法恢复。', true):''}<details><summary>查看所选项目（前 50 项）</summary>${items.slice(0,50).map(p=>`<div class="preview-path">${esc(p)}</div>`).join('')}</details><label><input type="checkbox" id="confirm-operation">我已核对，开始${batchLabel(kind)}</label>`, button(`开始${batchLabel(kind)}`,'batch-go',`data-kind="${kind}" disabled`,'primary'));
}
function junkConfirm(c) {
  modal(`一键清理 · ${c.name}`, `<p>${esc(c.desc)}</p>${notice('清理会把该类别下的缓存内容移入回收站（保留缓存文件夹本身），可随时恢复。正在使用的文件自动跳过；浏览器正在运行时部分文件无法删除。', true)}<label><input type="checkbox" id="confirm-junk">我已了解，开始清理（约 ${fmt(c.bytes)}）</label>`, button('开始清理','junk-go',`data-category="${esc(c.id)}" disabled`,'primary'));
}
async function junkDetail(cid) {
  const c = state.junk?.categories?.find(x=>x.id===cid);
  if (!c) return;
  const targets = c.risk === 'safe'
    ? c.targets.map(t => ({t, policy:null}))
    : await Promise.all(c.targets.map(async t => {
      let policy = {allowed:false};
      try { policy = await api('policy?path='+encodeURIComponent(t.path)); } catch (e) {}
      return {t, policy};
    }));
  modal(`${c.name} · 明细`, `<p>${esc(c.desc)}</p>${targets.map(({t, policy})=>`<div class="junk-target"><div><strong>${esc(base(t.path))}</strong><span class="file-path" title="${esc(t.path)}">${esc(t.path)}</span>${t.sample.length?`<span class="muted">如：${esc(t.sample.join('、'))}</span>`:''}</div><div><span class="amount">${fmt(t.bytes)}</span>${policy===null?'<span class="tag blue">由一键清理处理</span>':policy.allowed?button('移入回收站','batch-recycle-one',`data-path="${esc(t.path)}"`,'small'):'<span class="tag neutral">需专项处理</span>'}</div></div>`).join('')}${c.risk==='review'?notice('此类别按设计不做一键清理：请逐项确认后再处理。'):''}`, '');
}
let polling=false, lastCapacity=0;
function renderLive() {
  if ($('#modal').open) {state.pendingRender=true;return;}
  const tag = document.activeElement?.tagName;
  if (tag==='INPUT'||tag==='SELECT'||tag==='TEXTAREA') {state.pendingRender=true;return;}
  if (Date.now()-state.lastScroll<900) {state.pendingRender=true;return;}
  state.pendingRender=false;
  const y=window.scrollY;
  const content=$('#content');
  // Async refills (browse/history fetch) first swap in a shorter placeholder; pin the
  // current height briefly so the scroll restore is not clamped back to the top.
  content.style.minHeight=content.offsetHeight+'px';
  render();window.scrollTo(0,y);
  setTimeout(()=>{content.style.minHeight='';},2500);
}
async function poll(force=false) {
  if (polling)return;polling=true;
  try {
    const job=await api('job');
    if (job.status==='running'||state.lastJob==='running')renderJob(job);
    const finished=state.lastJob==='running'&&job.status!=='running';
    const changed=job.revision!==state.revision;
    const capacity=Date.now()-lastCapacity>15000;
    if (finished||changed||force) {
      if (finished)toast(job.message, job.status==='error');
      await refresh();
      renderLive();
    } else if (capacity) {
      lastCapacity=Date.now();
      const summary=await api('summary');
      state.summary=summary;state.revision=summary.revision;
      const stamp=summary.live_updated||summary.finished;
      setText($('#scan-time'),stamp?'数据更新 '+new Date(stamp).toLocaleString('zh-CN',{hour12:false}):'');
      renderLive();
    } else if (state.pendingRender)renderLive();
    state.lastJob=job.status;
  } catch(e){$('.local-badge').textContent='连接中断，请刷新页面';}finally{polling=false;}
}
async function action(name, el) {
  const d=el.dataset;
  if(name==='clear-selection'){selectedFiles.clear();updateSelection();}
  else if(name==='batch-recycle')await previewRecycle([...selectedFiles.keys()]);
  else if(name==='batch-purge')await previewPurge([...selectedFiles.keys()]);
  else if(name==='batch-recycle-one')await previewRecycle([d.path]);
  else if(name==='confirm-recycle'){await api('recycle-execute',{id:state.recyclePlan.id,confirm:true});state.recyclePlan=null;selectedFiles.clear();updateSelection();$('#modal').close();state.lastJob='running';}
  else if(name==='confirm-purge'){await api('purge-execute',{id:state.recyclePlan.id,confirm:true});state.recyclePlan=null;selectedFiles.clear();updateSelection();$('#modal').close();state.lastJob='running';}
  else if(name==='batch-go')await batchAll(d.kind);
  else if(name==='junk-clean'){const c=state.junk?.categories?.find(x=>x.id===d.category);if(c)junkConfirm(c);}
  else if(name==='junk-go'){await api('junk-clean',{category:d.category,confirm:true});$('#modal').close();state.lastJob='running';toast('清理已开始，正在移入回收站');}
  else if(name==='junk-detail')await junkDetail(d.category);
  else if(name==='recycle-empty'){modal('清空回收站',`<p>将永久删除回收站中的全部内容（${state.junk?.recycle?`${state.junk.recycle.count.toLocaleString()} 个项目 · 约 ${fmt(state.junk.recycle.bytes)}`:'所有项目'}），此操作无法恢复。</p>${notice('移入回收站的文件占用的空间，要在清空回收站后才会真正释放。',true)}<label><input type="checkbox" id="confirm-operation">我确认清空回收站</label>`,button('确认清空','recycle-empty-go','disabled','danger'));}
  else if(name==='recycle-empty-go'){await api('recycle-empty',{confirm:true});$('#modal').close();toast('回收站已清空');if(state.junk)state.junk.recycle={count:0,bytes:0};if(state.view==='clean')renderLive();else poll(true);}
  else if(name==='nav')route(d.view);
  else if(name==='drive'){state.drive=d.path;state.path=d.path;state.scope=d.path;render();}
  else if(name==='explore'){state.path=d.path;state.drive=state.summary.volumes.find(v=>d.path.toLowerCase().startsWith(v.path.toLowerCase()))?.path||state.drive;state.analyzeTab='folders';state.query='';state.offset=0;if(state.view==='analyze')render();else route('analyze');}
  else if(name==='analyze-tab'){state.analyzeTab=d.tab;state.offset=0;state.query='';render();}
  else if(name==='history-tab'){state.historyTab=d.tab;render();}
  else if(name==='up'){state.path=state.browse.parent;state.offset=0;state.query='';render();}
  else if(name==='prev'){state.offset=Math.max(0,state.offset-100);render();}
  else if(name==='next'){state.offset+=100;render();}
  else if(name==='details')await details(d.path);
  else if(name==='open'){await api('open',{path:d.path});toast('已在资源管理器中选中：'+base(d.path));}
  else if(name==='system'){await api('system',{action:d.system});toast('已打开 Windows 管理入口，请在系统窗口中核对并操作');}
  else if(name==='close'){$('#modal').close();if(state.pendingRender)renderLive();}
  else if(name==='plan-form')planForm(d.path,d.mode);
  else if(name==='custom-move')planForm();
  else if(name==='make-plan')await makePlan();
  else if(name==='execute'){await api('execute',{id:state.plan.id,confirm:$('#confirm-operation').checked});$('#modal').close();state.lastJob='running';renderJob(await api('job'));}
  else if(name==='start-scan'){const custom=$('#scan-custom').value.trim();const roots=custom?[custom]:$$('[name="scan-root"]:checked').map(e=>e.value);if(!roots.length)throw new Error('请选择至少一个磁盘');await api('scan',{roots});$('#modal').close();state.lastJob='running';renderJob(await api('job'));}
  else if(name==='cancel'){await api('cancel',{});toast('正在安全停止，当前步骤完成后生效');}
  else if(name==='dismiss-job'){state.jobDismissed=true;painted.job='';$('#job-panel').hidden=true;}
  else if(name==='restore-form'){modal('恢复到原位置',`<p>将这次操作中的文件复制回原位置并核验，然后移除目标副本。原位置存在不同内容的文件时会停止，不会覆盖。</p>${notice('请关闭正在使用这些文件的应用，并确认原磁盘有足够空间。',true)}`,button('确认恢复','restore',`data-id="${esc(d.id)}"`,'primary'));}
  else if(name==='restore'){await api('restore',{id:d.id,confirm:true});$('#modal').close();state.lastJob='running';renderJob(await api('job'));}
  else if(name==='compare'){const data=await api('compare',{snapshot:$('#snapshot-select').value});$('#comparison-results').innerHTML=comparison(data);}
}
document.addEventListener('click',async e=>{const b=e.target.closest('[data-action]');if(!b||b.disabled)return;const name=b.dataset.action;b.disabled=true;try{await action(name,b)}catch(err){toast(err.message,true)}finally{b.disabled=false;}});
function updateSelection(){
  const checks=$$('.file-check');
  for(const c of checks){c.checked=selectedFiles.has(c.dataset.path);c.closest('tr')?.classList.toggle('is-selected',c.checked);}
  const enabled=checks.filter(c=>!c.disabled),chosen=enabled.filter(c=>c.checked);
  const all=$('#select-page');if(all){all.checked=enabled.length>0&&chosen.length===enabled.length;all.indeterminate=chosen.length>0&&chosen.length<enabled.length;}
  const count=$('#selection-count');if(count)count.textContent=`已选 ${selectedFiles.size} 项 · ${fmt([...selectedFiles.values()].reduce((a,b)=>a+b,0))}`;
  for(const act of ['batch-recycle','batch-purge']){const btn=$(`[data-action="${act}"]`);if(btn)btn.disabled=!selectedFiles.size;}
}
document.addEventListener('change',e=>{
  if(e.target.matches('.file-check')){if(e.target.checked)selectedFiles.set(e.target.dataset.path,Number(e.target.dataset.bytes));else selectedFiles.delete(e.target.dataset.path);updateSelection();}
  if(e.target.id==='select-page'){for(const c of $$('.file-check:not(:disabled)')){if(e.target.checked)selectedFiles.set(c.dataset.path,Number(c.dataset.bytes));else selectedFiles.delete(c.dataset.path);}updateSelection();}
  if(e.target.id==='drive-select'){state.drive=e.target.value;state.path=e.target.value;state.scope=e.target.value;state.offset=0;render();}
  if(e.target.id==='size-select'){state.min=Number(e.target.value);state.offset=0;render();}
  if(e.target.id==='confirm-operation'){for(const act of ['execute','confirm-purge','recycle-empty-go','batch-go']){const b=$(`[data-action="${act}"]`);if(b)b.disabled=!e.target.checked;}}
  if(e.target.id==='confirm-junk'){const b=$('[data-action="junk-go"]');if(b)b.disabled=!e.target.checked;}
});
let searchTimer;
document.addEventListener('input',e=>{if(e.target.id==='query'){state.query=e.target.value;state.offset=0;clearTimeout(searchTimer);searchTimer=setTimeout(()=>render(),350);}});
document.addEventListener('keydown',e=>{if(e.target.id==='path-input'&&e.key==='Enter'){state.path=e.target.value.trim();state.offset=0;state.query='';render();}});
window.addEventListener('scroll',()=>{state.lastScroll=Date.now();},{passive:true});
$('#scan-button').innerHTML=icon('scan')+' 扫描磁盘';
$('#scan-button').addEventListener('click',scanForm);
$('#export-button').innerHTML=icon('export');
$('#export-button').addEventListener('click',async()=>{try{const data=await api('export');const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='Spacewell-分析结果.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('已导出分析结果，文件包含本机路径，分享前请脱敏。')}catch(e){toast(e.message,true)}});
$('#help-button').addEventListener('click',()=>modal('使用说明',`<div class="help-steps"><div><h3>清理中心</h3><p>垃圾文件按类别统计，安全类（缓存、临时文件）可一键清理，移入 Windows 回收站，可随时恢复。清空回收站后才真正释放磁盘空间。</p></div><div><h3>空间分析</h3><p>浏览目录或列出大文件，勾选后批量移入回收站，或对确认不再需要的文件永久删除。文件体积实时读取，目录体积随变化自动更新。</p></div><div><h3>跨盘迁移</h3><p>把不常用的大目录复制校验后转移到其他磁盘。源文件在校验通过后才移除，操作记录中可一键恢复。</p></div><div><h3>安全边界</h3><p>系统目录、数据库、联接点、云占位文件不会被直接操作；支持的删除范围是个人资料目录与已识别的缓存目录。所有数据只在本机处理。</p></div></div>`));
window.addEventListener('hashchange',navigate);
window.addEventListener('focus',()=>poll(true));
document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll(true)});
refresh().then(()=>{navigate();setInterval(()=>poll(),2500)}).catch(e=>{$('#content').innerHTML=empty('暂时无法连接本地服务',esc(e.message)+'。请重新运行启动程序。')});
