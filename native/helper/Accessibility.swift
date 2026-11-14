import AppKit
import ApplicationServices
import Foundation

// MARK: - Accessibility primitives

func axValue(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
  var value: CFTypeRef?
  let status = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
  return status == .success ? value : nil
}

func axString(_ element: AXUIElement, _ attribute: String) -> String? {
  return axValue(element, attribute) as? String
}

func axBool(_ element: AXUIElement, _ attribute: String) -> Bool? {
  return (axValue(element, attribute) as? NSNumber)?.boolValue
}

func axElement(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
  guard let value = axValue(element, attribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
  return (value as! AXUIElement)
}

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
  return (axValue(element, "AXChildren") as? [AXUIElement]) ?? []
}

func pointValue(_ value: AnyObject?) -> CGPoint? {
  guard let value = value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
  var point = CGPoint.zero
  return AXValueGetValue(value as! AXValue, .cgPoint, &point) ? point : nil
}

func sizeValue(_ value: AnyObject?) -> CGSize? {
  guard let value = value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
  var size = CGSize.zero
  return AXValueGetValue(value as! AXValue, .cgSize, &size) ? size : nil
}

func axFrame(_ element: AXUIElement) -> CGRect? {
  guard let origin = pointValue(axValue(element, "AXPosition")), let size = sizeValue(axValue(element, "AXSize")) else { return nil }
  return CGRect(origin: origin, size: size)
}

func axActions(_ element: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(element, &names) == .success, let list = names as? [String] else { return [] }
  return list
}

/// Several attributes in one round trip to the application. Missing ones come back as nil.
func axAttributes(_ element: AXUIElement, _ attributes: [String]) -> [AnyObject?] {
  var values: CFArray?
  let status = AXUIElementCopyMultipleAttributeValues(element, attributes as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values)
  guard status == .success, let list = values as? [AnyObject], list.count == attributes.count else {
    return [AnyObject?](repeating: nil, count: attributes.count)
  }
  return list.map { (value: AnyObject) -> AnyObject? in
    if value is NSNull { return nil }
    if CFGetTypeID(value) == AXValueGetTypeID() && AXValueGetType(value as! AXValue) == .axError { return nil }
    return value
  }
}

func applicationElement(_ pid: pid_t) -> AXUIElement {
  let element = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(element, 2.0)
  return element
}

// MARK: - Describing elements

let describedAttributes = [
  "AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXValue", "AXEnabled", "AXFocused", "AXPosition", "AXSize",
  "AXIdentifier", "AXHelp", "AXPlaceholderValue", "AXSelected", "AXChildren",
]

/// Containers that carry no information of their own; left out of compact listings.
let structuralRoles: Set<String> = [
  "AXGroup", "AXSplitGroup", "AXScrollArea", "AXLayoutArea", "AXLayoutItem", "AXUnknown", "AXSplitter", "AXScrollBar",
  "AXValueIndicator", "AXMatte", "AXGrowArea", "AXRuler", "AXRulerMarker", "AXColumn", "AXRow", "AXCell", "AXList",
  "AXOutline", "AXTable", "AXTabGroup", "AXToolbar", "AXBrowser",
]

func shortened(_ text: String, _ limit: Int) -> String {
  return text.count > limit ? String(text.prefix(limit)) + "…" : text
}

struct ElementSnapshot {
  var info: JSON
  var role: String
  var children: [AXUIElement]
  /// Title, description, value and the like, lower-cased, for text searches.
  var searchText: String
  var labelled: Bool
}

