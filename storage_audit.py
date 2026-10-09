"""Read-only Windows storage inventory. Python standard library only."""
from __future__ import annotations

import argparse
import ctypes
import heapq
import json
import os
from pathlib import Path
import shutil
import stat
import time
from datetime import datetime, timezone

VERSION = 1
GIB = 1024 ** 3
REPARSE = 0x400
OFFLINE = 0x1000
RECALL = 0x400000 | 0x40000


def modified_time(timestamp):
    # Some bundled files carry epoch/pre-epoch timestamps unsupported by Windows localtime.
    try:
        return datetime.fromtimestamp(timestamp, timezone.utc).isoformat(timespec="seconds")
    except (OSError, OverflowError, ValueError):
        return "时间不可解析"


def key(path):
    return os.path.normcase(os.path.abspath(path))


def within(path, parent):
    try:
        return os.path.commonpath([key(path), key(parent)]) == key(parent)
    except ValueError:
        return False


def fixed_drives():
    if os.name != "nt":
        return [os.path.abspath(os.sep)]
    return [f"{letter}:\\" for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
            if ctypes.windll.kernel32.GetDriveTypeW(f"{letter}:\\") == 3]


def normalize_roots(roots):
    result = []
    for root in sorted({key(p) for p in roots}, key=lambda p: (len(p), p)):
        if not os.path.isdir(root):
            raise ValueError(f"目录不存在或不可访问：{root}")
        # Reject linked ancestors too, so an explicit root cannot bypass traversal rules.
        for part in [Path(root), *Path(root).parents]:
            info = part.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & REPARSE:
                raise ValueError(f"扫描根目录不能经过链接或重解析点：{part}")
        if not any(within(root, p) for p in result):
            result.append(root)
    return result


def scan(roots, excluded=(), top=200, progress=None, cancel=None):
    started = datetime.now().astimezone().isoformat(timespec="seconds")
    records, largest, issues = {}, [], []
    issue_counts = {}
    files = 0
    tick = time.monotonic()

    def issue(path, kind, detail=""):
        issue_counts[kind] = issue_counts.get(kind, 0) + 1
        if len(issues) < 300:
            issues.append({"path": path, "kind": kind, "detail": detail})

    stack = [(p, None) for p in roots]
    while stack:
        if cancel and cancel.is_set():
            raise InterruptedError("扫描已取消，保留上次完整结果")
        path, parent = stack.pop()
        row = {"path": path, "parent": parent, "bytes": 0, "files": 0,
               "direct_bytes": 0, "old_bytes": 0, "incomplete": 0}
        records[path] = row
        try:
            # Recheck at visit time; don't descend into a link replaced during scan.
            info = os.stat(path, follow_symlinks=False)
            if getattr(info, "st_file_attributes", 0) & (REPARSE | OFFLINE | RECALL) or stat.S_ISLNK(info.st_mode):
                row["incomplete"] += 1
                issue(path, "link_or_cloud")
                continue
            with os.scandir(path) as entries:
                for entry in entries:
                    if any(within(entry.path, p) for p in excluded):
                        issue(entry.path, "excluded")
                        row["incomplete"] += 1
                        continue
                    try:
                        s = entry.stat(follow_symlinks=False)
                        attrs = getattr(s, "st_file_attributes", 0)
                        if attrs & (REPARSE | OFFLINE | RECALL) or stat.S_ISLNK(s.st_mode):
                            issue(entry.path, "link_or_cloud")
                            row["incomplete"] += 1
                            continue
                        if stat.S_ISDIR(s.st_mode):
                            stack.append((entry.path, path))
                        elif stat.S_ISREG(s.st_mode):
                            row["bytes"] += s.st_size
                            row["direct_bytes"] += s.st_size
                            row["files"] += 1
                            files += 1
                            if s.st_mtime < time.time() - 30 * 86400:
                                row["old_bytes"] += s.st_size
                            item = (s.st_size, entry.path, s.st_mtime)
                            if len(largest) < top:
                                heapq.heappush(largest, item)
                            elif item > largest[0]:
                                heapq.heapreplace(largest, item)
                    except OSError as exc:
                        issue(entry.path, "unreadable", str(exc))
                        row["incomplete"] += 1
        except OSError as exc:
            issue(path, "unreadable", str(exc))
            row["incomplete"] += 1
        if time.monotonic() - tick > 10:
            print(f"Scanned {files:,} files / {len(records):,} directories: {path}", flush=True)
            tick = time.monotonic()
        if progress:
            progress(files, len(records), path)
    # DFS inserts a parent before every descendant; reverse insertion order aggregates safely.
    for row in reversed(list(records.values())):
        if row["parent"] in records:
            parent = records[row["parent"]]
            for field in ("bytes", "files", "old_bytes", "incomplete"):
                parent[field] += row[field]
    volumes = []
    for drive in fixed_drives():
        try:
            usage = shutil.disk_usage(drive)
            volumes.append({"path": drive, "total": usage.total, "used": usage.used, "free": usage.free})
        except OSError as exc:
            issue(drive, "volume_unreadable", str(exc))
    return {"version": VERSION, "started": started,
            "finished": datetime.now().astimezone().isoformat(timespec="seconds"),
            "roots": roots, "volumes": volumes, "files_scanned": files,
            "directories": list(records.values()), "issue_counts": issue_counts, "issues": issues,
            "largest": [{"bytes": n, "path": p, "modified": modified_time(t)}
                        for n, p, t in sorted(largest, reverse=True)]}


