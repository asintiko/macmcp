import AppKit
import ApplicationServices
import Foundation

// mcpclaude desktop helper.
//
// Reads {"commands": [{"command": "...", "params": {...}}, ...]} on standard input, runs the
// commands in order and prints {"ok": true, "results": [...]} — or, at the first failure,
// {"ok": false, "index": n, "results": [...], "error": {"code": "...", "message": "..."}}.
// All coordinates are global display points with the origin at the top-left of the main display.

func run(_ command: String, _ params: JSON) throws -> Any {
  switch command {
  case "ping": return ["pong": true]
  case "permissions": return permissions(params)
  case "displays": return ["displays": displays()]
  case "cursor": return cursorPosition()
  case "frontmost": return frontmost()

  case "mouse_move": return try mouseMove(params)
  case "mouse_click": return try mouseClick(params)
  case "mouse_down": return try mouseButtonState(params, down: true)
  case "mouse_up": return try mouseButtonState(params, down: false)
  case "mouse_drag": return try mouseDrag(params)
  case "mouse_scroll": return try mouseScroll(params)
  case "key": return try keyboardKey(params)
  case "key_down": return try keyboardHold(params, down: true)
  case "key_up": return try keyboardHold(params, down: false)
  case "type": return try keyboardType(params)
  case "sleep":
    pause(max(0.0, min(params.double("ms") ?? 0.0, 60_000.0)))
    return [:] as JSON

  case "apps": return applicationList(params)
  case "app_activate": return try applicationActivate(params)
  case "app_quit": return try applicationQuit(params)
  case "app_hide": return try applicationHide(params)

  case "windows": return try windowList(params)
  case "window_action": return try windowAction(params)

  case "ui_tree": return try uiTree(params)
  case "ui_find": return try uiFind(params)
  case "ui_at": return try uiAt(params)
  case "ui_focused": return try uiFocused(params)
  case "ui_action": return try uiAction(params)
  case "menu_list": return try menuList(params)
  case "menu_select": return try menuSelect(params)

  case "clipboard_get": return clipboardGet()
  case "clipboard_set": return try clipboardSet(params)

  default: throw invalid("Unknown helper command \"\(command)\"")
  }
}

func emit(_ object: JSON) {
  let fallback = Data("{\"ok\":false,\"index\":0,\"results\":[],\"error\":{\"code\":\"FAILED\",\"message\":\"The result could not be encoded as JSON\"}}".utf8)
  var data = fallback
  // Serialising an invalid object raises an Objective-C exception, so check first.
  if JSONSerialization.isValidJSONObject(object), let encoded = try? JSONSerialization.data(withJSONObject: object, options: []) {
    data = encoded
  }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard let parsed = try? JSONSerialization.jsonObject(with: input, options: []), let request = parsed as? JSON else {
  emit(["ok": false, "index": 0, "results": [Any](), "error": ["code": "INVALID", "message": "The request is not a JSON object"]])
  exit(2)
}

var results: [Any] = []
let commands = (request["commands"] as? [Any] ?? []).compactMap { $0 as? JSON }
for (index, entry) in commands.enumerated() {
  do {
    let name = entry.string("command") ?? ""
    let params = entry["params"] as? JSON ?? [:]
    results.append(try run(name, params))
  } catch let error as HelperError {
    emit(["ok": false, "index": index, "results": results, "error": ["code": error.code, "message": error.message]])
    exit(1)
  } catch {
    emit(["ok": false, "index": index, "results": results, "error": ["code": "FAILED", "message": "\(error)"]])
    exit(1)
  }
}
emit(["ok": true, "results": results])
