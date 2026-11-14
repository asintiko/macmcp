"""mcpclaude bridge for Blender.

Loaded by Blender through ``--python``. It runs Python code on behalf of an mcpclaude tool and
reports what happened as JSON: captured output, the value of the code, or the traceback.

Two modes, chosen by the arguments after ``--``:

``--mcpclaude-exec REQUEST.json``
    Run one piece of code (headless runs), write the response to the file named in the
    request and return.

``--mcpclaude-serve SESSION.json``
    Stay available inside a running Blender (GUI sessions). The bridge listens on a loopback
    TCP port, writes the port and a random access token to SESSION.json (readable by the user
    only), and executes each request on Blender's main thread from an application timer.

Wire format in serve mode: one JSON object per line in each direction, one request per
connection: ``{"token": "...", "op": "exec", "code": "...", "args": [...], "undo": true}`` or
``{"token": "...", "op": "ping"}``.
"""

import ast
import atexit
import contextlib
import hmac
import io
import json
import linecache
import math
import os
import queue
import secrets
import socket
import sys
import threading
import time
import traceback

import bpy
import mathutils

BRIDGE_VERSION = 1
_SEQUENCES = (mathutils.Vector, mathutils.Color, mathutils.Euler, mathutils.Quaternion, mathutils.Matrix)
CODE_NAME = "<mcpclaude>"
MAX_OUTPUT_CHARS = 400_000
MAX_ITEMS = 5000


def _plain(value, depth=0):
    """Convert a Python or Blender value into something JSON can carry."""
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else repr(value)
    if depth > 8:
        return repr(value)
    if isinstance(value, dict):
        return {str(key): _plain(item, depth + 1) for key, item in list(value.items())[:MAX_ITEMS]}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_plain(item, depth + 1) for item in list(value)[:MAX_ITEMS]]
    if isinstance(value, bytes):
        return repr(value)
    if isinstance(value, bpy.types.ID):
        return {"type": type(value).__name__, "name": value.name}
    # Vectors, colours, rotations, matrices, property arrays and collections are sequences.
    if isinstance(value, _SEQUENCES) or type(value).__name__ in ("bpy_prop_array", "bpy_prop_collection"):
        try:
            return [_plain(item, depth + 1) for item in list(value)[:MAX_ITEMS]]
        except Exception:
            return repr(value)
    return repr(value)


def _clip(text):
    if len(text) <= MAX_OUTPUT_CHARS:
        return text
    half = MAX_OUTPUT_CHARS // 2
    return text[:half] + "\n… [%d characters left out] …\n" % (len(text) - MAX_OUTPUT_CHARS) + text[-half:]


def _user_traceback(error):
    """The traceback as the author of the code would see it: without the bridge's own frames."""
    frames = error.__traceback__
    while frames is not None and frames.tb_frame.f_code.co_filename != CODE_NAME:
        frames = frames.tb_next
    if frames is None:
        return "".join(traceback.format_exception_only(type(error), error))
    return "".join(traceback.format_exception(type(error), error, frames))


def _interface_context():
    """A window and 3D viewport for operators that need one; timers run without any."""
    manager = getattr(bpy.context, "window_manager", None)
    if bpy.app.background or manager is None or bpy.context.area is not None:
        return {}
    for window in manager.windows:
        override = {"window": window, "screen": window.screen}
        for area in window.screen.areas:
            if area.type == "VIEW_3D":
                override["area"] = area
                for region in area.regions:
                    if region.type == "WINDOW":
                        override["region"] = region
                        break
                break
        return override
    return {}


def run_code(source, args=()):
    """Execute `source` and describe the outcome.

    The value reported is the variable ``result`` if the code sets one, otherwise the value of
    its last statement when that is an expression (as in an interactive console).
    """
    started = time.time()
    output = io.StringIO()
    response = {"ok": True, "result": None}
    namespace = {"__name__": "__main__", "__file__": CODE_NAME, "bpy": bpy, "args": list(args)}
    linecache.cache[CODE_NAME] = (len(source), None, source.splitlines(True), CODE_NAME)
    try:
        tree = ast.parse(source, filename=CODE_NAME, mode="exec")
        last = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = ast.Expression(tree.body.pop().value)
        body = compile(tree, CODE_NAME, "exec")
        tail = compile(last, CODE_NAME, "eval") if last is not None else None
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            override = _interface_context()
            with bpy.context.temp_override(**override) if override else contextlib.nullcontext():
                exec(body, namespace)
                value = eval(tail, namespace) if tail is not None else None
        response["result"] = _plain(namespace["result"] if "result" in namespace else value)
    except SystemExit as stop:
        # sys.exit() in a script must not take Blender down with it.
        response["result"] = None
        if stop.code not in (None, 0):
            response = {"ok": False, "error": "SystemExit: %r" % (stop.code,), "traceback": ""}
    except BaseException as error:  # noqa: BLE001 - everything is reported to the caller
        response = {"ok": False, "error": "%s: %s" % (type(error).__name__, error), "traceback": _user_traceback(error)}
    response["stdout"] = _clip(output.getvalue())
    response["seconds"] = round(time.time() - started, 3)
    response["blender_version"] = bpy.app.version_string
    response["file"] = bpy.data.filepath
    return response


