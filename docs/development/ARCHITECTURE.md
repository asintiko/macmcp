# mcpclaude — Architecture

This document describes how mcpclaude is put together. It is kept in sync with the code; the
reasons behind the main choices are in [DECISIONS.md](DECISIONS.md).

## 1. What the system does

```
 Cloud AI agent (Claude, ChatGPT, API clients, IDE agents)
        │  MCP over Streamable HTTP (HTTPS)
        ▼
 ngrok edge  ──────────────  public URL  https://<name>.ngrok-free.app
        │  encrypted tunnel (outbound connection from the Mac)
        ▼
 ┌─────────────────────────── mcpclaude process on the Mac ───────────────────────────┐
 │  HTTP server (127.0.0.1 only)                                                       │
 │    ├─ auth gate: bearer header or token in URL path, or explicit no-auth            │
 │    ├─ /mcp        → MCP handler (2026-07-28 and 2025-era clients, stateless)        │
 │    ├─ /t/<id>     → one-time file transfer links                                    │
 │    └─ /health                                                                       │
 │  Runtime (single shared state)                                                      │
 │    ├─ permission policy: Project-Only or Full System Access                         │
 │    ├─ working directory, setup gate, pause switch                                   │
 │    ├─ process manager (foreground + background commands)                            │
 │    ├─ transfer link store                                                           │
 │    ├─ desktop driver (macOS)                                                        │
 │    └─ audit log                                                                     │
 │  Tool registry → shell, files, processes, transfer, system, apps, windows,          │
 │                  computer use, UI elements, scripting, After Effects, Blender       │
 └─────────────────────────────────────────────────────────────────────────────────────┘
        │                         │                           │
   /bin/zsh (sandbox-exec    screencapture, sips,       osascript, aerender,
   in Project-Only mode)     Swift helper (CGEvent, AX)  Blender (+ Python bridge)
```

The CLI (`mcpclaude`) owns the process: it runs the setup wizard, starts the HTTP server and
the tunnel, prints connection instructions, then shows a live activity log until the user
quits.

## 2. Source layout

```
src/
  cli/        entry point, argument parsing, wizard, directory picker, doctor, terminal UI
  config/     persisted settings and paths (~/.mcpclaude)
  server/     HTTP server, auth, MCP handler wiring, ngrok tunnel manager
  core/       runtime state, permission policy, sandbox profile, exec engine,
              process manager, transfer links, audit log, error model
  tools/      tool framework (registry) and one module per tool group
  desktop/    desktop driver interface, macOS implementation, screenshot pipeline,
              coordinate mapping, key parsing, Swift helper build/invoke
  creative/   After Effects and Blender integrations
native/helper/   Swift sources of the desktop helper (compiled on the Mac on first use)
assets/          Blender bridge script, agent usage guides
tests/           unit, integration and macOS-only suites
docs/            user and agent documentation; docs/development holds this plan
```

## 3. Request flow

1. The HTTP server accepts connections on `127.0.0.1` only. Public traffic arrives through
   the ngrok tunnel, which the same process opens with the embedded ngrok SDK.
2. The **auth gate** runs before anything else. In token mode it accepts
   `Authorization: Bearer <token>` on `/mcp`, or the token as a path segment
   (`/mcp/<token>`) for clients that can only store a URL. Comparison is constant-time and
   repeated failures are throttled. In no-auth mode (explicit opt-in) the gate is open.
3. The request is handed to the MCP SDK's stateless HTTP handler. For every request the
   handler asks a factory for a server instance; the factory registers the tools that are
   visible in the current permission mode. All state lives in the shared **Runtime**, never in
   the per-request server, so the endpoint works for both the stateless 2026-07-28 revision
   and 2025-era clients that still send `initialize`.
4. A tool call passes through one wrapper that
   - refuses the call while setup is unfinished or the server is paused,
   - checks that the tool is allowed in the current permission mode,
   - validates arguments against the tool's schema,
   - runs the handler with a context (runtime, cancellation signal, progress reporter),
   - converts results and errors into MCP tool results,
   - writes an audit record and a line in the live activity view.

## 4. Permission model

Two modes, chosen in the wizard and fixed for the lifetime of the process.

**Project-Only Access**

- File tools resolve every path (following symlinks on the deepest existing ancestor) and
  reject anything outside the project directory.
- Shell commands, scripts and background processes run under the macOS Seatbelt sandbox
  (`sandbox-exec`) with a generated profile: writes are allowed only in the project directory
  and temporary directories; reads are denied for user data outside the project (home
  directories, other volumes) while system and toolchain locations stay readable so that
  compilers and interpreters work. If the sandbox cannot be applied on macOS the command is
  refused rather than run unconfined.