def recommendations(data):
    home = Path.home()
    local = home / "AppData" / "Local"
    codex = Path(os.environ.get("CODEX_HOME", str(home / ".codex")))
    rules = []

    def rule(path, category, action):
        rules.append((key(path), category, action))

    for p in [local / "pip" / "Cache", local / "uv" / "cache", local / "npm-cache", home / ".cache" / "pip"]:
        rule(p, "缓存候选", "先确认对应包管理器使用此缓存，停止安装任务后通过其缓存管理命令清理；后续可能重新下载。目录大小不是保证可释放空间。")
    rule(local / "Temp", "临时文件候选", "优先使用 Windows 设置 → 系统 → 存储 → 临时文件。关闭应用后逐项核对，跳过占用中文件；不要把整个目录全删。30 天未修改仅为筛选线索。")
    for name in ["Downloads", "Desktop", "Documents", "Pictures", "Videos", "Music"]:
        rule(home / name, "迁移候选", "核对个人资料后复制到目标盘，验证文件数量、大小和重要文件内容，再切换保存位置；系统用户文件夹优先使用属性 → 位置。已同步目录需先检查同步设置。")
    rule(home / ".ollama" / "models", "迁移候选", "模型可能可重新下载；先核对使用中的模型和软件支持的数据目录设置，迁移后验证加载。不直接删除整个应用目录。")
    rule(home / ".cache" / "huggingface", "迁移候选", "模型/数据集缓存：先核对项目依赖与离线使用需求，再使用 Hugging Face 的缓存管理与路径配置。")
    rule(codex, "保留 / 专项迁移", "含会话、认证、数据库、插件与产物，不可整目录清空。官方 CODEX_HOME 配置不等于已验证 Windows 桌面版完整迁移；需退出应用、备份并验证后再规划。")
    rule(codex / "plugins", "应用管理", "插件及运行依赖可能较大；优先在 Codex 中卸载不使用的插件。名为 cache 的目录也可能是当前运行组件，不能一概删除。")
    rule(codex / "worktrees", "应用管理", "逐个检查未提交代码和未跟踪文件，再从 Codex 管理工作树。直接删目录可能丢失代码。")
    rule(codex / "sessions", "保留", "聊天会话记录，非普通缓存；不要直接删除。")
    rule(codex / "archived_sessions", "保留", "归档会话仍是历史数据，归档不等于可丢弃。")
    rule(codex / "visualizations", "迁移候选", "生成的本地成果；迁移可能让原聊天文件链接失效。先逐项导出并确认引用关系。")
    rule(home / ".cache" / "codex-runtimes", "应用管理", "Codex 工具运行环境，可能被文档、浏览器或其他工具使用。需核对当前版本的管理方式，不能仅因目录名含 cache 就删除。")
    rule(local / "OpenAI" / "Codex", "应用管理", "Codex 相关组件或数据，先核对子目录用途及应用依赖。不要直接整体移动或清空。")
    rule(home / "AppData" / "Roaming" / "Codex", "应用管理", "可能包含桌面应用配置和浏览器状态，先细分数据类型；不要直接清空。")
    for row in data["directories"]:
        p = Path(row["path"])
        if p.parent == local / "Packages" and "openai.codex" in p.name.lower():
            rule(p, "应用管理", "Codex Windows 应用包数据。需细分缓存、运行环境和持久状态，不能整包删除或手动搬走。")
        elif p.parent == local / "Packages" and p.name.lower().startswith("claude_"):
            rule(p, "应用管理", "Claude 应用包可能包含虚拟机、运行环境及用户状态；虚拟磁盘不是普通缓存。请通过应用支持的存储管理、卸载或重装处理，先保留所需成果。")
    result = []
    lookup = {path: (category, action) for path, category, action in rules}
    for row in data["directories"]:
        matched = lookup.get(key(row["path"]))
        if matched and row["bytes"]:
            result.append(dict(row, category=matched[0], action=matched[1]))
    system_root = Path(os.environ.get("SystemRoot", "C:\\Windows"))
    file_rules = {
        key(system_root / "MEMORY.DMP"): ("可清理候选 / 需确认", "系统崩溃转储。若不再用于蓝屏排查，可通过 Windows 磁盘清理的系统错误内存转储选项处理；如正在排查，先另盘备份。"),
        key(Path(system_root.anchor) / "pagefile.sys"): ("系统管理 / 不直接删除", "分页文件，参与虚拟内存和崩溃转储。不要手动删除或为腾空间直接禁用；调整需结合内存、负载及转储需求。"),
        key(Path(system_root.anchor) / "hiberfil.sys"): ("系统管理 / 不直接删除", "休眠相关系统文件。只有明确不需要相关功能后，才考虑通过 Windows 电源配置调整；不手动删除。"),
    }
    for row in data["largest"]:
        matched = file_rules.get(key(row["path"]))
        if matched:
            result.append(dict(row, old_bytes=0, incomplete=0, kind="file", category=matched[0], action=matched[1]))
    return sorted(result, key=lambda r: r["bytes"], reverse=True)


