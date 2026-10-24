// OxoFlow PasteHelper for macOS - same contract as PasteHelper.cs (Windows):
// simulates the paste shortcut (Cmd+V) with CGEvent and prints one JSON line.
//
//   PasteHelperMac [--dry-run] [--delay <ms>] [--info] [--trusted [--prompt]]
//
//   --info      frontmost application {process, bundle}
//   --trusted   {"trusted": bool}: Accessibility permission, needed to post key
//               events; --prompt also opens the system dialog asking for it
//
// Exit codes: 0 pasted (or dry-run/info), 2 blocked (no Accessibility permission),
// 3 unexpected error.
// Build: swiftc -O -o native/PasteHelperMac native/PasteHelperMac.swift
import AppKit
import ApplicationServices
import Foundation

func esc(_ s: String) -> String {
    s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        .replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\r", with: "")
}

func emit(_ fields: [(String, String)], raw: [(String, String)] = []) {
    let parts = fields.map { "\"\($0.0)\":\"\(esc($0.1))\"" } + raw.map { "\"\($0.0)\":\($0.1)" }
    print("{" + parts.joined(separator: ",") + "}")
}

var dryRun = false, info = false, trusted = false, prompt = false
var delayMs = 0
var args = CommandLine.arguments.dropFirst().makeIterator()
while let a = args.next() {
    switch a {
    case "--dry-run": dryRun = true
    case "--info": info = true
    case "--trusted": trusted = true
    case "--prompt": prompt = true
    case "--delay": delayMs = Int(args.next() ?? "") ?? 0
    case "--shift-insert", "--no-release": break   // Windows-only options, accepted for symmetry
    case "-h", "--help":
        print("PasteHelperMac [--dry-run] [--delay ms] [--info] [--trusted [--prompt]]")
        exit(0)
    default: break
    }
}

let front = NSWorkspace.shared.frontmostApplication
let proc = front?.localizedName ?? ""
let bundle = front?.bundleIdentifier ?? ""

if trusted {
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
    emit([("outcome", "trusted")], raw: [("trusted", AXIsProcessTrustedWithOptions(opts) ? "true" : "false")])
    exit(0)
}
if info {
    emit([("outcome", "info"), ("process", proc), ("bundle", bundle)])
    exit(0)
}

var plan = ""
if delayMs > 0 {
    plan += "sleep \(delayMs)ms | "
    if !dryRun { usleep(useconds_t(delayMs * 1000)) }
}
plan += "paste(Cmd+V)"
if dryRun {
    emit([("outcome", "dry-run"), ("process", proc), ("bundle", bundle), ("plan", plan)])
    exit(0)
}
// Without the Accessibility permission macOS silently drops posted events,
// so report it instead of claiming a paste.
guard AXIsProcessTrusted() else {
    emit([("outcome", "blocked"), ("reason", "accessibility"), ("process", proc), ("bundle", bundle), ("plan", plan)])
    exit(2)
}
let vKey: CGKeyCode = 9   // kVK_ANSI_V
guard let src = CGEventSource(stateID: .combinedSessionState),
      let down = CGEvent(keyboardEventSource: src, virtualKey: vKey, keyDown: true),
      let up = CGEvent(keyboardEventSource: src, virtualKey: vKey, keyDown: false) else {
    emit([("outcome", "failed"), ("error", "CGEvent unavailable")])
    exit(3)
}
// Explicit flags: modifiers the user may still hold from the trigger shortcut
// (Ctrl, Option...) must not turn Cmd+V into another chord.
down.flags = .maskCommand
up.flags = .maskCommand
// Short pauses: macOS drops events of a process that exits right after posting them.
down.post(tap: .cghidEventTap)
usleep(15_000)
up.post(tap: .cghidEventTap)
usleep(50_000)
emit([("outcome", "pasted"), ("process", proc), ("bundle", bundle), ("plan", plan)])
exit(0)
