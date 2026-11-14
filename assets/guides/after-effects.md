# mcpclaude — Adobe After Effects guide for agents

After Effects tools need **Full System Access** on macOS and a licensed After Effects
installation. `after_effects_info` lists the installed versions (use the exact name, e.g.
"Adobe After Effects 2025", with `open_application`), tells whether one is running and
summarises the open project.

## Choose the most direct tool

1. **ExtendScript** — `after_effects_run_script`. The scripting API reaches projects, items,
   compositions, layers, properties, keyframes, expressions, effects, masks, markers and the
   render queue. It is exact and fast; use it for everything it can do.
2. **Menu commands** — `select_menu_item` with the application name, e.g.
   `["Composition", "Add to Render Queue"]`, or from a script
   `app.executeCommand(app.findMenuCommandId("Add to Render Queue"))`.
3. **Mouse and keyboard on screenshots** — for the composition viewer, the timeline, effect
   controls and third-party plug-in panels that scripting does not reach. Read the
   `computer-use` guide.

## Starting up

1. `after_effects_info` → installed? running?
2. If it is not running: `open_application` with the exact name, then `wait` and
   `screenshot` until the main window is there. Starting takes 20-60 seconds, and a Home
   screen, a crash-recovery prompt or a "What's New" window may be in front — look at the
   screenshot and close what is in the way.
3. Open a project with `open_path` (the .aep file, `application` set to the After Effects
   name) or from a script: `app.open(new File("/path/project.aep"))`.

The first script call makes macOS ask the user whether the terminal may control After
Effects (Automation). Until they allow it, calls fail with `MACOS_PERMISSION_REQUIRED`.

## Writing ExtendScript

- The language is ECMAScript 3: `var` only, no arrow functions, no `let`/`const`, no
  template strings, no `Array.prototype.map/forEach/indexOf`, no `JSON`. Collections such as
  `app.project.items` and `comp.layers` are **1-based**.
- The value of the last statement is returned as JSON. Build a plain object to return
  several things: `({ name: comp.name, layers: comp.numLayers })` — in parentheses, or it is
  parsed as a block. Application objects come back as `{type, name}`.
- `log("text", value)` collects lines that are returned with the result. Never use
  `alert()`, `confirm()` or `prompt()`: they block After Effects until a person answers.
- Set `undo_group` on calls that change the project, so the user can undo the change as one
  step.
- Variables do not survive between calls. Find things again by name or id
  (`app.project.itemByID(id)`), or keep a value in `$.global`.
- Time is in seconds: `comp.time`, `layer.inPoint`, `property.setValueAtTime(seconds, value)`.
  Frame n of a composition is `n * comp.frameDuration`.

```javascript
// Example: a title that fades in, returned as a summary
var comp = app.project.items.addComp("Title", 1920, 1080, 1, 5, 25);
var text = comp.layers.addText("Hello");
var doc = text.property("Source Text").value;
doc.fontSize = 120; doc.justification = ParagraphJustification.CENTER_JUSTIFY;
text.property("Source Text").setValue(doc);
text.property("Position").setValue([960, 580]);
var opacity = text.property("Opacity");
opacity.setValueAtTime(0, 0); opacity.setValueAtTime(1, 100);
comp.openInViewer();
({ comp: comp.name, id: comp.id, layers: comp.numLayers });
```

## Rendering

- **From the running application**: add the composition to the render queue and render
  there. This blocks After Effects until the render is done, so keep it for short renders:
  `var item = app.project.renderQueue.items.add(comp); item.outputModule(1).file = new
  File("/path/out.mov"); app.project.renderQueue.render();`
- **With aerender** — `after_effects_render`. It renders the saved project in a separate
  process: save first (`app.project.save()`), then pass the project, and either nothing
  (render everything queued) or `comp` and `output`. Long renders continue in the
  background with a `process_id`; `read_process_output` shows aerender's PROGRESS lines.
- Output module and render settings templates are chosen by name
  (`output_module_template: "Lossless"`); the names are those in the user's After Effects.
- A preview frame without the render queue: `comp.saveFrameToPng(time, new
  File("/path/frame.png"))`, then `view_image`.

## When something goes wrong

- `TIMEOUT` from `after_effects_run_script` — After Effects is busy or a dialog is open
  (missing fonts or footage, a script alert, a save prompt). Take a `screenshot` and answer
  the dialog with `find_ui_elements` + `perform_ui_action` or a click.
- "After Effects is not running" — it is still starting, or it quit. Check with
  `after_effects_info`.
- An ExtendScript error names the line of your code. Changes made before the error stay; the
  user can undo them.
- Script file access errors ("permission denied" writing a file from a script) — the user has
  to enable *Settings → Scripting & Expressions → Allow Scripts to Write Files and Access
  Network* in After Effects.
