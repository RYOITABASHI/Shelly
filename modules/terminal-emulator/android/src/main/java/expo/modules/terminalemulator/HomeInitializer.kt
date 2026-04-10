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
    private const val BASHRC_VERSION = 8

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

            // Prompt: simple green \w + $ with OSC 133 markers for block detection
            // Written via sb.append to avoid Kotlin/bash escape hell
            // Target .bashrc content:
            //   PS1='\[\e]133;A\a\]\[\033[1;32m\]\w\[\033[0m\]\$ \[\e]133;B\a\]'
            //   PROMPT_COMMAND='builtin echo -ne "\033]133;D;$?\007"'
            sb.appendLine("# Prompt")
            sb.append("PS1='")
            sb.append("\\[\\e]133;A\\a\\]")       // OSC 133 prompt start
            sb.append("\\[\\033[1;32m\\]")         // green bold
            sb.append("\\w")                        // working dir (~ shortening)
            sb.append("\\[\\033[0m\\]")             // reset
            sb.append("\\$ ")                       // $ or #
            sb.append("\\[\\e]133;B\\a\\]")         // OSC 133 command start
            sb.appendLine("'")
            sb.appendLine("""PROMPT_COMMAND='echo -ne "\033]133;D;${'$'}?\007"'""")

            // MOTD — displayed once on first login, then flag file prevents repeat
            sb.appendLine()
            sb.appendLine("# Welcome MOTD (first launch only)")
            sb.appendLine("if [ ! -f \"\$HOME/.shelly_motd_shown\" ]; then")
            sb.appendLine("  printf '\\n'")
            sb.appendLine("  printf '\\033[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\\033[0m\\n'")
            sb.appendLine("  printf '\\033[1;32m  Shelly へようこそ\\033[0m\\n'")
            sb.appendLine("  printf '\\033[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\\033[0m\\n'")
            sb.appendLine("  printf '\\n'")
            sb.appendLine("  printf '  以下のCLIツールがインストール済みです:\\n'")
            sb.appendLine("  printf '\\n'")
            sb.appendLine("  printf '    \\033[33mclaude\\033[0m    — Claude Code (Anthropic)\\n'")
            sb.appendLine("  printf '    \\033[33mgemini\\033[0m    — Gemini CLI  (Google)\\n'")
            sb.appendLine("  printf '    \\033[33mcodex\\033[0m     — Codex CLI   (OpenAI)\\n'")
            sb.appendLine("  printf '\\n'")
            sb.appendLine("  printf '  お持ちのアカウントでログインしてください:\\n'")
            sb.appendLine("  printf '\\n'")
            sb.appendLine("  printf '    \\033[90m\$\\033[0m claude auth login\\n'")
            sb.appendLine("  printf '    \\033[90m\$\\033[0m gemini auth login\\n'")
            sb.appendLine("  printf '\\n'")
            sb.appendLine("  printf '\\033[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\\033[0m\\n'")
            sb.appendLine("  printf '\\n'")
            sb.appendLine("  touch \"\$HOME/.shelly_motd_shown\"")
            sb.appendLine("fi")

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
