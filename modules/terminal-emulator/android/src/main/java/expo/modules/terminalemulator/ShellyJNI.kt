package expo.modules.terminalemulator

object ShellyJNI {
    init {
        System.loadLibrary("shelly-pty")
        System.loadLibrary("shelly-exec")
    }

    // ── PTY (interactive terminal) ──────────────────────────────────────────

    @JvmStatic
    external fun createSubprocess(
        linkerPath: String,
        bashPath: String,
        ldLibPath: String,
        homePath: String,
        rows: Int,
        cols: Int,
        resultArray: IntArray
    ): Int

    @JvmStatic
    external fun setPtyWindowSize(fd: Int, rows: Int, cols: Int)

    @JvmStatic
    external fun waitFor(pid: Int): Int

    @JvmStatic
    external fun close(fd: Int)

    // ── Exec (non-interactive command execution) ────────────────────────────

    /** Fork+exec a command, capture stdout/stderr, return [exitCode, stdout, stderr] */
    @JvmStatic
    external fun execSubprocess(
        linkerPath: String,
        bashPath: String,
        ldLibPath: String,
        homePath: String,
        command: String,
        timeoutMs: Int
    ): Array<String>

    /**
     * Read a small procfs file (e.g. /proc/net/tcp{,6}) directly via fopen
     * in-process. Works around bug #36 where shelling out to `cat` via
     * bash+LD_PRELOAD fails with exit=1 on some devices. Returns an empty
     * string on any error. Never throws.
     */
    @JvmStatic
    external fun readProcNetFile(path: String): String

    /**
     * List a directory via opendir/readdir/lstat in-process. Works around
     * bug #70 where shelling out to `ls` via bash+LD_PRELOAD fails with
     * exit=0 stdout=0chars on some devices (same root cause as bug #36).
     *
     * Returns tab-delimited lines: `NAME\tTYPE\tSIZE\n` where TYPE is one
     * of 'd' (dir), 'f' (regular file), 'l' (symlink), '?' (other). Dots
     * ('.' / '..') are skipped. Returns an empty string on any error.
     * Never throws.
     */
    @JvmStatic
    external fun readDir(path: String): String

    /**
     * Enumerate the app's TCP listen sockets via NETLINK_SOCK_DIAG.
     * Replaces readProcNetFile("/proc/net/tcp*") for bug #99 — Android
     * 10+ SELinux blocks procfs reads but leaves the netlink socket
     * diag path open and kernel-filters to the caller's own sockets.
     *
     * `family`: 4 for AF_INET, 6 for AF_INET6. Returns a string in the
     * same format parseProcNetTcp already consumes (header line + one
     * socket per line with hex-encoded local_address:port and state).
     * Empty string on any failure so the Sidebar gracefully surfaces
     * "No listeners" instead of crashing.
     */
    @JvmStatic
    external fun queryListenSockets(family: Int): String
}
