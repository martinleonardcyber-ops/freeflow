// OxoFlow PasteHelper - tiny console tool that simulates the paste shortcut
// (Ctrl+V, or Shift+Insert with --shift-insert) with SendInput, after releasing
// any modifier key the user may still be holding (mirrors Wispr Flow's
// "WindowsKeyUpSimulation" + PasteText/PasteOutcome flow).
//
//   PasteHelper.exe [--dry-run] [--shift-insert] [--delay <ms>] [--no-release] [--info]
//   PasteHelper.exe --mask   (taps the unassigned key vkE8 so releasing a held Win key
//                             does not open the Start menu - Wispr's "WindowsShortcutMaskingV2")
//
// Exit codes: 0 pasted (or dry-run), 2 blocked (SendInput rejected events, e.g.
// UIPI against an elevated window), 3 unexpected error.
// Build: C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /optimize /target:exe /out:PasteHelper.exe PasteHelper.cs
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class PasteHelper
{
    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Explicit)]
    struct INPUTUNION { [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public long pad1; [FieldOffset(8)] public long pad2; [FieldOffset(16)] public long pad3; }

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public INPUTUNION u; }

    const uint INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_SCANCODE = 0x0008;

    const ushort VK_SHIFT = 0x10, VK_CONTROL = 0x11, VK_MENU = 0x12;
    const ushort VK_LSHIFT = 0xA0, VK_RSHIFT = 0xA1, VK_LCONTROL = 0xA2, VK_RCONTROL = 0xA3;
    const ushort VK_LMENU = 0xA4, VK_RMENU = 0xA5, VK_LWIN = 0x5B, VK_RWIN = 0x5C;
    const ushort VK_INSERT = 0x2D, VK_V = 0x56, VK_SPACE = 0x20;

    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);

    static bool dryRun;
    static StringBuilder plan = new StringBuilder();

    static INPUT Key(ushort vk, bool up)
    {
        var i = new INPUT { type = INPUT_KEYBOARD };
        i.u.ki.wVk = vk;
        i.u.ki.wScan = (ushort)MapVirtualKey(vk, 0);
        i.u.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
        if (vk == VK_INSERT || vk == VK_RCONTROL || vk == VK_RMENU || vk == VK_LWIN || vk == VK_RWIN)
            i.u.ki.dwFlags |= KEYEVENTF_EXTENDEDKEY;
        return i;
    }

    static string Name(ushort vk)
    {
        switch (vk)
        {
            case VK_LSHIFT: return "LShift"; case VK_RSHIFT: return "RShift";
            case VK_LCONTROL: return "LCtrl"; case VK_RCONTROL: return "RCtrl";
            case VK_LMENU: return "LAlt"; case VK_RMENU: return "RAlt";
            case VK_LWIN: return "LWin"; case VK_RWIN: return "RWin";
            case VK_SHIFT: return "Shift"; case VK_CONTROL: return "Ctrl"; case VK_MENU: return "Alt";
            case VK_INSERT: return "Insert"; case VK_V: return "V"; case VK_SPACE: return "Space";
            default: return "VK" + vk;
        }
    }

    // Returns the number of events the OS accepted (or the requested count in dry-run).
    static uint Send(INPUT[] seq, string label)
    {
        var sb = new StringBuilder(label + ":");
        foreach (var e in seq) sb.Append(' ').Append(Name(e.u.ki.wVk)).Append((e.u.ki.dwFlags & KEYEVENTF_KEYUP) != 0 ? "^" : "v");
        plan.Append(sb).Append(" | ");
        if (dryRun) return (uint)seq.Length;
        return SendInput((uint)seq.Length, seq, Marshal.SizeOf(typeof(INPUT)));
    }

    static int Main(string[] args)
    {
        bool shiftInsert = false, release = true, info = false, mask = false;
        int delay = 0;
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--dry-run": dryRun = true; break;
                case "--shift-insert": shiftInsert = true; break;
                case "--no-release": release = false; break;
                case "--info": info = true; break;
                case "--mask": mask = true; break;
                case "--delay": if (i + 1 < args.Length) int.TryParse(args[++i], out delay); break;
                case "-h": case "--help":
                    Console.WriteLine("PasteHelper [--dry-run] [--shift-insert] [--delay ms] [--no-release] [--info]");
                    return 0;
            }
        }
        try
        {
            string fgProc = "", fgTitle = "", fgClass = "";
            IntPtr hwnd = GetForegroundWindow();
            if (hwnd != IntPtr.Zero)
            {
                uint pid; GetWindowThreadProcessId(hwnd, out pid);
                try { fgProc = Process.GetProcessById((int)pid).ProcessName; } catch { }
                var t = new StringBuilder(256); GetWindowText(hwnd, t, 256); fgTitle = t.ToString();
                var c = new StringBuilder(128); GetClassName(hwnd, c, 128); fgClass = c.ToString();
            }
            if (mask)
            {
                const ushort VK_MASK = 0xE8; // unassigned: apps ignore it, but Windows sees "Win + another key"
                uint ok = Send(new[] { Key(VK_MASK, false), Key(VK_MASK, true) }, "mask");
                Console.WriteLine("{\"outcome\":\"" + (dryRun ? "dry-run" : ok == 2 ? "masked" : "blocked") + "\",\"plan\":\"" + Esc(plan.ToString().TrimEnd(' ', '|')) + "\"}");
                return 0;
            }
            if (info)
            {
                Console.WriteLine("{\"outcome\":\"info\",\"process\":\"" + Esc(fgProc) + "\",\"title\":\"" + Esc(fgTitle) + "\",\"class\":\"" + Esc(fgClass) + "\"}");
                return 0;
            }

            if (delay > 0) { plan.Append("sleep " + delay + "ms | "); if (!dryRun) Thread.Sleep(delay); }

            uint sent = 0, wanted = 0;
            if (release)
            {
                // Release whatever the user still holds from the trigger shortcut
                // (e.g. Ctrl+Alt+Space) so the paste chord is not polluted.
                ushort[] mods = { VK_LSHIFT, VK_RSHIFT, VK_LCONTROL, VK_RCONTROL, VK_LMENU, VK_RMENU, VK_LWIN, VK_RWIN, VK_SPACE };
                var ups = new System.Collections.Generic.List<INPUT>();
                foreach (var vk in mods)
                    if ((GetAsyncKeyState(vk) & 0x8000) != 0) ups.Add(Key(vk, true));
                if (ups.Count > 0) { wanted += (uint)ups.Count; sent += Send(ups.ToArray(), "release"); if (!dryRun) Thread.Sleep(30); }
                else plan.Append("release: nothing held | ");
            }

            INPUT[] chord = shiftInsert
                ? new[] { Key(VK_LSHIFT, false), Key(VK_INSERT, false), Key(VK_INSERT, true), Key(VK_LSHIFT, true) }
                : new[] { Key(VK_LCONTROL, false), Key(VK_V, false), Key(VK_V, true), Key(VK_LCONTROL, true) };
            wanted += (uint)chord.Length;
            sent += Send(chord, shiftInsert ? "paste(Shift+Insert)" : "paste(Ctrl+V)");

            string outcome = dryRun ? "dry-run" : (sent == wanted ? "pasted" : "blocked");
            Console.WriteLine("{\"outcome\":\"" + outcome + "\",\"sent\":" + sent + ",\"wanted\":" + wanted +
                              ",\"process\":\"" + Esc(fgProc) + "\",\"title\":\"" + Esc(fgTitle) + "\",\"plan\":\"" + Esc(plan.ToString().TrimEnd(' ', '|')) + "\"}");
            return outcome == "blocked" ? 2 : 0;
        }
        catch (Exception ex)
        {
            Console.WriteLine("{\"outcome\":\"failed\",\"error\":\"" + Esc(ex.Message) + "\"}");
            return 3;
        }
    }

    static string Esc(string s) { return (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", " ").Replace("\r", ""); }
}
