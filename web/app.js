'use strict';
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const token = $('meta[name="spacewell-token"]').content;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  analyze: '<path d="M4 19h16M6 15V9m6 6V4m6 11v-5"/>',
  clean: '<path d="m14 3-4 9m-3-1 7 3-3 7H3l2-7zM17 5h4m-2-2v4M17 16h4m-2-2v4"/>',
  move: '<path d="M3 6h7l2 2h9v12H3zM7 14h10m-3-3 3 3-3 3"/>',
  history: '<path d="M3 11a9 9 0 1 1 2 7M3 4v7h7m2-5v6l4 2"/>',
  disk: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 14h18m-4 2h1m-5 0h1"/>',
  scan: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M7 12h10"/>',
  arrow: '<path d="M4 12h15m-5-5 5 5-5 5"/>',
  back: '<path d="m13 5-7 7 7 7M6 12h14"/>',
  folder: '<path d="M3 6h7l2 2h9v12H3z"/>',
  file: '<path d="M14 3H5v18h14V8zM14 3v5h5M8 13h8m-8 4h6"/>',
  large: '<path d="M14 3H5v18h14V8zM14 3v5h5m-9 6h5m-2-2v5"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  export: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.5"/>',
  leaf: '<path d="M5 19C-2 5 13 2 21 3c1 13-7 18-14 13M4 21 15 10"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  external: '<path d="M14 3h7v7m0-7L10 14M10 5H3v16h16v-7"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  compare: '<path d="M8 3v18m8-18v18M3 8l5-5 5 5m-2 8 5 5 5-5"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.file}</svg>`;
