"""Known cache/junk path catalog with risk tiers; metadata-only scanning, standard library only."""
from __future__ import annotations

from datetime import datetime, timezone
import os
from pathlib import Path
import stat
import time

REPARSE = 0x400
OFFLINE = 0x1000
RECALL = 0x400000 | 0x40000

# risk: 'safe' → 一键清理（移入回收站，可恢复）；'review' → 仅列出体积与说明，用户逐项确认。
CATALOG = [
    {'id': 'temp', 'group': '系统临时文件', 'risk': 'safe', 'name': '用户临时文件夹',
     'desc': '%TEMP% 里是安装程序和应用运行留下的临时文件，可放心清理。正在使用的文件会自动跳过。',
     'paths': ['{temp}']},
    {'id': 'windows-temp', 'group': '系统临时文件', 'risk': 'safe', 'name': '系统临时文件夹',
     'desc': 'Windows\\Temp 下的系统级临时文件；受权限保护的部分会自动跳过。',
     'paths': ['{windir}/Temp']},
    {'id': 'shader', 'group': '系统缓存', 'risk': 'safe', 'name': '显卡着色器缓存',
     'desc': 'DirectX / NVIDIA / AMD 编译后的着色器缓存。删除后游戏首次加载略慢，随后自动重建。',
     'paths': ['{local}/D3DSCache', '{local}/NVIDIA/DXCache', '{local}/AMD/DxCache', '{local}/NVIDIA Corporation/NV_Cache']},
    {'id': 'dumps', 'group': '系统缓存', 'risk': 'safe', 'name': '应用崩溃转储',
     'desc': '应用崩溃时留下的 minidump 文件。确认不再需要排查崩溃原因即可清理。',
     'paths': ['{local}/CrashDumps']},
    {'id': 'memory-dump', 'group': '系统缓存', 'risk': 'review', 'name': '系统内存转储',
     'desc': 'C:\\Windows\\MEMORY.DMP 是系统蓝屏时写下的完整内存映像，体积大。确认不再用于排查后可删除。',
     'paths': ['{windir}/MEMORY.DMP']},
    {'id': 'pip', 'group': '开发工具缓存', 'risk': 'safe', 'name': 'pip 缓存',
     'desc': 'pip 下载过的安装包副本。删除后下次安装同版本包会重新下载，不影响已装好的环境。',
     'paths': ['{local}/pip/Cache']},
    {'id': 'uv', 'group': '开发工具缓存', 'risk': 'safe', 'name': 'uv 缓存',
     'desc': 'uv 的包与 wheel 缓存，效果等同于 uv cache clean，不影响已创建的虚拟环境。',
     'paths': ['{local}/uv/cache']},
    {'id': 'npm', 'group': '开发工具缓存', 'risk': 'safe', 'name': 'npm 缓存',
     'desc': 'npm 的下载缓存（_cacache）。删除后重新安装依赖时需要重新下载，不影响现有项目。',
     'paths': ['{local}/npm-cache']},
    {'id': 'yarn', 'group': '开发工具缓存', 'risk': 'safe', 'name': 'Yarn 缓存',
     'desc': 'Yarn 的全局包缓存。删除后重新安装时需要重新下载。',
     'paths': ['{local}/Yarn/Cache']},
    {'id': 'pnpm', 'group': '开发工具缓存', 'risk': 'review', 'name': 'pnpm 内容存储',
     'desc': 'pnpm 用硬链接让所有项目共享同一份包文件；删除存储会让现有项目的 node_modules 失效。仅在了解后果时处理。',
     'paths': ['{local}/pnpm/store']},
    {'id': 'chrome', 'group': '浏览器缓存', 'risk': 'safe', 'name': 'Chrome 浏览器缓存',
     'desc': '网页图片 / 脚本缓存，不含密码、历史和书签。浏览器运行时部分文件被占用会跳过；先关闭浏览器清理更彻底。',
     'paths': ['{local}/Google/Chrome/User Data/*/Cache', '{local}/Google/Chrome/User Data/*/Code Cache', '{local}/Google/Chrome/User Data/*/GPUCache']},
    {'id': 'edge', 'group': '浏览器缓存', 'risk': 'safe', 'name': 'Edge 浏览器缓存',
     'desc': '与 Chrome 相同的网页缓存，删除后浏览器自动重建。不含收藏、密码和登录状态。',
     'paths': ['{local}/Microsoft/Edge/User Data/*/Cache', '{local}/Microsoft/Edge/User Data/*/Code Cache', '{local}/Microsoft/Edge/User Data/*/GPUCache']},
    {'id': 'firefox', 'group': '浏览器缓存', 'risk': 'safe', 'name': 'Firefox 缓存',
     'desc': 'Firefox 的 cache2 网页缓存。先关闭 Firefox 清理更彻底。',
     'paths': ['{local}/Mozilla/Firefox/Profiles/*/cache2']},
    {'id': 'models-hf', 'group': 'AI 模型缓存', 'risk': 'review', 'name': 'HuggingFace 模型缓存',
     'desc': '下载过的模型与数据集副本，重新下载耗时且体积大。确认相关项目不再使用后再处理。',
     'paths': ['{home}/.cache/huggingface']},
    {'id': 'models-ollama', 'group': 'AI 模型缓存', 'risk': 'review', 'name': 'Ollama 本地模型',
     'desc': '本地大模型文件，删除后 ollama 需要重新拉取。建议优先用 ollama rm 管理单个模型。',
     'paths': ['{home}/.ollama/models']},
]

