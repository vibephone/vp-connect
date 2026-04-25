// vp-helper — native macOS event-injection helper for vp-connect.
//
// Replaces the JXA (osascript -l JavaScript) helper that vp-connect used
// up through 1.6.x. The wire protocol is identical so the Node parent can
// fall back to JXA if this binary is missing/unrunnable. Why a native
// build:
//
//   • JXA goes through Apple Events + a JavaScriptCore interpreter, which
//     adds 1–3 ms of jitter per event and occasionally hits 10–30 ms tail
//     spikes (GC, NSFileHandle.availableData wakeups). Pointer drags feel
//     it because they're high-frequency.
//   • Native code goes straight to CoreGraphics with sub-100 µs latency
//     per event and zero GC pauses, which is what makes the trackpad feel
//     "MacBook-quality" rather than "remote-desktop-quality".
//
// Single file, no SwiftPM scaffolding — compiled with:
//
//     swiftc -O vp-helper.swift -o vp-helper -framework CoreGraphics -framework Foundation
//
// Universal binary build (arm64 + x86_64) is the responsibility of the
// `build.sh` script next to this file. The shipped binary is ad-hoc
// signed (`codesign -s -`) so macOS Gatekeeper / TCC don't choke on an
// unsigned helper child of the (also-unsigned) `node` parent.
//
// Protocol (line-oriented over stdin, newline-terminated):
//
//   "K:code,flags"   → keyboard event. code = CGKeyCode (virtual key),
//                      flags = bitmask of CGEventFlags (Shift/Ctrl/Alt/Cmd).
//   "M:dx,dy"        → relative mouse move in points. We sample the
//                      current cursor location and apply the scaled delta.
//   "C:left|right"   → mouse click at the current cursor location.
//   "dx,dy"          → pixel-smooth scroll wheel (legacy, no prefix). Same
//                      sign convention as Apple's CGScrollWheel: positive
//                      dy = content moves down.
//
// Anything malformed is silently ignored — we never want a stray byte to
// crash the helper and leave the user without a trackpad.

import Foundation
import CoreGraphics

// ── stderr logger (debug) ──────────────────────────────────────────────────
// Cheap unbuffered logger used to verify that lines actually reach this
// process and that CGEvent calls return what we expect. The LaunchAgent
// captures stderr to /tmp/vp-connect-err.log.

let dbg = FileHandle.standardError
@inline(__always)
func log(_ s: String) {
    if let d = (s + "\n").data(using: .utf8) { dbg.write(d) }
}

// ── Tunables (env-var) ──────────────────────────────────────────────────────

/// Cursor-acceleration multiplier. The phone sends raw point deltas from a
/// finger drag; we scale them into Mac screen points. 1.0 = 1pt-finger →
/// 1pt-Mac (sluggish on a 6.9" phone). Default 1.7 was chosen empirically
/// to feel close to a real MacBook trackpad.
let pointerSensitivity: CGFloat = {
    if let s = ProcessInfo.processInfo.environment["VP_POINTER_SENSITIVITY"],
       let v = Double(s), v > 0 {
        return CGFloat(v)
    }
    return 1.7
}()

// ── Cursor query ────────────────────────────────────────────────────────────

/// Read the cursor's current location in global display coordinates.
/// Returns nil only if CGEvent allocation fails — should never happen on
/// a properly-permissioned process. Each call ~5 µs.
@inline(__always)
func currentCursor() -> CGPoint? {
    guard let evt = CGEvent(source: nil) else { return nil }
    return evt.location
}

// ── Event posting ───────────────────────────────────────────────────────────

func postKey(code: Int, flags: Int) {
    let kc = CGKeyCode(code & 0xFFFF)
    log("[postKey] enter code=\(code) flags=0x\(String(flags, radix: 16))")
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: kc, keyDown: true) else {
        log("[postKey] FAILED to create down event")
        return
    }
    guard let up = CGEvent(keyboardEventSource: nil, virtualKey: kc, keyDown: false) else {
        log("[postKey] FAILED to create up event")
        return
    }
    if flags != 0 {
        let f = CGEventFlags(rawValue: UInt64(flags))
        down.flags = f
        up.flags   = f
    }
    // kCGHIDEventTap routes the synthetic event into the normal pipeline
    // so the frontmost app receives it like a real keyboard press.
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
    log("[postKey] posted down+up (code=\(code))")
}