- Tools that inherently reach outside the directory are not available: desktop control,
  screenshots, application and window management, AppleScript, clipboard, system process
  control, After Effects and Blender tools.

**Full System Access**

- No path restrictions, no sandbox, every tool available, no per-action confirmation. The
  process still only has the rights of the user who started it and whatever macOS privacy
  permissions (Accessibility, Screen Recording, Automation) the terminal has been granted.

Before the wizard finishes, the endpoint answers discovery and `tools/list` (so a provider
can validate the connector) but every tool call returns a "setup not finished" error.

## 5. Tool framework

Each tool is one `defineTool({...})` object:

- `name`, `title`, `group`, `access` (`any` or `full`), optional platform requirement,
- `description` with usage notes,
- `input` — a zod object schema; every parameter has a description,
- `examples` — at least one example call (rendered into the description and the docs),
- `annotations` (read-only / destructive / idempotent hints),
- `handler(args, ctx)` returning text, JSON data and/or images.

The registry is the single source of truth: the MCP server, `mcpclaude tools`, and the
generated reference in `docs/TOOLS.md` all read from it. A catalogue test fails the build if
a tool lacks a description, parameter descriptions or examples.

Errors are raised as `ToolError(code, message, hint)` and returned to the agent as MCP error
results (`isError: true`) with a stable code such as `PERMISSION_DENIED`, `NOT_FOUND`,
`INVALID_ARGUMENT`, `TIMEOUT`, `MACOS_PERMISSION_REQUIRED`.

## 6. Command execution

All commands — foreground and background — go through the **process manager**. A foreground
`run_command` is "start, then wait up to N seconds"; if the command is still running it is
left running and the result carries a `process_id` that the agent can poll, feed input to, or
stop. Output is kept in a bounded buffer with a cursor so agents can read incrementally.
Processes are started in their own process group so the whole tree can be signalled.

## 7. Desktop driver (macOS)

`DesktopDriver` is an interface; `MacDesktopDriver` implements it with:

- **`screencapture`** for pixels and **`sips`** for scaling/encoding (both ship with macOS),
- a small **Swift helper** for everything else: display geometry, cursor position, mouse and
  keyboard events (CGEvent), running applications, window management and UI elements
  (Accessibility API), menu traversal, permission checks. The helper is compiled with
  `swiftc` on first use and cached under `~/.mcpclaude/bin`.
- **`osascript`** for AppleScript/JXA.

Coordinates: agents always work in **screenshot space** — the pixel grid of the full-display
screenshot the server returns (scaled so the long edge is at most 1280 px by default). The
driver converts to and from macOS points per display. Region ("zoom") screenshots show more
detail but do not change the coordinate space.

Desktop actions are serialised through a mutex so concurrent tool calls cannot interleave
input events. Action tools can return a fresh screenshot in the same result.

The helper is a one-shot process: it reads a list of commands as JSON, runs them in order and
prints the results, stopping at the first failure. A batch (`computer_actions`) is therefore
one process, and keys or buttons it holds are released before it exits.

When Full System Access is chosen, the wizard builds the helper and asks macOS for the
Accessibility and Screen Recording permissions (`src/cli/desktop-setup.ts`); `mcpclaude
doctor` reports the same checks without prompting.

## 8. Creative applications

- **After Effects** — ExtendScript is executed through AppleScript (`DoScriptFile`) with a
  wrapper that captures the result or the exception as JSON; renders can run through
  `aerender` as background processes.
- **Blender** — Python runs either headless (`blender --background --python …`) or inside a
  running GUI session through a small bridge script that Blender loads at launch; the bridge
  executes code on Blender's main thread and returns stdout, result and traceback.

## 9. Persistence

`~/.mcpclaude/` (override with `MCPCLAUDE_HOME`):

- `config.json` (mode 0600): access token, ngrok authtoken if the user chose to save it,
  preferred port and domain, recent project directories.
- `logs/audit-YYYY-MM-DD.jsonl`: one record per tool call.
- `bin/`: compiled desktop helper, keyed by a hash of its sources.
- `tmp/`: scratch files (screenshots, scripts).

## 10. Testing strategy

- **Unit tests** (any OS): policy, sandbox profile generation, coordinate mapping, key
  parsing, config, auth, process manager, wizard logic with a scripted prompter.
- **Integration tests** (any OS): a real HTTP server driven by the official MCP client in both
  protocol eras; file, shell, process, transfer and system tools against temp directories.
- **macOS suite** (GitHub macOS runners): helper build, real screenshots, mouse/keyboard
  effects read back from the system, window and menu control, Seatbelt enforcement.
- **CLI end-to-end**: the built binary driven through a pseudo-terminal.
