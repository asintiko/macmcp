# mcpclaude — Progress Log

One entry per milestone, newest first. Each entry lists what was verified and how; the
checkboxes in [PLAN.md](PLAN.md) are only ticked on the basis of these entries.

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