func snapshot(_ element: AXUIElement, id: String, valueLimit: Int) -> ElementSnapshot {
  let values = axAttributes(element, describedAttributes)
  let role = values[0] as? String ?? "AXUnknown"
  var info: JSON = ["id": id + ":" + role, "role": role]
  var search: [String] = []
  var labelled = false

  if let subrole = values[1] as? String, !subrole.isEmpty { info["subrole"] = subrole }
  if let title = values[2] as? String, !title.isEmpty {
    info["title"] = shortened(title, 200)
    search.append(title)
    labelled = true
  }
  if let description = values[3] as? String, !description.isEmpty {
    info["description"] = shortened(description, 200)
    search.append(description)
    labelled = true
  }
  if let text = values[4] as? String {
    if !text.isEmpty {
      info["value"] = shortened(text, valueLimit)
      if text.count > valueLimit { info["value_length"] = text.count }
      search.append(String(text.prefix(2000)))
      labelled = true
    }
  } else if let number = values[4] as? NSNumber {
    info["value"] = number
    labelled = true
  }
  if let enabled = (values[5] as? NSNumber)?.boolValue, !enabled { info["enabled"] = false }
  if let focused = (values[6] as? NSNumber)?.boolValue, focused { info["focused"] = true }
  if let origin = pointValue(values[7]), let size = sizeValue(values[8]) {
    info["frame"] = rectJSON(CGRect(origin: origin, size: size))
  }
  if let identifier = values[9] as? String, !identifier.isEmpty {
    info["identifier"] = shortened(identifier, 120)
    search.append(identifier)
  }
  if let help = values[10] as? String, !help.isEmpty {
    info["help"] = shortened(help, 200)
    search.append(help)
  }
  if let placeholder = values[11] as? String, !placeholder.isEmpty {
    info["placeholder"] = shortened(placeholder, 120)
    search.append(placeholder)
  }
  if let selected = (values[12] as? NSNumber)?.boolValue, selected { info["selected"] = true }
  let children = (values[13] as? [AXUIElement]) ?? []
  return ElementSnapshot(info: info, role: role, children: children, searchText: search.joined(separator: "\n").lowercased(), labelled: labelled)
}

func normalizedRole(_ role: String) -> String {
  let lower = role.lowercased().replacingOccurrences(of: " ", with: "").replacingOccurrences(of: "_", with: "")
  return lower.hasPrefix("ax") ? lower : "ax" + lower
}

// MARK: - Locating elements

/// Element ids are "<pid>:<child indexes from the application element>:<role>", e.g. "512:0.3.1:AXButton".
func resolveElement(_ id: String) throws -> (element: AXUIElement, pid: pid_t) {
  let parts = id.components(separatedBy: ":")
  guard parts.count >= 2, let pid = Int32(parts[0]) else { throw invalid("Malformed element id \"\(id)\"") }
  var element = applicationElement(pid)
  for piece in parts[1].split(separator: ".") {
    guard let index = Int(piece) else { throw invalid("Malformed element id \"\(id)\"") }
    let children = axChildren(element)
    guard index >= 0 && index < children.count else {
      throw notFound("The interface has changed: element \(id) no longer exists. Look it up again.")
    }
    element = children[index]
  }
  if parts.count >= 3 && !parts[2].isEmpty {
    let role = axString(element, "AXRole") ?? "AXUnknown"
    if role != parts[2] {
      throw notFound("The interface has changed: element \(id) is now a \(role). Look it up again.")
    }
  }
  return (element, pid)
}

struct Scope {
  let root: AXUIElement
  let pid: pid_t
  let path: [Int]
  let app: NSRunningApplication?
}

/// The part of the interface a query applies to: one window, or one application (default: the frontmost).
func resolveScope(_ params: JSON) throws -> Scope {
  try requireAccessibility()
  if params.integer("window_id") != nil {
    let found = try findWindow(params)
    let appElement = applicationElement(found.app.processIdentifier)
    let index = axChildren(appElement).firstIndex(where: { CFEqual($0, found.window) })
    guard let position = index else { throw notFound("The window is not part of the application's interface tree") }
    return Scope(root: found.window, pid: found.app.processIdentifier, path: [position], app: found.app)
  }
  let app: NSRunningApplication
  if params.integer("pid") != nil || params.string("bundle_id") != nil || params.string("name") != nil {
    app = try findApplication(params)
  } else {
    guard let front = NSWorkspace.shared.frontmostApplication else { throw notFound("No application is frontmost") }
    app = front
  }
  return Scope(root: applicationElement(app.processIdentifier), pid: app.processIdentifier, path: [], app: app)
}

func elementID(_ pid: pid_t, _ path: [Int]) -> String {
  return "\(pid):" + path.map { String($0) }.joined(separator: ".")
}

// MARK: - Tree and search

