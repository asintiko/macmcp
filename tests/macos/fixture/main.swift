import AppKit
import Foundation

// Test fixture for the desktop tools: a small application that reports every input event it
// receives as one JSON object per line on standard output. The macOS test suite drives it with
// the real tools (mouse, keyboard, windows, menus, Accessibility) and compares what arrived.

func report(_ event: String, _ fields: [String: Any] = [:]) {
  var record = fields
  record["event"] = event
  guard JSONSerialization.isValidJSONObject(record), let data = try? JSONSerialization.data(withJSONObject: record, options: []) else { return }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

func modifierNames(_ flags: NSEvent.ModifierFlags) -> [String] {
  var names: [String] = []
  if flags.contains(.command) { names.append("cmd") }
  if flags.contains(.shift) { names.append("shift") }
  if flags.contains(.option) { names.append("alt") }
  if flags.contains(.control) { names.append("ctrl") }
  return names
}

/// A rectangle in the coordinates CGEvent and Accessibility use: points from the top-left
/// corner of the main display.
@MainActor
func globalRect(_ rect: NSRect) -> [String: Any] {
  let screenHeight = NSScreen.screens.first?.frame.height ?? 0
  return [
    "x": Double(rect.origin.x),
    "y": Double(screenHeight - rect.origin.y - rect.height),
    "width": Double(rect.width),
    "height": Double(rect.height),
  ]
}

@MainActor
func screenFrame(of view: NSView) -> [String: Any] {
  guard let window = view.window else { return [:] }
  return globalRect(window.convertToScreen(view.convert(view.bounds, to: nil)))
}

/// A magenta area that reports mouse, scroll and key events with positions relative to its
/// top-left corner.
final class Canvas: NSView {
  override var acceptsFirstResponder: Bool { return true }
  override var isFlipped: Bool { return true }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { return true }

  override func draw(_ dirtyRect: NSRect) {
    NSColor(srgbRed: 1, green: 0, blue: 1, alpha: 1).setFill()
    bounds.fill()
  }

  private func position(_ event: NSEvent) -> [String: Any] {
    let point = convert(event.locationInWindow, from: nil)
    return ["x": Double(point.x), "y": Double(point.y), "button": event.buttonNumber, "modifiers": modifierNames(event.modifierFlags)]
  }

  private func click(_ name: String, _ event: NSEvent) {
    var fields = position(event)
    fields["clicks"] = event.clickCount
    report(name, fields)
  }

  override func mouseDown(with event: NSEvent) { click("mouse_down", event) }
  override func mouseUp(with event: NSEvent) { click("mouse_up", event) }
  override func rightMouseDown(with event: NSEvent) { click("mouse_down", event) }
  override func rightMouseUp(with event: NSEvent) { click("mouse_up", event) }
  override func otherMouseDown(with event: NSEvent) { click("mouse_down", event) }
  override func otherMouseUp(with event: NSEvent) { click("mouse_up", event) }
  override func mouseDragged(with event: NSEvent) { report("mouse_dragged", position(event)) }
  override func rightMouseDragged(with event: NSEvent) { report("mouse_dragged", position(event)) }

  override func scrollWheel(with event: NSEvent) {
    report("scroll", ["dx": Double(event.scrollingDeltaX), "dy": Double(event.scrollingDeltaY), "modifiers": modifierNames(event.modifierFlags)])
  }

  override func keyDown(with event: NSEvent) {
    report("key", ["characters": event.charactersIgnoringModifiers ?? "", "code": Int(event.keyCode), "modifiers": modifierNames(event.modifierFlags)])
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSTextFieldDelegate {
  var window: NSWindow!
  var field: NSTextField!
  var button: NSButton!
  var checkbox: NSButton!
  var canvas: Canvas!

  func applicationDidFinishLaunching(_ notification: Notification) {
    buildMenu()
    let screenHeight = NSScreen.screens.first?.frame.height ?? 768
    let size = NSSize(width: 640, height: 420)
    let origin = NSPoint(x: 80, y: screenHeight - 110 - size.height)
    window = NSWindow(
      contentRect: NSRect(origin: origin, size: size),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    window.title = "mcpclaude fixture"
    window.delegate = self
    window.isReleasedWhenClosed = false

    guard let content = window.contentView else { return }
    field = NSTextField(frame: NSRect(x: 20, y: size.height - 50, width: 280, height: 24))
    field.placeholderString = "Type here"
    field.delegate = self
    field.target = self
    field.action = #selector(AppDelegate.submitted(_:))
    content.addSubview(field)

    button = NSButton(title: "Press Me", target: self, action: #selector(AppDelegate.pressed(_:)))
    button.frame = NSRect(x: 320, y: size.height - 54, width: 120, height: 32)
    content.addSubview(button)

    checkbox = NSButton(checkboxWithTitle: "Enable option", target: self, action: #selector(AppDelegate.toggled(_:)))
    checkbox.frame = NSRect(x: 460, y: size.height - 50, width: 160, height: 24)
    content.addSubview(checkbox)

    canvas = Canvas(frame: NSRect(x: 20, y: 20, width: size.width - 40, height: size.height - 100))
    content.addSubview(canvas)

    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { self.announce("ready") }
  }

  /// Report where everything is, so the tests know where to point.
  func announce(_ event: String) {
    report(event, [
      "pid": Int(ProcessInfo.processInfo.processIdentifier),
      "window_number": window.windowNumber,
      "window": globalRect(window.frame),
      "field": screenFrame(of: field),
      "button": screenFrame(of: button),
      "checkbox": screenFrame(of: checkbox),
      "canvas": screenFrame(of: canvas),
      "active": NSApp.isActive,
      "key": window.isKeyWindow,
      "value": field.stringValue,
      "checked": checkbox.state == .on,
    ])
  }

  func buildMenu() {
    let mainMenu = NSMenu()

    let appItem = NSMenuItem()
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "Quit Fixture", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu
    mainMenu.addItem(appItem)

    // Without an Edit menu the standard shortcuts (select all, copy, paste) do nothing.
    let editItem = NSMenuItem()
    let editMenu = NSMenu(title: "Edit")
    editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = editMenu
    mainMenu.addItem(editItem)

    let fixtureItem = NSMenuItem()
    let fixtureMenu = NSMenu(title: "Fixture")
    let pingItem = NSMenuItem(title: "Ping", action: #selector(AppDelegate.ping(_:)), keyEquivalent: "k")
    pingItem.keyEquivalentModifierMask = [.command, .shift]
    pingItem.target = self
    fixtureMenu.addItem(pingItem)
    let stateItem = NSMenuItem(title: "Report State", action: #selector(AppDelegate.reportState(_:)), keyEquivalent: "")
    stateItem.target = self
    fixtureMenu.addItem(stateItem)
    let echoItem = NSMenuItem(title: "Echo", action: nil, keyEquivalent: "")
    let echoMenu = NSMenu(title: "Echo")
    let deepItem = NSMenuItem(title: "Deep Item…", action: #selector(AppDelegate.deep(_:)), keyEquivalent: "")
    deepItem.target = self
    echoMenu.addItem(deepItem)
    echoItem.submenu = echoMenu
    fixtureMenu.addItem(echoItem)
    // No action: AppKit shows it disabled.
    fixtureMenu.addItem(NSMenuItem(title: "Unavailable", action: nil, keyEquivalent: ""))
    fixtureItem.submenu = fixtureMenu
    mainMenu.addItem(fixtureItem)

    NSApp.mainMenu = mainMenu
  }

  @objc func pressed(_ sender: Any?) { report("button", ["title": button.title]) }
  @objc func toggled(_ sender: Any?) { report("checkbox", ["checked": checkbox.state == .on]) }
  @objc func submitted(_ sender: Any?) { report("submit", ["value": field.stringValue]) }
  @objc func ping(_ sender: Any?) { report("menu", ["title": "Ping", "value": field.stringValue]) }
  @objc func deep(_ sender: Any?) { report("menu", ["title": "Deep Item"]) }
  @objc func reportState(_ sender: Any?) { announce("state") }

  func controlTextDidChange(_ notification: Notification) { report("text", ["value": field.stringValue]) }

  func windowDidMove(_ notification: Notification) { report("window_moved", ["window": globalRect(window.frame)]) }
  func windowDidResize(_ notification: Notification) { report("window_resized", ["window": globalRect(window.frame)]) }
  func windowDidMiniaturize(_ notification: Notification) { report("window_minimized") }
  func windowDidDeminiaturize(_ notification: Notification) { report("window_restored") }
  func windowDidBecomeKey(_ notification: Notification) { report("window_key") }
  func windowWillClose(_ notification: Notification) { report("window_closed") }

  func applicationDidBecomeActive(_ notification: Notification) { report("active") }
  func applicationDidResignActive(_ notification: Notification) { report("inactive") }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { return true }
  func applicationWillTerminate(_ notification: Notification) { report("terminated") }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