func postMouseMove(dx: Int, dy: Int) {
    guard let cur = currentCursor() else { return }
    let nx = cur.x + CGFloat(dx) * pointerSensitivity
    let ny = cur.y + CGFloat(dy) * pointerSensitivity
    let evt = CGEvent(
        mouseEventSource: nil,
        mouseType: .mouseMoved,
        mouseCursorPosition: CGPoint(x: nx, y: ny),
        mouseButton: .left   // ignored for mouseMoved but the API requires it
    )
    evt?.post(tap: .cghidEventTap)
}

func postMouseClick(button: String) {
    guard let cur = currentCursor() else { return }
    let isRight   = (button == "right")
    let downType: CGEventType   = isRight ? .rightMouseDown : .leftMouseDown
    let upType:   CGEventType   = isRight ? .rightMouseUp   : .leftMouseUp
    let btn:      CGMouseButton = isRight ? .right : .left

    guard let down = CGEvent(mouseEventSource: nil, mouseType: downType,
                             mouseCursorPosition: cur, mouseButton: btn),
          let up   = CGEvent(mouseEventSource: nil, mouseType: upType,
                             mouseCursorPosition: cur, mouseButton: btn)
    else { return }
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
}

func postScroll(dx: Int, dy: Int) {
    // CGEvent(scrollWheelEvent2Source:units:wheelCount:wheel1:wheel2:wheel3:)
    //   units: .pixel  → sub-line precision (real trackpad style)
    //   wheel1 = vertical (positive scrolls content down)
    //   wheel2 = horizontal (positive scrolls content right)
    // The Mac applies the user's natural-scroll setting on top for us.
    guard let evt = CGEvent(
        scrollWheelEvent2Source: nil,
        units: .pixel,
        wheelCount: 2,
        wheel1: Int32(dy),
        wheel2: Int32(dx),
        wheel3: 0
    ) else { return }
    // Stamp the event with the current cursor location so it routes to
    // whatever scroll view the user is hovering over. No `cachedFrame`
    // gymnastics any more — with the new mouse trackpad the phone user
    // explicitly parks the pointer wherever they want, so "wherever the
    // cursor is" is unambiguously the right target on every platform.
    if let cur = currentCursor() {
        evt.location = cur
    }
    evt.post(tap: .cghidEventTap)
}

// ── Line dispatcher ─────────────────────────────────────────────────────────

@inline(__always)
func parseIntPair(_ s: Substring) -> (Int, Int)? {
    let parts = s.split(separator: ",", maxSplits: 1, omittingEmptySubsequences: false)
    guard parts.count == 2,
          let a = Int(parts[0].trimmingCharacters(in: .whitespaces)),
          let b = Int(parts[1].trimmingCharacters(in: .whitespaces))
    else { return nil }
    return (a, b)
}

func handleLine(_ raw: String) {
    let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if line.isEmpty { return }

    // Keyboard: "K:code,flags"
    if line.hasPrefix("K:") {
        log("[handleLine] K: \(line)")
        if let (code, flags) = parseIntPair(line.dropFirst(2)) {
            postKey(code: code, flags: flags)
        } else {
            log("[handleLine] K: parse failed for \(line)")
        }
        return
    }

    // Mouse move: "M:dx,dy"
    if line.hasPrefix("M:") {
        if let (dx, dy) = parseIntPair(line.dropFirst(2)) {
            if dx != 0 || dy != 0 { postMouseMove(dx: dx, dy: dy) }
        }
        return
    }

    // Mouse click: "C:left" / "C:right"
    if line.hasPrefix("C:") {
        let btn = line.dropFirst(2).trimmingCharacters(in: .whitespaces)
        postMouseClick(button: btn)
        return
    }

    // Scroll: "dx,dy" (legacy, unprefixed)
    if let (dx, dy) = parseIntPair(Substring(line)) {
        if dx != 0 || dy != 0 { postScroll(dx: dx, dy: dy) }
    }
}

// ── stdin loop ──────────────────────────────────────────────────────────────
//
// `readLine` is line-buffered and blocks until the next newline arrives.
// That's exactly what we want: vp-connect (Node) sends one event per line
// with `socket.setNoDelay(true)` so they hit our stdin promptly. We don't
// need our own polling loop or async runtime — just drain forever.

while let line = readLine(strippingNewline: true) {
    handleLine(line)
}
