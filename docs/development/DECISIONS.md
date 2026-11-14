# mcpclaude — Technical Decisions

Each entry records a decision, the alternatives considered and why. Entries are appended as
the project evolves; superseded decisions are marked rather than deleted.

## D1 — TypeScript on Node.js (≥ 22), distributed as an npm CLI

- The official MCP SDK is most complete in TypeScript, ngrok ships an embeddable Node SDK,
  and `npm install -g` gives the `mcpclaude` command with no extra packaging.
- Alternatives: Python (official MCP SDK, good macOS bindings through PyObjC, but needs a
  managed virtualenv and native wheels); Swift (best macOS access, but no official MCP SDK
  with Streamable HTTP parity and a much longer path to a working server).

## D2 — MCP SDK v2 with the stateless HTTP handler

- `@modelcontextprotocol/server` 2.x implements the 2026-07-28 revision (no sessions, no
  `initialize` handshake) and `createMcpHandler` also serves 2025-era clients statelessly
  from the same factory. One endpoint covers both generations of clients.
- Consequence: no per-session state. Everything that must survive between calls (working
  directory, background processes, transfer links) lives in the process-wide Runtime and is
  addressed with explicit handles (`process_id`, link ids), which is also what the 2026
  revision recommends.
- The deprecated HTTP+SSE transport (2024-11-05) is not served.

## D3 — Embedded ngrok SDK (`@ngrok/ngrok`) for the tunnel

- The SDK embeds the ngrok agent, so users do not have to install or configure the ngrok CLI;
  only an authtoken is required. The token is taken from `--ngrok-authtoken`,
  `NGROK_AUTHTOKEN`, mcpclaude's config, or an existing ngrok CLI config file, and otherwise
  asked for once in the wizard.
- The tunnel sits behind a small `TunnelProvider` interface so tests can use a fake, and so
  `--no-tunnel` / `--public-url` can support other tunnels or local use.

## D4 — Authentication: access token by default, explicit no-auth, no OAuth

- **Token mode (default).** A 256-bit random token is generated once and stored in the config
  file. Clients send it as `Authorization: Bearer <token>`. Because several hosted clients
  only let the user paste a URL, the same token is also accepted as a path segment:
  `https://<host>/mcp/<token>`. That URL is the "unique connection URL" printed by the CLI.
- **No-auth mode.** Only when started with `--no-auth` (or the saved equivalent) and
  confirmed. The CLI prints a prominent warning because anyone who learns the URL can use the
  server.
- **OAuth 2.1** is deliberately out of scope: the brief asks for access tokens, and a local
  authorization server (dynamic registration, PKCE, consent page) would add a large attack
  surface for little gain in a single-user tool.
- Hardening that applies in both modes: the HTTP server binds to loopback only; requests with
  a browser `Origin` that is not the tunnel/localhost are rejected; failed token attempts are
  throttled; tokens never appear in logs.

## D5 — Setup gate

The brief orders the wizard as connection → directory → permission level, so the public URL
exists before the permission level is known. Until the wizard completes, the endpoint is
reachable (so a provider can register the connector) but every tool call is refused with a
`SETUP_PENDING` error. Nothing can run before the user has chosen a directory and a mode.

## D6 — Permission modes and OS-level sandboxing

- Path checks in the file tools are necessary but not sufficient: a shell command can read
  or write anything the user can. Project-Only mode therefore runs every command under
  macOS **Seatbelt** (`sandbox-exec`) with a generated profile (writes only inside the
  project and temp directories; reads of user data outside the project denied).
- `sandbox-exec` is deprecated by Apple but still shipped and used by comparable agent tools
  for the same purpose. If it is missing or fails on macOS, Project-Only mode refuses to run
  commands instead of running them unconfined.
- GUI control cannot be confined to a directory, so desktop tools exist only in Full System
  Access mode.
- On non-macOS hosts (development only) there is no OS sandbox; commands are limited by
  working directory and path checks only, and `server_info` says so.

## D7 — Desktop driver: `screencapture` + `sips` + a compiled Swift helper

- Screenshots use Apple's own `screencapture` tool: it tracks macOS changes to screen-capture
  APIs (the CoreGraphics capture functions are unavailable in recent SDKs) and needs no
  compilation. Scaling and JPEG/PNG encoding use `sips`.
- Input injection, window management and UI inspection need CoreGraphics events and the
  Accessibility API. A Swift command-line helper gives typed, fast, complete access to both.
  It is compiled with `swiftc` on first use (Xcode Command Line Tools) and cached.
- Alternatives: JXA/AppleScript only (no compile step, but slow, weak Accessibility access
  and fragile C-function bridging); third-party native Node modules (prebuilt binaries of
  uncertain maintenance, no Accessibility tree); Python + PyObjC (extra runtime).

## D8 — One coordinate space for agents

Agents see and send coordinates in the pixel grid of the full-display screenshot the server
returns (long edge ≤ 1280 px by default, so providers do not rescale it). The server converts
to macOS points per display. Window bounds and UI element frames are reported in the same
space. Zoomed region screenshots include the mapping back to that space.

## D9 — Granular tools plus one batch tool

Mouse, keyboard and screenshot actions are separate tools with exact schemas, which every
model family handles well. `computer_actions` runs a list of the same actions in one call to
cut round trips in multi-step workflows. Action tools return a fresh screenshot by default.

## D10 — Unified execution engine with background hand-off

`run_command` does not kill a command that outlives its wait time; it hands back a
`process_id`. Agents frequently misjudge durations (installs, renders), and killing work that
is nearly finished wastes more than it protects. Explicit `stop_process` is always available.

## D11 — File transfer: inline for small files, one-time HTTP links for large ones

Base64 through a model's context is impractical beyond a few hundred kilobytes. For anything
larger the server issues short-lived, single-purpose URLs on the same tunnel
(`create_download_link`, `create_upload_link`) that a cloud sandbox can use with `curl`.
Links are unguessable, expire, are confined by the same path policy, and can only be minted
through an authenticated tool call.

## D12 — Creative applications through their scripting interfaces first

GUI automation is the fallback, not the default: After Effects is driven with ExtendScript
through AppleScript and `aerender`; Blender with Python, headless or through a bridge loaded
into the GUI session. Both are combined with screenshots and input tools when a task needs
the interface itself.

## D13 — Verification on macOS runners

The development machine is Linux. Everything macOS-specific is exercised in GitHub Actions on
hosted macOS runners (the repository is public, so these minutes are free). Tasks in PLAN.md
are only ticked when the corresponding check has actually passed there or locally.
