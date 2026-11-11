"""Small Windows shell, recycle-bin and directory-notification adapters (no shell commands)."""
import ctypes
from ctypes import wintypes
from pathlib import Path
import os
import struct
import subprocess
import tempfile
import threading


def reveal(path):
    """Open the parent and select this exact item, including Unicode/spaces/commas."""
    shell = ctypes.WinDLL('shell32', use_last_error=True)
    ole = ctypes.WinDLL('ole32', use_last_error=True)
    ole.CoInitializeEx.argtypes = [ctypes.c_void_p, wintypes.DWORD]
    ole.CoInitializeEx.restype = ctypes.c_long
    ole.CoTaskMemFree.argtypes = [ctypes.c_void_p]
    shell.SHParseDisplayName.argtypes = [wintypes.LPCWSTR, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p), wintypes.DWORD, ctypes.c_void_p]
    shell.SHParseDisplayName.restype = ctypes.c_long
    shell.SHOpenFolderAndSelectItems.argtypes = [ctypes.c_void_p, wintypes.UINT, ctypes.c_void_p, wintypes.DWORD]
    shell.SHOpenFolderAndSelectItems.restype = ctypes.c_long
    initialized = ole.CoInitializeEx(None, 2)
    pidl = ctypes.c_void_p()
    try:
        hr = shell.SHParseDisplayName(str(path), None, ctypes.byref(pidl), 0, None)
        if hr < 0:
            raise OSError(f'无法定位此文件（Windows 错误 {hr:#x}）')
        hr = shell.SHOpenFolderAndSelectItems(pidl, 0, None, 0)
        if hr < 0:
            raise OSError(f'资源管理器定位失败（Windows 错误 {hr:#x}）')
    finally:
        if pidl:
            ole.CoTaskMemFree(pidl)
        if initialized in (0, 1):
            ole.CoUninitialize()


class DirectoryWatch:
    def __init__(self, root, changed, failed):
        self.root, self.changed, self.failed = Path(root), changed, failed
        self.stopped = threading.Event()
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        k = self.kernel
        k.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        k.CreateFileW.restype = wintypes.HANDLE
        k.ReadDirectoryChangesW.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, wintypes.BOOL, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p, ctypes.c_void_p]
        k.ReadDirectoryChangesW.restype = wintypes.BOOL
        k.CancelIoEx.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
        k.CloseHandle.argtypes = [wintypes.HANDLE]
        self.handle = k.CreateFileW(str(root), 1, 7, None, 3, 0x02000000, None)
        if self.handle == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def run(self):
        buffer = ctypes.create_string_buffer(65536)
        received = wintypes.DWORD()
        try:
            while not self.stopped.is_set():
                ok = self.kernel.ReadDirectoryChangesW(self.handle, buffer, len(buffer), True, 1 | 2 | 8 | 16, ctypes.byref(received), None, None)
                if self.stopped.is_set():
                    break
                if not ok or not received.value:
                    self.failed(str(self.root), '目录通知中断或缓冲区溢出，正在自动重连')
                    break
                offset = 0
                while offset + 12 <= received.value:
                    following, action, size = struct.unpack_from('<III', buffer.raw, offset)
                    name = buffer.raw[offset+12:offset+12+size].decode('utf-16-le')
                    relative = Path(name)
                    if not relative.is_absolute() and '..' not in relative.parts:
                        self.changed(str(self.root / relative))
                    if not following:
                        break
                    offset += following
        finally:
            self.kernel.CloseHandle(self.handle)

    def close(self):
        self.stopped.set()
        self.kernel.CancelIoEx(self.handle, None)


def _run_powershell(script, env=None, timeout=120):
    return subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
                          env=env, capture_output=True, text=True, encoding='utf-8',
                          timeout=timeout, creationflags=0x08000000)


def recycle_many(paths):
    """Move many paths to the recycle bin with one PowerShell process.

    Paths are handed over through a UTF-8 batch file so Unicode names survive the
    console codepage. Returns (done, failed) where failed holds [path, message] pairs.
    """
    script = r"""
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName Microsoft.VisualBasic
$paths = Get-Content -LiteralPath $env:SPACEWELL_BATCH -Encoding UTF8 | Where-Object { $_ }
$done = @()
$failed = @()
foreach ($p in $paths) {
  try {
    if ([System.IO.Directory]::Exists($p)) {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin', 'ThrowException')
    } elseif ([System.IO.File]::Exists($p)) {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin', 'ThrowException')
    }
    if ([System.IO.Directory]::Exists($p) -or [System.IO.File]::Exists($p)) { throw '文件仍存在，可能被占用' }
    $done += $p
  } catch { $failed += ($p + "`t" + $_.Exception.Message) }
}
[Console]::Out.Write("DONE`n" + ($done -join "`n") + "`nFAILED`n" + ($failed -join "`n"))
"""
    fd, batch = tempfile.mkstemp(prefix='spacewell-', suffix='.paths')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8-sig') as f:
            f.write('\n'.join(str(p) for p in paths))
        env = os.environ.copy()
        env['SPACEWELL_BATCH'] = batch
        result = _run_powershell(script, env=env, timeout=120 + len(paths) * 10)
    finally:
        try:
            os.unlink(batch)
        except OSError:
            pass
    done, failed = [], []
    section = None
    for line in (result.stdout or '').splitlines():
        if line == 'DONE':
            section = done
        elif line == 'FAILED':
            section = failed
        elif section is not None and line:
            if section is failed:
                path, _, message = line.partition('\t')
                failed.append([path, message or '删除失败'])
            else:
                section.append(line)
    reported = {p for p in done} | {pair[0] for pair in failed}
    failed.extend([str(p), '进程中断，结果未知'] for p in paths if str(p) not in reported)
    return done, failed


def empty_recycle_bin():
    """Permanently clear the recycle bin for the current user."""
    result = _run_powershell("$ErrorActionPreference = 'Stop'; Clear-RecycleBin -Force", timeout=180)
    if result.returncode:
        raise OSError('清空回收站失败，请打开 Windows 回收站窗口手动重试')


def recycle_bin_info():
    """Estimate recycle bin count and size via Shell COM; returns dict or None."""
    script = r"""
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  $shell = New-Object -ComObject Shell.Application
  $bin = $shell.Namespace(0xA)
  $count = 0
  $bytes = [long]0
  if ($bin -ne $null) { foreach ($i in $bin.Items()) { $count++; $bytes += [long]$i.Size } }
  [Console]::Out.Write("OK $count $bytes")
} catch { [Console]::Out.Write("ERR " + $_.Exception.Message) }
"""
    try:
        result = _run_powershell(script, timeout=20)
        for line in (result.stdout or '').splitlines():
            if line.startswith('OK '):
                _, count, size = line.split()
                return {'count': int(count), 'bytes': int(size)}
    except (OSError, subprocess.TimeoutExpired, ValueError):
        pass
    return None
