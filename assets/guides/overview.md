# mcpclaude — overview for agents

You are connected to **mcpclaude**, a server running on the user's own Mac. The tools let you
work on that machine: run commands, read and change files, manage processes and — when the
user allowed it — see the screen and control mouse, keyboard and applications.

## Start here

1. Call `server_info`. It tells you the **permission level**, the **project directory**, the
   **working directory** and which tool groups are available.
2. Respect the permission level:
   - **Project-Only Access** — files and commands are confined to the project directory.
     Paths outside it are rejected with `OUTSIDE_PROJECT`; commands run inside an OS sandbox.
     Desktop control, applications and system-wide tools are not available. Only the user
     can change the level, by restarting mcpclaude.
   - **Full System Access** — no path restrictions; every tool is available and nothing asks
     for confirmation. Be deliberate: there is no undo for deleted files.
3. Relative paths and commands use the working directory. Change it with
   `change_directory`.

## Which guide to read next

`usage_guide` has one topic per kind of work. Read the one that matches your task before
starting multi-step work:

- `computer-use` — screenshots, mouse, keyboard, applications, windows, menus and dialogs.
- `blender` — Python scripting, headless renders and live sessions in Blender.
- `after-effects` — ExtendScript, menu commands and rendering in Adobe After Effects.

## Errors

Failed calls return a line such as `Error [NOT_FOUND]: …` and often a `Hint:`. Codes are
stable: `INVALID_ARGUMENT`, `NOT_FOUND`, `ALREADY_EXISTS`, `PERMISSION_DENIED`,
`OUTSIDE_PROJECT`, `SETUP_PENDING`, `PAUSED`, `TIMEOUT`, `TOO_LARGE`, `CONFLICT`,
`UNSUPPORTED_PLATFORM`, `DEPENDENCY_MISSING`, `MACOS_PERMISSION_REQUIRED`, `CANCELLED`,
`FAILED`, `INTERNAL`.

- `SETUP_PENDING` — the user is still in the setup wizard. Wait a little and retry.
- `PAUSED` — the user paused the server from the terminal. Stop and wait.
- `MACOS_PERMISSION_REQUIRED` — macOS privacy settings block the action. Tell the user which
  permission to grant (the hint names it); you cannot grant it yourself.

## The user is watching

Every tool call is shown live in the user's terminal and written to an audit log. The user
can pause or stop the server at any time.
