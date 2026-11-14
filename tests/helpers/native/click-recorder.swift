import AppKit
import Foundation

// Test tool: a window that records every mouse event it receives, one JSON object per line.
//
//   click-recorder <log file> <x> <y> <width> <height>
//
// The rectangle is the content area in global display points with the origin at the top-left
// of the main display — the coordinate system of the mcpclaude desktop helper. Once the window
// is on screen a {"kind":"ready",...} line reports where it really is; after that every button
// press and release is logged with the button number, the click count, the modifier keys and
// the position macOS delivered. The tool runs until it is killed.

let arguments = CommandLine.arguments
guard arguments.count >= 6,
  let originX = Double(arguments[2]), let originY = Double(arguments[3]),
  let contentWidth = Double(arguments[4]), let contentHeight = Double(arguments[5])
else {
  FileHandle.standardError.write(Data("usage: click-recorder <log file> <x> <y> <width> <height>\n".utf8))
  exit(2)
}

let logPath = arguments[1]
FileManager.default.createFile(atPath: logPath, contents: nil)
guard let logHandle = FileHandle(forWritingAtPath: logPath) else {
  FileHandle.standardError.write(Data("cannot write \(logPath)\n".utf8))
  exit(3)
}

func writeEntry(_ entry: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: entry, options: [.sortedKeys]) else { return }
  logHandle.seekToEndOfFile()
  logHandle.write(data)
  logHandle.write(Data("\n".utf8))
}

func modifierNames(_ flags: NSEvent.ModifierFlags) -> [String] {
  var names: [String] = []
  if flags.contains(.command) { names.append("cmd") }
  if flags.contains(.shift) { names.append("shift") }
  if flags.contains(.option) { names.append("alt") }
  if flags.contains(.control) { names.append("ctrl") }
  return names
}

final class RecorderView: NSView {
  override var acceptsFirstResponder: Bool { return true }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { return true }

  private func record(_ kind: String, _ event: NSEvent) {
    var entry: [String: Any] = [
      "kind": kind,
      "button": event.buttonNumber,
      "clicks": event.clickCount,
      "modifiers": modifierNames(event.modifierFlags),
    ]
    if let location = event.cgEvent?.location {
      entry["x"] = Double(location.x)
      entry["y"] = Double(location.y)
    }
    writeEntry(entry)
  }

  override func mouseDown(with event: NSEvent) { record("down", event) }
  override func mouseUp(with event: NSEvent) { record("up", event) }
  override func rightMouseDown(with event: NSEvent) { record("down", event) }
  override func rightMouseUp(with event: NSEvent) { record("up", event) }
  override func otherMouseDown(with event: NSEvent) { record("down", event) }
  override func otherMouseUp(with event: NSEvent) { record("up", event) }

  override func scrollWheel(with event: NSEvent) {
    writeEntry(["kind": "scroll", "dx": Double(event.scrollingDeltaX), "dy": Double(event.scrollingDeltaY)])
  }

  override func draw(_ dirtyRect: NSRect) {
    NSColor.systemTeal.setFill()
    bounds.fill()
  }
}

let application = NSApplication.shared
application.setActivationPolicy(.regular)

// Cocoa measures from the bottom-left corner of the main display.
let mainHeight = Double(NSScreen.screens.first?.frame.height ?? 0)
let contentRect = NSRect(x: originX, y: mainHeight - originY - contentHeight, width: contentWidth, height: contentHeight)
let window = NSWindow(contentRect: contentRect, styleMask: [.titled], backing: .buffered, defer: false)
window.title = "mcpclaude click recorder"
window.isReleasedWhenClosed = false
window.level = .floating
window.contentView = RecorderView(frame: NSRect(x: 0, y: 0, width: contentWidth, height: contentHeight))
window.setFrame(window.frameRect(forContentRect: contentRect), display: true)
window.makeKeyAndOrderFront(nil)
application.activate(ignoringOtherApps: true)

DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
  let content = window.contentRect(forFrameRect: window.frame)
  var screenNumber = 0
  if let screen = window.screen, let index = NSScreen.screens.firstIndex(of: screen) { screenNumber = index + 1 }
  writeEntry([
    "kind": "ready",
    "pid": Int(ProcessInfo.processInfo.processIdentifier),
    "x": Double(content.minX),
    "y": mainHeight - Double(content.maxY),
    "width": Double(content.width),
    "height": Double(content.height),
    "scale": Double(window.backingScaleFactor),
    "screen": screenNumber,
  ])
}

application.run()