func uiTree(_ params: JSON) throws -> JSON {
  let scope = try resolveScope(params)
  let maxDepth = max(1, min(params.integer("max_depth") ?? 8, 60))
  let maxElements = max(1, min(params.integer("max_elements") ?? 250, 3000))
  let compact = params.flag("compact", fallback: true)
  let valueLimit = max(20, min(params.integer("value_limit") ?? 200, 20_000))
  var output: [JSON] = []
  var visited = 0
  var truncated = false

  func visit(_ element: AXUIElement, _ path: [Int], _ depth: Int) {
    if output.count >= maxElements || visited >= 20_000 {
      truncated = true
      return
    }
    visited += 1
    let snap = snapshot(element, id: elementID(scope.pid, path), valueLimit: valueLimit)
    if !(compact && structuralRoles.contains(snap.role) && !snap.labelled) || depth == 0 {
      var info = snap.info
      info["depth"] = depth
      if !snap.children.isEmpty { info["children"] = snap.children.count }
      output.append(info)
    }
    if depth >= maxDepth {
      if !snap.children.isEmpty { truncated = true }
      return
    }
    for (index, child) in snap.children.enumerated() {
      visit(child, path + [index], depth + 1)
    }
  }
  visit(scope.root, scope.path, 0)
  return ["application": scope.app?.localizedName ?? "", "pid": Int(scope.pid), "elements": output, "truncated": truncated]
}

func uiFind(_ params: JSON) throws -> JSON {
  let scope = try resolveScope(params)
  let text = (params.string("text") ?? "").lowercased()
  let role = params.string("role").map { normalizedRole($0) }
  guard !text.isEmpty || role != nil else { throw invalid("Give text and/or role to search for") }
  let limit = max(1, min(params.integer("limit") ?? 25, 500))
  let maxDepth = max(1, min(params.integer("max_depth") ?? 40, 80))
  let valueLimit = max(20, min(params.integer("value_limit") ?? 200, 20_000))
  var matches: [JSON] = []
  var visited = 0
  var truncated = false

  func visit(_ element: AXUIElement, _ path: [Int], _ depth: Int) {
    if matches.count >= limit || visited >= 20_000 {
      truncated = true
      return
    }
    visited += 1
    let snap = snapshot(element, id: elementID(scope.pid, path), valueLimit: valueLimit)
    let roleMatches = role == nil || normalizedRole(snap.role) == role
    let textMatches = text.isEmpty || snap.searchText.contains(text)
    if roleMatches && textMatches && depth > 0 {
      var info = snap.info
      info["actions"] = axActions(element)
      matches.append(info)
    }
    if depth >= maxDepth { return }
    for (index, child) in snap.children.enumerated() {
      visit(child, path + [index], depth + 1)
    }
  }
  visit(scope.root, scope.path, 0)
  return ["application": scope.app?.localizedName ?? "", "pid": Int(scope.pid), "elements": matches, "truncated": truncated]
}

/// The child-index path of an element, found by walking up to its application.
func pathOf(_ element: AXUIElement) -> [Int]? {
  var chain: [AXUIElement] = [element]
  var current = element
  while let parent = axElement(current, "AXParent") {
    chain.append(parent)
    current = parent
    if chain.count > 80 { return nil }
  }
  guard axString(current, "AXRole") == "AXApplication" else { return nil }
  var path: [Int] = []
  var index = chain.count - 1
  while index > 0 {
    let parent = chain[index]
    let child = chain[index - 1]
    guard let position = axChildren(parent).firstIndex(where: { CFEqual($0, child) }) else { return nil }
    path.append(position)
    index -= 1
  }
  return path
}

func describeLocated(_ element: AXUIElement, valueLimit: Int) -> JSON {
  var pid: pid_t = 0
  AXUIElementGetPid(element, &pid)
  let path = pathOf(element)
  var info = snapshot(element, id: path.map { elementID(pid, $0) } ?? "\(pid):?", valueLimit: valueLimit).info
  if path == nil { info.removeValue(forKey: "id") }
  info["actions"] = axActions(element)
  info["pid"] = Int(pid)
  if let app = NSRunningApplication(processIdentifier: pid) { info["application"] = app.localizedName ?? "" }
  var ancestors: [String] = []
  var current = element
  while let parent = axElement(current, "AXParent"), ancestors.count < 12 {
    let role = axString(parent, "AXRole") ?? "AXUnknown"
    let title = axString(parent, "AXTitle") ?? ""
    ancestors.append(title.isEmpty ? role : "\(role) \"\(shortened(title, 60))\"")
    current = parent
  }
  info["ancestors"] = ancestors
  return info
}

