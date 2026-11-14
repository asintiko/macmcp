# mcpclaude

An MCP (Model Context Protocol) server for **remote cloud AI agents on macOS**. Run one command in Terminal and a cloud AI agent — Claude, Cursor, Windsurf, or any other MCP client — can run shell commands, edit files, manage processes, and drive the desktop of your Mac (screenshots, mouse, keyboard, windows, menus), including creative suites such as Blender and Adobe After Effects, through an encrypted ngrok tunnel.

---

## Highlights

- **Zero-Setup Tunneling:** Automatically spins up a secure public ngrok tunnel with an embedded agent — no separate ngrok CLI installation required.
- **Two Security Tiers:**
  - **Project-Only Access:** Confines all file operations and shell commands strictly to the selected project root. Commands are enforced at the OS kernel level using a custom macOS **Seatbelt sandbox** (`sandbox-exec`) profile. Desktop control and system tools are hidden and refused.
  - **Full System Access:** Unrestricted filesystem, shell, and full macOS GUI control (Computer Use), enabled only after explicit user confirmation.
- **Computer Use on macOS:** High-performance, pixel-accurate desktop automation via Apple's native tools (`screencapture`, `sips`) and a fast, cached Swift command-line helper:
  - Cursor movement, clicks (left, right, middle, double, triple), smooth dragging, and wheel scrolling.
  - Full keyboard typing, modifier combinations, and named key sequences.
  - Window management: listing, moving, resizing, focusing, minimizing, and full-screen toggling.
  - Native macOS Accessibility (AX) inspection: find buttons, menus, dialogs, and text fields by label or role without fragile coordinate guessing.
  - AppleScript and JXA (JavaScript for Automation) execution with clipboard integration.
  - Batch execution (`computer_actions`) to run multi-step input sequences with a single round trip.
- **Creative Application Automation:**
  - **Blender:** Headless Python execution (`blender_run_python`), frame and animation rendering (`blender_render`), and live GUI session bridge automation (`blender_launch`).
  - **Adobe After Effects:** ExtendScript evaluation (`after_effects_run_script`), composition and render queue inspection, and headless background rendering via `aerender`.
- **Operator-First CLI:** Interactive 3-step setup wizard, live terminal activity view showing agent tool calls in real time, instant pause/resume/quit controls, and built-in system diagnostics (`mcpclaude doctor`).

---

## System Requirements

- **Operating System:** macOS 14 (Sonoma), macOS 15 (Sequoia), or newer. (Core server and non-desktop tools also run on Linux for testing and development).
- **Node.js:** v22.0.0 or newer.
- **Xcode Command Line Tools:** Required for compiling the Swift desktop automation helper:
  ```bash
  xcode-select --install
  ```
- **ngrok Account:** An ngrok authtoken is required for public tunnels (free accounts supported).

---

## Installation

Install globally via npm:

```bash
npm install -g mcpclaude
```

Verify your environment with the doctor command:

```bash
mcpclaude doctor
```

---

## Quick Start

### 1. Launch the Interactive Wizard

Simply run:

```bash
mcpclaude
```

The CLI guides you through three quick steps:

1. **Tunnel & Connection:** Starts the local HTTP server and ngrok tunnel. It outputs your unique MCP connection URL:
   ```
   Public MCP URL: https://abc-123.ngrok-free.app/mcp/your-access-token
   ```
2. **Project Directory:** Choose your working directory using an interactive terminal file browser or type a manual path.
3. **Permission Level:** Choose between **Project-Only Access** (sandboxed to the chosen directory) or **Full System Access** (unrestricted, includes Computer Use).

### 2. Connect Your AI Client

