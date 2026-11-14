import ApplicationServices
import Carbon.HIToolbox
import Foundation

let eventSource = CGEventSource(stateID: .hidSystemState)

func eventFlags(_ names: [String]) throws -> CGEventFlags {
  var flags = CGEventFlags()
  for name in names {
    switch name {
    case "cmd": flags.insert(.maskCommand)
    case "shift": flags.insert(.maskShift)
    case "alt": flags.insert(.maskAlternate)
    case "ctrl": flags.insert(.maskControl)
    case "fn": flags.insert(.maskSecondaryFn)
    default: throw invalid("Unknown modifier \"\(name)\"")
    }
  }
  return flags
}

// MARK: - Mouse

struct MouseButtonKind {
  let button: CGMouseButton
  let down: CGEventType
  let up: CGEventType
  let dragged: CGEventType
}

func mouseButton(_ name: String?) throws -> MouseButtonKind {
  switch name ?? "left" {
  case "left":
    return MouseButtonKind(button: .left, down: .leftMouseDown, up: .leftMouseUp, dragged: .leftMouseDragged)
  case "right":
    return MouseButtonKind(button: .right, down: .rightMouseDown, up: .rightMouseUp, dragged: .rightMouseDragged)
  case "middle":
    return MouseButtonKind(button: .center, down: .otherMouseDown, up: .otherMouseUp, dragged: .otherMouseDragged)
  default:
    throw invalid("Unknown mouse button \"\(name ?? "")\"")
  }
}

func postMouse(_ type: CGEventType, at point: CGPoint, button: CGMouseButton, clicks: Int64 = 0, flags: CGEventFlags = CGEventFlags()) throws {
  guard let event = CGEvent(mouseEventSource: eventSource, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
    throw failed("Could not create a mouse event")
  }
  if clicks > 0 {
    event.setIntegerValueField(.mouseEventClickState, value: clicks)
  }
  event.flags = flags
  event.post(tap: .cghidEventTap)
}

func mouseMove(_ params: JSON) throws -> JSON {
  try requireEventPosting()
  let point = try params.point()
  if let dragging = params.string("dragging") {
    // With a button held the system reports movement as drag events; applications track those.
    let kind = try mouseButton(dragging)
    let flags = try eventFlags(params.strings("modifiers"))
    try postMouse(kind.dragged, at: point, button: kind.button, clicks: 1, flags: flags)
  } else {
    try postMouse(.mouseMoved, at: point, button: .left)
  }
  pause(20)
  return cursorPosition()
}

func mouseClick(_ params: JSON) throws -> JSON {
  try requireEventPosting()
  let point = try params.point()
  let kind = try mouseButton(params.string("button"))
  let count = max(1, min(params.integer("count") ?? 1, 3))
  let flags = try eventFlags(params.strings("modifiers"))
  let hold = params.double("hold_ms") ?? 40

  try postMouse(.mouseMoved, at: point, button: kind.button)
  pause(30)
  try pressModifiers(flags)
  defer { releaseModifiers(flags) }
  for number in 1...count {
    try postMouse(kind.down, at: point, button: kind.button, clicks: Int64(number), flags: flags)
    pause(hold)
    try postMouse(kind.up, at: point, button: kind.button, clicks: Int64(number), flags: flags)
    if number < count { pause(70) }
  }
  pause(20)
  return cursorPosition()
}

/// Press or release a mouse button without the other half, for drags built from several steps.
func mouseButtonState(_ params: JSON, down: Bool) throws -> JSON {
  try requireEventPosting()
  let point = try params.point()
  let kind = try mouseButton(params.string("button"))
  let flags = try eventFlags(params.strings("modifiers"))
  if down {
    try postMouse(.mouseMoved, at: point, button: kind.button)
    pause(30)
    try postMouse(kind.down, at: point, button: kind.button, clicks: 1, flags: flags)
  } else {
    try postMouse(kind.dragged, at: point, button: kind.button, clicks: 1, flags: flags)
    pause(30)
    try postMouse(kind.up, at: point, button: kind.button, clicks: 1, flags: flags)
  }
  pause(20)
  return cursorPosition()
}

func mouseDrag(_ params: JSON) throws -> JSON {
  try requireEventPosting()
  let from = try params.point("from_x", "from_y")
  let to = try params.point("to_x", "to_y")
  let kind = try mouseButton(params.string("button"))
  let flags = try eventFlags(params.strings("modifiers"))
  let duration = max(50.0, min(params.double("duration_ms") ?? 500.0, 10_000.0))
  let steps = max(2, min(Int(duration / 12.0), 300))

  try postMouse(.mouseMoved, at: from, button: kind.button)
  pause(40)
  try pressModifiers(flags)
  defer { releaseModifiers(flags) }
  try postMouse(kind.down, at: from, button: kind.button, clicks: 1, flags: flags)
  // Applications start a drag only after the button has been held for a moment.
  pause(90)
  for step in 1...steps {
    let progress = Double(step) / Double(steps)
    let x = Double(from.x) + (Double(to.x) - Double(from.x)) * progress
    let y = Double(from.y) + (Double(to.y) - Double(from.y)) * progress
    try postMouse(kind.dragged, at: CGPoint(x: x, y: y), button: kind.button, clicks: 1, flags: flags)
    pause(duration / Double(steps))
  }
  pause(60)
  try postMouse(kind.up, at: to, button: kind.button, clicks: 1, flags: flags)
  pause(20)
  return cursorPosition()
}

