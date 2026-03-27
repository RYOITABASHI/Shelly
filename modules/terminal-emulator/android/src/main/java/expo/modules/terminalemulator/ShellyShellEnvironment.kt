package expo.modules.terminalemulator

import java.io.File

interface ShellEnvironment {
    val shellPath: String
    val homePath: String
    val envVars: Map<String, String>
    fun isAvailable(): Boolean
    fun tmuxPath(): String
}

class TermuxShellEnvironment : ShellEnvironment {
    override val shellPath = "/data/data/com.termux/files/usr/bin/bash"
    override val homePath = "/data/data/com.termux/files/home"

    override val envVars = mapOf(
        "PATH" to "/data/data/com.termux/files/usr/bin:/data/data/com.termux/files/usr/bin/applets",
        "HOME" to homePath,
        "TERM" to "xterm-256color",
        "LANG" to "en_US.UTF-8",
        "LD_LIBRARY_PATH" to "/data/data/com.termux/files/usr/lib",
        "PREFIX" to "/data/data/com.termux/files/usr",
        "TMPDIR" to "/data/data/com.termux/files/usr/tmp",
        "COLORTERM" to "truecolor",
        "PROMPT_COMMAND" to "\${PROMPT_COMMAND:+\$PROMPT_COMMAND;}echo -ne '\\033]133;D;\$?\\007\\033]133;A\\007'"
    )

    override fun isAvailable(): Boolean = File(shellPath).exists()
    override fun tmuxPath(): String = "/data/data/com.termux/files/usr/bin/tmux"
}