#### Claude Desktop
Add the server to your `claude_desktop_config.json` (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mac": {
      "command": "mcpclaude",
      "args": ["start", "--dir", "/Users/you/Projects/my-project", "--project-only"]
    }
  }
}
```

#### Web Claude / Cloud MCP Connectors
When configuring an external or cloud-hosted agent, select **Streamable HTTP** transport and provide the full public URL printed by `mcpclaude`:

```
https://abc-123.ngrok-free.app/mcp/<your-access-token>
```

#### Authentication
By default, `mcpclaude` generates a secure 256-bit access token. Clients can authenticate via:
- HTTP header: `Authorization: Bearer <token>`
- URL path: `https://<tunnel-host>/mcp/<token>` (supported by connectors that only accept a single URL input)

To run without authentication, explicitly pass `--no-auth` (requires confirmation).

---

## Permissions and macOS Security (TCC)

When using **Full System Access**, macOS requires privacy permissions before synthetic input or screen captures can succeed:

1. **Accessibility (`System Settings > Privacy & Security > Accessibility`):**
   Required for mouse clicks, key events, and querying the Accessibility UI tree. Add your Terminal application (e.g. `Terminal`, `iTerm2`, or `Ghostty`).
2. **Screen Recording (`System Settings > Privacy & Security > Screen & System Audio Recording`):**
   Required for taking desktop and window screenshots. Add your Terminal application.
3. **Automation (`System Settings > Privacy & Security > Automation`):**
   Required when running AppleScript to control other applications (e.g., System Events, TextEdit, Finder).

The wizard and `mcpclaude doctor` will automatically detect and report any missing permissions.

---

## CLI Reference

```
Usage: mcpclaude [command] [options]

Commands:
  start [options]    Start the MCP server (default command)
  doctor             Check dependencies, permissions, and configuration
  tools [options]    List or export available tools (--format text|json|markdown)
  config <action>    Manage configuration (get, set, path)

Options:
  --dir <path>             Path to project root directory
  --project-only           Run in Project-Only Access mode (sandboxed)
  --full-access            Run in Full System Access mode (unrestricted + GUI)
  --port <number>          Local HTTP port (default: random free port)
  --token <string>         Custom access token
  --no-auth                Disable token authentication (prompts for confirmation)
  --ngrok-authtoken <key>  ngrok authtoken
  --no-tunnel              Run locally without ngrok tunnel
  --public-url <url>       Specify a custom public URL
  --non-interactive        Disable interactive wizard (requires --dir and mode)
  -v, --version            Display version
  -h, --help               Display help
```

---

## Live Activity & Controls

While the server is running, the terminal displays an audit log of every tool call made by the agent. You can control the server directly using single keypresses:

- **`p`** — **Pause / Resume:** Temporarily freezes incoming agent actions. Any tool calls made while paused receive a `PAUSED` error.
- **`i`** — **Info:** Displays current connection URL, active directory, permission level, and connected background processes.
- **`q`** or **`Ctrl+C`** — **Quit:** Gracefully terminates background processes, closes the ngrok tunnel, and shuts down the server.

---

## Troubleshooting

- **`Error [SETUP_PENDING]`:** The cloud agent connected before you finished selecting the directory or permission level in the CLI wizard. Complete the wizard steps and the agent will proceed.
- **`Error [OUTSIDE_PROJECT]`:** The agent attempted to access a file or execute a command outside the designated project folder while running in Project-Only mode.
- **`Error [MACOS_PERMISSION_REQUIRED]`:** macOS blocked a screenshot or input event. Check `mcpclaude doctor` to see which permission is missing and grant it in System Settings.
- **`Error [DEPENDENCY_MISSING]`:** Xcode Command Line Tools are missing. Run `xcode-select --install` in Terminal.

---

## Documentation Links

- [Documentation Index](docs/README.md)
- [Complete Tool Reference](docs/TOOLS.md)
- [Development Plan & Progress](docs/development/PLAN.md)
- [System Architecture](docs/development/ARCHITECTURE.md)
- [Technical Decisions](docs/development/DECISIONS.md)

---

## License

UNLICENSED
