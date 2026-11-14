#!/usr/bin/env python3
"""Pseudo-terminal driver for the end-to-end CLI tests.

Starts a command on a pty and obeys JSON commands on stdin, one per line:

  {"op": "expect", "pattern": "<regex>", "timeout": 15}   wait until unread output matches
  {"op": "send", "data": "<text>"}                        type into the terminal
  {"op": "wait_exit", "timeout": 15}                      wait for the command to end
  {"op": "transcript"}                                    everything printed so far
  {"op": "kill"}

Each command is answered with one JSON line on stdout. Output is matched with ANSI escape
sequences removed; a successful match consumes the output up to its end, so a later
`expect` only sees what was printed after it.

Usage: pty_driver.py '<json array: argv>'   (terminal size from PTY_COLS / PTY_ROWS)
"""
import codecs
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[@-Z\\-_]")


def exit_code(status):
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return -os.WTERMSIG(status)
    return None


def main():
    argv = json.loads(sys.argv[1])
    cols = int(os.environ.get("PTY_COLS", "120"))
    rows = int(os.environ.get("PTY_ROWS", "50"))

    pid, fd = pty.fork()
    if pid == 0:
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        os.execvp(argv[0], argv)

    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    state = {"raw": "", "cursor": 0, "code": None, "exited": False, "eof": False}

    def plain():
        return ANSI.sub("", state["raw"])

    def reap(block=False):
        if state["exited"]:
            return
        try:
            done, status = os.waitpid(pid, 0 if block else os.WNOHANG)
        except ChildProcessError:
            state["exited"] = True
            return
        if done == pid:
            state["exited"] = True
            state["code"] = exit_code(status)

    def pump(timeout):
        """Read whatever the command printed within `timeout` seconds."""
        if state["eof"]:
            time.sleep(min(timeout, 0.05))
            reap()
            return
        ready, _, _ = select.select([fd], [], [], timeout)
        if fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b""
            if data:
                state["raw"] += decoder.decode(data)
            else:
                state["eof"] = True
        reap()

    def reply(obj):
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        command = json.loads(line)
        op = command.get("op")

        if op == "expect":
            pattern = re.compile(command["pattern"])
            deadline = time.time() + float(command.get("timeout", 15))
            while True:
                text = plain()
                match = pattern.search(text, state["cursor"])
                if match:
                    state["cursor"] = match.end()
                    reply({"ok": True, "match": match.group(0), "groups": list(match.groups())})
                    break
                if time.time() >= deadline or (state["exited"] and state["eof"]):
                    reply({
                        "ok": False,
                        "error": "exited" if state["exited"] else "timeout",
                        "exit_code": state["code"],
                        "unread": text[state["cursor"]:][-4000:],
                    })
                    break
                pump(0.05)
        elif op == "send":
            pump(0)
            os.write(fd, command["data"].encode("utf-8"))
            reply({"ok": True})
        elif op == "wait_exit":
            deadline = time.time() + float(command.get("timeout", 15))
            while not state["exited"] and time.time() < deadline:
                pump(0.05)
            # Collect what was printed on the way out.
            drain_until = time.time() + 0.5
            while not state["eof"] and time.time() < drain_until:
                pump(0.05)
            reply({"ok": state["exited"], "exit_code": state["code"], "unread": plain()[state["cursor"]:][-4000:]})
        elif op == "transcript":
            pump(0)
            reply({"ok": True, "text": plain()})
        elif op == "kill":
            if not state["exited"]:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                reap(block=True)
            reply({"ok": True})
        else:
            reply({"ok": False, "error": "unknown op"})

    if not state["exited"]:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


if __name__ == "__main__":
    main()
