package expo.modules.terminalemulator

/**
 * The no-overwrite move of the MCP typed-op handoff (McpTypedOpConsumer:
 * `typed-requests/claimed/<x>` → `requests/<name>`). Pure: the file system is
 * the [Fs] passed in, so the JVM test can inject any errno.
 *
 * Why not link(2) + unlink(2) (the first version): SELinux denies apps
 * (untrusted_app) the `link` permission on app_data_file, so on the device
 * every handoff failed (EACCES) and was reported as `not_attended`
 * (2026-11-16, build 2964). `rename` is allowed.
 *
 * Route 1 — renameat2(RENAME_NOREPLACE) (ShellyJNI.renameNoReplace, API 30+):
 * atomic, never replaces an existing destination, EEXIST when the name is
 * taken. The same guarantee link + unlink gave.
 *
 * Route 2 — only when route 1 is not available (API < 30, the native call
 * missing, ENOSYS, or EINVAL = the file system does not support the flag):
 * `lstat(dst)` absent, then rename(2). WEAKER: between the check and the
 * rename a process of the SAME uid could create `dst`, and rename would
 * replace it. Only Shelly's own uid can write `requests/`, and a file moved
 * there is still acted on by RN only with a valid bridge-key MAC AND the
 * single-use handoff token for its callId (`handoffs/<callId>`), so the
 * window can neither run an unsigned request nor run one twice.
 *
 * Any other error (EACCES, EPERM, EXDEV, ...) is [Result.Failed] with no
 * fallback (rename(2) has the same permission checks as renameat2).
 */
internal object McpHandoffMove {
    // Linux errno values (asm-generic; the same on arm64). Literal on purpose:
    // OsConstants are android.jar stubs in JVM unit tests.
    const val EPERM = 1
    const val ENOENT = 2
    const val EIO = 5
    const val EACCES = 13
    const val EEXIST = 17
    const val EXDEV = 18
    const val EINVAL = 22
    const val ENOSPC = 28
    const val EROFS = 30
    const val ENOSYS = 38

    /** [Fs.renameNoReplace]: the primitive cannot be used here at all. */
    const val UNAVAILABLE = -1

    const val ROUTE_NOREPLACE = "renameat2"
    const val ROUTE_CHECKED = "rename_checked"

    interface Fs {
        /** renameat2(src, dst, RENAME_NOREPLACE): 0, a positive errno, or [UNAVAILABLE]. Never throws. */
        fun renameNoReplace(src: String, dst: String): Int

        /** Something (anything, a symlink included) is at [path]. True when that can't be ruled out. Never throws. */
        fun exists(path: String): Boolean

        /** rename(2): 0 or a positive errno. Never throws. */
        fun rename(src: String, dst: String): Int
    }

    sealed class Result {
        /** [dst] now names the file that was [src]. */
        data class Moved(val route: String) : Result()

        /** [dst] already existed (or could not be ruled out); nothing was moved. */
        object Taken : Result()

        /** Not moved; [errno] as returned by the route that failed. */
        data class Failed(val errno: Int, val route: String) : Result()
    }

    fun move(src: String, dst: String, fs: Fs): Result {
        when (val r = fs.renameNoReplace(src, dst)) {
            0 -> return Result.Moved(ROUTE_NOREPLACE)
            EEXIST -> return Result.Taken
            UNAVAILABLE, ENOSYS, EINVAL -> Unit // route 2 below
            else -> return Result.Failed(r, ROUTE_NOREPLACE)
        }
        if (fs.exists(dst)) return Result.Taken
        val r2 = fs.rename(src, dst)
        return if (r2 == 0) Result.Moved(ROUTE_CHECKED) else Result.Failed(r2, ROUTE_CHECKED)
    }

    /**
     * After a move that did not happen: the refusal to answer with, or null
     * when the state is ambiguous (the claimed file is gone, or something is
     * at the destination) and nothing may be written (no second writer).
     * Never [McpTypedOpDecision.NOT_ATTENDED]: RN was live; the move failed.
     */
    fun refusalAfterFailure(claimedStillThere: Boolean, destExists: Boolean): McpTypedOpDecision.Refusal? =
        if (claimedStillThere && !destExists) McpTypedOpDecision.HANDOFF_FAILED else null

    /** The audit `code` for a failed move ([a-z_], IngressAuditWriter's CODE_RE). */
    fun failureCode(result: Result?): String = when (result) {
        null -> "token_not_written"
        is Result.Moved -> "moved"
        Result.Taken -> "eexist"
        is Result.Failed -> when (result.errno) {
            EPERM -> "eperm"
            ENOENT -> "enoent"
            EIO -> "eio"
            EACCES -> "eacces"
            EEXIST -> "eexist"
            EXDEV -> "exdev"
            EINVAL -> "einval"
            ENOSPC -> "enospc"
            EROFS -> "erofs"
            ENOSYS -> "enosys"
            else -> "errno_other"
        }
    }
}