func uiAt(_ params: JSON) throws -> JSON {
  try requireAccessibility()
  let point = try params.point()
  let system = AXUIElementCreateSystemWide()
  var found: AXUIElement?
  let status = AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &found)
  guard status == .success, let element = found else { throw notFound("No interface element at that position") }
  return describeLocated(element, valueLimit: 400)
}

func uiFocused(_ params: JSON) throws -> JSON {
  try requireAccessibility()
  let valueLimit = max(20, min(params.integer("value_limit") ?? 4000, 100_000))
  let system = AXUIElementCreateSystemWide()
  var element = axElement(system, "AXFocusedUIElement")
  if element == nil, let front = NSWorkspace.shared.frontmostApplication {
    element = axElement(applicationElement(front.processIdentifier), "AXFocusedUIElement")
  }
  guard let focused = element else { throw notFound("No interface element has keyboard focus") }
  return describeLocated(focused, valueLimit: valueLimit)
}

// MARK: - Acting on elements

func uiAction(_ params: JSON) throws -> JSON {
  try requireAccessibility()
  let target = try resolveElement(try params.requireString("id"))
  let element = target.element
  let action = try params.requireString("action")
  var note: String?

  func perform(_ name: String) throws {
    let status = AXUIElementPerformAction(element, name as CFString)
    if status == .success { return }
    if status == .cannotComplete {
      // Typical when the action opens a dialog: the application answers only after it closes.
      note = "The application did not confirm the action in time; it has most likely happened."
      return
    }
    if status == .actionUnsupported {
      throw invalid("This element does not support \(name). It supports: \(axActions(element).joined(separator: ", "))")
    }
    throw failed("\(name) failed (accessibility error \(status.rawValue))")
  }

  func set(_ attribute: String, _ value: CFTypeRef) throws {
    let status = AXUIElementSetAttributeValue(element, attribute as CFString, value)
    if status == .success { return }
    if status == .attributeUnsupported || status == .illegalArgument {
      throw invalid("This element does not accept a new \(attribute)")
    }
    throw failed("Setting \(attribute) failed (accessibility error \(status.rawValue))")
  }

  switch action {
  case "describe": break
  case "press": try perform("AXPress")
  case "show_menu": try perform("AXShowMenu")
  case "increment": try perform("AXIncrement")
  case "decrement": try perform("AXDecrement")
  case "confirm": try perform("AXConfirm")
  case "cancel": try perform("AXCancel")
  case "pick": try perform("AXPick")
  case "raise": try perform("AXRaise")
  case "scroll_to_visible": try perform("AXScrollToVisible")
  case "focus": try set("AXFocused", kCFBooleanTrue)
  case "select": try set("AXSelected", kCFBooleanTrue)
  case "set_value":
    if let text = params.string("value") {
      try set("AXValue", text as CFString)
    } else if let number = params["value"] as? NSNumber {
      try set("AXValue", number)
    } else {
      throw invalid("set_value needs a value")
    }
  default:
    throw invalid("Unknown action \"\(action)\"")
  }
  pause(60)
  var result = snapshot(element, id: elementID(target.pid, []), valueLimit: 400).info
  result["id"] = try params.requireString("id")
  if let message = note { result["note"] = message }
  return result
}

// MARK: - Menus

func menuBar(of app: NSRunningApplication) throws -> AXUIElement {
  guard let bar = axElement(applicationElement(app.processIdentifier), "AXMenuBar") else {
    throw notFound("\(app.localizedName ?? "The application") has no menu bar")
  }
  return bar
}

func shortcutText(_ key: String, _ modifiers: Int) -> String {
  var parts: [String] = []
  if modifiers & 4 != 0 { parts.append("ctrl") }
  if modifiers & 2 != 0 { parts.append("alt") }
  if modifiers & 1 != 0 { parts.append("shift") }
  if modifiers & 8 == 0 { parts.append("cmd") }
  parts.append(key.lowercased())
  return parts.joined(separator: "+")
}

