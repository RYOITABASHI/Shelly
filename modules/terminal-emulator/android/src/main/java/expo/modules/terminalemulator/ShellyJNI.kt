package expo.modules.terminalemulator

object ShellyJNI {
    init {
        System.loadLibrary("shelly-pty")
    }

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
}
