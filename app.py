"""Spacewell: loopback-only storage manager, standard library only."""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import shutil
import stat
import subprocess
import threading
import time
from urllib.parse import urlsplit, parse_qs
import webbrowser

import storage_audit as audit
import windows_integration

BASE = Path(__file__).resolve().parent
REPORTS = BASE / "reports"
STATE = BASE / "local-state"
GIB = 1024 ** 3


def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    with temp.open('w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(temp, path)


def no_links(path, must_exist=True):
    """Reject alternate streams, device/UNC paths and linked ancestors."""
    p = Path(path)
    if not p.is_absolute() or (os.name == 'nt' and (str(p).startswith('\\\\') or ':' in str(p)[2:])):
        raise ValueError('只支持本机磁盘上的绝对路径')
    for part in [p, *p.parents]:
        if not part.exists() and not part.is_symlink():
            if part == p and must_exist:
                raise ValueError('路径不存在，请刷新扫描结果')
            continue
        s = part.lstat()
        if stat.S_ISLNK(s.st_mode) or getattr(s, 'st_file_attributes', 0) & (audit.REPARSE | audit.OFFLINE | audit.RECALL):
            raise ValueError('不操作链接、联接点、云占位或离线文件')
    return p


def fingerprint(path):
    s = path.stat(follow_symlinks=False)
    return [s.st_size, s.st_mtime_ns, s.st_ino]


def same_volume(source, target):
    return source.drive.lower() == target.drive.lower() if os.name == 'nt' else source.stat().st_dev == target.stat().st_dev


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(2 ** 20), b''):
            h.update(block)
    return h.hexdigest()


def verified_copy(source, target, expected):
    no_links(source)
    no_links(target, False)
    if fingerprint(source) != expected:
        raise ValueError(f'源文件已变化，已停止：{source}')
    target.parent.mkdir(parents=True, exist_ok=True)
    no_links(target.parent)
    # Native Windows copy retains timestamps, attributes and NTFS alternate streams
    # (including downloaded files' Zone.Identifier). Fail if a destination exists.
    if os.name == 'nt':
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        copy = kernel.CopyFileExW
        copy.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD]
        copy.restype = wintypes.BOOL
        if not copy(str(source), str(target), None, None, None, 1 | 0x800):
            raise ctypes.WinError(ctypes.get_last_error())
        with target.open('rb+') as copied:
            os.fsync(copied.fileno())
    else:
        with source.open('rb') as src, target.open('xb') as dst:
            shutil.copyfileobj(src, dst, 2 ** 20)
            dst.flush()
            os.fsync(dst.fileno())
        shutil.copystat(source, target)
    sha = digest(source)
    if fingerprint(source) != expected or digest(target) != sha:
        raise ValueError('文件变化或复制校验失败；源文件仍保留，目标副本需检查')
    return sha