_VARS = None


def _vars():
    global _VARS
    if _VARS is None:
        home = Path.home()
        local = Path(os.environ.get('LOCALAPPDATA', home / 'AppData' / 'Local'))
        _VARS = {
            'home': home,
            'local': local,
            'roaming': Path(os.environ.get('APPDATA', home / 'AppData' / 'Roaming')),
            'windir': Path(os.environ.get('SystemRoot', 'C:/Windows')),
            'temp': Path(os.environ.get('TEMP', str(local / 'Temp'))),
        }
    return _VARS


def _resolve(template):
    p = Path(template.format(**_vars()))
    if '*' in str(p):
        parent = p.parent
        if not parent.is_dir():
            return []
        try:
            return [x for x in parent.glob(p.name)]
        except OSError:
            return []
    return [p] if p.exists() else []


def expand_paths(entry):
    """All existing concrete paths for one catalog entry (dirs or single files)."""
    out = []
    for template in entry['paths']:
        out.extend(_resolve(template))
    return out


def category(cid):
    for entry in CATALOG:
        if entry['id'] == cid:
            return entry
    return None


def measure(path):
    """Logical size/file count of one path, skipping links and cloud placeholders."""
    p = Path(path)
    try:
        s = p.stat(follow_symlinks=False)
    except OSError:
        return {'bytes': 0, 'files': 0, 'incomplete': 1}
    if not stat.S_ISDIR(s.st_mode):
        return {'bytes': s.st_size, 'files': 1, 'incomplete': 0}
    total = files = incomplete = 0
    stack = [p]
    while stack:
        try:
            with os.scandir(stack.pop()) as it:
                for e in it:
                    try:
                        s = e.stat(follow_symlinks=False)
                        if stat.S_ISLNK(s.st_mode) or getattr(s, 'st_file_attributes', 0) & (REPARSE | OFFLINE | RECALL):
                            incomplete += 1
                        elif stat.S_ISDIR(s.st_mode):
                            stack.append(e.path)
                        elif stat.S_ISREG(s.st_mode):
                            total += s.st_size
                            files += 1
                    except OSError:
                        incomplete += 1
        except OSError:
            incomplete += 1
    return {'bytes': total, 'files': files, 'incomplete': incomplete}


def scan_junk(progress=None, cancel=None):
    """Measure every catalog category; only walks known cache paths, so it finishes in seconds."""
    categories = []
    for entry in CATALOG:
        if cancel is not None and cancel.is_set():
            raise InterruptedError('已取消')
        cat = {'id': entry['id'], 'name': entry['name'], 'group': entry['group'], 'risk': entry['risk'],
               'desc': entry['desc'], 'bytes': 0, 'files': 0, 'incomplete': 0, 'targets': []}
        for path in expand_paths(entry):
            row = measure(path)
            sample = []
            if not Path(path).is_dir():
                sample = [Path(path).name]
            else:
                try:
                    with os.scandir(path) as it:
                        sample = [e.name for e in it if not e.name.startswith('.')][:5]
                except OSError:
                    pass
            cat['targets'].append({'path': str(path), 'bytes': row['bytes'], 'files': row['files'],
                                   'file': not Path(path).is_dir(), 'sample': sample})
            cat['bytes'] += row['bytes']
            cat['files'] += row['files']
            cat['incomplete'] += row['incomplete']
            if progress:
                progress(entry['id'], str(path))
        categories.append(cat)
    return {'generated': datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds'),
            'categories': categories}
