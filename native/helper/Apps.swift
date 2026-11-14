import AppKit
import ApplicationServices
import Foundation

// Maps an accessibility window element to its window-server id. Private, but stable for many
// macOS releases and the only way to tell two windows with the same title apart.
@_silgen_name("_AXUIElementGetWindow")
@discardableResult
func _AXUIElementGetWindow(_ element: AXUIElement, _ identifier: inout CGWindowID) -> AXError

// MARK: - Applications

func policyName(_ policy: NSApplication.ActivationPolicy) -> String {
  switch policy {
  case .regular: return "regular"
  case .accessory: return "accessory"
  default: return "background"
  }
}

func applicationJSON(_ app: NSRunningApplication) -> JSON {
  var info: JSON = [
    "pid": Int(app.processIdentifier),
    "name": app.localizedName ?? "",
    "active": app.isActive,
    "hidden": app.isHidden,
    "kind": policyName(app.activationPolicy),
  ]
  if let bundle = app.bundleIdentifier { info["bundle_id"] = bundle }
  if let path = app.bundleURL?.path ?? app.executableURL?.path { info["path"] = path }
  if let launched = app.launchDate { info["launched_at"] = ISO8601DateFormatter().string(from: launched) }
  return info
}

func applicationList(_ params: JSON) -> JSON {
  let includeBackground = params.flag("include_background")
  let apps = NSWorkspace.shared.runningApplications.filter { includeBackground || $0.activationPolicy == .regular }
  var result: JSON = ["applications": apps.map { applicationJSON($0) }]
  if let front = NSWorkspace.shared.frontmostApplication { result["frontmost"] = applicationJSON(front) }
  return result
}

func findApplication(_ params: JSON) throws -> NSRunningApplication {
  let apps = NSWorkspace.shared.runningApplications
  if let pid = params.integer("pid") {
    if let app = apps.first(where: { Int($0.processIdentifier) == pid }) { return app }
    if let app = NSRunningApplication(processIdentifier: pid_t(pid)) { return app }
    throw notFound("No running application with pid \(pid)")
  }
  if let bundle = params.string("bundle_id") {
    let wanted = bundle.lowercased()
    if let app = apps.first(where: { ($0.bundleIdentifier ?? "").lowercased() == wanted }) { return app }
    throw notFound("No running application with bundle id \(bundle)")
  }
  if let name = params.string("name") {
    var wanted = name.lowercased()
    if wanted.hasSuffix(".app") { wanted = String(wanted.dropLast(4)) }
    // Applications with windows first, so that a helper process of the same name is not picked.
    let ordered = apps.sorted { policyRank($0.activationPolicy) < policyRank($1.activationPolicy) }
    let exact = ordered.first(where: { app in
      if (app.localizedName ?? "").lowercased() == wanted { return true }
      if let file = app.bundleURL?.deletingPathExtension().lastPathComponent.lowercased(), file == wanted { return true }
      if let executable = app.executableURL?.lastPathComponent.lowercased(), executable == wanted { return true }
      return (app.bundleIdentifier ?? "").lowercased() == wanted
    })
    if let app = exact { return app }
    let partial = ordered.filter { ($0.localizedName ?? "").lowercased().contains(wanted) && $0.activationPolicy == .regular }
    if partial.count == 1 { return partial[0] }
    if partial.count > 1 {
      let names = partial.map { $0.localizedName ?? "" }.joined(separator: ", ")
      throw invalid("\"\(name)\" matches several running applications: \(names). Use the exact name, the bundle id or the pid.")
    }
    throw notFound("No running application named \"\(name)\"")
  }
  throw invalid("Name the application with name, bundle_id or pid")
}

func policyRank(_ policy: NSApplication.ActivationPolicy) -> Int {
  switch policy {
  case .regular: return 0
  case .accessory: return 1
  default: return 2
  }
}

func isFrontmost(_ app: NSRunningApplication) -> Bool {
  return NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier
}

func bringToFront(_ app: NSRunningApplication) -> Bool {
  if app.isHidden { app.unhide() }
  app.activate(options: [.activateAllWindows])
  for _ in 0..<12 {
    pump(0.05)
    if isFrontmost(app) { return true }
  }
  // Since macOS 14 a background process may be refused; ask through Accessibility instead.
  if AXIsProcessTrusted() {
    AXUIElementSetAttributeValue(applicationElement(app.processIdentifier), "AXFrontmost" as CFString, kCFBooleanTrue)
    for _ in 0..<12 {
      pump(0.05)
      if isFrontmost(app) { return true }
    }
  }
  return isFrontmost(app)
}

