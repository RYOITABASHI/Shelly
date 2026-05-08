/*
 * shelly-xdg-open.c
 *
 * Native xdg-open replacement that hands URLs off to the React Native
 * side via a file queue. The RN side has a Linking-equivalent dispatch
 * (useBrowserStore.openUrl) running inside the activity context, so
 * starting Browser Pane navigation works from there. From the shell-
 * side native binary we cannot use `am start` because Android's
 * ActivityManagerService rejects activity starts from `untrusted_app`
 * uid binder calls (BackgroundActivityStartController + Samsung Knox
 * augmented sepolicy on Galaxy Z Fold6). Confirmed on-device 2026-05-08:
 * every `am start` variant — direct, with -W, with -f 0x10000000 — failed
 * with `cmd: Failure calling service activity: Failed transaction
 * (2147483646)`, regardless of the target scheme (https, shelly).
 *
 * The bridge is therefore: this binary writes the requested URL to
 * `$HOME/.shelly-deep-link-queue` (one URL per line, append mode), and
 * exits. The RN-side poller in app/_layout.tsx reads + truncates the
 * queue every ~250 ms and dispatches each URL to the Browser Pane
 * store.
 *
 * Why a queue file instead of single-URL drop:
 *   - `O_APPEND | O_WRONLY` is atomic for ≤ PIPE_BUF (4 KB) writes per
 *     POSIX, so concurrent invocations don't corrupt each other.
 *   - The poller can drain in batches if multiple URLs arrived between
 *     ticks (rare but possible when an OAuth flow opens both an auth
 *     URL and a redirect URL in quick succession).
 *
 * Triggered by:
 *   - Claude Code's i3() OAuth opener (cli.js ~ offset 6880697):
 *     `spawn(process.env.BROWSER ?? "xdg-open", [url])`.
 *   - Gemini CLI's authWithWeb(): identical pattern via google-auth-
 *     library's openBrowser().
 *   - Any other tool respecting xdg-open / $BROWSER conventions.
 *
 * HomeInitializer.kt symlinks `$HOME/bin/xdg-open` → `$libDir/
 * shelly_xdg_open` and exports `BROWSER=$HOME/bin/xdg-open`. Either
 * lookup path resolves to this binary.
 *
 * Argument contract:
 *   shelly_xdg_open <url>     # http or https only
 *
 * Exit codes:
 *   0  success (URL queued for RN dispatch)
 *   1  bad arg / unsupported scheme / I/O failure
 *
 * Caller note: Claude Code's i3() ignores the return code, so a non-
 * zero exit doesn't break the OAuth flow. We still bother validating
 * the input because the same binary may be called from contexts that
 * DO check (wsl-open compatibility, manual user invocation).
 *
 * SECURITY NOTE on scheme allowlist: passing arbitrary URLs through a
 * file queue that the RN side will hand to a WebView is a privilege-
 * escalation hazard. `file://`, `content://`, `intent://` could pivot
 * to internal-app navigation we don't intend. The OAuth use case is
 * 100% http/https, so we restrict to those two schemes here. The RN
 * dispatcher additionally re-validates before opening — defense in
 * depth.
 */

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/uio.h>
#include <unistd.h>

#define QUEUE_NAME "/.shelly-deep-link-queue"

/* RFC 3986 unreserved + a few schemes-safe characters. Encode all else. */
static int is_unreserved(char c) {
    return (c >= 'A' && c <= 'Z') ||
           (c >= 'a' && c <= 'z') ||
           (c >= '0' && c <= '9') ||
           c == '-' || c == '_' || c == '.' || c == '~';
}

static const char hex[] = "0123456789ABCDEF";

static void url_encode(const char *in, char *out, size_t out_size) {
    size_t j = 0;
    for (size_t i = 0; in[i] && j + 4 < out_size; i++) {
        unsigned char c = (unsigned char) in[i];
        if (is_unreserved((char) c)) {
            out[j++] = (char) c;
        } else {
            out[j++] = '%';
            out[j++] = hex[c >> 4];
            out[j++] = hex[c & 0xF];
        }
    }
    out[j] = 0;
}

static int starts_with(const char *s, const char *prefix) {
    size_t n = strlen(prefix);
    return strncmp(s, prefix, n) == 0;
}

int main(int argc, char **argv) {
    if (argc < 2 || argv[1] == NULL || argv[1][0] == 0) {
        fprintf(stderr, "xdg-open: missing URL argument\n");
        return 1;
    }
    const char *url = argv[1];

    if (!starts_with(url, "http://") && !starts_with(url, "https://")) {
        fprintf(stderr, "xdg-open: only http/https URLs are supported on Shelly\n");
        return 1;
    }

    /* The URL is just URL — no encoding here. The RN side reads it as
     * a single line and passes it directly to the Browser Pane store.
     * URL encoding only mattered when we were stuffing the URL into
     * `shelly://browser?url=<encoded>` deep-link form, which we've
     * abandoned (am start path is structurally blocked from app uid). */
    (void) is_unreserved; (void) hex; (void) url_encode; /* silence unused */

    const char *home = getenv("HOME");
    if (home == NULL || home[0] == 0) {
        fprintf(stderr, "xdg-open: $HOME unset\n");
        return 1;
    }

    char path[PATH_MAX];
    int written = snprintf(path, sizeof(path), "%s%s", home, QUEUE_NAME);
    if (written < 0 || (size_t) written >= sizeof(path)) {
        fprintf(stderr, "xdg-open: HOME path too long\n");
        return 1;
    }

    /* Append URL + newline to the queue file. O_APPEND + writes ≤
     * PIPE_BUF (4 KB) are atomic per POSIX, so concurrent invocations
     * don't interleave. mode 0600 keeps the queue private to the app
     * uid. Newline is the separator the RN poller splits on. */
    int fd = open(path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
    if (fd < 0) {
        fprintf(stderr, "xdg-open: open(%s): %s\n", path, strerror(errno));
        return 1;
    }

    size_t url_len = strlen(url);
    /* Writev as one call to keep URL + newline atomic together. */
    struct iovec iov[2];
    iov[0].iov_base = (void *) url;
    iov[0].iov_len = url_len;
    iov[1].iov_base = (void *) "\n";
    iov[1].iov_len = 1;
    ssize_t got = writev(fd, iov, 2);
    int saved_errno = errno;
    close(fd);

    if (got < 0 || (size_t) got != url_len + 1) {
        fprintf(stderr, "xdg-open: writev(%s): %s\n", path,
                got < 0 ? strerror(saved_errno) : "short write");
        return 1;
    }

    /* Best-effort note on stderr so the calling CLI's logs show that
     * the queue was written. The CLI ignores xdg-open output anyway. */
    fprintf(stderr, "xdg-open: queued %s\n", url);
    return 0;
}