func mouseScroll(_ params: JSON) throws -> JSON {
  try requireEventPosting()
  if params.double("x") != nil {
    let point = try params.point()
    try postMouse(.mouseMoved, at: point, button: .left)
    pause(40)
  }
  let flags = try eventFlags(params.strings("modifiers"))
  let unit: CGScrollEventUnit = params.string("unit") == "pixel" ? .pixel : .line
  let chunk: Int32 = unit == .pixel ? 120 : 4
  var remainingX = Int32(params.integer("dx") ?? 0)
  var remainingY = Int32(params.integer("dy") ?? 0)
  // Long distances are sent as several wheel events, as a real wheel would produce them.
  while remainingX != 0 || remainingY != 0 {
    let stepX = max(-chunk, min(chunk, remainingX))
    let stepY = max(-chunk, min(chunk, remainingY))
    guard let event = CGEvent(scrollWheelEvent2Source: eventSource, units: unit, wheelCount: 2, wheel1: stepY, wheel2: stepX, wheel3: 0) else {
      throw failed("Could not create a scroll event")
    }
    event.flags = flags
    event.post(tap: .cghidEventTap)
    remainingX -= stepX
    remainingY -= stepY
    pause(15)
  }
  pause(20)
  return cursorPosition()
}

// MARK: - Keyboard

struct KeyEntry {
  let code: CGKeyCode
  let shift: Bool
}

/// Physical modifier keys, pressed around key strokes and clicks so that applications which
/// read the global modifier state see them too. Fn is only set as a flag: pressing it alone
/// opens the emoji picker or dictation.
let modifierKeys: [(mask: CGEventFlags, code: CGKeyCode)] = [
  (mask: .maskCommand, code: 55),
  (mask: .maskShift, code: 56),
  (mask: .maskAlternate, code: 58),
  (mask: .maskControl, code: 59),
]

func postKey(_ code: CGKeyCode, down: Bool, flags: CGEventFlags) throws {
  guard let event = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: down) else {
    throw failed("Could not create a keyboard event")
  }
  event.flags = flags
  event.post(tap: .cghidEventTap)
}

func pressModifiers(_ flags: CGEventFlags) throws {
  var active = CGEventFlags()
  for entry in modifierKeys where flags.contains(entry.mask) {
    active.insert(entry.mask)
    try postKey(entry.code, down: true, flags: active)
    pause(8)
  }
}

func releaseModifiers(_ flags: CGEventFlags) {
  var active = flags
  for entry in modifierKeys.reversed() where flags.contains(entry.mask) {
    active.remove(entry.mask)
    try? postKey(entry.code, down: false, flags: active)
    pause(8)
  }
}

/// Key positions of a US keyboard, used when the current layout has no key for a character.
let ansiKeys: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
  "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
  "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34,
  "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46,
  ".": 47, " ": 49, "`": 50,
]

let ansiShiftedKeys: [String: CGKeyCode] = [
  "!": 18, "@": 19, "#": 20, "$": 21, "^": 22, "%": 23, "+": 24, "(": 25, "&": 26, "_": 27, "*": 28,
  ")": 29, "}": 30, "{": 33, "\"": 39, ":": 41, "|": 42, "<": 43, "?": 44, ">": 47, "~": 50,
]

/// Keys of the numeric keypad: left out of the layout map so that digits and operators resolve
/// to the main block.
let keypadCodes: Set<Int> = [65, 67, 69, 71, 75, 76, 78, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92]

var layoutMapCache: [String: KeyEntry]?

