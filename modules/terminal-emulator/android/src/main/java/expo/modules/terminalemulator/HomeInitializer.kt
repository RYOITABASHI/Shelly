package expo.modules.terminalemulator

import android.content.Context
import java.io.File

object HomeInitializer {
    fun getHomeDir(context: Context): File =
        File(context.filesDir, "home").also { it.mkdirs() }

    fun initialize(context: Context): File {
        val home = getHomeDir(context)
        File(home, "projects").mkdirs()

        val bashrc = File(home, ".bashrc")
        if (!bashrc.exists()) {
            val libDir = LibExtractor.getLibDir(context).absolutePath
            bashrc.writeText(
                "export HOME=\"${home.absolutePath}\"\n" +
                "export TERM=xterm-256color\n" +
                "export COLORTERM=truecolor\n" +
                "export LANG=en_US.UTF-8\n" +
                "export SHELL=\"$libDir/libbash.so\"\n" +
                "export PATH=\"$libDir:/system/bin:/vendor/bin\"\n" +
                "export LD_LIBRARY_PATH=\"$libDir\"\n" +
                "\n" +
                "# OSC 133 for command block detection\n" +
                "PS1='\\[\\e]133;A\\a\\]\\u@shelly:\\w\\\$ \\[\\e]133;B\\a\\]'\n" +
                "PROMPT_COMMAND='echo -ne \"\\033]133;D;\\\$?\\007\"'\n"
            )
        }

        val profile = File(home, ".profile")
        if (!profile.exists()) {
            profile.writeText("[ -f ~/.bashrc ] && . ~/.bashrc\n")
        }

        return home
    }
}
