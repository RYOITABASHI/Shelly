package expo.modules.terminalemulator

import android.content.Context
import java.io.File

object HomeInitializer {
    private val COREUTILS_APPLETS = listOf(
        "arch", "base32", "base64", "basename", "cat", "chgrp", "chmod", "chown",
        "cksum", "comm", "cp", "csplit", "cut", "date", "dd", "df", "dir", "dircolors",
        "dirname", "du", "echo", "env", "expand", "expr", "factor", "false", "fmt",
        "fold", "groups", "head", "hostid", "id", "install", "join", "kill", "link",
        "ln", "logname", "ls", "md5sum", "mkdir", "mkfifo", "mknod", "mktemp", "mv",
        "nice", "nl", "nohup", "nproc", "numfmt", "od", "paste", "pathchk", "pinky",
        "pr", "printenv", "printf", "pwd", "readlink", "realpath", "rm", "rmdir",
        "seq", "sha1sum", "sha224sum", "sha256sum", "sha384sum", "sha512sum",
        "shred", "shuf", "sleep", "sort", "split", "stat", "stty", "sum", "sync",
        "tac", "tail", "tee", "test", "timeout", "touch", "tr", "true", "truncate",
        "tsort", "tty", "uname", "unexpand", "uniq", "unlink", "users", "vdir",
        "wc", "who", "whoami", "yes"
    )

    /** Version counter — increment to force .bashrc regeneration */
    private const val BASHRC_VERSION = 7

    fun getHomeDir(context: Context): File =
        File(context.filesDir, "home").also { it.mkdirs() }

    fun initialize(context: Context): File {
        val home = getHomeDir(context)
        val libDir = LibExtractor.getLibDir(context).absolutePath

        File(home, "projects").mkdirs()

        // Regenerate .bashrc if version changed
        val bashrc = File(home, ".bashrc")
        val versionFile = File(home, ".bashrc_version")
        val currentVersion = try { versionFile.readText().trim().toInt() } catch (_: Exception) { 0 }

        if (!bashrc.exists() || currentVersion < BASHRC_VERSION) {
            val sb = StringBuilder()

            // Environment — preserve PATH/LD_LIBRARY_PATH if already set by
            // shelly-pty.c (which includes lib dir, npm bins, etc.)
            sb.appendLine("export HOME=\"${home.absolutePath}\"")
            sb.appendLine("export TERM=xterm-256color")
            sb.appendLine("export COLORTERM=truecolor")
            sb.appendLine("export LANG=en_US.UTF-8")
            sb.appendLine("export SHELL=\"$libDir/libbash.so\"")
            sb.appendLine("export PATH=\"\${PATH:-$libDir:/system/bin:/vendor/bin}\"")
            sb.appendLine("export LD_LIBRARY_PATH=\"\${LD_LIBRARY_PATH:-$libDir}\"")
            sb.appendLine()

            // Linker64 helper function
            sb.appendLine("# Run binary via linker64 (SELinux blocks direct execve on app_data_file)")
            sb.appendLine("_run() { /system/bin/linker64 \"\$@\"; }")
            sb.appendLine()

            // Tool functions
            sb.appendLine("node() { _run $libDir/node \"\$@\"; }")
            sb.appendLine("git() { _run $libDir/git \"\$@\"; }")
            sb.appendLine("npm() { _run $libDir/node $libDir/node_modules/npm/bin/npm-cli.js \"\$@\"; }")
            sb.appendLine("npx() { _run $libDir/node $libDir/node_modules/npm/bin/npx-cli.js \"\$@\"; }")
            sb.appendLine("python3() { PYTHONHOME=$libDir/python3.13 _run $libDir/python3 \"\$@\"; }")
            sb.appendLine("python() { python3 \"\$@\"; }")
            sb.appendLine("pip() { python3 -m pip \"\$@\"; }")
            sb.appendLine("pip3() { pip \"\$@\"; }")
            sb.appendLine("curl() { _run $libDir/curl \"\$@\"; }")
            sb.appendLine("ssh() { _run $libDir/ssh \"\$@\"; }")
            sb.appendLine("rg() { _run $libDir/rg \"\$@\"; }")
            sb.appendLine("jq() { _run $libDir/jq \"\$@\"; }")
            sb.appendLine("sqlite3() { _run $libDir/sqlite3 \"\$@\"; }")
            sb.appendLine()

            // AI CLI tools (node-based)
            sb.appendLine("# AI CLI tools")
            sb.appendLine("claude() { _run $libDir/node $libDir/node_modules/@anthropic-ai/claude-code/cli.js \"\$@\"; }")
            sb.appendLine("gemini() { _run $libDir/node $libDir/node_modules/@google/gemini-cli/bundle/gemini.js \"\$@\"; }")
            sb.appendLine("codex() { _run $libDir/node $libDir/node_modules/@openai/codex/bin/codex.js \"\$@\"; }")
            sb.appendLine("export -f claude gemini codex")
            sb.appendLine()

            // Coreutils: use --coreutils-prog=NAME to select applet
            // Skip bash builtins — overriding them breaks ANSI escapes in printf/echo
            val bashBuiltins = setOf("echo", "printf", "pwd", "test", "true", "false", "kill")
            sb.appendLine("# Coreutils applets (bash builtins excluded)")
            for (applet in COREUTILS_APPLETS) {
                if (applet in bashBuiltins) continue
                sb.appendLine("$applet() { _run $libDir/coreutils --coreutils-prog=$applet \"\$@\"; }")
            }
            sb.appendLine()

            // OSC 133 for command block detection
            sb.appendLine("# OSC 133 for command block detection")
            // Use custom prompt that manually shortens HOME to ~
            // (\w may show full path if HOME isn't set before bash initializes)
            sb.appendLine("__shelly_cwd() { local d=\"\\\$(pwd)\"; echo \"\\\${d/#\\\$HOME/\\~}\"; }")
            sb.appendLine("PS1='\\[\\e]133;A\\a\\]\\[\\033[1;32m\\]\\\$(__shelly_cwd)\\[\\033[0m\\]\\\$ \\[\\e]133;B\\a\\]'")
            sb.appendLine("PROMPT_COMMAND='builtin echo -ne \"\\033]133;D;\\\$?\\007\"'")

            bashrc.writeText(sb.toString())
            versionFile.writeText(BASHRC_VERSION.toString())
        }

        // Create .profile
        val profile = File(home, ".profile")
        if (!profile.exists()) {
            profile.writeText("[ -f ~/.bashrc ] && . ~/.bashrc\n")
        }

        return home
    }
}
