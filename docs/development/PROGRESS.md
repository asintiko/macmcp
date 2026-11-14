# mcpclaude — Progress Log

One entry per milestone, newest first. Each entry lists what was verified and how; the
checkboxes in [PLAN.md](PLAN.md) are only ticked on the basis of these entries.

## M4 — Desktop driver and Computer Use (2026-11-14)

- Finished the milestone that commit `5f9a82f` had left in progress: the wizard now prepares
  desktop control after Full System Access is chosen (builds the helper, asks macOS for
  Accessibility and Screen Recording, names what is missing and where to grant it),
  `mcpclaude doctor` reports the Command Line Tools, the helper and both permissions, and a
  `computer-use` usage guide is served to agents.
- Verified in CI run 43577764440 (commit `6340195`): Linux Node 22 and 24, `macos-15`
  (Swift 6.1.2) and `macos-26` (Swift 6.3.3) all green; 27 test files on macOS.
- `tests/macos/computer-use.test.ts` drives a real desktop through the MCP endpoint, 17 steps
  in order, each read back from the system: screenshots (JPEG, lossless PNG that is not one
  flat colour, enlarged region, single window), pointer position after `mouse_move`, a
  document opened in TextEdit, window moved/resized/dragged by its title bar/minimised/
  restored/closed, text typed (including capitals, symbols, accents and characters on no
  key), shortcuts, clipboard copy and paste, double- and triple-click selection, scrolling
  (scroll bar value), Accessibility search/tree/element-at/set-value/press, menu listing and
  selection, application switching, AppleScript and JXA (including control of System Events),
  a batch with held Shift, quit. Screenshots of every step are kept as a CI artifact.
- `tests/integration/tools-desktop.test.ts` (39 tests, any OS) runs the same tools against a
  fake Mac: coordinate conversion on Retina and secondary displays, helper commands sent,
  result texts, error mapping, ordering of concurrent calls, visibility per permission mode.
- Found by the real-desktop runs and fixed:
  - a control that disappears through its own action (a button closing its panel) was
    reported as "Unknown"; it is now described as it was, with a note that it is gone;
  - menu items report a stale "disabled" state until their menu is opened, so
    `select_menu_item` refused commands that were available; it now opens the menu to
    refresh the state before deciding, and closes it again if the item really is disabled;
  - modifiers held with `key_down` were not applied to the events that followed; they are
    now, and anything still held when a batch ends or fails is released;
  - the scroll bars of a text view are told apart by a new `orientation` field, and
    unlabelled controls show their subrole (`Button (CloseButton)`).
- Not verified (left open in PLAN.md): right/middle click and full-screen windows on a real
  desktop, Retina and multi-display hardware, and a Mac where the privacy permissions have
  not been granted — the hosted runners have one 1x display and grant both permissions.

## M3 — CLI, wizard and tunnel (2026-11-14)

- Implemented in commit `c413c07`: argument parsing and help, the three-step wizard, the
  ngrok tunnel manager, `doctor`, `tools`, `config` and the live activity view.
- Verified in CI run 43560026710 (commit `c413c07`) and again in 43577764440: Linux Node 22
  and 24, `macos-15`, `macos-26`. `tests/e2e/cli.test.ts` runs the compiled binary on a
  pseudo-terminal: the wizard walked with the keyboard, an agent served, pause/resume/quit,
  path validation, the Full System Access confirmation, Ctrl+C, the saved directory offered
  on the next start, and the no-auth confirmation. The real ngrok SDK is exercised up to its
  rejection of an invalid authtoken.
- Not verified: a live tunnel reachable from the internet. Neither the development
  environment nor the repository has an ngrok authtoken; `mcpclaude doctor` performs that
  round trip on a machine that has one.

## M2 — Shell, processes, files, transfer, system tools (2026-11-14)

- Implemented 33 tools on top of the M1 framework (35 with the two meta tools): `run_command`,
  `run_script`; `start_process`, `list_processes`, `read_process_output`,
  `write_process_input`, `stop_process`, `list_system_processes`, `kill_process`; twelve file
  tools; three navigation tools; six transfer tools (inline base64, one-time HTTP links on
  the tunnel, URL download/upload); `system_info`, `get_environment`, `check_tools`.