func applicationActivate(_ params: JSON) throws -> JSON {
  let app = try findApplication(params)
  let front = bringToFront(app)
  var info = applicationJSON(app)
  info["active"] = front
  return info
}

func applicationQuit(_ params: JSON) throws -> JSON {
  let app = try findApplication(params)
  let force = params.flag("force")
  let wait = max(0.0, min(params.double("wait_seconds") ?? 5.0, 60.0))
  let accepted = force ? app.forceTerminate() : app.terminate()
  var waited = 0.0
  while !app.isTerminated && waited < wait {
    pump(0.1)
    waited += 0.1
  }
  var info = applicationJSON(app)
  info["requested"] = accepted
  info["terminated"] = app.isTerminated
  return info
}

func applicationHide(_ params: JSON) throws -> JSON {
  let app = try findApplication(params)
  let hide = params.flag("hide", fallback: true)
  let accepted = hide ? app.hide() : app.unhide()
  pump(0.15)
  var info = applicationJSON(app)
  info["requested"] = accepted
  return info
}

// MARK: - Windows

func windowServerList(_ options: CGWindowListOption, _ relativeTo: CGWindowID = kCGNullWindowID) -> [[String: Any]] {
  return (CGWindowListCopyWindowInfo(options, relativeTo) as? [[String: Any]]) ?? []
}

func axWindows(_ app: NSRunningApplication) -> [AXUIElement] {
  let element = AXUIElementCreateApplication(app.processIdentifier)
  AXUIElementSetMessagingTimeout(element, 1.5)
  return (axValue(element, "AXWindows") as? [AXUIElement]) ?? []
}

func windowNumber(_ window: AXUIElement) -> Int? {
  var identifier: CGWindowID = 0
  let status = _AXUIElementGetWindow(window, &identifier)
  return status == .success && identifier != 0 ? Int(identifier) : nil
}

func windowJSON(_ window: AXUIElement, app: NSRunningApplication, order: [Int: Int]) -> JSON {
  let values = axAttributes(window, ["AXTitle", "AXPosition", "AXSize", "AXMinimized", "AXMain", "AXFocused", "AXFullScreen", "AXSubrole"])
  var info: JSON = [
    "app": app.localizedName ?? "",
    "pid": Int(app.processIdentifier),
    "title": values[0] as? String ?? "",
    "minimized": (values[3] as? NSNumber)?.boolValue ?? false,
    "main": (values[4] as? NSNumber)?.boolValue ?? false,
    "focused": (values[5] as? NSNumber)?.boolValue ?? false,
    "fullscreen": (values[6] as? NSNumber)?.boolValue ?? false,
  ]
  if let bundle = app.bundleIdentifier { info["bundle_id"] = bundle }
  if let subrole = values[7] as? String { info["kind"] = subrole }
  if let origin = pointValue(values[1]), let size = sizeValue(values[2]) {
    info["frame"] = rectJSON(CGRect(origin: origin, size: size))
  }
  if let number = windowNumber(window) {
    info["window_id"] = number
    if let position = order[number] { info["z"] = position }
  }
  return info
}

func windowList(_ params: JSON) throws -> JSON {
  let onScreen = windowServerList([.optionOnScreenOnly, .excludeDesktopElements])
  var order: [Int: Int] = [:]
  for (position, entry) in onScreen.enumerated() {
    if let number = entry[kCGWindowNumber as String] as? Int { order[number] = position }
  }

  guard AXIsProcessTrusted() else {
    // Without Accessibility only the window server's view is available: no minimised windows,
    // and titles only with Screen Recording permission.
    var windows: [JSON] = []
    for entry in onScreen {
      guard (entry[kCGWindowLayer as String] as? Int ?? 0) == 0, let number = entry[kCGWindowNumber as String] as? Int else { continue }
      var info: JSON = [
        "window_id": number,
        "app": entry[kCGWindowOwnerName as String] as? String ?? "",
        "pid": entry[kCGWindowOwnerPID as String] as? Int ?? 0,
        "title": entry[kCGWindowName as String] as? String ?? "",
        "z": order[number] ?? 0,
      ]
      if let bounds = entry[kCGWindowBounds as String] as? [String: Any] {
        let x: Double = (bounds["X"] as? NSNumber)?.doubleValue ?? 0.0
        let y: Double = (bounds["Y"] as? NSNumber)?.doubleValue ?? 0.0
        let width: Double = (bounds["Width"] as? NSNumber)?.doubleValue ?? 0.0
        let height: Double = (bounds["Height"] as? NSNumber)?.doubleValue ?? 0.0
        info["frame"] = rectJSON(CGRect(x: x, y: y, width: width, height: height))
      }
      windows.append(info)
    }
    return ["windows": windows, "limited": true]
  }

  var apps: [NSRunningApplication]
  if params.integer("pid") != nil || params.string("bundle_id") != nil || params.string("name") != nil {
    apps = [try findApplication(params)]
  } else {
    apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
  }
  var windows: [JSON] = []
  for app in apps {
    for window in axWindows(app) {
      windows.append(windowJSON(window, app: app, order: order))
    }
  }
  // Front to back; windows that are not on screen (minimised, other Spaces) last.
  windows.sort { (left: JSON, right: JSON) -> Bool in
    let a = left["z"] as? Int ?? Int.max
    let b = right["z"] as? Int ?? Int.max
    return a < b
  }
  return ["windows": windows, "limited": false]
}