# ── One-shot execution (headless) ───────────────────────────────────────────────────────────


def execute_request(request_path):
    with open(request_path, "r", encoding="utf-8") as handle:
        request = json.load(handle)
    with open(request["code_file"], "r", encoding="utf-8") as handle:
        source = handle.read()
    response = run_code(source, request.get("args") or [])
    if response["ok"] and request.get("save"):
        try:
            if bpy.data.filepath:
                bpy.ops.wm.save_mainfile()
            elif request.get("save_as"):
                bpy.ops.wm.save_as_mainfile(filepath=request["save_as"])
            response["saved"] = bpy.data.filepath
        except Exception as error:  # noqa: BLE001
            response = {**response, "ok": False, "error": "Saving failed: %s" % error, "traceback": ""}
    partial = request["result_file"] + ".partial"
    with open(partial, "w", encoding="utf-8") as handle:
        json.dump(response, handle)
    os.replace(partial, request["result_file"])


# ── Live sessions ───────────────────────────────────────────────────────────────────────────


class Bridge:
    def __init__(self, session_path):
        self.session_path = session_path
        self.token = secrets.token_hex(24)
        self.requests = queue.Queue()
        self.busy = False
        self.served = 0
        self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(8)
        self.port = self.server.getsockname()[1]

    def start(self):
        threading.Thread(target=self._accept, name="mcpclaude-bridge", daemon=True).start()
        bpy.app.timers.register(self._tick, first_interval=0.1, persistent=True)
        self._write_session()
        atexit.register(self._forget_session)

    def _write_session(self):
        session = {
            "bridge": BRIDGE_VERSION,
            "pid": os.getpid(),
            "port": self.port,
            "token": self.token,
            "blender_version": bpy.app.version_string,
            "started": time.time(),
        }
        partial = self.session_path + ".partial"
        handle = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(session, stream)
        os.replace(partial, self.session_path)

    def _forget_session(self):
        try:
            with open(self.session_path, "r", encoding="utf-8") as handle:
                if json.load(handle).get("pid") == os.getpid():
                    os.remove(self.session_path)
        except Exception:  # noqa: BLE001
            pass

    # Network thread: read requests, answer pings, queue everything else for the main thread.
    def _accept(self):
        while True:
            try:
                connection, _address = self.server.accept()
            except OSError:
                return
            threading.Thread(target=self._receive, args=(connection,), daemon=True).start()

    def _receive(self, connection):
        try:
            connection.settimeout(30)
            data = b""
            while not data.endswith(b"\n"):
                chunk = connection.recv(65536)
                if not chunk:
                    break
                data += chunk
                if len(data) > 64 * 1024 * 1024:
                    raise ValueError("request too large")
            request = json.loads(data.decode("utf-8"))
            if not isinstance(request, dict) or not hmac.compare_digest(str(request.get("token", "")), self.token):
                self._send(connection, {"ok": False, "error": "Access token rejected", "traceback": ""})
                return
            if request.get("op") == "ping":
                self._send(connection, {"ok": True, "pong": True, "pid": os.getpid(), "busy": self.busy, "served": self.served, "blender_version": bpy.app.version_string})
                return
            connection.settimeout(None)
            self.requests.put((request, connection))
        except Exception as error:  # noqa: BLE001
            self._send(connection, {"ok": False, "error": "Bad request: %s" % error, "traceback": ""})

    @staticmethod
    def _send(connection, response):
        try:
            connection.sendall(json.dumps(response).encode("utf-8") + b"\n")
        except OSError:
            pass
        finally:
            try:
                connection.close()
            except OSError:
                pass

    # Main thread: Blender's data may only be touched from here.
    def _tick(self):
        try:
            request, connection = self.requests.get_nowait()
        except queue.Empty:
            return 0.05
        self.busy = True
        try:
            response = run_code(str(request.get("code", "")), request.get("args") or [])
        except BaseException as error:  # noqa: BLE001
            response = {"ok": False, "error": "%s: %s" % (type(error).__name__, error), "traceback": traceback.format_exc()}
        finally:
            self.busy = False
            self.served += 1
        if request.get("undo", True):
            # One undo step per request: the user can take the change back with Ctrl+Z, and
            # Blender knows the file has unsaved changes.
            try:
                override = _interface_context()
                with bpy.context.temp_override(**override) if override else contextlib.nullcontext():
                    bpy.ops.ed.undo_push(message="mcpclaude: Python")
            except Exception:  # noqa: BLE001
                pass
        self._send(connection, response)
        return 0.0


def main():
    arguments = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    if len(arguments) >= 2 and arguments[0] == "--mcpclaude-exec":
        execute_request(arguments[1])
    elif len(arguments) >= 2 and arguments[0] == "--mcpclaude-serve":
        Bridge(arguments[1]).start()
    else:
        print("mcpclaude_bridge.py: expected --mcpclaude-exec REQUEST.json or --mcpclaude-serve SESSION.json after --")


main()
