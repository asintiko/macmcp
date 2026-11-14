# mcpclaude — Progress Log

One entry per milestone, newest first. Each entry lists what was verified and how; the
checkboxes in [PLAN.md](PLAN.md) are only ticked on the basis of these entries.

## M0 — Planning and scaffolding (2026-11-14)

- Requirements analysed and mapped to milestones in PLAN.md; architecture and decisions
  written.
- Scaffold: TypeScript 7, Vitest 5, MCP SDK v2 (`@modelcontextprotocol/server` 2.4), ngrok SDK
  1.8.
- Verified locally: `npm run typecheck`, `npm run build`, `npm test`.
- Verified with a throwaway experiment that the MCP SDK's stateless handler serves both a
  2025-era client (initialize handshake) and progress notifications from one factory.
- Pushed as commit `e4d6ada`; CI run 43554118682 green on Linux (Node 22, 24) and macOS.
- Added a temporary CI job (`macos-probe`) that reports which desktop capabilities the
  hosted macOS runners provide (screen capture, synthetic input, Accessibility, Seatbelt), to
  decide how much of M4 can be verified in CI.
