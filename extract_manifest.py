import ctypes
from ctypes import wintypes

kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
LOAD_LIBRARY_AS_DATAFILE = 0x00000002
RT_MANIFEST = 24

exe = r"D:\Share\Scripts\Explore\htmlEditor\src-tauri\target\release\html-editor.exe"

kernel32.LoadLibraryExW.argtypes = [wintypes.LPCWSTR, wintypes.HANDLE, wintypes.DWORD]
kernel32.LoadLibraryExW.restype = wintypes.HMODULE
kernel32.FindResourceW.argtypes = [wintypes.HMODULE, ctypes.c_void_p, ctypes.c_void_p]
kernel32.FindResourceW.restype = ctypes.c_void_p
kernel32.LoadResource.argtypes = [wintypes.HMODULE, ctypes.c_void_p]
kernel32.LoadResource.restype = ctypes.c_void_p
kernel32.LockResource.argtypes = [ctypes.c_void_p]
kernel32.LockResource.restype = ctypes.c_void_p
kernel32.SizeofResource.argtypes = [wintypes.HMODULE, ctypes.c_void_p]
kernel32.SizeofResource.restype = wintypes.DWORD
kernel32.FreeLibrary.argtypes = [wintypes.HMODULE]
kernel32.FreeLibrary.restype = ctypes.c_int

hmod = kernel32.LoadLibraryExW(exe, None, LOAD_LIBRARY_AS_DATAFILE)
if not hmod:
    raise ctypes.WinError(ctypes.get_last_error())

res_info = kernel32.FindResourceW(hmod, 1, RT_MANIFEST)
if not res_info:
    print("NO_MANIFEST_RESOURCE (id=1)")
else:
    size = kernel32.SizeofResource(hmod, res_info)
    hres = kernel32.LoadResource(hmod, res_info)
    ptr = kernel32.LockResource(hres)
    data = ctypes.string_at(ptr, size)
    print(f"=== manifest bytes: {size} ===")
    print(f"first 16 bytes hex: {data[:16].hex()}")
    text = None
    for enc in ("utf-16", "utf-8", "utf-16-le"):
        try:
            t = data.decode(enc)
            if "<assembly" in t:
                text = t
                break
        except Exception:
            continue
    if text is None:
        text = data.decode("utf-8", errors="replace")
    print("=== EMBEDDED MANIFEST (full) ===")
    print(text)
kernel32.FreeLibrary(hmod)