func findWindow(_ params: JSON) throws -> (window: AXUIElement, app: NSRunningApplication) {
  try requireAccessibility()
  guard let wanted = params.integer("window_id") else { throw invalid("Missing numeric parameter \"window_id\"") }
  var candidates: [NSRunningApplication] = []
  let owner = windowServerList([.optionIncludingWindow], CGWindowID(wanted)).first?[kCGWindowOwnerPID as String] as? Int
  if let pid = owner, let app = NSRunningApplication(processIdentifier: pid_t(pid)) {
    candidates = [app]
  } else {
    candidates = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
  }
  for app in candidates {
    for window in axWindows(app) where windowNumber(window) == wanted {
      return (window, app)
    }
  }
  throw notFound("No window with id \(wanted). Window ids change when windows are closed and reopened; list the windows again.")
}

func setWindow(_ window: AXUIElement, _ attribute: String, _ value: CFTypeRef, what: String) throws {
  let status = AXUIElementSetAttributeValue(window, attribute as CFString, value)
  guard status == .success else { throw failed("The window could not be \(what) (accessibility error \(status.rawValue))") }
}

func windowAction(_ params: JSON) throws -> JSON {
  let found = try findWindow(params)
  let window = found.window
  let action = try params.requireString("action")

  switch action {
  case "focus":
    if axBool(window, "AXMinimized") == true {
      try setWindow(window, "AXMinimized", kCFBooleanFalse, what: "restored")
      pump(0.3)
    }
    _ = bringToFront(found.app)
    AXUIElementPerformAction(window, "AXRaise" as CFString)
    AXUIElementSetAttributeValue(window, "AXMain" as CFString, kCFBooleanTrue)
  case "move":
    var origin = CGPoint(x: try params.requireDouble("x"), y: try params.requireDouble("y"))
    guard let value = AXValueCreate(.cgPoint, &origin) else { throw failed("Could not encode the position") }
    try setWindow(window, "AXPosition", value, what: "moved")
  case "resize":
    var size = CGSize(width: try params.requireDouble("width"), height: try params.requireDouble("height"))
    guard let value = AXValueCreate(.cgSize, &size) else { throw failed("Could not encode the size") }
    try setWindow(window, "AXSize", value, what: "resized")
  case "minimize":
    try setWindow(window, "AXMinimized", kCFBooleanTrue, what: "minimised")
  case "restore":
    try setWindow(window, "AXMinimized", kCFBooleanFalse, what: "restored")
  case "fullscreen":
    try setWindow(window, "AXFullScreen", kCFBooleanTrue, what: "made full screen")
  case "exit_fullscreen":
    try setWindow(window, "AXFullScreen", kCFBooleanFalse, what: "taken out of full screen")
  case "close":
    guard let button = axElement(window, "AXCloseButton") else { throw failed("This window has no close button") }
    let status = AXUIElementPerformAction(button, "AXPress" as CFString)
    guard status == .success || status == .cannotComplete else {
      throw failed("The window could not be closed (accessibility error \(status.rawValue))")
    }
    pump(0.3)
    return ["closed": true, "window_id": params.integer("window_id") ?? 0]
  default:
    throw invalid("Unknown window action \"\(action)\"")
  }
  pump(0.25)
  var order: [Int: Int] = [:]
  for (position, entry) in windowServerList([.optionOnScreenOnly, .excludeDesktopElements]).enumerated() {
    if let number = entry[kCGWindowNumber as String] as? Int { order[number] = position }
  }
  return windowJSON(window, app: found.app, order: order)
}

func frontmost() -> JSON {
  var result: JSON = [:]
  guard let app = NSWorkspace.shared.frontmostApplication else { return result }
  result["application"] = applicationJSON(app)
  if AXIsProcessTrusted() {
    let element = applicationElement(app.processIdentifier)
    if let window = axElement(element, "AXFocusedWindow") ?? axElement(element, "AXMainWindow") {
      result["window"] = windowJSON(window, app: app, order: [:])
    }
  }
  return result
}