const fmt = n => n == null ? '未扫描' : n >= 1073741824 ? `${(n/1073741824).toFixed(2)} GiB` : n >= 1048576 ? `${(n/1048576).toFixed(1)} MiB` : n >= 1024 ? `${(n/1024).toFixed(1)} KiB` : `${n} B`;
const gib = n => (n/1073741824).toFixed(1);
const base = p => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const titles = {overview:['存储总览','给电脑，留一点空间。','看清每一份占用，安心整理你的本地存储。'],analyze:['空间分析','大文件，不再藏起来。','逐层浏览真实目录，找到空间占用的源头。'],clean:['清理中心','每一次清理，都心中有数。','先核对，再处理；个人文件可转移至其他盘的恢复区。'],move:['迁移管理','给重要文件，换个宽敞的家。','跨盘复制、内容校验、移除源文件，操作全程可追溯。'],history:['操作记录','每一步，都有迹可循。','查看执行结果、恢复文件，并比较存储空间的变化。']};
const state = {view:'overview', summary:null, drive:'C:\\', path:'C:\\', scope:null, revision:0, query:'', offset:0, sort:'size', analyzeTab:'folders', cleanTab:'all', historyTab:'operations', min:0, files:[], browse:null, request:0, lastJob:'', plan:null, pendingRender:false};
async function api(path, data) {
  const res = await fetch('/api/'+path, {method:data === undefined?'GET':'POST', headers:{'X-Spacewell-Token':token, ...(data === undefined?{}:{'Content-Type':'application/json'})},body:data === undefined?undefined:JSON.stringify(data)});
  const value = await res.json();
  if (!res.ok) throw new Error(value.error || '操作失败');
  return value;
}
function toast(text, error=false) { const node=document.createElement('div');node.className='toast'+(error?' error':'');node.textContent=text;$('#toasts').append(node);setTimeout(()=>node.remove(),error?9000:4500); }
function notice(text, warning=false) {return `<div class="notice ${warning?'warning':''}">${icon('info')}<span>${text}</span></div>`;}
function button(label, action, extra='', cls='') {return `<button class="button ${cls}" data-action="${action}" ${extra}>${label}</button>`;}
function empty(title, text) {return `<div class="empty">${icon('leaf')}<h3>${title}</h3><p>${text}</p></div>`;}
function loading() {return '<div class="loading-screen"><div class="spinner"></div><p>正在读取本地数据…</p></div>';}
const colors=['#6f9373','#9eb598','#c4d2b8','#bcae85','#d5c8a9','#93b5aa','#b9ccc5','#d7ddd0','#a9b8a3','#9aac91','#c2baa3','#a8c2ba'];
function route(view) {location.hash=view;}
async function refresh() {
  const previous=state.summary?.snapshot;state.summary=await api('summary');state.revision=state.summary.revision;
  if(!state.scope || previous!==state.summary.snapshot){state.scope=state.summary.roots[0]||state.drive;state.path=state.scope;state.offset=0;state.drive=state.summary.volumes.find(v=>state.scope.toLowerCase().startsWith(v.path.toLowerCase()))?.path||state.drive;}
  const stamp=state.summary.live_updated||state.summary.finished;
  $('#scan-time').textContent=stamp?'数据更新 '+new Date(stamp).toLocaleString('zh-CN',{hour12:false}):'尚无完整扫描';
  $('.local-badge').textContent=state.summary.monitor?.status==='limited'?'自动更新受限':'自动更新已开启';
  $('.local-badge').title=state.summary.monitor?.message||'';renderJob(state.summary.job);
}
function folderScope(){return !!state.scope&&!/^[a-z]:[\\/]*$/i.test(state.scope);}
function inScope(path){const scope=(folderScope()?state.scope:state.drive).toLowerCase().replace(/[\\/]+$/,'');return path.toLowerCase()===scope||path.toLowerCase().startsWith(scope+'\\');}
function scopeNotice(){return `<div class="scope-context">${icon('folder')}<div><small>当前扫描范围</small><strong title="${esc(state.scope)}">${esc(state.scope||state.drive)}</strong></div><span class="tag blue">自动更新</span></div>`;}
function navigate() {state.view=location.hash.slice(1) in titles?location.hash.slice(1):'overview';state.query='';state.offset=0;render();}
function driveOptions(selected=state.drive, all=false) {return (all?'<option value="">全部磁盘</option>':'')+state.summary.volumes.map(v=>`<option value="${esc(v.path)}" ${v.path===selected?'selected':''}>${esc(v.path)} · ${fmt(v.free)} 可用</option>`).join('');}
function render() {
  if(!state.summary)return;
  const [crumb,title,subtitle]=titles[state.view];$('#crumb').textContent=crumb;$('#page-title').textContent=title;$('#page-subtitle').textContent=subtitle;
  $('#eyebrow').textContent={overview:'YOUR SPACE, REIMAGINED',analyze:'EXPLORE YOUR STORAGE',clean:'MAKE ROOM FOR WHAT MATTERS',move:'A LITTLE MORE BREATHING ROOM',history:'EVERY CHANGE, ACCOUNTED FOR'}[state.view];
  $('#navigation').innerHTML=Object.entries(titles).map(([v,t])=>`<button class="nav-item ${v===state.view?'active':''}" data-action="nav" data-view="${v}" title="${t[0]}">${icon(v)}<span>${t[0]}</span></button>`).join('');
  const handlers={overview:renderOverview,analyze:renderAnalyze,clean:renderClean,move:renderMove,history:renderHistory};
  Promise.resolve(handlers[state.view]()).catch(e=>{$('#content').innerHTML=empty('读取遇到问题',esc(e.message));toast(e.message,true)});
}
function driveCards(){return `<div class="drive-grid">${state.summary.volumes.map(v=>{const n=v.used/v.total*100;return `<button class="drive-card ${v.path===state.drive?'selected':''}" data-action="drive" data-path="${esc(v.path)}"><div class="drive-head"><div class="drive-icon">${icon('disk')}</div><div><div class="drive-name">本地磁盘 (${esc(v.path.slice(0,2))})</div><div class="drive-type">${v.path.startsWith('C')?'SYSTEM VOLUME':'LOCAL VOLUME'}</div></div><span class="tag ${n>90?'warn':''}">${n>90?'空间紧张':'空间充足'}</span></div><div class="drive-space"><strong>${gib(v.free)}</strong><span>GiB 可用</span></div><div class="drive-caption">共 ${gib(v.total)} GiB</div><div class="drive-bar ${n>90?'danger':''}"><i style="width:${n}%"></i></div><div class="drive-foot"><span>已使用 ${n.toFixed(1)}%</span><span>${v.path===state.drive?'当前磁盘':'查看分析'} ↗</span></div></button>`}).join('')}</div>`;}
async function renderOverview(){
  if(folderScope())return renderFolderOverview();
  const request=++state.request;
  const vol=state.summary.volumes.find(v=>v.path===state.drive)||state.summary.volumes[0];
  if(!vol){$('#content').innerHTML=empty('未发现可访问磁盘','请检查本机磁盘连接。');return;}
  const recs=state.summary.recommendations.filter(r=>r.path.toLowerCase().startsWith(vol.path.toLowerCase()));
  const dump=recs.find(r=>r.path.toLowerCase().endsWith('memory.dmp'));
  const migration=recs.filter(r=>r.category==='迁移候选');
  const used=vol.used/vol.total*100;
  $('#content').innerHTML=driveCards()+`<div class="dashboard-grid"><section class="panel"><div class="panel-head"><div><h2>${esc(vol.path.slice(0,2))} 盘空间概览</h2><p>磁盘容量来自 Windows 实时查询</p></div><button class="text-button" data-action="explore" data-path="${esc(vol.path)}">深入查看 ${icon('arrow')}</button></div><div class="panel-body"><div class="donut-wrap"><div class="donut" style="background:conic-gradient(#739978 0% ${used}%,#eaf0e6 ${used}% 100%)"><div class="donut-center"><small>已使用空间</small><strong>${gib(vol.used)} <span>GiB</span></strong><span>${used.toFixed(1)}% 的磁盘容量</span></div></div><div class="legend"><div class="legend-row"><i style="background:#739978"></i>已使用<strong>${fmt(vol.used)}</strong></div><div class="legend-row"><i style="background:#e1e9da"></i>可用空间<strong>${fmt(vol.free)}</strong></div><div class="legend-row"><i style="background:#b9c7ab"></i>总容量<strong>${fmt(vol.total)}</strong></div><div class="legend-row"><i style="background:#d0d8c9"></i>扫描文件<strong>${state.summary.files.toLocaleString()}</strong></div></div></div><div class="tiny-note">目录排名使用逻辑大小；压缩文件、硬链接和未读取区域可能造成差异。</div></div></section><section class="panel insight-panel"><div class="insight-leaf"></div><div class="insight-body"><div class="insight-label">${icon('leaf')} 空间整理建议</div><h2>${dump?'一份旧转储，<br>也许就是新的空间。':'给常用磁盘，<br>留出更多呼吸空间。'}</h2><p>${dump?'发现一份系统崩溃转储。确认不再用于蓝屏排查后，可通过 Windows 清理。':'从个人资料与模型开始，先核对，再迁移。所有建议都可以查看具体路径。'}</p><div class="insight-metric"><strong>${dump?gib(dump.bytes):migration.length}</strong><span>${dump?'GiB · 候选体积，待确认':'个迁移候选 · 等待核对'}</span></div><button class="button small" data-action="nav" data-view="clean">查看处理建议 ${icon('arrow')}</button></div></section></div><div class="section-heading"><h2>从这里开始整理</h2><span>每个操作，先预览再执行</span></div><div class="action-grid"><button class="action-card" data-action="nav" data-view="clean"><span class="tile-icon">${icon('clean')}</span><h3>清理不再需要的文件</h3><p>核对缓存与临时文件，找回可用空间。</p><span class="card-bottom">前往清理中心 ${icon('arrow')}</span></button><button class="action-card" data-action="large"><span class="tile-icon">${icon('large')}</span><h3>找出隐藏的大文件</h3><p>按体积排序，一眼看到存储大头。</p><span class="card-bottom">查看大文件 ${icon('arrow')}</span></button><button class="action-card" data-action="nav" data-view="move"><span class="tile-icon">${icon('move')}</span><h3>将文件迁到其他磁盘</h3><p>复制、校验后转移，保留恢复记录。</p><span class="card-bottom">规划一次迁移 ${icon('arrow')}</span></button></div><div class="section-heading"><h2>占用较大的目录</h2><button class="text-button" data-action="explore" data-path="${esc(vol.path)}">查看全部 ${icon('arrow')}</button></div><section class="panel" id="overview-table">${loading()}</section>`;
  try{const data=await api('browse?path='+encodeURIComponent(vol.path));if(request!==state.request||state.view!=='overview')return;$('#overview-table').innerHTML=fileTable(data.items.filter(r=>r.directory).slice(0,5),false);}catch(e){if($('#overview-table'))$('#overview-table').innerHTML=empty('目录暂不可读',esc(e.message));}
}
async function renderFolderOverview(){
  const request=++state.request;
  const scope=state.summary.scopes.find(s=>s.path.toLowerCase()===state.scope.toLowerCase())||{};
  const bytes=scope.bytes||0, direct=scope.direct_bytes||0, count=scope.files||0;
  const ratio=bytes?Math.min(100,direct/bytes*100):0;
  $('#page-title').textContent=base(state.scope)+'，一眼看清。';
  $('#page-subtitle').textContent='这里展示你选择的文件夹。删除、移动或新增文件后，会自动更新相关数据。';
  const volume=state.summary.volumes.find(v=>state.scope.toLowerCase().startsWith(v.path.toLowerCase()));
  $('#content').innerHTML=scopeNotice()+`${scope.missing?notice('当前目录已被删除或移动，已清除旧的占用记录。请重新选择扫描位置。',true):''}${state.summary.monitor?.status==='limited'?notice(esc(state.summary.monitor.message),true):''}<div class="scope-stats"><article class="panel scope-stat"><small>文件夹已知体积</small><strong>${fmt(bytes)}</strong><span>${scope.incomplete?'存在跳过项，非完整物理占用':'文件逻辑大小，包含子目录'}</span></article><article class="panel scope-stat"><small>文件总数</small><strong>${count.toLocaleString()} <em>个</em></strong><span>当前范围内已统计的文件</span></article><article class="panel scope-stat"><small>所属磁盘可用空间</small><strong>${volume?fmt(volume.free):'未知'}</strong><span>${volume?esc(volume.path)+' · 磁盘容量仅作参考':'容量暂不可读'}</span></article></div><div class="dashboard-grid"><section class="panel"><div class="panel-head"><div><h2>文件夹空间构成</h2><p>只统计 ${esc(base(state.scope))}，不包含其他磁盘</p></div><button class="text-button" data-action="explore" data-path="${esc(state.scope)}">打开目录 ${icon('arrow')}</button></div><div class="panel-body"><div class="donut-wrap"><div class="donut" style="background:conic-gradient(#739978 0% ${ratio}%,#c8d6bf ${ratio}% 100%)"><div class="donut-center"><small>当前文件夹</small><strong>${gib(bytes)} <span>GiB</span></strong><span>${count.toLocaleString()} 个文件</span></div></div><div class="legend"><div class="legend-row"><i style="background:#739978"></i>本层文件<strong>${fmt(direct)}</strong></div><div class="legend-row"><i style="background:#c8d6bf"></i>子目录文件<strong>${fmt(Math.max(0,bytes-direct))}</strong></div></div></div><div class="tiny-note">按文件逻辑体积统计。清理后自动更新；磁盘容量与文件夹大小不是同一指标。</div></div></section><section class="panel"><div class="panel-head"><div><h2>边整理，边更新</h2><p>无需重复点击扫描磁盘</p></div>${icon('history')}</div><div class="panel-body scope-help"><h3>勾选多个文件，<br>在这里一起整理。</h3><p>删除文件后，列表、目录体积和文件数量会在几秒内更新。移入回收站会减少文件夹体积；从回收站永久删除后，才会释放磁盘容量。</p>${button('查看这个文件夹的大文件','large','','soft')}</div></section></div><div class="section-heading"><h2>当前文件夹的文件与子目录</h2><span>勾选后可直接批量移入回收站</span></div><section class="panel" id="scope-files">${loading()}</section><details class="other-volumes"><summary>其他磁盘容量 · 仅供参考</summary>${driveCards()}</details>`;
  if(scope.missing){$('#scope-files').innerHTML=empty('文件夹已不存在','选择新的扫描目录继续管理。');return;}
  const data=await api('browse?path='+encodeURIComponent(state.scope));if(request!==state.request||state.view!=='overview')return;
  $('#scope-files').innerHTML=fileTable(data.items.slice(0,10));
}
const selectedFiles = new Map();
let recyclePreview = null;
function fileTable(rows, operations=true){
  if(!rows.length)return empty('这里很清爽','没有匹配的文件，试试其他目录或筛选条件。');
  const current = new Set(rows.map(r=>r.path));
  for(const path of selectedFiles.keys())if(!current.has(path))selectedFiles.delete(path);
  return `<div class="batch-bar"><label><input type="checkbox" id="select-page" aria-label="全选当前页" ${rows.filter(r=>!r.linked).every(r=>selectedFiles.has(r.path))?'checked':''}> 全选当前页</label><span id="selection-count">已选 ${selectedFiles.size} 项 · ${fmt([...selectedFiles.values()].reduce((a,b)=>a+b,0))}</span>${button('移入回收站','batch-recycle',selectedFiles.size?'':'disabled','small primary')}${button('取消选择','clear-selection','','small')}</div><div class="table-wrap"><table><thead><tr><th class="check-cell">选择</th><th>文件 / 目录</th><th>体积</th><th>类型</th><th class="right-align">操作</th></tr></thead><tbody>${rows.map(r=>`<tr class="${selectedFiles.has(r.path)?'is-selected':''}"><td class="check-cell"><input type="checkbox" class="file-check" aria-label="选择 ${esc(r.name||base(r.path))}" data-path="${esc(r.path)}" data-bytes="${r.bytes||0}" ${selectedFiles.has(r.path)?'checked':''} ${r.linked?'disabled':''}></td><td><div class="file-cell"><span class="file-icon ${r.directory?'folder':''}">${icon(r.directory?'folder':'file')}</span><div><button class="plain file-name" title="${esc(r.path)}" data-action="${r.directory&&!r.linked?'explore':'details'}" data-path="${esc(r.path)}">${esc(r.name||base(r.path))}</button><span class="file-path" title="${esc(r.path)}">${esc(r.path)}</span></div></div></td><td class="amount">${fmt(r.bytes)}${r.incomplete?'<br><span class="tag neutral">统计不完整</span>':''}</td><td><span class="tag ${r.linked?'warn':'neutral'}">${r.linked?'链接 / 受限':r.directory?'文件夹':'文件'}</span></td><td><div class="row-actions"><button class="text-button" data-action="open" data-path="${esc(r.path)}" title="在资源管理器选中此项">定位 ${icon('external')}</button>${operations?`<button class="text-button" data-action="details" data-path="${esc(r.path)}">管理 ${icon('arrow')}</button>`:`<button class="text-button" data-action="explore" data-path="${esc(r.path)}">查看 ${icon('arrow')}</button>`}</div></td></tr>`).join('')}</tbody></table></div>`;
}
async function renderAnalyze(){
  const request=++state.request;
  $('#content').innerHTML=`<div class="toolbar"><div class="segmented"><button data-action="analyze-tab" data-tab="folders" class="${state.analyzeTab==='folders'?'active':''}">目录浏览</button><button data-action="analyze-tab" data-tab="large" class="${state.analyzeTab==='large'?'active':''}">大文件</button></div><select class="select" id="drive-select" aria-label="磁盘">${driveOptions()}</select><div class="search-field">${icon('search')}<input class="field" id="query" value="${esc(state.query)}" placeholder="搜索${state.analyzeTab==='folders'?'当前目录':'大文件路径'}…" aria-label="搜索文件"></div>${state.analyzeTab==='large'?`<select id="size-select" class="select" aria-label="最小文件大小"><option value="0">所有体积</option><option value="104857600" ${state.min===104857600?'selected':''}>100 MiB 以上</option><option value="1073741824" ${state.min===1073741824?'selected':''}>1 GiB 以上</option><option value="5368709120" ${state.min===5368709120?'selected':''}>5 GiB 以上</option></select>`:''}</div><div id="analysis-body">${loading()}</div>`;
  if(state.analyzeTab==='folders'){
    const data=await api(`browse?path=${encodeURIComponent(state.path)}&q=${encodeURIComponent(state.query)}&offset=${state.offset}&sort=${state.sort}`);
    if(request!==state.request||state.view!=='analyze')return;
    state.browse=data;
    const sum=data.chart.reduce((a,r)=>a+r.bytes,0)||1;
    $('#analysis-body').innerHTML=`<div class="path-bar"><button class="icon-button" data-action="up" title="上一级" aria-label="上一级">${icon('back')}</button><input id="path-input" aria-label="当前目录，输入后回车" value="${esc(data.path)}"><button class="text-button" data-action="open" data-path="${esc(data.path)}">资源管理器 ${icon('external')}</button></div>${data.chart.length?`<div class="mini-chart" aria-label="子目录相对体积">${data.chart.slice(0,8).map((r,i)=>`<button class="chart-tile" data-action="explore" data-path="${esc(r.path)}" title="${esc(r.path)} · ${fmt(r.bytes)}" style="flex:${Math.max(.06,r.bytes/sum)};background:${colors[i]}"><strong>${esc(base(r.path))}</strong><span>${fmt(r.bytes)}</span></button>`).join('')}</div>`:''}<section class="panel">${fileTable(data.items)}<div class="table-footer"><span>${data.total.toLocaleString()} 项 · 文件大小实时读取，目录大小随变化自动更新</span><div>${button('上一页','prev','', 'small')}${button('下一页','next',state.offset+100>=data.total?'disabled':'','small')}</div></div></section>`;
  }else{
    const data=await api(`files?drive=${encodeURIComponent(state.drive)}&scope=${encodeURIComponent(folderScope()?state.scope:'')}&q=${encodeURIComponent(state.query)}&min=${state.min}`);
    if(request!==state.request||state.view!=='analyze')return;
    state.files=data.items;
    $('#analysis-body').innerHTML=scopeNotice()+notice(`保存当前范围最多 2,000 个大文件，匹配 ${data.items.length} 项。列表随文件变化自动更新；大小不能单独证明文件可删除。`)+`<section class="panel">${fileTable(data.items.slice(state.offset,state.offset+100))}<div class="table-footer"><span>按体积从大到小 · ${data.items.length} 项</span><div>${button('上一页','prev','','small')}${button('下一页','next',state.offset+100>=data.items.length?'disabled':'','small')}</div></div></section>`;
  }
}
function recCard(r, mode){
  const system=/memory\.dmp$/i.test(r.path);
  const allowed=r.policy?.allowed;
  const action=mode==='move'?'move':'clean';
  return `<article class="recommendation"><span class="file-icon ${r.kind==='file'?'':'folder'}">${icon(r.kind==='file'?'file':'folder')}</span><div><h3>${esc(base(r.path))}<span class="tag ${allowed?'blue':'neutral'}">${esc(r.category)}</span></h3><span class="file-path">${esc(r.path)}</span><p>${esc(r.action)}</p></div><div><span class="amount">${fmt(r.bytes)}</span><div class="rec-actions"><button class="text-button" data-action="explore" data-path="${esc(r.kind==='file'?r.path.replace(/[\\/][^\\/]+$/,''):r.path)}">浏览</button>${system?button('Windows 清理','system','data-system="cleanup"','small soft'):allowed?button(mode==='move'?'预览迁移':'预览转移至恢复区','plan-form',`data-mode="${action}" data-path="${esc(r.path)}"`,'small soft'):button('查看说明','details',`data-path="${esc(r.path)}"`,'small')}</div></div></article>`;
}
function renderClean(){
  ++state.request;
  const rows=state.summary.recommendations.filter(r=>inScope(r.path));
  const filtered=rows.filter(r=>state.cleanTab==='all'||(state.cleanTab==='cache'?/缓存|临时|可清理/.test(r.category):/保留|系统|应用/.test(r.category)));
  $('#content').innerHTML=notice('清理采用跨盘恢复区：核验后转移源文件，释放源盘空间，但不会减少所有磁盘的总占用。要永久移除恢复区文件，请先核对操作记录，再在资源管理器处理。')+`<div class="toolbar"><div class="segmented"><button data-action="clean-tab" data-tab="all" class="${state.cleanTab==='all'?'active':''}">全部建议</button><button data-action="clean-tab" data-tab="cache" class="${state.cleanTab==='cache'?'active':''}">缓存与临时文件</button><button data-action="clean-tab" data-tab="protected" class="${state.cleanTab==='protected'?'active':''}">需专项处理</button></div><select class="select" id="drive-select" aria-label="磁盘">${driveOptions()}</select>${button(icon('settings')+' 系统存储','system','data-system="storage"')}${button('回收站','system','data-system="recycle"')}</div><div class="recommendations">${filtered.length?filtered.map(r=>recCard(r,'clean')).join(''):empty('当前范围没有已识别的候选','可以切换磁盘，或在空间分析中浏览个人文件。')}</div>`;
}
function renderMove(){
  ++state.request;
  const rows=state.summary.recommendations.filter(r=>r.category==='迁移候选'&&inScope(r.path));
  $('#content').innerHTML=notice('迁移会逐文件复制并核验内容，然后移除源文件。源空目录保留，不自动修改应用配置或 Windows 文件夹位置；模型与软件引用路径需在迁移后切换。')+`<div class="toolbar"><select class="select" id="drive-select" aria-label="源磁盘">${driveOptions()}</select><span style="flex:1"></span>${button(icon('folder')+' 选择其他目录','custom-move','','soft')}</div><div class="section-heading"><h2>适合规划迁移的数据</h2><span>根据已知目录用途识别，执行前仍需核对</span></div><div class="recommendations">${rows.length?rows.map(r=>recCard(r,'move')).join(''):empty('没有已识别的迁移候选','扫描 C 盘后查看建议，也可以手动选择受支持的个人资料目录。')}</div><div class="section-heading"><h2>目标盘可用空间</h2><span>为新位置预留余量</span></div>${driveCards()}`;
}
async function renderHistory(){
  const request=++state.request;
  $('#content').innerHTML=`<div class="toolbar"><div class="segmented"><button data-action="history-tab" data-tab="operations" class="${state.historyTab==='operations'?'active':''}">操作记录</button><button data-action="history-tab" data-tab="snapshots" class="${state.historyTab==='snapshots'?'active':''}">快照对比</button><button data-action="history-tab" data-tab="issues" class="${state.historyTab==='issues'?'active':''}">扫描盲区</button></div></div><div id="history-body">${loading()}</div>`;
  if(state.historyTab==='operations'){
    const rows=await api('history');if(request!==state.request)return;
    const statuses={done:'已完成',error:'部分失败',cancelled:'已取消',running:'执行中',restoring:'恢复中',restored:'已恢复',restore_error:'恢复未完成',interrupted:'上次中断'};
    $('#history-body').innerHTML=rows.length?notice('恢复只处理原记录中的文件，遇到文件内容变化或同名冲突时停止。恢复需要原盘有足够空间。已转移文件会自动从当前范围移除，恢复后也会自动更新。')+`<div class="history-list">${rows.map(r=>`<article class="history-item"><div class="history-title"><h3>${icon(r.mode==='clean'?'clean':'move')} ${r.mode==='clean'?'转移至恢复区':'跨盘迁移'} · ${esc(base(r.source))}</h3><span class="tag ${/error|interrupted/.test(r.status)?'warn':''}">${statuses[r.status]||esc(r.status)}</span></div><div class="history-path">${esc(r.source)}<br>↳ ${esc(r.target)}</div><div class="history-foot"><div><p>${esc(r.time)} · 完成 ${r.completed} / ${r.count} 个文件 · ${fmt(r.moved_bytes)}</p><p>${esc(r.message||'执行中')}</p></div><div class="row-actions">${button('查看目标','open',`data-path="${esc(r.target)}"`,'small')}${r.status!=='restored'?button('恢复原位置','restore-form',`data-id="${esc(r.id)}"`,'small soft'):''}</div></div></article>`).join('')}</div>`:empty('还没有文件操作记录','从空间分析、清理中心或迁移管理中开始；所有执行结果都会留在这里。');
  }else if(state.historyTab==='snapshots'){
    const rows=await api('snapshots');if(request!==state.request)return;
    $('#history-body').innerHTML=notice('比较当前快照与所选历史快照。仅比较两次都完整读取的同名目录；父子目录相互包含，变化量不能相加。')+`<div class="toolbar"><select class="select" id="snapshot-select" aria-label="历史快照">${rows.map(r=>`<option value="${esc(r.name)}">${esc(r.name)}${r.name===state.summary.snapshot?' · 当前':''}</option>`).join('')}</select>${button('比较快照','compare','','soft')}</div><div id="comparison-results">${comparison(state.summary.comparison)}</div>`;
  }else{
    const data=await api('issues');if(request!==state.request)return;
    const names={link_or_cloud:'链接 / 云占位',unreadable:'读取失败',excluded:'主动排除',volume_unreadable:'磁盘不可读'};
    $('#history-body').innerHTML=notice('以下最多展示前 300 条问题样例，不代表全部问题。扫描不会提权、更改权限或下载云文件。')+`<section class="panel"><div class="summary-strip">${Object.entries(data.counts).map(([k,n])=>`<div><small>${names[k]||esc(k)}</small><strong>${n.toLocaleString()}</strong></div>`).join('')}</div><div class="table-wrap"><table><thead><tr><th>路径</th><th>原因</th></tr></thead><tbody>${data.items.map(r=>`<tr><td><span class="file-path" style="max-width:700px" title="${esc(r.path)}">${esc(r.path)}</span></td><td><span class="tag neutral">${names[r.kind]||esc(r.kind)}</span></td></tr>`).join('')}</tbody></table></div></section>`;
  }
}
function comparison(data){if(!data?.rows?.length)return empty('尚无可比较的变化',esc(data?.message||'选择历史快照开始比较。'));return `<section class="panel"><div class="table-wrap"><table><thead><tr><th>目录</th><th>空间变化</th></tr></thead><tbody>${data.rows.map(r=>`<tr><td><span class="file-path" title="${esc(r.path)}">${esc(r.path)}</span></td><td class="comparison-size ${r.delta>0?'positive':'negative'}">${r.delta>0?'+':'−'}${fmt(Math.abs(r.delta))}</td></tr>`).join('')}</tbody></table></div></section>`;}
function modal(title, body, footer=''){$('#modal-content').innerHTML=`<div class="modal-head"><h2>${title}</h2><button class="icon-button" data-action="close" aria-label="关闭">${icon('close')}</button></div><div class="modal-body">${body}</div><div class="modal-foot">${button('取消','close')}${footer}</div>`;if(!$('#modal').open)$('#modal').showModal();}
async function details(path){
  const policy=await api('policy?path='+encodeURIComponent(path));
  const rec=state.summary.recommendations.find(r=>r.path.toLowerCase()===path.toLowerCase());
  modal('查看与管理',`<div class="preview-path">${esc(path)}</div><p>${esc(rec?.action||policy.reason)}</p>${notice(policy.allowed?'操作前关闭正在使用这些文件的应用。预览会重新读取文件清单，执行时再次核验。':'此位置不支持直接转移。请选择系统管理入口，或先在资源管理器核对。',!policy.allowed)}<div class="toolbar">${button(icon('external')+' 在资源管理器中选中','open',`data-path="${esc(path)}"`)}${/memory\.dmp$/i.test(path)?button('Windows 磁盘清理','system','data-system="cleanup"','soft'):''}${!policy.allowed?button('应用管理','system','data-system="apps"'):''}</div>`,policy.allowed?button('预览转移至恢复区','plan-form',`data-mode="clean" data-path="${esc(path)}"`,'soft')+button('预览迁移','plan-form',`data-mode="move" data-path="${esc(path)}"`,'primary'):'');
}
function planForm(path='',mode='move'){
  const targets=state.summary.volumes.filter(v=>!path.toLowerCase().startsWith(v.path.toLowerCase()));
  modal(mode==='clean'?'转移到可恢复的清理区':'规划跨盘迁移',`<p>${mode==='clean'?'将选中的文件转移到其他盘的恢复区，以释放源盘空间。你可以在操作记录中恢复。':'选择源文件或目录，以及接收文件的磁盘。程序将建立独立目标目录，不覆盖已有文件。'}</p><label for="source-input">源文件 / 目录</label><input class="field" id="source-input" type="text" value="${esc(path)}" placeholder="C:\Users\…\Downloads\旧文件.zip"><label for="target-input">目标磁盘 / 现有目录</label><input class="field" id="target-input" type="text" value="${esc(targets.find(v=>v.path.startsWith('E'))?.path||targets[0]?.path||'')}" list="target-list"><datalist id="target-list">${targets.map(v=>`<option value="${esc(v.path)}">${fmt(v.free)} 可用</option>`).join('')}</datalist>${notice(mode==='clean'?'恢复区占用目标磁盘空间。程序不会永久销毁文件；保留恢复区，才能一键恢复。':'本工具只迁移文件内容，不自动修改应用路径。迁移模型前请退出对应应用；迁移后需设置新的模型位置。')}<input id="plan-mode" type="hidden" value="${mode}">`,button('生成操作预览','make-plan','','primary'));
}
async function makePlan(){
  const source=$('#source-input').value.trim(), target=$('#target-input').value.trim(), mode=$('#plan-mode').value;
  if(!source||!target)throw new Error('请填写源路径和目标目录');
  const plan=await api('plan',{source,target,mode});state.plan=plan;
  modal('确认本次操作',`<p>下面是重新读取的文件清单摘要。预览有效期 10 分钟。</p><label>源位置</label><div class="preview-path">${esc(plan.source)}</div><label>${mode==='clean'?'恢复区位置':'迁移目标'}</label><div class="preview-path">${esc(plan.target)}</div><div class="modal-stats"><div><small>文件数量</small><strong>${plan.count.toLocaleString()}</strong></div><div><small>逻辑体积</small><strong>${fmt(plan.bytes)}</strong></div><div><small>目标剩余估算</small><strong>${fmt(plan.free-plan.bytes)}</strong></div></div>${notice('复制并校验后，源文件会被移除；源空目录保留。硬链接、压缩文件可能使实际释放量不同。发生错误时，已完成的部分可从操作记录恢复。',true)}<details><summary>查看文件样例（前 8 项）</summary>${plan.sample.map(p=>`<div class="preview-path">${esc(p)}</div>`).join('')}</details><label><input type="checkbox" id="confirm-operation">我已核对路径，已关闭使用这些文件的应用，确认转移源文件。</label>`,button('确认并开始','execute','disabled','primary'));
}
function scanForm(){modal('更新磁盘分析',`<p>选择扫描范围。扫描只读取文件元数据，不修改源文件；可以随时取消并保留上次完整结果。</p><div class="scan-options">${state.summary.volumes.map(v=>`<label><input type="checkbox" name="scan-root" value="${esc(v.path)}" ${v.path===state.drive?'checked':''}>${esc(v.path)} · ${fmt(v.free)} 可用</label>`).join('')}</div><label for="scan-custom">或只扫描一个目录（填写后优先使用）</label><input type="text" id="scan-custom" class="field" value="${esc(folderScope()?state.scope:'')}" placeholder="例如 C:\Users\YourName\Downloads"><p>完整磁盘扫描可能需要几分钟。目录中的联接点、云占位和无权限项会被跳过并记录。</p>`,button('开始扫描','start-scan','','primary'));}
function renderJob(job){
  const panel=$('#job-panel');
  if(!job||job.status==='idle'){panel.hidden=true;return;}
  const running=job.status==='running';
  const label={scan:'扫描本地存储',move:'迁移文件',clean:'转移至恢复区',restore:'恢复文件',recycle:'移入回收站'}[job.kind]||'操作';
  panel.hidden=false;
  panel.innerHTML=`${running?'<div class="spinner"></div>':icon(job.status==='done'?'check':'info')}<div class="job-info"><strong>${label} · ${running?(job.kind==='scan'?`${(job.files||0).toLocaleString()} 个文件 / ${(job.directories||0).toLocaleString()} 个目录`:job.kind==='recycle'?`${job.done||0} / ${job.total||0} 项`:fmt(job.done||0)+' / '+fmt(job.total||0)):job.status==='done'?'完成':job.status==='cancelled'?'已取消':'遇到问题'}</strong><p title="${esc(job.message)}">${esc(job.message)}</p>${running&&job.total?`<div class="progress-track"><div style="width:${Math.min(100,job.done/job.total*100)}%"></div></div>`:''}</div>${running?button('停止','cancel','','small'):button('收起','dismiss-job','','small')}`;
  $('#scan-button').disabled=running;
}
let polling=false, lastCapacityRefresh=0;
function renderLive(){
  if($('#modal').open || ['INPUT','SELECT'].includes(document.activeElement?.tagName)){state.pendingRender=true;return;}
  const y=window.scrollY;state.pendingRender=false;render();window.scrollTo(0,y);
}
async function poll(force=false){
  if(polling)return;polling=true;
  try{
    const job=await api('job');if(job.status==='running'||state.lastJob==='running')renderJob(job);
    const finished=state.lastJob==='running'&&job.status!=='running';
    const changed=job.revision!==state.revision;
    const capacity=Date.now()-lastCapacityRefresh>10000;
    if(finished||changed||force||capacity){
      if(finished){toast(job.message,job.status==='error');if(job.kind==='recycle'&&job.result)modal('批量处理结果',`<p>已移入回收站 ${job.result.done.length} 项。</p>${job.result.errors.length?`<div class="recycle-list">${job.result.errors.map(e=>`<p>${esc(e)}</p>`).join('')}</div>`:'<p>文件列表和目录统计已更新。可通过 Windows 回收站恢复。</p>'}`,button('打开回收站','system','data-system="recycle"','soft'));}
      await refresh();lastCapacityRefresh=Date.now();
      if(finished||changed||force||state.view==='overview')renderLive();
    }else if(state.pendingRender)renderLive();
    state.lastJob=job.status;
  }catch(e){$('.local-badge').textContent='连接中断，请刷新页面';}finally{polling=false;}
}
async function action(name, el){
  const d=el.dataset;
  if(name==='clear-selection'){selectedFiles.clear();updateSelection();}
  else if(name==='batch-recycle'){
    recyclePreview=await api('recycle-plan',{paths:[...selectedFiles.keys()]});
    modal('将所选项目移入回收站',`<p>共 <strong>${recyclePreview.items.length} 项 · ${fmt(recyclePreview.bytes)}</strong>。文件夹包含其中全部内容。</p><div class="recycle-list">${recyclePreview.items.map(i=>`<div><strong>${esc(base(i.path))}</strong><span>${esc(i.path)}</span><small>${fmt(i.bytes)}</small></div>`).join('')}</div>${notice('可在 Windows 回收站恢复。移入回收站暂不释放磁盘空间；本操作不会主动清空回收站。')}`,button('确认移入回收站','confirm-recycle','','primary'));
  }
  else if(name==='confirm-recycle'){
    await api('recycle-execute',{id:recyclePreview.id,confirm:true});selectedFiles.clear();$('#modal').close();state.lastJob='running';renderJob(await api('job'));
  }
  else if(name==='nav')route(d.view);
  else if(name==='drive'){state.drive=d.path;state.path=d.path;state.scope=d.path;render();}
  else if(name==='explore'){state.path=d.path;state.drive=state.summary.volumes.find(v=>d.path.toLowerCase().startsWith(v.path.toLowerCase()))?.path||state.drive;state.analyzeTab='folders';state.query='';state.offset=0;if(state.view==='analyze')render();else route('analyze');}
  else if(name==='large'){state.analyzeTab='large';route('analyze');}
  else if(name==='analyze-tab'){state.analyzeTab=d.tab;state.offset=0;state.query='';render();}
  else if(name==='clean-tab'){state.cleanTab=d.tab;render();}
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
  else if(name==='cancel'){await api('cancel',{});toast('正在安全停止，当前文件校验完成后生效');}
  else if(name==='dismiss-job')$('#job-panel').hidden=true;
  else if(name==='restore-form'){modal('恢复到原位置',`<p>将这次操作中的文件复制回原位置并核验，然后移除目标副本。原位置存在不同内容的文件时会停止，不会覆盖。</p>${notice('请关闭正在使用这些文件的应用，并确认原磁盘有足够空间。恢复后也需要自行切回应用保存路径。',true)}`,button('确认恢复','restore',`data-id="${esc(d.id)}"`,'primary'));}
  else if(name==='restore'){await api('restore',{id:d.id,confirm:true});$('#modal').close();state.lastJob='running';renderJob(await api('job'));}
  else if(name==='compare'){const data=await api('compare',{snapshot:$('#snapshot-select').value});$('#comparison-results').innerHTML=comparison(data);}
}
document.addEventListener('click',async e=>{const b=e.target.closest('[data-action]');if(!b||b.disabled)return;const name=b.dataset.action;b.disabled=true;try{await action(name,b)}catch(err){toast(err.message,true)}finally{b.disabled=false;}});
function updateSelection(){
  const checks=$$('.file-check');
  for(const c of checks){c.checked=selectedFiles.has(c.dataset.path);c.closest('tr').classList.toggle('is-selected',c.checked);}
  const enabled=checks.filter(c=>!c.disabled),chosen=enabled.filter(c=>c.checked);
  const all=$('#select-page');if(all){all.checked=enabled.length>0&&chosen.length===enabled.length;all.indeterminate=chosen.length>0&&chosen.length<enabled.length;}
  const count=$('#selection-count');if(count)count.textContent=`已选 ${selectedFiles.size} 项 · ${fmt([...selectedFiles.values()].reduce((a,b)=>a+b,0))}`;
  const btn=$('[data-action="batch-recycle"]');if(btn)btn.disabled=!selectedFiles.size;
}
document.addEventListener('change',e=>{
 if(e.target.matches('.file-check')){if(e.target.checked)selectedFiles.set(e.target.dataset.path,Number(e.target.dataset.bytes));else selectedFiles.delete(e.target.dataset.path);updateSelection();}
 if(e.target.id==='select-page'){for(const c of $$('.file-check:not(:disabled)')){if(e.target.checked)selectedFiles.set(c.dataset.path,Number(c.dataset.bytes));else selectedFiles.delete(c.dataset.path);}updateSelection();}
if(e.target.id==='drive-select'){state.drive=e.target.value;state.path=state.drive;state.scope=state.drive;state.offset=0;render();}if(e.target.id==='size-select'){state.min=Number(e.target.value);state.offset=0;render();}if(e.target.id==='confirm-operation')$('[data-action="execute"]').disabled=!e.target.checked;});
let searchTimer;
document.addEventListener('input',e=>{if(e.target.id==='query'){state.query=e.target.value;state.offset=0;clearTimeout(searchTimer);searchTimer=setTimeout(()=>{const value=state.query;render();const field=$('#query');if(field){field.focus();field.setSelectionRange(value.length,value.length)}},350);}});
document.addEventListener('keydown',e=>{if(e.target.id==='path-input'&&e.key==='Enter'){state.path=e.target.value.trim();state.offset=0;state.query='';render();}});
$('#scan-button').innerHTML=icon('scan')+' 扫描磁盘';$('#scan-button').addEventListener('click',scanForm);
$('#export-button').innerHTML=icon('export');$('#export-button').addEventListener('click',async()=>{try{const data=await api('export');const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='Spacewell-分析结果.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('已导出分析结果，文件包含本机路径，分享前请脱敏。')}catch(e){toast(e.message,true)}});
$('#help-button').addEventListener('click',()=>modal('关于留白 Spacewell',`<div class="help-steps"><div><h3>01 / 看清空间</h3><p>总览使用 Windows 实时容量。目录大小来自最近快照，文件列表读取实时元数据。目录变化会自动更新相关排名；返回页面时也会刷新。</p></div><div><h3>02 / 安心处理</h3><p>支持下载、桌面、文档、图片、视频、音乐及已识别模型和缓存目录。系统目录、数据库、联接点和云占位不直接操作；缓存最近 7 天有修改时会阻止整目录转移。</p></div><div><h3>03 / 转移与恢复</h3><p>清理区和迁移区都使用其他盘接收文件。复制并核验后才移除源文件；不会覆盖目标。恢复记录保存在项目 local-state 中，请保留此目录。</p></div><div><h3>04 / 应用路径与系统清理</h3><p>迁移后请自行切换软件保存目录，模型应先退出应用。系统崩溃转储与安装应用使用 Windows 清理入口。恢复区文件需自行永久删除，删除后无法再恢复。</p></div></div>`));
window.addEventListener('hashchange',navigate);
window.addEventListener('focus',()=>poll(true));
document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll(true)});
refresh().then(()=>{navigate();setInterval(()=>poll(),1400)}).catch(e=>{$('#content').innerHTML=empty('暂时无法连接本地服务',esc(e.message)+'。请重新运行 start.cmd。')});
