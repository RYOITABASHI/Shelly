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

    /** Version counter — increment to force .bashrc regeneration.
     *  History:
     *    13: pre-OSC133 era
     *    14: drop OSC 133 from PS1 (0dff463b) — was forgotten to bump,
     *        which left users stuck on the broken phantom-prompt PS1 even
     *        after the code was fixed. Bumping now so the next launch
     *        regenerates .bashrc with the simple green-cwd-$ prompt.
     *    15: switch PS1 generation from $'...' ANSI-C quoting to
     *        `printf -v PS1 '\[\033[...\]...'`. The $'...' form turned
     *        \[ \] into literal backslash-bracket bytes, so bash never
     *        saw them as width hints and `echo "$PS1"` dumped ugly
     *        \[\]~\[\]\$. printf -v keeps \[ \] literal for bash while
     *        still expanding \033 into ESC.
     *    16: bug #76/#77 — pass --include=optional/--os=linux/--cpu=arm64
     *        to the npm install line so codex pulls its native binary, and
     *        sed-patch gemini-cli's hardcoded Termux check after install.
     *        Bumping resets the cached .bashrc and clears the daily update
     *        marker so the next bash launch re-runs the install with the
     *        new flags instead of waiting 24h.
     *    17: bug #80 — the CLI auto-update subshell used to run as a tracked
     *        background job and bash would dump a multi-line "[1]+ Done (...)"
     *        notification containing the whole install pipeline with
     *        unexpanded $__shelly_cli_dir literals the next time the user
     *        pressed Enter. Wrapped the body in a named function and
     *        launched via `( __shelly_bg_cli_update & )` so the job is
     *        orphaned and never enters the parent shell's job table.
     *    18: bug #76 final — ship Alpine minirootfs + rewrite the codex.js
     *        sed patch to remap the ET_EXEC binaryPath into proot's /root
     *        view so the binary actually loads. The previous marker was
     *        just "proot", so we switch to a "shelly-proot" tag to force
     *        the sed to re-run on installs that already went through the
     *        old marker.
     *    19: bug #93/#95 — add $HOME/bin/bash wrapper so `bash script.sh`
     *        works (previously only libbash.so via linker64 existed). Also
     *        add install.log for the CLI post-install pipeline so sed
     *        patch failures are visible, and verify the codex.js patch
     *        actually applied after sed runs. */
    private const val BASHRC_VERSION = 19

    fun getHomeDir(context: Context): File =
        File(context.filesDir, "home").also { it.mkdirs() }

    fun initialize(context: Context): File {
        val home = getHomeDir(context)
        val libDir = LibExtractor.getLibDir(context).absolutePath

        File(home, "projects").mkdirs()

        // bug #76 final fix: extract Alpine minirootfs so proot has a real
        // rootfs to mount. Without one, `proot /path/to/static-binary` fails
        // with "unexpected e_type: 2" because ET_EXEC needs a libc that
        // proot can mmap through its own loader, and the only way to give
        // proot a libc is to hand it a rootfs via -r. The rootfs is ~8 MiB
        // unpacked, shipped as a 3.7 MiB .tar.gz asset.
        val rootfsDir = File(home, ".shelly-rootfs")
        val rootfsMarker = File(rootfsDir, "etc/alpine-release")
        if (!rootfsMarker.exists()) {
            try {
                rootfsDir.mkdirs()
                val assetName = try {
                    context.assets.open("alpine-rootfs.tar").close(); "alpine-rootfs.tar"
                } catch (_: Exception) {
                    "alpine-rootfs.tar.gz"
                }
                val isGz = assetName.endsWith(".gz")
                val tempTar = File(context.cacheDir, assetName)
                context.assets.open(assetName).use { input ->
                    tempTar.outputStream().use { output -> input.copyTo(output) }
                }
                val pb = ProcessBuilder(
                    "/system/bin/tar",
                    if (isGz) "xzf" else "xf",
                    tempTar.absolutePath,
                    "-C", rootfsDir.absolutePath,
                )
                pb.redirectErrorStream(true)
                val proc = pb.start()
                val out = proc.inputStream.bufferedReader().readText()
                val code = proc.waitFor()
                tempTar.delete()
                if (code != 0) {
                    android.util.Log.e("HomeInitializer", "rootfs tar failed (exit $code): $out")
                }
                // Make sure the proot-writable subdirs the wrapper binds into
                // actually exist; Alpine minirootfs leaves /root and /tmp in
                // place but we explicitly mkdir them so the bind mount can
                // land even on stripped rootfs builds.
                File(rootfsDir, "root").mkdirs()
                File(rootfsDir, "tmp").mkdirs()
                File(rootfsDir, "usr/local/bin").mkdirs()
            } catch (e: Exception) {
                android.util.Log.e("HomeInitializer", "rootfs extraction failed: ${e.message}")
            }
        }

        // bug #76: proot wrapper. The earlier version passed the binary
        // through as the only argument, which made proot try to load the
        // ET_EXEC static binary straight into the host address space. That
        // fails on Android because the binary's LOAD segment at 0x400000
        // collides with mmap_min_addr, and proot reports it as
        // "unexpected e_type: 2". The fix is to give proot a rootfs with -r
        // plus the usual bind mounts so it re-maps the load segments
        // through its own ptrace-based loader.
        //
        //   -0             fake uid 0 (required because musl's geteuid
        //                  check refuses to run otherwise)
        //   --kill-on-exit send SIGKILL to the tracee on proot exit
        //   -r rootfs      use the bundled Alpine minirootfs
        //   -b /dev        pass through real /dev
        //   -b /proc       pass through real /proc
        //   -b /sys        pass through real /sys
        //   -b $HOME:/root bind Shelly HOME into /root so the user's
        //                  files and .shelly-cli tree are visible to codex
        //   -w /root       start in /root
        val binDir = File(home, "bin")
        binDir.mkdirs()
        val prootWrapper = File(binDir, "proot")
        prootWrapper.writeText(
            "#!/system/bin/sh\n" +
            "exec /system/bin/linker64 $libDir/libproot.so " +
            "-0 --kill-on-exit " +
            "-r ${rootfsDir.absolutePath} " +
            "-b /dev -b /proc -b /sys " +
            "-b ${home.absolutePath}:/root " +
            "-w /root " +
            "\"\$@\"\n"
        )
        prootWrapper.setExecutable(true, false)

        // bug #93: bash wrapper — Shelly launches bash as libbash.so via
        // linker64, so there is no "bash" binary on PATH. Scripts that call
        // `bash /path/to/script.sh` or `#!/usr/bin/env bash` shebangs fail.
        // Place a thin wrapper at $HOME/bin/bash that delegates to linker64.
        val bashWrapper = File(binDir, "bash")
        bashWrapper.writeText(
            "#!/system/bin/sh\n" +
            "exec /system/bin/linker64 $libDir/libbash.so \"\$@\"\n"
        )
        bashWrapper.setExecutable(true, false)

        // Regenerate .bashrc if version changed
        val bashrc = File(home, ".bashrc")
        val versionFile = File(home, ".bashrc_version")
        val currentVersion = try { versionFile.readText().trim().toInt() } catch (_: Exception) { 0 }

        if (!bashrc.exists() || currentVersion < BASHRC_VERSION) {
            // bug #76/#77: when the bashrc version bumps because the install
            // script changed, force the next bash launch to re-run the npm
            // install instead of waiting for the daily update window. The
            // simplest knob is to delete the timestamp marker — the install
            // block treats a missing marker as "older than the interval" and
            // re-runs.
            try { File(home, ".shelly_last_update").delete() } catch (_: Exception) {}

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
            // bug #77: gemini-cli bundles a hardcoded check that throws if
            // process.env.TERMUX_VERSION is undefined on Android, even though
            // it never actually needs Termux for the chat path. Setting any
            // value satisfies the check and lets the bundle load. We pair this
            // with the post-install sed below so a future gemini release that
            // moves to a different gating mechanism still gets neutralised.
            sb.appendLine("export TERMUX_VERSION=shelly")
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
            // Placed after coreutils so date/cat functions are available.
            //
            // bug #80: previously this used `( ... ) &>/dev/null &` which ran
            // the update as a tracked background job. Bash's job control
            // still prints a multi-line "[1]+ Done (...)" notification with
            // the entire subshell body the next time the user presses Enter,
            // and variable names like $__shelly_cli_dir show up unexpanded
            // because bash stores the pre-expansion command string. We now
            // wrap the whole thing in a named function, redirect inside the
            // function so bash never sees any output, and launch via an
            // outer subshell `( fn & )` so the job is orphaned and never
            // enters the parent shell's job table — no Done line at all.
            sb.appendLine("# Auto-update CLI tools (background, once per day)")
            sb.appendLine("__shelly_update_marker=\"\$HOME/.shelly_last_update\"")
            sb.appendLine("__shelly_update_interval=86400")
            sb.appendLine("__shelly_now=\$(date +%s 2>/dev/null || printf '%(%s)T' -1 2>/dev/null || echo 0)")
            sb.appendLine("__shelly_last_update=\$(cat \"\$__shelly_update_marker\" 2>/dev/null || echo 0)")
            sb.appendLine("__shelly_bg_cli_update() {")
            sb.appendLine("  local __log=\"\$HOME/.shelly-cli/install.log\"")
            sb.appendLine("  mkdir -p \"\$__shelly_cli_dir\"")
            sb.appendLine("  exec </dev/null >>\"\$__log\" 2>&1")
            sb.appendLine("  echo \"--- \$(date) ---\"")
            // bug #76: @openai/codex has optionalDependencies for the platform-
            // specific native binary (@openai/codex-linux-arm64). On Android
            // npm doesn't auto-install them because Bionic libc isn't
            // recognized as a normal Linux target, so pass --include=optional
            // and --os=linux --cpu=arm64 to pull the arm64 build down.
            sb.appendLine("  echo '[install] npm install start'")
            sb.appendLine("  _run $libDir/node $libDir/node_modules/npm/bin/npm-cli.js install --prefix \"\$__shelly_cli_dir\" --include=optional --os=linux --cpu=arm64 @anthropic-ai/claude-code@latest @google/gemini-cli@latest @openai/codex@latest")
            sb.appendLine("  echo \"[install] npm install exit=\$?\"")
            // bug #76 + #95: patch codex.js to run the ET_EXEC native binary
            // through proot+Alpine rootfs. Previously this sed ran silently
            // inside a background job with stdout/stderr sent to /dev/null, so
            // failures were invisible. Now we log each step to install.log and
            // wait for npm install to complete before patching.
            sb.appendLine("  __codex_js=\"\$__shelly_cli_dir/node_modules/@openai/codex/bin/codex.js\"")
            sb.appendLine("  echo \"[patch] codex.js=\$__codex_js exists=\$([ -f \"\$__codex_js\" ] && echo yes || echo no)\"")
            sb.appendLine("  if [ -f \"\$__codex_js\" ]; then")
            sb.appendLine("    if grep -q 'shelly-proot' \"\$__codex_js\"; then")
            sb.appendLine("      echo '[patch] codex.js already patched, skipping'")
            sb.appendLine("    else")
            sb.appendLine("      _run $libDir/coreutils --coreutils-prog=sed -i 's#spawn(binaryPath, process.argv.slice(2)#spawn(\"proot\", [binaryPath.replace(process.env.HOME, \"/root\"), ...process.argv.slice(2)] /*shelly-proot*/#' \"\$__codex_js\"")
            sb.appendLine("      echo \"[patch] codex.js sed exit=\$?\"")
            sb.appendLine("      if grep -q 'shelly-proot' \"\$__codex_js\"; then")
            sb.appendLine("        echo '[patch] codex.js patch verified OK'")
            sb.appendLine("      else")
            sb.appendLine("        echo '[patch] WARNING: codex.js patch did NOT apply'")
            sb.appendLine("      fi")
            sb.appendLine("    fi")
            sb.appendLine("  fi")
            // bug #77: neutralize gemini-cli's hardcoded Termux check. The
            // bundle filename includes a content hash (chunk-XXXXX.js) so we
            // glob the whole bundle dir and rewrite every
            // "You need to install Termux" throw into a noop expression.
            sb.appendLine("  __gemini_bundle_dir=\"\$__shelly_cli_dir/node_modules/@google/gemini-cli/bundle\"")
            sb.appendLine("  if [ -d \"\$__gemini_bundle_dir\" ]; then")
            sb.appendLine("    for __f in \"\$__gemini_bundle_dir\"/chunk-*.js; do")
            sb.appendLine("      [ -f \"\$__f\" ] || continue")
            sb.appendLine("      if grep -q 'You need to install Termux' \"\$__f\"; then")
            sb.appendLine("        _run $libDir/coreutils --coreutils-prog=sed -i 's|throw new Error(\"You need to install Termux[^\"]*\")|undefined|g' \"\$__f\"")
            sb.appendLine("        echo \"[patch] gemini \$__f sed exit=\$?\"")
            sb.appendLine("      fi")
            sb.appendLine("    done")
            sb.appendLine("  fi")
            sb.appendLine("  echo \"\$__shelly_now\" > \"\$__shelly_update_marker\"")
            sb.appendLine("  echo '[install] done'")
            sb.appendLine("}")
            sb.appendLine("if [ \$(( __shelly_now - __shelly_last_update )) -ge \$__shelly_update_interval ]; then")
            sb.appendLine("  ( __shelly_bg_cli_update & )")
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
            sb.appendLine("  # printf -v assigns to PS1 directly; \\[ \\] stay literal so bash treats")
            sb.appendLine("  # them as PS1 width-hint markers, and \\033 expands to ESC for color.")
            sb.appendLine("  printf -v PS1 '\\[\\033[1;32m\\]%s\\[\\033[0m\\]\\$ ' \"\$d\"")
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
