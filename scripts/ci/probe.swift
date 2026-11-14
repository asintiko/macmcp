// Throwaway diagnostic for GitHub macOS runners: which desktop APIs actually work in CI?
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

func line(_ s: String) { print("PROBE " + s) }

line("ax_trusted=\(AXIsProcessTrusted())")
line("screen_capture_preflight=\(CGPreflightScreenCaptureAccess())")

var count: UInt32 = 0
CGGetActiveDisplayList(0, nil, &count)
var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
CGGetActiveDisplayList(count, &ids, &count)
for id in ids {
    let b = CGDisplayBounds(id)
    line("display id=\(id) main=\(CGDisplayIsMain(id)) bounds=\(b.origin.x),\(b.origin.y),\(b.size.width),\(b.size.height) pixels=\(CGDisplayPixelsWide(id))x\(CGDisplayPixelsHigh(id))")
}
for s in NSScreen.screens {
    line("nsscreen frame=\(s.frame) scale=\(s.backingScaleFactor)")
}

func cursor() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }
line("cursor_before=\(cursor())")
let src = CGEventSource(stateID: .hidSystemState)
for target in [CGPoint(x: 200, y: 200), CGPoint(x: 333, y: 444)] {
    if let ev = CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: target, mouseButton: .left) {
        ev.post(tap: .cghidEventTap)
    }
    usleep(250_000)
    line("cursor_after_move_to_\(Int(target.x))_\(Int(target.y))=\(cursor())")
}

if let front = NSWorkspace.shared.frontmostApplication {
    line("frontmost=\(front.localizedName ?? "?") pid=\(front.processIdentifier)")
    let app = AXUIElementCreateApplication(front.processIdentifier)
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value)
    let n = (value as? [AXUIElement])?.count ?? -1
    line("ax_windows_err=\(err.rawValue) count=\(n)")
}

let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
if let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] {
    line("cg_windows=\(list.count)")
    for w in list.prefix(8) {
        let owner = w[kCGWindowOwnerName as String] as? String ?? "?"
        let name = w[kCGWindowName as String] as? String ?? "<no title>"
        let layer = w[kCGWindowLayer as String] as? Int ?? -1
        line("window owner=\(owner) name=\(name) layer=\(layer)")
    }
}

// Type text if asked: `probe type <text>`
let args = CommandLine.arguments
if args.count >= 3, args[1] == "type" {
    let text = Array(args[2].utf16)
    for down in [true, false] {
        if let ev = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down) {
            ev.keyboardSetUnicodeString(stringLength: text.count, unicodeString: text)
            ev.post(tap: .cghidEventTap)
        }
        usleep(50_000)
    }
    line("typed=\(args[2])")
}