func menuItemJSON(_ item: AXUIElement, depth: Int, maxDepth: Int) -> JSON? {
  let values = axAttributes(item, ["AXTitle", "AXEnabled", "AXMenuItemMarkChar", "AXMenuItemCmdChar", "AXMenuItemCmdModifiers", "AXChildren"])
  guard let title = values[0] as? String, !title.isEmpty else { return nil }
  var info: JSON = ["title": title]
  if let enabled = (values[1] as? NSNumber)?.boolValue, !enabled { info["enabled"] = false }
  if let mark = values[2] as? String, !mark.isEmpty { info["checked"] = true }
  if let key = values[3] as? String, !key.isEmpty {
    info["shortcut"] = shortcutText(key, (values[4] as? NSNumber)?.intValue ?? 0)
  }
  if let submenu = (values[5] as? [AXUIElement])?.first {
    info["submenu"] = true
    if depth < maxDepth {
      info["items"] = axChildren(submenu).compactMap { menuItemJSON($0, depth: depth + 1, maxDepth: maxDepth) }
    }
  }
  return info
}

func normalizedTitle(_ title: String) -> String {
  var text = title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().replacingOccurrences(of: "…", with: "...")
  while text.hasSuffix("...") { text = String(text.dropLast(3)).trimmingCharacters(in: .whitespaces) }
  return text
}

func matchMenuItem(_ items: [AXUIElement], _ wanted: String) -> AXUIElement? {
  let target = normalizedTitle(wanted)
  let titled = items.map { (item: $0, title: normalizedTitle(axString($0, "AXTitle") ?? "")) }
  if let exact = titled.first(where: { $0.title == target }) { return exact.item }
  let prefixed = titled.filter { !target.isEmpty && $0.title.hasPrefix(target) }
  return prefixed.count == 1 ? prefixed[0].item : nil
}

/// Walk the menu bar along `path`; returns the item reached and the menu items below it.
func descendMenu(_ app: NSRunningApplication, _ path: [String]) throws -> (item: AXUIElement?, children: [AXUIElement], titles: [String]) {
  var children = axChildren(try menuBar(of: app))
  var item: AXUIElement?
  var titles: [String] = []
  for wanted in path {
    guard let match = matchMenuItem(children, wanted) else {
      let available = children.compactMap { axString($0, "AXTitle") }.filter { !$0.isEmpty }
      let place = titles.isEmpty ? "the menu bar" : "\"" + titles.joined(separator: " > ") + "\""
      throw notFound("No menu item \"\(wanted)\" in \(place). Available: \(available.joined(separator: ", "))")
    }
    titles.append(axString(match, "AXTitle") ?? wanted)
    item = match
    children = axChildren(match).first.map { axChildren($0) } ?? []
  }
  return (item, children, titles)
}

func targetApplication(_ params: JSON) throws -> NSRunningApplication {
  if params.integer("pid") != nil || params.string("bundle_id") != nil || params.string("name") != nil {
    return try findApplication(params)
  }
  guard let front = NSWorkspace.shared.frontmostApplication else { throw notFound("No application is frontmost") }
  return front
}

func menuList(_ params: JSON) throws -> JSON {
  try requireAccessibility()
  let app = try targetApplication(params)
  let located = try descendMenu(app, params.strings("path"))
  let maxDepth = max(0, min(params.integer("max_depth") ?? 1, 6))
  let items = located.children.compactMap { menuItemJSON($0, depth: 0, maxDepth: maxDepth) }
  return ["application": app.localizedName ?? "", "pid": Int(app.processIdentifier), "path": located.titles, "items": items]
}

func menuSelect(_ params: JSON) throws -> JSON {
  try requireAccessibility()
  let app = try targetApplication(params)
  let path = params.strings("path")
  guard !path.isEmpty else { throw invalid("path must name at least one menu") }
  let located = try descendMenu(app, path)
  guard let item = located.item else { throw invalid("path must name at least one menu") }
  if axBool(item, "AXEnabled") == false {
    throw failed("The menu item \"\(located.titles.joined(separator: " > "))\" is disabled right now")
  }
  if !located.children.isEmpty {
    throw invalid("\"\(located.titles.joined(separator: " > "))\" is a submenu; add the item to choose from it")
  }
  let status = AXUIElementPerformAction(item, "AXPress" as CFString)
  guard status == .success || status == .cannotComplete else {
    throw failed("Choosing the menu item failed (accessibility error \(status.rawValue))")
  }
  return ["application": app.localizedName ?? "", "selected": located.titles]
}
