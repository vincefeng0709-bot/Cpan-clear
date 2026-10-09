"""Small Windows shell and directory-notification adapters (no shell commands)."""
import ctypes
from ctypes import wintypes
from pathlib import Path
import struct
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
                    self.failed(str(self.root), '目录通知中断或缓冲区溢出，需要重新核对扫描范围')
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


def recycle(path):
    """Request Windows recycle semantics; never retry as permanent deletion."""
    import os
    import subprocess
    script = r"""
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Microsoft.VisualBasic
$p = $env:SPACEWELL_RECYCLE_PATH
try {
 if ([System.IO.Directory]::Exists($p)) {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin', 'ThrowException')
 } else {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin', 'ThrowException')
 }
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
"""
    env = os.environ.copy()
    env['SPACEWELL_RECYCLE_PATH'] = str(path)
    result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
                            env=env, capture_output=True, creationflags=0x08000000)
    if result.returncode or Path(path).exists():
        raise OSError('移入回收站失败或已取消；请检查文件占用、权限和回收站状态')