/// Which key (and whether Shift) produces each character on the user's current keyboard layout.
func layoutMap() -> [String: KeyEntry] {
  if let cached = layoutMapCache { return cached }
  var map: [String: KeyEntry] = [:]
  var sources: [TISInputSource] = []
  if let current = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue() { sources.append(current) }
  if let ascii = TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue() { sources.append(ascii) }

  for source in sources {
    guard let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { continue }
    let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
    data.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
      guard let layout = buffer.bindMemory(to: UCKeyboardLayout.self).baseAddress else { return }
      for shift in [false, true] {
        for code in 0..<128 where !keypadCodes.contains(code) {
          var deadKeys: UInt32 = 0
          var length = 0
          var characters = [UniChar](repeating: 0, count: 4)
          let modifiers: UInt32 = shift ? UInt32((shiftKey >> 8) & 0xFF) : 0
          let status = UCKeyTranslate(
            layout,
            UInt16(code),
            UInt16(kUCKeyActionDown),
            modifiers,
            UInt32(LMGetKbdType()),
            OptionBits(1 << kUCKeyTranslateNoDeadKeysBit),
            &deadKeys,
            characters.count,
            &length,
            &characters
          )
          if status == noErr && length > 0 {
            let text = String(utf16CodeUnits: characters, count: length)
            if map[text] == nil && !text.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) {
              map[text] = KeyEntry(code: CGKeyCode(code), shift: shift)
            }
          }
        }
      }
    }
    if !map.isEmpty { break }
  }
  layoutMapCache = map
  return map
}

func keyForCharacter(_ character: String) -> KeyEntry? {
  let map = layoutMap()
  if let entry = map[character] { return entry }
  let lower = character.lowercased()
  if lower != character, let entry = map[lower] { return KeyEntry(code: entry.code, shift: true) }
  if let code = ansiKeys[character] { return KeyEntry(code: code, shift: false) }
  if lower != character, let code = ansiKeys[lower] { return KeyEntry(code: code, shift: true) }
  if let code = ansiShiftedKeys[character] { return KeyEntry(code: code, shift: true) }
  return nil
}

func typeText(_ text: String, delay: Double) throws {
  for character in text {
    if character == "\n" || character == "\r" || character == "\r\n" {
      try postKey(36, down: true, flags: CGEventFlags())
      try postKey(36, down: false, flags: CGEventFlags())
    } else if character == "\t" {
      try postKey(48, down: true, flags: CGEventFlags())
      try postKey(48, down: false, flags: CGEventFlags())
    } else {
      // Sent as text rather than key codes, so it does not depend on the keyboard layout.
      let units = Array(String(character).utf16)
      guard let down = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: true),
        let up = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: false)
      else {
        throw failed("Could not create a keyboard event")
      }
      down.flags = CGEventFlags()
      up.flags = CGEventFlags()
      down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
      up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
      down.post(tap: .cghidEventTap)
      up.post(tap: .cghidEventTap)
    }
    pause(delay)
  }
}

func keyboardType(_ params: JSON) throws -> JSON {
  try requireEventPosting()
  let text = try params.requireString("text")
  try typeText(text, delay: max(0.0, min(params.double("delay_ms") ?? 6.0, 500.0)))
  pause(20)
  return ["characters": text.count]
}

/// Resolve a key given as a virtual key code or as the character it produces.
func resolveKey(_ params: JSON, flags: inout CGEventFlags) throws -> CGKeyCode? {
  if let code = params.integer("code") {
    return CGKeyCode(code)
  }
  guard let character = params.string("char"), !character.isEmpty else {
    throw invalid("A key needs \"code\" or \"char\"")
  }
  if let entry = keyForCharacter(character) {
    if entry.shift { flags.insert(.maskShift) }
    return entry.code
  }
  return nil
}

func keyboardKey(_ params: JSON) throws -> JSON {
  try requireEventPosting()
  var flags = try eventFlags(params.strings("modifiers"))
  let repeats = max(1, min(params.integer("repeat") ?? 1, 200))
  let hold = max(0.0, min(params.double("hold_ms") ?? 20.0, 10_000.0))

  guard let code = try resolveKey(params, flags: &flags) else {
    // No key produces this character on the current layout: without modifiers it can still be typed.
    let character = params.string("char") ?? ""
    if flags.isEmpty || flags == .maskShift {
      for _ in 0..<repeats { try typeText(character, delay: 6) }
      return ["typed": character]
    }
    throw invalid("No key produces \"\(character)\" on the current keyboard layout")
  }

  try pressModifiers(flags)
  defer { releaseModifiers(flags) }
  for index in 0..<repeats {
    try postKey(code, down: true, flags: flags)
    pause(hold)
    try postKey(code, down: false, flags: flags)
    if index < repeats - 1 { pause(25) }
  }
  pause(20)
  return ["code": Int(code)]
}

/// Press or release one key and leave it that way (held keys, modifier-drags).
func keyboardHold(_ params: JSON, down: Bool) throws -> JSON {
  try requireEventPosting()
  var flags = try eventFlags(params.strings("modifiers"))
  guard let code = try resolveKey(params, flags: &flags) else {
    throw invalid("No key produces \"\(params.string("char") ?? "")\" on the current keyboard layout")
  }
  for entry in modifierKeys where entry.code == code {
    if down { flags.insert(entry.mask) } else { flags.remove(entry.mask) }
  }
  try postKey(code, down: down, flags: flags)
  pause(20)
  return ["code": Int(code)]
}
