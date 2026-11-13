#!/usr/bin/env python3
"""Start the UI on a private X display and D-Bus, never the user's session."""
import ctypes
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def has_window(title):
    x11 = ctypes.CDLL("libX11.so.6")
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    x11.XDefaultRootWindow.restype = ctypes.c_ulong
    x11.XQueryTree.argtypes = [ctypes.c_void_p, ctypes.c_ulong,
                             ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong),
                             ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong)), ctypes.POINTER(ctypes.c_uint)]
    x11.XFetchName.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_char_p)]
    x11.XFree.argtypes = [ctypes.c_void_p]
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    display = x11.XOpenDisplay(None)
    if not display:
        return False
    root, parent = ctypes.c_ulong(), ctypes.c_ulong()
    children, count = ctypes.POINTER(ctypes.c_ulong)(), ctypes.c_uint()
    found = False
    try:
        x11.XQueryTree(display, x11.XDefaultRootWindow(display), ctypes.byref(root),
                       ctypes.byref(parent), ctypes.byref(children), ctypes.byref(count))
        for i in range(count.value):
            name = ctypes.c_char_p()
            if x11.XFetchName(display, children[i], ctypes.byref(name)) and name.value:
                found |= title.encode() in name.value
                x11.XFree(name)
        if children:
            x11.XFree(children)
    finally:
        x11.XCloseDisplay(display)
    return found


def main():
    # The outer invocation establishes isolated X and D-Bus servers.
    if len(sys.argv) == 1:
        subprocess.run(["dbus-run-session", "--", "xvfb-run", "-a", "python3", __file__, "--inside"], check=True)
        return
    home = Path(".build-home/ui-smoke").resolve()
    (home / ".rewindos").mkdir(parents=True, exist_ok=True)
    (home / ".rewindos/config.toml").write_text(
        "[capture]\nenabled = false\n[privacy]\nusage_heartbeat = false\n"
    )
    env = dict(os.environ, HOME=str(home), XDG_CONFIG_HOME=str(home / ".config"),
               XDG_DATA_HOME=str(home / ".local/share"), XDG_CACHE_HOME=str(home / ".cache"),
               GDK_BACKEND="x11", LIBGL_ALWAYS_SOFTWARE="1")
    with open(home / "ui.log", "w") as log:
        app = subprocess.Popen([os.environ.get("REWINDOS_SMOKE_BINARY", "target/release/rewindos")], env=env, stdout=log,
                               stderr=subprocess.STDOUT, start_new_session=True)
        try:
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if app.poll() is not None:
                    raise RuntimeError(f"UI exited with {app.returncode}: {(home / 'ui.log').read_text()}")
                if has_window("RewindOS"):
                    time.sleep(10)
                    if app.poll() is not None:
                        raise RuntimeError(f"UI exited after window creation: {(home / 'ui.log').read_text()}")
                    print("UI smoke passed: RewindOS window created and stayed alive for 10 seconds")
                    return
                time.sleep(0.5)
            raise RuntimeError(f"No RewindOS window: {(home / 'ui.log').read_text()}")
        finally:
            if app.poll() is None:
                os.killpg(app.pid, signal.SIGTERM)
                try:
                    app.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(app.pid, signal.SIGKILL)
                    app.wait()


if __name__ == "__main__":
    main()