class Manager:
    def __init__(self, reports=REPORTS, state=STATE, allowed=None):
        self.reports, self.state = Path(reports), Path(state)
        home = Path.home()
        self.personal = [home / n for n in ['Downloads', 'Desktop', 'Documents', 'Pictures', 'Videos', 'Music']]
        self.models = [home / '.ollama' / 'models', home / '.cache' / 'huggingface']
        self.caches = [home / 'AppData/Local' / n for n in ['npm-cache', 'uv/cache', 'pip/Cache', 'Temp']]
        self.allowed = allowed if allowed is not None else self.personal + self.models + self.caches
        self.lock = threading.RLock()
        self.cancel = threading.Event()
        self.job = {'status': 'idle', 'kind': '', 'message': '等待操作'}
        self.plans = {}
        self.data = {'directories': [], 'largest': [], 'recommendations': [], 'roots': [], 'issues': [], 'issue_counts': {}, 'files_scanned': 0}
        self.index, self.children = {}, {}
        self.snapshot = None
        self.revision = 0
        self.live_updated = None
        self.watchers = []
        self.monitor_stop = threading.Event()
        self.monitor_enabled = False
        self.pending = set()
        self.monitor = {'status': 'off', 'message': '自动更新未启动'}
        self.load_latest()

    def load_latest(self):
        paths = sorted(self.reports.glob('scan-*.json'), reverse=True)
        if paths:
            self.set_data(json.loads(paths[0].read_text(encoding='utf-8')), paths[0].name)

    def set_data(self, data, name):
        index, children = {}, {}
        for row in data['directories']:
            index[audit.key(row['path'])] = row
            if row['parent']:
                children.setdefault(audit.key(row['parent']), []).append(row)
        with self.lock:
            self.data, self.index, self.children, self.snapshot = data, index, children, name
            self.revision += 1
            self.live_updated = data.get('finished')
        if self.monitor_enabled:
            self.watch_roots()

    def watch_roots(self):
        for watcher in self.watchers:
            watcher.close()
        self.watchers = []
        self.monitor = {'status': 'watching', 'message': '正在监听当前扫描范围'}
        for root in self.data['roots']:
            try:
                no_links(root)
                self.watchers.append(windows_integration.DirectoryWatch(root, self.queue_change, self.watch_failed))
            except (OSError, ValueError) as exc:
                self.watch_failed(root, str(exc))

    def watch_failed(self, root, message):
        with self.lock:
            self.monitor = {'status': 'limited', 'message': f'{root}：{message}'}
            self.revision += 1

    def queue_change(self, changed):
        if any(audit.within(changed, p) for p in (self.reports, self.state)):
            return
        parent = audit.key(Path(changed).parent)
        with self.lock:
            if any(audit.within(parent, root) for root in self.data['roots']):
                if len(self.pending) < 2000:
                    self.pending.add(parent)
                else:
                    self.monitor = {'status': 'limited', 'message': '变化过于密集，请重新扫描以核对完整结果'}

    def start_monitor(self):
        self.monitor_enabled = True
        self.watch_roots()
        # Reconcile known large-file parents at startup, catching deletions while closed.
        self.pending.update(audit.key(Path(r['path']).parent) for r in self.data['largest'])
        self.pending.update(audit.key(r) for r in self.data['roots'])
        def run():
            while not self.monitor_stop.wait(1.5):
                if self.job['status'] == 'running':
                    continue
                with self.lock:
                    self.pending.update(audit.key(root) for root in self.data['roots'] if not Path(root).exists() and not self.index.get(audit.key(root), {}).get('missing'))
                    batch = list(self.pending)[:30]
                    self.pending.difference_update(batch)
                for parent in batch:
                    try:
                        self.reconcile_directory(parent)
                    except (OSError, ValueError) as exc:
                        self.watch_failed(parent, str(exc))
        threading.Thread(target=run, daemon=True).start()

    def stop_monitor(self):
        self.monitor_stop.set()
        for watcher in self.watchers:
            watcher.close()

    def reconcile_directory(self, path):
        """Refresh only immediate entries and new subtrees; propagate size deltas upward."""
        with self.lock:
            p = Path(path)
            while audit.key(p) not in self.index and p != p.parent:
                p = p.parent
            normalized = audit.key(p)
            if normalized not in self.index:
                return False
            row = self.index[normalized]
            if not p.exists() and row['parent']:
                return self.reconcile_directory(row['parent'])
            old = dict(row)
            direct, dirs, skipped = [], set(), 0
            if p.exists():
                no_links(p)
                with os.scandir(p) as entries:
                    for e in entries:
                        if any(audit.within(e.path, excluded) for excluded in (self.reports, self.state)):
                            skipped += 1
                            continue
                        s = e.stat(follow_symlinks=False)
                        if stat.S_ISLNK(s.st_mode) or getattr(s, 'st_file_attributes', 0) & (audit.REPARSE | audit.OFFLINE | audit.RECALL):
                            skipped += 1
                        elif stat.S_ISDIR(s.st_mode):
                            dirs.add(audit.key(e.path))
                        elif stat.S_ISREG(s.st_mode):
                            direct.append({'path': e.path, 'bytes': s.st_size, 'modified': audit.modified_time(s.st_mtime), '_old': s.st_mtime < time.time()-30*86400})
            previous_children = self.children.get(normalized, [])
            removed = [c['path'] for c in previous_children if audit.key(c['path']) not in dirs]
            if removed:
                for name in list(self.index):
                    if any(audit.within(name, r) for r in removed):
                        self.index.pop(name, None)
                        self.children.pop(name, None)
            additions, new_large = [], []
            for directory in dirs:
                if directory not in self.index:
                    new = audit.scan([directory], excluded=[str(self.reports), str(self.state)], top=2000)
                    new['directories'][0]['parent'] = row['path']
                    additions.extend(new['directories'])
                    new_large.extend(new['largest'])
                    for child in new['directories']:
                        self.index[audit.key(child['path'])] = child
                        if child['parent'] and audit.key(child['parent']) != normalized:
                            self.children.setdefault(audit.key(child['parent']), []).append(child)
            children = [self.index[d] for d in dirs]
            self.children[normalized] = children
            row.update(direct_bytes=sum(f['bytes'] for f in direct),
                       bytes=sum(f['bytes'] for f in direct)+sum(c['bytes'] for c in children),
                       files=len(direct)+sum(c['files'] for c in children),
                       old_bytes=sum(f['bytes'] for f in direct if f['_old'])+sum(c['old_bytes'] for c in children),
                       incomplete=skipped+sum(c['incomplete'] for c in children), missing=not p.exists())
            # Update every ancestor using this subtree's net change, never summing overlaps.
            parent = row['parent']
            while parent and audit.key(parent) in self.index:
                ancestor = self.index[audit.key(parent)]
                for field in ('bytes', 'files', 'old_bytes', 'incomplete'):
                    ancestor[field] += row[field]-old[field]
                parent = ancestor['parent']
            largest = [r for r in self.data['largest'] if audit.key(Path(r['path']).parent) != normalized and not any(audit.within(r['path'], x) for x in removed)]
            largest.extend({k:v for k,v in f.items() if k != '_old'} for f in direct)
            largest.extend(new_large)
            largest.sort(key=lambda r:(-r['bytes'], r['path'].lower()))
            changed = old != row or removed or additions or largest[:2000] != self.data['largest']
            if not changed:
                return False
            self.data['largest'] = largest[:2000]
            if removed or additions:
                self.data['directories'] = list(self.index.values())
            self.data['files_scanned'] = sum(self.index[audit.key(root)]['files'] for root in self.data['roots'] if audit.key(root) in self.index)
            candidates = {audit.key(r['path']): self.index[audit.key(r['path'])] for r in self.data['recommendations'] if audit.key(r['path']) in self.index}
            candidates[normalized] = row
            candidates.update((audit.key(r['path']),r) for r in additions)
            self.data['recommendations'] = audit.recommendations({'directories':list(candidates.values()), 'largest':self.data['largest']})
            self.live_updated = audit.datetime.now().astimezone().isoformat(timespec='seconds')
            self.revision += 1
            return True

    def volumes(self):
        rows = []
        for p in audit.fixed_drives():
            try:
                d = shutil.disk_usage(p)
                rows.append({'path': p, 'total': d.total, 'used': d.used, 'free': d.free})
            except OSError:
                pass
        return rows

    def policy(self, path):
        try:
            p = no_links(path)
            if audit.within(p, BASE) or not any(audit.within(p, a) for a in self.allowed):
                return {'allowed': False, 'reason': '系统、应用或未分类目录：使用系统管理入口，或在资源管理器中核对。'}
            if any(part.lower() in {'.git', '.ssh', '.codex', 'onedrive', 'node_modules'} for part in p.parts):
                return {'allowed': False, 'reason': '含代码、同步或应用状态，需专项处理。'}
            if p.is_file() and (p.suffix.lower() in {'.db', '.sqlite', '.vhd', '.vhdx', '.pst', '.ost'} or p.name.lower().endswith(('-wal', '-shm'))):
                return {'allowed': False, 'reason': '数据库、邮件或虚拟磁盘需要应用专用流程。'}
            return {'allowed': True, 'reason': '支持核验后跨盘转移；不会覆盖目标文件。'}
        except (OSError, ValueError) as exc:
            return {'allowed': False, 'reason': str(exc)}

    def summary(self):
        with self.lock:
            d = self.data
            recs = [dict(r, policy=self.policy(r['path'])) for r in d.get('recommendations', [])]
            return {'volumes': self.volumes(), 'snapshot': self.snapshot, 'finished': d.get('finished'),
                    'roots': d['roots'], 'files': d['files_scanned'], 'directories': len(d['directories']),
                    'issues': d['issue_counts'], 'recommendations': recs, 'job': dict(self.job),
                    'home': str(Path.home()), 'comparison': d.get('comparison', {}),
                    'revision': self.revision, 'live_updated': self.live_updated, 'monitor': dict(self.monitor),
                    'scopes': [dict(self.index.get(audit.key(root), {}), path=root) for root in d['roots']]}

    def browse(self, path, query='', offset=0, sort='size'):
        p = no_links(path)
        if not p.is_dir():
            raise ValueError('请选择目录')
        result = []
        with os.scandir(p) as entries:
            for e in entries:
                if query.lower() not in e.name.lower():
                    continue
                try:
                    s = e.stat(follow_symlinks=False)
                    linked = bool(getattr(s, 'st_file_attributes', 0) & (audit.REPARSE | audit.OFFLINE | audit.RECALL)) or stat.S_ISLNK(s.st_mode)
                    directory = stat.S_ISDIR(s.st_mode)
                    known = self.index.get(audit.key(e.path), {})
                    result.append({'path': e.path, 'name': e.name, 'directory': directory, 'linked': linked,
                                   'bytes': known.get('bytes') if directory else s.st_size,
                                   'incomplete': known.get('incomplete', 0), 'modified': audit.modified_time(s.st_mtime)})
                except OSError:
                    result.append({'path': e.path, 'name': e.name, 'directory': False, 'linked': True, 'bytes': None, 'incomplete': 1})
        result.sort(key=(lambda r: r['name'].lower()) if sort == 'name' else lambda r: -(r['bytes'] or 0))
        children = sorted(self.children.get(audit.key(p), []), key=lambda r: r['bytes'], reverse=True)[:12]
        return {'path': str(p), 'parent': str(p.parent), 'total': len(result), 'items': result[offset:offset+100],
                'chart': children, 'record': self.index.get(audit.key(p))}

    def history(self):
        rows = []
        for p in sorted(self.state.glob('*/meta.json'), reverse=True):
            try:
                row = json.loads(p.read_text(encoding='utf-8'))
                if row['status'] in {'running', 'restoring'} and row['id'] != self.job.get('id'):
                    row['status'] = 'interrupted'
                    row['message'] = '上次操作被中断，可尝试恢复已转移文件'
                rows.append(row)
            except (OSError, ValueError, KeyError):
                pass
        return rows

    def inventory(self, source):
        p = no_links(source)
        policy = self.policy(p)
        if not policy['allowed']:
            raise ValueError(policy['reason'])
        files = []
        stack = [p]
        while stack:
            current = no_links(stack.pop())
            if not self.policy(current)['allowed']:
                raise ValueError(f'包含需专项处理的数据：{current}')
            if current.is_dir():
                with os.scandir(current) as it:
                    stack.extend(Path(e.path) for e in it)
            elif current.is_file():
                fp = fingerprint(current)
                if any(audit.within(current, c) for c in self.caches) and time.time_ns() - fp[1] < 7 * 86400 * 10**9:
                    raise ValueError('包含最近 7 天修改的缓存，请逐项选择旧文件，或使用软件自带清理。')
                files.append({'source': str(current), 'relative': str(current.relative_to(p)) if p.is_dir() else p.name, 'fingerprint': fp})
                if len(files) > 50000:
                    raise ValueError('单次最多处理 50,000 个文件，请选择更小的子目录')
        if not files:
            raise ValueError('此目录没有可处理的普通文件')
        return files

    def plan(self, source, target, mode):
        if mode not in {'clean', 'move'}:
            raise ValueError('不支持的操作')
        source = no_links(source)
        target = no_links(target)
        if not target.is_dir() or audit.within(target, source) or audit.within(source, target) and target != Path(target.anchor):
            raise ValueError('目标须为现有目录，且不能与源目录嵌套')
        if same_volume(source, target):
            raise ValueError('请选择另一个磁盘，才能释放源盘空间')
        blocked = [Path(os.environ.get('SystemRoot', 'C:/Windows')), Path.home(), BASE]
        blocked += [Path(target.anchor) / n for n in ['Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', '$Recycle.Bin', 'System Volume Information']]
        if any(audit.within(target, b) for b in blocked):
            raise ValueError('目标目录不应位于系统、用户配置或本工具目录内')
        files = self.inventory(source)
        size = sum(f['fingerprint'][0] for f in files)
        free = shutil.disk_usage(target).free
        if size + 256 * 2**20 > free:
            raise ValueError('目标空间不足，需要额外保留至少 256 MiB')
        ident = time.strftime('%Y%m%d-%H%M%S-') + secrets.token_hex(4)
        destination = target / ('Spacewell-Recovery' if mode == 'clean' else 'Spacewell-Migrated') / ident / source.name
        no_links(destination, False)
        if destination.exists():
            raise ValueError('目标已存在')
        result = {'id': ident, 'source': str(source), 'target': str(destination), 'mode': mode,
                  'bytes': size, 'count': len(files), 'free': free, 'created': time.time(),
                  'files': files, 'is_directory': source.is_dir()}
        with self.lock:
            self.plans = {k: v for k, v in self.plans.items() if time.time() - v['created'] < 600}
            self.plans[ident] = result
        return {k: v for k, v in result.items() if k != 'files'} | {'sample': [f['source'] for f in files[:8]]}

    def recycle_manifest(self, path):
        p = no_links(path)
        if any(audit.key(p) == audit.key(a) for a in self.allowed):
            raise ValueError('请选择此目录内的具体文件或子目录')
        entries = []
        stack = [p]
        while stack:
            item = no_links(stack.pop())
            policy = self.policy(item)
            if not policy['allowed']:
                raise ValueError(policy['reason'])
            entries.append({'path': str(item), 'fingerprint': fingerprint(item), 'directory': item.is_dir()})
            if len(entries) > 50000:
                raise ValueError('单次目录过大，请分批选择')
            if item.is_dir():
                stack.extend(item.iterdir())
        return sorted(entries, key=lambda x: audit.key(x['path']))

    def recycle_plan(self, paths):
        if not isinstance(paths, list) or not 1 <= len(paths) <= 100:
            raise ValueError('每批请选择 1–100 项')
        candidates = sorted({audit.key(no_links(p)) for p in paths}, key=len)
        sources = []
        for candidate in candidates:
            if not any(audit.within(candidate, parent) for parent in sources):
                sources.append(candidate)
        items = []
        for source in sources:
            manifest = self.recycle_manifest(source)
            items.append({'path': str(source), 'manifest': manifest,
                          'bytes': sum(e['fingerprint'][0] for e in manifest if not e['directory'])})
        ident = secrets.token_hex(16)
        plan = {'id': ident, 'mode': 'recycle', 'created': time.time(), 'items': items}
        with self.lock:
            self.plans = {k: v for k, v in self.plans.items() if time.time()-v['created'] < 600}
            self.plans[ident] = plan
        return {'id': ident, 'items': [{'path': i['path'], 'bytes': i['bytes']} for i in items],
                'bytes': sum(i['bytes'] for i in items)}

    def recycle_execute(self, ident):
        with self.lock:
            plan = self.plans.get(ident)
            if not plan or plan.get('mode') != 'recycle' or time.time()-plan['created'] > 600:
                raise ValueError('预览已失效，请重新选择')
            def work():
                errors, done = [], []
                self.job['total'] = len(plan['items'])
                for item in plan['items']:
                    if self.cancel.is_set():
                        errors.append('剩余项目已取消')
                        break
                    try:
                        if self.recycle_manifest(item['path']) != item['manifest']:
                            raise ValueError('预览后文件发生变化，请重新预览')
                        windows_integration.recycle(item['path'])
                        done.append(item['path'])
                    except (OSError, ValueError) as exc:
                        errors.append(item['path'] + '：' + str(exc))
                    self.queue_change(item['path'])
                    self.reconcile_directory(str(Path(item['path']).parent))
                    self.job['done'] = self.job.get('done', 0)+1
                self.job['result'] = {'done': done, 'errors': errors}
                save_json(self.state / ('recycle-' + ident + '.json'), self.job['result'])
                if errors:
                    raise ValueError('已处理 %d 项；%s' % (len(done), '；'.join(errors)))
            self.begin('recycle', work, ident)
            self.plans.pop(ident, None)

    def begin(self, kind, worker, ident=None):
        with self.lock:
            if self.job['status'] == 'running':
                raise ValueError('已有操作正在进行，请等待完成或取消')
            self.cancel.clear()
            self.job = {'status': 'running', 'kind': kind, 'id': ident, 'message': '准备中', 'done': 0, 'total': 0}
        def run():
            try:
                worker()
                self.job.update(status='done', message='操作完成')
            except InterruptedError as exc:
                self.job.update(status='cancelled', message=str(exc))
            except Exception as exc:
                self.job.update(status='error', message=str(exc))
        threading.Thread(target=run, daemon=True).start()

    def start_scan(self, roots):
        roots = audit.normalize_roots(roots)
        def work():
            last = [0.0]
            def progress(files, dirs, path):
                if time.monotonic() - last[0] > .3:
                    self.job.update(files=files, directories=dirs, message=path)
                    last[0] = time.monotonic()
            data = audit.scan(roots, excluded=[str(self.reports), str(self.state)], top=2000, progress=progress, cancel=self.cancel)
            self.job['message'] = '生成建议与历史快照'
            data['recommendations'] = audit.recommendations(data)
            data['comparison'] = audit.compare(data, self.data) if self.snapshot else {'message': '首次扫描', 'rows': []}
            name = 'scan-' + time.strftime('%Y%m%d-%H%M%S') + '.json'
            save_json(self.reports / name, data)
            audit.write_report(data, self.reports / 'latest.html')
            self.set_data(data, name)
        self.begin('scan', work)

    def append_event(self, ident, event):
        path = self.state / ident / 'events.jsonl'
        with path.open('a', encoding='utf-8') as f:
            f.write(json.dumps(event, ensure_ascii=False) + '\n')
            f.flush()
            os.fsync(f.fileno())

    def execute(self, ident):
        with self.lock:
            plan = self.plans.get(ident)
            if not plan or time.time() - plan['created'] > 600:
                raise ValueError('预览已失效，请重新生成')
            def work():
                self.plans.pop(ident, None)
                meta = {k: v for k, v in plan.items() if k not in {'files', 'created'}}
                meta.update(status='running', time=time.strftime('%Y-%m-%d %H:%M:%S'), completed=0, moved_bytes=0)
                statefile = self.state / ident / 'meta.json'
                save_json(statefile, meta)
                self.job['total'] = plan['bytes']
                try:
                    for f in plan['files']:
                        if self.cancel.is_set():
                            raise InterruptedError('操作已停止；已转移的文件可以在操作记录中恢复')
                        source = no_links(f['source'])
                        if not self.policy(source)['allowed']:
                            raise ValueError('源文件已不符合操作条件')
                        target = Path(plan['target']) / f['relative'] if plan['is_directory'] else Path(plan['target'])
                        self.job['message'] = str(source)
                        sha = verified_copy(source, target, f['fingerprint'])
                        event = {'source': str(source), 'target': str(target), 'sha256': sha, 'bytes': f['fingerprint'][0], 'state': 'copied'}
                        # A durable copy record precedes unlink, including crash recovery.
                        self.append_event(ident, event)
                        no_links(source)
                        no_links(target)
                        if fingerprint(source) != f['fingerprint'] or digest(source) != sha:
                            raise ValueError('源文件在复制期间变化，源文件已保留')
                        source.unlink()
                        self.append_event(ident, dict(event, state='moved'))
                        meta['completed'] += 1
                        meta['moved_bytes'] += event['bytes']
                        self.job['done'] = meta['moved_bytes']
                        save_json(statefile, meta)
                    meta.update(status='done', message='校验并转移完成；源空目录保留，软件保存位置未自动修改')
                except Exception as exc:
                    meta.update(status='cancelled' if isinstance(exc, InterruptedError) else 'error', message=str(exc))
                    raise
                finally:
                    save_json(statefile, meta)
            self.begin(plan['mode'], work, ident)

    def restore(self, ident):
        if not ident or any(c not in '0123456789abcdef-' for c in ident):
            raise ValueError('无效记录')
        folder = self.state / ident
        meta = json.loads((folder / 'meta.json').read_text(encoding='utf-8'))
        if meta['status'] == 'restored':
            raise ValueError('此记录已经恢复')
        events = {}
        log = folder / 'events.jsonl'
        if not log.exists():
            raise ValueError('没有已完成的复制记录')
        for line in log.read_text(encoding='utf-8').splitlines():
            try:
                e = json.loads(line)
                events[e['source']] = e
            except (ValueError, KeyError):
                continue
        def work():
            meta['status'] = 'restoring'
            save_json(folder / 'meta.json', meta)
            self.job['total'] = sum(e['bytes'] for e in events.values())
            try:
                for e in events.values():
                    if self.cancel.is_set():
                        raise InterruptedError('恢复已暂停，可再次点击恢复继续')
                    if e['state'] == 'restored':
                        continue
                    source, target = Path(e['source']), Path(e['target'])
                    if not audit.within(source, meta['source']) or not audit.within(target, meta['target']):
                        raise ValueError('记录路径不符合原始操作范围')
                    if not any(audit.within(source, a) for a in self.allowed) or audit.within(source, BASE):
                        raise ValueError('原路径不属于受支持的个人数据范围')
                    no_links(source, False)
                    no_links(target, False)
                    if not target.exists() and source.exists() and digest(source) == e['sha256']:
                        self.append_event(ident, dict(e, state='restored'))
                        self.job['done'] += e['bytes']
                        continue
                    no_links(target)
                    self.job['message'] = str(source)
                    if digest(target) != e['sha256']:
                        raise ValueError('目标文件已被修改，停止恢复以保留你的修改')
                    if source.exists():
                        # A crash after copy-back is recoverable if both copies agree.
                        if digest(source) != e['sha256']:
                            raise ValueError('原路径已有不同文件，不会覆盖：' + str(source))
                    else:
                        parent = source.parent
                        while not parent.exists():
                            parent = parent.parent
                        if shutil.disk_usage(parent).free < e['bytes'] + 64 * 2**20:
                            raise ValueError('原盘空间不足，停止恢复')
                        verified_copy(target, source, fingerprint(target))
                    no_links(target)
                    no_links(source)
                    if digest(source) != e['sha256'] or digest(target) != e['sha256']:
                        raise ValueError('恢复后核验失败，两份文件均保留')
                    target.unlink()
                    self.append_event(ident, dict(e, state='restored'))
                    self.job['done'] += e['bytes']
                meta.update(status='restored', message='文件已恢复，未覆盖任何现有文件')
            except Exception as exc:
                meta.update(status='restore_error', message=str(exc))
                raise
            finally:
                save_json(folder / 'meta.json', meta)
        self.begin('restore', work, ident)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, value, status=200, mime='application/json; charset=utf-8'):
        payload = json.dumps(value, ensure_ascii=False).encode() if not isinstance(value, bytes) else value
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
        self.end_headers()
        self.wfile.write(payload)

    def authorized(self, api=False):
        expected = f'127.0.0.1:{self.server.server_port}'
        if self.headers.get('Host') != expected:
            return False
        origin = self.headers.get('Origin')
        if origin and origin != 'http://' + expected:
            return False
        return not api or secrets.compare_digest(self.headers.get('X-Spacewell-Token', ''), self.server.token)

    def do_GET(self):
        url = urlsplit(self.path)
        if not self.authorized(url.path.startswith('/api/')):
            return self.reply({'error': '请求未授权，请从本机启动入口访问'}, 403)
        params = {k: v[0] for k, v in parse_qs(url.query).items()}
        m = self.server.manager
        try:
            if url.path == '/api/summary':
                return self.reply(m.summary())
            if url.path == '/api/job':
                return self.reply(dict(m.job, revision=m.revision, live_updated=m.live_updated, monitor=m.monitor, pending=len(m.pending)))
            if url.path == '/api/browse':
                return self.reply(m.browse(params.get('path', 'C:\\'), params.get('q', ''), max(0, int(params.get('offset', 0))), params.get('sort', 'size')))
            if url.path == '/api/files':
                rows = [dict(r, policy=m.policy(r['path'])) for r in m.data['largest'] if r['path'].lower().startswith(params.get('drive', '').lower()) and (not params.get('scope') or audit.within(r['path'], params['scope'])) and params.get('q', '').lower() in r['path'].lower() and r['bytes'] >= float(params.get('min', 0))]
                return self.reply({'items': rows, 'limit': len(m.data['largest'])})
            if url.path == '/api/issues':
                return self.reply({'counts': m.data['issue_counts'], 'items': m.data['issues']})
            if url.path == '/api/history':
                return self.reply(m.history())
            if url.path == '/api/policy':
                return self.reply(m.policy(params['path']))
            if url.path == '/api/snapshots':
                return self.reply([{'name': p.name, 'bytes': p.stat().st_size} for p in sorted(m.reports.glob('scan-*.json'), reverse=True)])
            if url.path == '/api/export':
                return self.reply({'snapshot': m.snapshot, 'finished': m.data.get('finished'), 'volumes': m.volumes(), 'recommendations': m.data['recommendations'], 'largest': m.data['largest'], 'issues': m.data['issue_counts']})
            files = {'/': ('index.html', 'text/html; charset=utf-8'), '/app.js': ('app.js', 'text/javascript; charset=utf-8'), '/style.css': ('style.css', 'text/css; charset=utf-8')}
            if url.path in files:
                file, mime = files[url.path]
                body = (BASE / 'web' / file).read_bytes()
                if file == 'index.html':
                    body = body.replace(b'__TOKEN__', self.server.token.encode())
                return self.reply(body, mime=mime)
            self.reply({'error': '页面不存在'}, 404)
        except (ValueError, OSError, KeyError) as exc:
            self.reply({'error': str(exc)}, 400)

    def do_POST(self):
        if not self.authorized(True):
            return self.reply({'error': '请求未授权'}, 403)
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 65536 or self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                raise ValueError('无效请求')
            body = json.loads(self.rfile.read(length))
            m = self.server.manager
            route = urlsplit(self.path).path
            if route == '/api/scan':
                m.start_scan(body['roots'])
            elif route == '/api/cancel':
                m.cancel.set()
            elif route == '/api/recycle-plan':
                return self.reply(m.recycle_plan(body['paths']))
            elif route == '/api/recycle-execute':
                if body.get('confirm') is not True:
                    raise ValueError('请先确认所选文件')
                m.recycle_execute(body['id'])
            elif route == '/api/plan':
                return self.reply(m.plan(body['source'], body['target'], body['mode']))
            elif route == '/api/execute':
                if body.get('confirm') is not True:
                    raise ValueError('请先确认预览')
                m.execute(body['id'])
            elif route == '/api/restore':
                if body.get('confirm') is not True:
                    raise ValueError('请确认恢复操作')
                m.restore(body['id'])
            elif route == '/api/compare':
                name = body['snapshot']
                if Path(name).name != name or not name.startswith('scan-') or not name.endswith('.json'):
                    raise ValueError('无效快照')
                old = json.loads((m.reports / name).read_text(encoding='utf-8'))
                return self.reply(audit.compare(m.data, old))
            elif route == '/api/open':
                p = no_links(body['path'])
                windows_integration.reveal(p)
                m.queue_change(str(p))
            elif route == '/api/system':
                actions = {'storage': 'ms-settings:storagesense', 'apps': 'ms-settings:appsfeatures', 'recycle': 'shell:RecycleBinFolder'}
                if body['action'] == 'cleanup':
                    subprocess.Popen(['cleanmgr.exe', '/d', 'C:'])
                elif body['action'] in actions:
                    os.startfile(actions[body['action']])
                else:
                    raise ValueError('未知系统入口')
            else:
                return self.reply({'error': '接口不存在'}, 404)
            self.reply({'ok': True})
        except (ValueError, OSError, KeyError, TypeError) as exc:
            self.reply({'error': str(exc)}, 400)


def make_server(port=8765, manager=None):
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.token = secrets.token_urlsafe(32)
    server.manager = manager or Manager()
    return server


def main():
    parser = argparse.ArgumentParser(description='Spacewell 本地磁盘管理')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    server = make_server(args.port)
    server.manager.start_monitor()
    url = f'http://127.0.0.1:{server.server_port}'
    print(f'Spacewell ready: {url}', flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.manager.cancel.set()
    finally:
        server.manager.stop_monitor()
        server.server_close()


if __name__ == '__main__':
    main()
