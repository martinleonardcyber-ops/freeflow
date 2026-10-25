// OxoFlow fn-key listener for macOS: Wispr Flow's "hold fn to talk".
// Electron's globalShortcut and uiohook cannot see the fn (globe) key, so this
// long-running helper watches it with a listen-only CGEventTap and prints one
// line per event on stdout:
//
//   ready        the tap is installed
//   down / up    fn pressed / released (alone)
//   spoil        another key was pressed while fn was held (fn+F1, fn+arrows...):
//                not a dictation
//   denied       no permission to listen to the keyboard (Accessibility /
//                Input Monitoring); the process then exits with code 2
//
// Build: swiftc -O -o native/FnKeyMac native/FnKeyMac.swift
import ApplicationServices
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)
func say(_ s: String) { print(s); fflush(stdout) }

let kVKFunction: Int64 = 63
var fnDown = false
var tapPort: CFMachPort?   // global: a C callback cannot capture context

let mask: CGEventMask = (1 << CGEventType.flagsChanged.rawValue) | (1 << CGEventType.keyDown.rawValue)
let callback: CGEventTapCallBack = { _, type, event, _ in
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let t = tapPort { CGEvent.tapEnable(tap: t, enable: true) }   // macOS disables slow taps
        return Unmanaged.passUnretained(event)
    }
    if type == .flagsChanged && event.getIntegerValueField(.keyboardEventKeycode) == kVKFunction {
        let down = event.flags.contains(.maskSecondaryFn)
        if down != fnDown {
            fnDown = down
            say(down ? "down" : "up")
        }
    } else if fnDown {
        // Any other key (or modifier) while fn is held: a fn shortcut, not a dictation.
        say("spoil")
    }
    return Unmanaged.passUnretained(event)
}

guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                                  eventsOfInterest: mask, callback: callback, userInfo: nil) else {
    // Adds OxoFlow to Privacy & Security › Input Monitoring and asks the user (once).
    _ = CGRequestListenEventAccess()
    say("denied")
    exit(2)
}
tapPort = tap
CFRunLoopAddSource(CFRunLoopGetCurrent(), CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0), .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
say("ready")

// Quit with the parent: stdin closes when OxoFlow exits.
DispatchQueue.global().async {
    while readLine() != nil {}
    exit(0)
}
CFRunLoopRun()
