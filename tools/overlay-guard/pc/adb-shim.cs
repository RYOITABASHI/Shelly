// adb shim (shelly-hayato-bridge #6, item 1). First on the user PATH as adb.exe.
// Refuses any invocation that writes the phone's Settings.Global
// overlay_display_devices (it puts an overlay on the owner's screen), logs it,
// and otherwise runs the real adb with the original command line, inheriting
// stdin/stdout/stderr, and returns its exit code.
// The real adb: %SHELLY_REAL_ADB% if set, else the first adb.exe on PATH that is
// not in this shim's own directory.
using System;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;

class AdbShim {
    const string K = "overlay_display_devices";
    static readonly Regex[] Writes = {
        new Regex(@"settings\s+(?:put|delete|reset)\s+(?:--user\s+\S+\s+)?global\s+[""']?" + K, RegexOptions.IgnoreCase),
        new Regex(@"settings\s+reset\s+(?:--user\s+\S+\s+)?global\b", RegexOptions.IgnoreCase),
        new Regex(@"content\s+(?:insert|update|delete)\b.*settings/global.*" + K, RegexOptions.IgnoreCase),
        new Regex(@"settings\s+(?:put|delete)\s+(?:--user\s+\S+\s+)?global\s+[""']?[\$`]", RegexOptions.IgnoreCase),
    };

    static int Main(string[] args) {
        string raw = RawArgs();
        string joined = string.Join(" ", args);
        foreach (var re in Writes) {
            if (re.IsMatch(joined) || re.IsMatch(raw)) {
                Log("shim blocked: " + Trunc(joined, 200));
                Console.Error.WriteLine("adb (overlay-guard): refused. Writing overlay_display_devices on the phone is forbidden " +
                    "(it shows an overlay on the owner's screen). Use `shelly-vd open` / `shelly-vd close` or the ClosePaw VD.");
                return 13;
            }
        }
        string real = RealAdb();
        if (real == null) { Console.Error.WriteLine("adb (overlay-guard): the real adb.exe was not found"); return 127; }
        var psi = new ProcessStartInfo(real, raw) { UseShellExecute = false };
        using (var p = Process.Start(psi)) {
            p.WaitForExit();
            return p.ExitCode;
        }
    }

    // The command line after argv[0], verbatim (keeps the caller's quoting).
    static string RawArgs() {
        string cl = Environment.CommandLine;
        int i = 0;
        if (cl.Length > 0 && cl[0] == '"') { i = cl.IndexOf('"', 1); i = i < 0 ? cl.Length : i + 1; }
        else { while (i < cl.Length && cl[i] != ' ' && cl[i] != '\t') i++; }
        return cl.Substring(i).TrimStart();
    }

    static string RealAdb() {
        string env = Environment.GetEnvironmentVariable("SHELLY_REAL_ADB");
        if (!string.IsNullOrEmpty(env) && File.Exists(env)) return env;
        string self = Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName);
        foreach (string d in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';')) {
            if (d.Trim().Length == 0) continue;
            string dir;
            try { dir = Path.GetFullPath(d.Trim().Trim('"')); } catch { continue; }
            if (string.Equals(dir.TrimEnd('\\'), self.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) continue;
            string c = Path.Combine(dir, "adb.exe");
            if (File.Exists(c)) return c;
        }
        return null;
    }

    static void Log(string s) {
        try {
            string f = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude", "overlay-guard.log");
            File.AppendAllText(f, DateTime.UtcNow.ToString("o") + " " + s + Environment.NewLine);
        } catch { }
    }

    static string Trunc(string s, int n) { return s.Length <= n ? s : s.Substring(0, n) + "..."; }
}
