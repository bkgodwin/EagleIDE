"""On-demand cumulative CPU counters; sampling history lives in the browser."""
import os
from pathlib import Path


def cpu_counters():
    if os.name == "nt":
        import ctypes
        class ProcessorTimes(ctypes.Structure):
            _fields_ = [(name, ctypes.c_longlong) for name in
                       ("idle", "kernel", "user", "dpc", "interrupt")] + [("interrupt_count", ctypes.c_ulong)]
        values = (ProcessorTimes * (os.cpu_count() or 1))()
        status = ctypes.windll.ntdll.NtQuerySystemInformation(8, ctypes.byref(values), ctypes.sizeof(values), None)
        if status != 0:
            return []
        return [{"total": v.kernel + v.user, "idle": v.idle} for v in values]
    try:
        result = []
        for line in Path("/proc/stat").read_text(encoding="ascii").splitlines():
            fields = line.split()
            if fields and fields[0].startswith("cpu") and fields[0][3:].isdigit():
                values = [int(v) for v in fields[1:9]]
                result.append({"total": sum(values), "idle": values[3] + values[4]})
        return result
    except (OSError, ValueError, IndexError):
        return []
