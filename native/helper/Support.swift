import AppKit
import ApplicationServices
import Foundation

/// An error reported to the Node side with a stable code.
struct HelperError: Error {
  let code: String
  let message: String
}

func invalid(_ message: String) -> HelperError { HelperError(code: "INVALID", message: message) }
func notFound(_ message: String) -> HelperError { HelperError(code: "NOT_FOUND", message: message) }
func failed(_ message: String) -> HelperError { HelperError(code: "FAILED", message: message) }

typealias JSON = [String: Any]

extension Dictionary where Key == String, Value == Any {
  func string(_ key: String) -> String? { self[key] as? String }
  func double(_ key: String) -> Double? { (self[key] as? NSNumber)?.doubleValue }
  func integer(_ key: String) -> Int? { (self[key] as? NSNumber)?.intValue }
  func flag(_ key: String, fallback: Bool = false) -> Bool { (self[key] as? NSNumber)?.boolValue ?? fallback }
  func strings(_ key: String) -> [String] { (self[key] as? [Any] ?? []).compactMap { $0 as? String } }

  func requireDouble(_ key: String) throws -> Double {
    guard let value = double(key) else { throw invalid("Missing numeric parameter \"\(key)\"") }
    return value
  }

  func requireString(_ key: String) throws -> String {
    guard let value = string(key) else { throw invalid("Missing text parameter \"\(key)\"") }
    return value
  }

  func point(_ xKey: String = "x", _ yKey: String = "y") throws -> CGPoint {
    let x = try requireDouble(xKey)
    let y = try requireDouble(yKey)
    return CGPoint(x: x, y: y)
  }
}

func rectJSON(_ rect: CGRect) -> JSON {
  return [
    "x": Double(rect.origin.x),
    "y": Double(rect.origin.y),
    "width": Double(rect.size.width),
    "height": Double(rect.size.height),
  ]
}

/// Sleep for a number of milliseconds.
func pause(_ milliseconds: Double) {
  if milliseconds > 0 { usleep(UInt32(milliseconds * 1000)) }
}

/// Let AppKit process notifications (application and window state) for a moment.
func pump(_ seconds: Double) {
  RunLoop.current.run(until: Date().addingTimeInterval(seconds))
}

func requireAccessibility() throws {
  if !AXIsProcessTrusted() {
    throw HelperError(code: "ACCESSIBILITY_REQUIRED", message: "macOS has not granted Accessibility access to the application that runs mcpclaude")
  }
}

func requireEventPosting() throws {
  if !(AXIsProcessTrusted() || CGPreflightPostEventAccess()) {
    throw HelperError(code: "ACCESSIBILITY_REQUIRED", message: "macOS has not granted Accessibility access to the application that runs mcpclaude, so mouse and keyboard events are discarded")
  }
}

func permissions(_ params: JSON) -> JSON {
  let prompt = params.flag("prompt")
  var accessibility = AXIsProcessTrusted()
  if prompt && !accessibility {
    let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
    accessibility = AXIsProcessTrustedWithOptions(options)
  }
  var screenRecording = CGPreflightScreenCaptureAccess()
  if prompt && !screenRecording {
    screenRecording = CGRequestScreenCaptureAccess()
  }
  return ["accessibility": accessibility, "screen_recording": screenRecording]
}

func displays() -> [JSON] {
  var count: UInt32 = 0
  CGGetActiveDisplayList(0, nil, &count)
  var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
  CGGetActiveDisplayList(count, &ids, &count)
  let mainID = CGMainDisplayID()
  var result: [JSON] = []
  for (index, id) in ids.prefix(Int(count)).enumerated() {
    let bounds = CGDisplayBounds(id)
    var pixelWidth = Int(bounds.width)
    var pixelHeight = Int(bounds.height)
    if let mode = CGDisplayCopyDisplayMode(id) {
      pixelWidth = mode.pixelWidth
      pixelHeight = mode.pixelHeight
    }
    let scale = bounds.width > 0 ? Double(pixelWidth) / Double(bounds.width) : 1.0
    result.append([
      "id": Int(id),
      "index": index + 1,
      "main": id == mainID,
      "x": Double(bounds.origin.x),
      "y": Double(bounds.origin.y),
      "width": Double(bounds.width),
      "height": Double(bounds.height),
      "pixel_width": pixelWidth,
      "pixel_height": pixelHeight,
      "scale": scale,
    ])
  }
  return result
}

func cursorPosition() -> JSON {
  let location = CGEvent(source: nil)?.location ?? CGPoint.zero
  return ["x": Double(location.x), "y": Double(location.y)]
}

func clipboardGet() -> JSON {
  let pasteboard = NSPasteboard.general
  var result: JSON = ["types": (pasteboard.types ?? []).map { $0.rawValue }]
  if let text = pasteboard.string(forType: .string) {
    result["text"] = text
  }
  return result
}

func clipboardSet(_ params: JSON) throws -> JSON {
  let text = try params.requireString("text")
  let pasteboard = NSPasteboard.general
  pasteboard.clearContents()
  guard pasteboard.setString(text, forType: .string) else { throw failed("The clipboard did not accept the text") }
  return ["characters": text.count]
}