def compare(current, previous):
    if previous.get("version") != VERSION or sorted(current["roots"]) != sorted(previous.get("roots", [])):
        return {"message": "扫描范围或版本不同，不比较目录增长。", "rows": []}
    old = {key(r["path"]): r for r in previous["directories"]}
    changes = []
    for r in current["directories"]:
        before = old.get(key(r["path"]))
        if before and not r["incomplete"] and not before["incomplete"] and r["bytes"] != before["bytes"]:
            changes.append({"path": r["path"], "delta": r["bytes"] - before["bytes"]})
    return {"message": "仅比较两次都完整读取的同名目录；父子目录重叠，变化量不可相加。新增/消失目录不单独计入。",
            "rows": sorted(changes, key=lambda r: abs(r["delta"]), reverse=True)[:100]}


def write_report(data, output):
    template = Path(__file__).with_name("report.html").read_text(encoding="utf-8")
    # Store all directory metadata in JSON; keep offline HTML small and responsive.
    view = dict(data)
    view["directory_count"] = len(data["directories"])
    view["directories"] = sorted(data["directories"], key=lambda r: r["bytes"], reverse=True)[:3000]
    payload = json.dumps(view, ensure_ascii=False).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    output.write_text(template.replace("/*REPORT_DATA*/null", payload), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description="本地磁盘只读分析；不删除、不迁移、不读取文件内容。")
    parser.add_argument("--roots", nargs="+", help="扫描目录，默认 C 盘；重叠目录自动合并")
    parser.add_argument("--all", action="store_true", help="扫描全部固定磁盘，可能耗时较长")
    parser.add_argument("--output", type=Path, default=Path(__file__).parent / "reports")
    parser.add_argument("--compare", type=Path, help="与上次 scan-*.json 比较")
    args = parser.parse_args()
    if args.all and args.roots:
        parser.error("--all 与 --roots 不能同时使用")
    try:
        roots = normalize_roots(fixed_drives() if args.all else args.roots or ["C:\\"])
    except (ValueError, OSError) as exc:
        parser.error(str(exc))
    output = args.output.absolute()
    if any(within(r, output) for r in roots):
        parser.error("扫描根目录不能位于报告输出目录内")
    previous = json.loads(args.compare.read_text(encoding="utf-8")) if args.compare else None
    data = scan(roots, excluded=[str(output)])
    data["recommendations"] = recommendations(data)
    data["comparison"] = compare(data, previous) if previous else {"message": "首次扫描：没有历史基线，无法据此判断安装 Codex 前后的增长。", "rows": []}
    output.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    snapshot = output / f"scan-{stamp}.json"
    snapshot.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    report = output / f"report-{stamp}.html"
    write_report(data, report)
    write_report(data, output / "latest.html")
    print(json.dumps({"snapshot": str(snapshot), "report": str(report), "files": data["files_scanned"],
                      "directories": len(data["directories"]), "issues": data["issue_counts"]}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
