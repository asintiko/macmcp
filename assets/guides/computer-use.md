# mcpclaude — Computer Use guide for agents

Desktop control exists only in **Full System Access** mode on macOS. `server_info` shows
whether the `computer`, `apps`, `windows`, `ui` and `scripting` groups are available.

## Choose the most direct tool

Work down this list and stop at the first one that can do the job. Each step down is slower
and less exact than the one above it.

1. **A command or a script.** `run_command`, `run_script`, the file tools. Most tasks never
   need the screen.
2. **The application's own scripting.** `run_applescript` (Finder, Safari, Mail, Keynote,
   Photoshop, …), `blender_run_python`, `after_effects_run_script`.
3. **Menus and controls by name.** `select_menu_item`, `find_ui_elements` +
   `perform_ui_action`. No coordinates, no timing problems.
4. **Mouse and keyboard on screenshots.** `screenshot`, `click`, `drag`, `scroll`,
   `type_text`, `press_key`. Always works, for canvases, timelines and custom interfaces too.

## The loop for mouse and keyboard work

1. `screenshot` — look first. The result also names the frontmost application and where the
   pointer is.
2. Act: `click`, `type_text`, `press_key`, … Every action returns a fresh screenshot by
   default, so you see the outcome without another call.
3. Check the new screenshot before the next step. If nothing changed, do not repeat blindly:
   the application may be busy (`wait`), a dialog may be in the way, or the click missed.

## Coordinates

- Every `x`/`y` is a **pixel of the full screenshot**, measured from its top-left corner. The
  screenshot size is stable for a display (long edge at most 1280 px); it is reported as
  `screen` in every screenshot result.
- `screenshot` with `region` enlarges part of the screen so small text becomes readable. The
  enlarged picture is **for reading only** — its result text gives the formula back to
  full-screenshot coordinates.
- Window positions (`list_windows`) and element positions (`find_ui_elements`,
  `get_ui_tree`) are in the same coordinates: `center` can be passed straight to `click`.
- With several displays, pass `display` (1 = main) to `screenshot` and to the mouse tools.

## Keyboard

- `type_text` types characters into whatever has focus. Click the field first, or confirm
  with `get_focused_ui_element`. For long text, `set_clipboard` then `press_key` `"cmd+v"`
  is faster and more reliable.
- `press_key` is for shortcuts and named keys: `"cmd+s"`, `"escape"`, `"cmd+shift+z"`,
  `"down down return"`.
- Reading text back: `get_focused_ui_element`, or select and copy (`"cmd+a cmd+c"`) and
  `get_clipboard`.

## Applications and windows

- `open_application` starts or activates an application and waits for it; `open_path` opens
  a document (optionally with a named application). Large applications keep loading after
  their window appears: `wait`, then look.
- `list_windows` gives ids and positions; `focus_window`, `set_window_bounds` and
  `set_window_state` arrange them. A predictable layout (for example the application
  window at a fixed size in the top-left corner) makes coordinates repeatable.
- Keyboard input goes to the **frontmost** application. Check `frontmost_application` in the
  screenshot result if keys seem to have no effect.

## Menus, buttons and dialogs

- `list_menus` shows every command of an application with its shortcut and whether it is
  enabled; `select_menu_item` chooses one by path, e.g. `["File", "Export", "Add to Render
  Queue"]`.
- `find_ui_elements` (by text and/or role) returns controls with an `element_id`;
  `perform_ui_action` presses them, sets their value or focuses them. In dialogs this is
  the dependable way to press "Save", "Replace" or "Don't Save".
- `get_ui_tree` outlines a window when you do not know what it contains;
  `get_ui_element_at` tells what is under a coordinate.
- Element ids go stale whenever the interface changes. If one is rejected, search again.
- Canvases, viewports and timelines (After Effects compositions, Blender's 3D viewport) are
  usually opaque to these tools: use screenshots there.

## Several steps in one call

`computer_actions` runs a list of actions without a round trip in between and returns one
screenshot at the end. Use it for sequences whose positions do not depend on how the screen
changes: click a field, select all, type, press Return. For a slow, precise drag, build it
from `mouse_down`, several `mouse_move` steps and `mouse_up`; hold modifiers with
`key_down` / `key_up`.

## When something goes wrong

- `MACOS_PERMISSION_REQUIRED` — macOS blocks the action until the user grants a privacy
  permission (Accessibility for input and interface elements, Screen Recording for
  screenshots, Automation for AppleScript control of another application). Tell the user
  exactly which one; the hint names the settings page. You cannot grant it yourself.
- `DEPENDENCY_MISSING` for desktop tools — the Xcode Command Line Tools are needed once to
  build the desktop helper: ask the user to run `xcode-select --install`.
- A click seems to do nothing — take a `screenshot` with a `region` around the target and
  check the coordinates; make sure no dialog or other window covers it; try
  `find_ui_elements` and `perform_ui_action` `press`.
- An application does not react to fast input — raise `delay_ms` in `type_text` and
  `duration_ms` in `drag`, or add `wait` steps.
- An unexpected dialog — read it (`get_ui_tree` on the frontmost window, or a screenshot)
  and answer it deliberately. Never dismiss a "save changes?" dialog without knowing what
  would be lost.

## Be careful with the user's Mac

The user sees every call in their terminal and can pause the server. The desktop is theirs:
do not close their windows or quit their applications unless the task requires it, leave
documents saved or untouched, and say what you changed.
