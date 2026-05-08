/*
 * shelly-xdg-open.c
 *
 * Native xdg-open replacement that fires Shelly's `shelly://browser?
 * url=<encoded>` deep link via `am start`. Lives in jniLibs (packaged
 * as `libshelly_xdg_open.so`, extracted at runtime to `$libDir/
 * shelly_xdg_open`), so it's directly exec-able from app context — no
 * SELinux script-read audit issue, no shebang dispatch chain.
 *
 * Replaces the v78–v80 attempts at a #!-script shim, all of which
 * failed because Android's kernel binfmt_script needs file{read} on
 * `app_data_file` scripts under the caller's domain. Samsung Knox's
 * hardened sepolicy denies that read for `untrusted_app_*` even when
 * direct execve from the same context succeeds (different LSM hook
 * recursion). Native binary sidesteps the entire mechanism — kernel
 * does one execve on a labelled-executable file in libDir, that's it.
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
 *   0  success (am start dispatched)
 *   1  bad arg / unsupported scheme / am exec failure
 *
 * Caller note: Claude Code's i3() ignores the return code, so a non-
 * zero exit doesn't break the OAuth flow. We still bother validating
 * the input because the same binary may be called from contexts that
 * DO check (wsl-open compatibility, manual user invocation).
 *
 * SECURITY NOTE on scheme allowlist: firing arbitrary intents from a
 * URL passed in by an external CLI is a privilege-escalation hazard.
 * `file://`, `content://`, `intent://` schemes can pivot to Activities
 * we don't intend. The OAuth use case is 100% http/https, so we
 * restrict to those two schemes.
 */

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define AM_BIN "/system/bin/am"

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

    /* URL-encode so embedded `&`, `?`, `#`, `"` etc. survive being
     * folded into the shelly://browser?url=<encoded> query value. The
     * deep-link handler in app/_layout.tsx does decodeURIComponent on
     * the param before handing it to the Browser Pane store. */
    char encoded[8192];
    url_encode(url, encoded, sizeof(encoded));

    char target[16384];
    int written = snprintf(target, sizeof(target),
                           "shelly://browser?url=%s", encoded);
    if (written < 0 || (size_t) written >= sizeof(target)) {
        fprintf(stderr, "xdg-open: deep link URL too long\n");
        return 1;
    }

    /* execv with am ensures the spawned process is a child of the
     * caller (claude / gemini / interactive bash) and carries the
     * caller's env. `am` itself runs as the activity manager bridge;
     * the deep link is dispatched as android.intent.action.VIEW with
     * data <target>, which app/_layout.tsx receives via Linking. */
    char *am_argv[] = {
        (char *) "am",
        (char *) "start",
        (char *) "-a",
        (char *) "android.intent.action.VIEW",
        (char *) "-d",
        target,
        NULL,
    };
    execv(AM_BIN, am_argv);

    /* execv only returns on failure. */
    fprintf(stderr, "xdg-open: execv(%s): %s\n", AM_BIN, strerror(errno));
    return 1;
}
