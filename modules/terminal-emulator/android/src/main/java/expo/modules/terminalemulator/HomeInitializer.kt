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
    private const val BASHRC_VERSION = 13

    fun getHomeDir(context: Context): File =
        File(context.filesDir, "home").also { it.mkdirs() }

    fun initialize(context: Context): File {
        val home = getHomeDir(context)
        val libDir = LibExtractor.getLibDir(context).absolutePath

        File(home, "projects").mkdirs()

        // Create ~/bin/ with proot wrapper for codex.js spawn() calls
        val binDir = File(home, "bin")
        binDir.mkdirs()
        val prootWrapper = File(binDir, "proot")
        // Always regenerate to keep in sync with lib path
        prootWrapper.writeText("#!/system/bin/sh\nexec /system/bin/linker64 $libDir/libproot.so \"\$@\"\n")
        prootWrapper.setExecutable(true, false)

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
            sb.appendLine("export PATH=\"${home.absolutePath}/bin:\${PATH:-$libDir:/system/bin:/vendor/bin}\"")
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

            // AI CLI tools — use updated CLIs ($HOME/.shelly-cli) if available, else bundled
            sb.appendLine("# AI CLI tools (with auto-update support)")
            sb.appendLine("__shelly_cli_dir=\"\$HOME/.shelly-cli\"")
            sb.appendLine("if [ -d \"\$__shelly_cli_dir/node_modules\" ]; then")
            sb.appendLine("  __cli_dir=\"\$__shelly_cli_dir/node_modules\"")
            sb.appendLine("else")
            sb.appendLine("  __cli_dir=\"$libDir/node_modules\"")
            sb.appendLine("fi")
            sb.appendLine("claude() { _run $libDir/node \"\$__cli_dir/@anthropic-ai/claude-code/cli.js\" \"\$@\"; }")
            sb.appendLine("gemini() { _run $libDir/node \"\$__cli_dir/@google/gemini-cli/bundle/gemini.js\" \"\$@\"; }")
            sb.appendLine("codex() { _run $libDir/node \"\$__cli_dir/@openai/codex/bin/codex.js\" \"\$@\"; }")
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

            // CLI auto-update (background, once per day)
            // Placed after coreutils so date/cat functions are available
            sb.appendLine("# Auto-update CLI tools (background, once per day)")
            sb.appendLine("__shelly_update_marker=\"\$HOME/.shelly_last_update\"")
            sb.appendLine("__shelly_update_interval=86400")
            sb.appendLine("__shelly_now=\$(date +%s 2>/dev/null || printf '%(%s)T' -1 2>/dev/null || echo 0)")
            sb.appendLine("__shelly_last_update=\$(cat \"\$__shelly_update_marker\" 2>/dev/null || echo 0)")
            sb.appendLine("if [ \$(( __shelly_now - __shelly_last_update )) -ge \$__shelly_update_interval ]; then")
            sb.appendLine("  (")
            sb.appendLine("    mkdir -p \"\$__shelly_cli_dir\"")
            sb.appendLine("    _run $libDir/node $libDir/node_modules/npm/bin/npm-cli.js install --prefix \"\$__shelly_cli_dir\" @anthropic-ai/claude-code@latest @google/gemini-cli@latest @openai/codex@latest 2>/dev/null")
            sb.appendLine("    # Patch codex.js to use proot for ET_EXEC binary on Android")
            sb.appendLine("    __codex_js=\"\$__shelly_cli_dir/node_modules/@openai/codex/bin/codex.js\"")
            sb.appendLine("    if [ -f \"\$__codex_js\" ] && ! grep -q proot \"\$__codex_js\" 2>/dev/null; then")
            sb.appendLine("      _run $libDir/coreutils --coreutils-prog=sed -i 's/spawn(binaryPath, process.argv.slice(2)/spawn(\"proot\", [binaryPath, ...process.argv.slice(2)]/' \"\$__codex_js\" 2>/dev/null")
            sb.appendLine("    fi")
            sb.appendLine("    echo \"\$__shelly_now\" > \"\$__shelly_update_marker\"")
            sb.appendLine("  ) &>/dev/null &")
            sb.appendLine("fi")
            sb.appendLine()

            // Prompt: PROMPT_COMMAND dynamically builds PS1 with HOME→~ replacement.
            // bash's \w doesn't shorten HOME when launched via linker64, so we do it
            // manually. We previously embedded OSC 133 (shell-integration) markers
            // here, but the bundled TerminalView didn't strip them and they leaked
            // into the visible buffer (\[\e]133;A\a\] showed up literally),
            // throwing off cursor column math and producing the "phantom prompt"
            // bug. Drop OSC 133 entirely — it's only useful to terminals that
            // understand it (Warp, WezTerm) and we don't.
            sb.appendLine("# Prompt with dynamic HOME shortening")
            sb.appendLine("# Resolve real HOME path once (symlink: /data/user/0 vs /data/data)")
            sb.appendLine("SHELLY_HOME_REAL=\$(cd \"\$HOME\" 2>/dev/null && pwd -P)")
            sb.appendLine("[ -z \"\$SHELLY_HOME_REAL\" ] && SHELLY_HOME_REAL=\"\$HOME\"")
            sb.appendLine("__shelly_prompt() {")
            sb.appendLine("  local d")
            sb.appendLine("  d=\"\$(pwd -P 2>/dev/null || pwd)\"")
            sb.appendLine("  # Replace home path with ~ (\\~ prevents tilde expansion in replacement)")
            sb.appendLine("  d=\"\${d/#\$SHELLY_HOME_REAL/\\~}\"")
            sb.appendLine("  d=\"\${d/#\$HOME/\\~}\"")
            sb.appendLine("  # Use printf-style escapes via \$'...' so \\[ \\] reach bash literally")
            sb.appendLine("  PS1=\$'\\[\\e[1;32m\\]'\"\$d\"\$'\\[\\e[0m\\]\\$ '")
            sb.appendLine("}")
            sb.appendLine("PROMPT_COMMAND=__shelly_prompt")

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
