# mcpclaude Documentation

Welcome to the documentation for **mcpclaude**, an MCP (Model Context Protocol) server that allows cloud AI agents to securely connect to and work on a local Mac through an ngrok tunnel.

---

## Documentation Index

### 1. User & Operator Guides
- **[Main README](../README.md)** — Installation, CLI usage, interactive setup wizard, client configuration (Claude Desktop, Web Claude, Cursor), permission modes, and security model.
- **[Tool Reference](TOOLS.md)** — Detailed specification of all 72 MCP tools, input schemas, parameter descriptions, required permissions, and example calls.

### 2. Built-in Agent Guides
The server ships with specialized usage guides that agents can query dynamically using the `usage_guide` tool:
- **[Agent Overview](../assets/guides/overview.md)** (`usage_guide topic: "overview"`) — How agents should orient themselves, check permissions with `server_info`, handle errors, and work with the working directory.
- **[Computer Use Guide](../assets/guides/computer-use.md)** (`usage_guide topic: "computer-use"`) — Driving the macOS desktop: coordinate systems, screenshots, mouse clicks and dragging, keyboard input, application and window management, Accessibility UI elements, and batch actions (`computer_actions`).
- **[Blender Guide](../assets/guides/blender.md)** (`usage_guide topic: "blender"`) — Headless Python scripting, headless frame rendering, and live GUI session bridge automation.
- **[Adobe After Effects Guide](../assets/guides/after-effects.md)** (`usage_guide topic: "after-effects"`) — ExtendScript execution, composition inspection, menu commands, and headless rendering via `aerender`.

### 3. Architecture & Development
For developers contributing to or maintaining mcpclaude:
- **[Development Plan (PLAN.md)](development/PLAN.md)** — Living requirements, milestone definitions (M0–M7), and implementation status.
- **[Progress Log (PROGRESS.md)](development/PROGRESS.md)** — Milestone verification logs and CI test evidence.
- **[Architecture (ARCHITECTURE.md)](development/ARCHITECTURE.md)** — System design, component breakdown, concurrency model, runtime state, and tunnel lifecycle.
- **[Technical Decisions (DECISIONS.md)](development/DECISIONS.md)** — Key technical choices (Node/TypeScript, stateless MCP v2, ngrok embedded SDK, token auth, Seatbelt sandbox, Swift desktop helper).

---

## Quick Reference

### Running Diagnostics
Check your system dependencies, Node version, ngrok configuration, Xcode Command Line Tools, and macOS privacy permissions:
```bash
mcpclaude doctor
```

### Inspecting Available Tools
View all tools grouped by category directly in your terminal:
```bash
mcpclaude tools
```
Or export the full catalogue as Markdown or JSON:
```bash
mcpclaude tools --format markdown --output docs/TOOLS.md
mcpclaude tools --format json
```

### Non-Interactive / Scripted Start
Start without the interactive wizard by providing options via CLI flags:
```bash
mcpclaude start --dir ~/Projects/my-app --project-only
# Or for full desktop automation:
mcpclaude start --dir ~/Projects/my-app --full-access
```
