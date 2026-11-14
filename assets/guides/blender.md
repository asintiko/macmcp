# mcpclaude — Blender guide for agents

Blender tools need **Full System Access**. `blender_info` tells you the installed version and
whether a live session is running. The Python API changes between major versions (render
engine names, node and action APIs): check the version before writing code, and read an
error's traceback before retrying.

## Three ways to work, most direct first

1. **Headless Python** — `blender_run_python` with `blend_file`. A background Blender opens
   the file, runs your code and exits. Add `save: true` to keep the changes. Fast, exact,
   leaves the user's screen alone. Use it for building scenes, batch edits, imports and
   exports, reading data out of files.
2. **Headless render** — `blender_render`. Renders a frame or a range from the saved file and
   returns the image paths; long renders continue in the background with a `process_id`.
   Look at a result with `view_image`.
3. **Live session** — `blender_launch`, then `blender_run_python` (mode `live` or `auto`).
   The code runs inside the Blender window the user sees, on its current scene. Use it when
   the work should be visible, continued by hand, or combined with Computer Use
   (`screenshot`, `click`, `press_key`) for things the API does not reach.

## Writing code for blender_run_python

- `bpy` is imported. The returned value is the variable `result` if you set it, otherwise the
  value of the last line when it is an expression. `print` output comes back as well.
- Datablocks are returned as `{"type": "Object", "name": "Cube"}`, vectors, colours and
  matrices as lists. Return small, specific data (names, counts, positions), not whole
  collections of everything.
- Prefer the data API to operators: `bpy.data.objects.new(...)`, `obj.location = (…)`,
  `collection.objects.link(obj)`. Operators (`bpy.ops.*`) depend on context — active object,
  mode, area. In a live session a 3D viewport is supplied as context automatically; headless
  there is no interface, so operators that need one fail.
- One call, one coherent step. After an error nothing is rolled back: inspect the scene
  before running corrected code, or reopen the file (headless runs without `save` change
  nothing on disk).
- A new file: `blend_file` that does not exist yet plus `save: true` creates it from the
  startup scene. Pass `factory_settings: true` for a clean, add-on-free start.

```python
# Example: a lit, camera-ready scene with one object, saved by save: true
import math
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj)
mesh = bpy.data.meshes.new("Ico")
import bmesh
bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=3, radius=1.0); bm.to_mesh(mesh); bm.free()
ico = bpy.data.objects.new("Ico", mesh); bpy.context.scene.collection.objects.link(ico)
cam = bpy.data.objects.new("Camera", bpy.data.cameras.new("Camera"))
cam.location = (4, -4, 3); cam.rotation_euler = (math.radians(63), 0, math.radians(45))
bpy.context.scene.collection.objects.link(cam); bpy.context.scene.camera = cam
light = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
light.rotation_euler = (math.radians(50), 0, math.radians(30))
bpy.context.scene.collection.objects.link(light)
[o.name for o in bpy.data.objects]
```

## Rendering

- `blender_render` uses the settings stored in the file; `engine`, `format`, `samples`,
  `resolution_x/y` and `resolution_percentage` override them for this render only.
- Preview first: `resolution_percentage: 25` and a low `samples` value take seconds and show
  framing and lighting mistakes before a long render.
- `CYCLES` renders on any machine. EEVEE (`BLENDER_EEVEE_NEXT` in 4.2-4.5, `BLENDER_EEVEE`
  before and from 5.0) needs a GPU and a logged-in desktop session.
- "The render produced no output" usually means the scene has no camera
  (`bpy.context.scene.camera`), or the engine name is wrong for this version.
- The render reads the file from disk. If the scene is open with unsaved changes in a live
  session, save it there first (`bpy.ops.wm.save_mainfile()`).

## Live sessions

- `blender_launch` starts a new Blender with the bridge loaded; a Blender the user started
  themselves is not reachable through `blender_run_python` (use Computer Use on it, or ask
  the user to close it and launch a session).
- Code runs on Blender's main thread: while it runs, the interface is frozen and no other
  call is answered. Keep live code short; render long jobs with `blender_render`.
- Open and save files from the code: `bpy.ops.wm.open_mainfile(filepath=…)` (discards unsaved
  changes of the current scene — check `bpy.data.is_dirty` and ask the user if in doubt),
  `bpy.ops.wm.save_as_mainfile(filepath=…)`.
- For anything you cannot do in Python, look and click: `screenshot`, then `click`,
  `press_key` (Blender shortcuts act on the editor under the mouse pointer — move the
  pointer over the right editor first).
- End the session with `quit_application` ("Blender"); it asks about unsaved changes like a
  normal quit.