- Every tool is exercised by an integration test that drives a real HTTP server with the
  official MCP client, in Full System Access and in Project-Only mode (path refusals, symlink
  escapes, hidden tools).
- Seatbelt sandbox: the first macOS CI run (43557433946) failed — Apple's own tools (`mktemp`,
  `xcrun`, `sips`, the Swift compiler) ignore `TMPDIR` and write to the per-user Darwin temp
  and cache directories, which the profile keeps closed because every application of the user
  shares them. Fixed by pointing those tools at private sub-directories through
  `DIRHELPER_USER_DIR_SUFFIX` (the mechanism macOS uses for sandboxed apps), confirmed first
  with a probe run and then in the suite.
- Verified in CI run 43558105166 (commit `052545d`): Linux Node 22 and 24, `macos-15` and
  `macos-26` all green. On macOS 392 tests pass, including the 22 enforcement cases in
  `tests/macos/sandbox.test.ts` that run real commands under the generated profile: reads
  and writes outside the project are denied, symlinks do not escape, the project root cannot
  be removed, other applications and outside processes cannot be driven or signalled, the
  ssh agent and mcpclaude's own secrets are not exposed — while zsh/bash/sh, git, Node, npm
  install, Python, the C and Swift compilers, DNS/TLS and localhost servers keep working.
- Not a sandbox: on Linux (development only) Project-Only mode has path checks but no OS
  confinement for commands; `server_info` and the startup output say so.

## M1 — Core server (2026-11-14)

- Implemented: config store, auth gate, path policy, runtime, audit log, tool framework,
  stateless MCP endpoint, HTTP server (auth, Host/Origin checks, health, transfer-link
  routes), `server_info` and `usage_guide`. Process manager, exec helpers, Seatbelt profile
  generator and transfer-link store were written ahead of M2 because the runtime owns them.
- Verified locally (Linux, Node 24): `npm run typecheck`, `npm test` — 107 tests passing,
  including an integration suite that drives a real HTTP server with the official MCP client
  in both protocol eras (2025 `initialize` handshake and pinned `2026-07-28`): tool listing
  with schemas, calls, error mapping, progress notifications, setup gate, pause, Project-Only
  visibility and refusals, bearer/URL-token/no-auth access, throttling, Host/Origin
  rejection, audit trail.
- Symlink escapes (directory links, file links, dangling links) are covered by
  `tests/unit/permissions.test.ts`.
- macOS capability probe (run 43554506883, since removed) on `macos-26` (Swift 6.3.3) and
  `macos-15` (Swift 6.1.2): `sandbox-exec` with `-D` parameters enforces read/write denials;
  `screencapture` and `sips` work (1024×768 display at 1x); Accessibility is trusted;
  CGEvent mouse moves are honoured (cursor read back at the posted position); AX window
  queries and System Events menu listing work; `open -a TextEdit` works. Apple events sent
  straight to TextEdit time out (no TCC grant on the runner), so CI reads text back through
  Accessibility instead.
- Added `tests/macos/sandbox.test.ts`: 20 enforcement cases that run real commands under the
  generated profile on the macOS runners (result recorded under M2).

## M0 — Planning and scaffolding (2026-11-14)

- Requirements analysed and mapped to milestones in PLAN.md; architecture and decisions
  written.
- Scaffold: TypeScript 7, Vitest 5, MCP SDK v2 (`@modelcontextprotocol/server` 2.4), ngrok SDK
  1.8.
- Verified locally: `npm run typecheck`, `npm run build`, `npm test`.
- Verified with a throwaway experiment that the MCP SDK's stateless handler serves both a
  2025-era client (initialize handshake) and progress notifications from one factory.
- Pushed as commit `e4d6ada`; CI run 43554118682 green on Linux (Node 22, 24) and macOS.
- Ran a temporary CI job (`macos-probe`) reporting which desktop capabilities the
  hosted macOS runners provide (screen capture, synthetic input, Accessibility, Seatbelt), to
  decide how much of M4 can be verified in CI.
