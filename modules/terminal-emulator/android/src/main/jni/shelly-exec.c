/*
 * shelly-exec.c — Non-interactive command execution via fork+exec+pipe.
 *
 * Unlike shelly-pty.c (which creates a PTY for interactive terminal use),
 * this uses plain pipes to capture stdout/stderr and return them as strings.
 * Used for programmatic command execution (AI dispatch, file ops, diagnostics).
 *
 * JNI class: expo.modules.terminalemulator.ShellyJNI
 */

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <jni.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <linux/netlink.h>
#include <linux/sock_diag.h>
#include <linux/inet_diag.h>
#include <netinet/in.h>
#include <netinet/tcp.h>

#include <android/log.h>

#define TAG "ShellyExec"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  TAG, __VA_ARGS__)

/* Max output buffer: 4 MB per stream */
#define MAX_OUTPUT (4 * 1024 * 1024)

/* Read all data from fd into a malloc'd buffer. Returns length, -1 on error. */
static ssize_t read_all(int fd, char **out) {
    size_t capacity = 4096;
    size_t len = 0;
    char *buf = (char *)malloc(capacity);
    if (!buf) return -1;

    while (len < MAX_OUTPUT) {
        ssize_t n = read(fd, buf + len, capacity - len);
        if (n < 0) {
            if (errno == EINTR) continue;
            free(buf);
            return -1;
        }
        if (n == 0) break;
        len += n;
        if (len >= capacity) {
            capacity *= 2;
            if (capacity > MAX_OUTPUT) capacity = MAX_OUTPUT;
            char *tmp = (char *)realloc(buf, capacity);
            if (!tmp) { free(buf); return -1; }
            buf = tmp;
        }
    }
    *out = buf;
    return (ssize_t)len;
}

JNIEXPORT jobjectArray JNICALL
Java_expo_modules_terminalemulator_ShellyJNI_execSubprocess(
        JNIEnv *env,
        jclass  clazz __attribute__((unused)),
        jstring linkerPathJ,
        jstring bashPathJ,
        jstring ldLibPathJ,
        jstring homePathJ,
        jstring commandJ,
        jint    timeoutMs)
{
    const char *linkerPath = (*env)->GetStringUTFChars(env, linkerPathJ, NULL);
    const char *bashPath   = (*env)->GetStringUTFChars(env, bashPathJ,   NULL);
    const char *ldLibPath  = (*env)->GetStringUTFChars(env, ldLibPathJ,  NULL);
    const char *homePath   = (*env)->GetStringUTFChars(env, homePathJ,   NULL);
    const char *command    = (*env)->GetStringUTFChars(env, commandJ,    NULL);

    if (!linkerPath || !bashPath || !ldLibPath || !homePath || !command) {
        LOGE("GetStringUTFChars failed");
        jclass ex = (*env)->FindClass(env, "java/lang/RuntimeException");
        (*env)->ThrowNew(env, ex, "GetStringUTFChars failed");
        return NULL;
    }

    /* Create pipes for stdout and stderr */
    int stdout_pipe[2], stderr_pipe[2];
    if (pipe(stdout_pipe) < 0 || pipe(stderr_pipe) < 0) {
        LOGE("pipe: %s", strerror(errno));
        jclass ex = (*env)->FindClass(env, "java/lang/RuntimeException");
        (*env)->ThrowNew(env, ex, "pipe() failed");
        goto release_strings;
    }

    pid_t pid = fork();

    if (pid < 0) {
        LOGE("fork: %s", strerror(errno));
        close(stdout_pipe[0]); close(stdout_pipe[1]);
        close(stderr_pipe[0]); close(stderr_pipe[1]);
        jclass ex = (*env)->FindClass(env, "java/lang/RuntimeException");
        (*env)->ThrowNew(env, ex, "fork() failed");
        goto release_strings;
    }

    if (pid == 0) {
        /* ============ CHILD ============ */

        /* Redirect stdout/stderr to pipes */
        close(stdout_pipe[0]);
        close(stderr_pipe[0]);
        dup2(stdout_pipe[1], STDOUT_FILENO);
        dup2(stderr_pipe[1], STDERR_FILENO);
        close(stdout_pipe[1]);
        close(stderr_pipe[1]);

        /* Close stdin (not interactive) */
        close(STDIN_FILENO);
        open("/dev/null", O_RDONLY);

        /* Reset signals */
        struct sigaction sa;
        memset(&sa, 0, sizeof(sa));
        sa.sa_handler = SIG_DFL;
        for (int s = 1; s < 32; s++) {
            sigaction(s, &sa, NULL);
        }
        sigset_t sigs;
        sigfillset(&sigs);
        sigprocmask(SIG_UNBLOCK, &sigs, NULL);

        /* Build environment — use explicit envp array instead of clearenv+setenv
         * because Android Bionic's clearenv() can leave environ in a state
         * where subsequent setenv() calls don't actually populate the
         * environ pointer used by execve(). */
        char pathBuf[2048];
        snprintf(pathBuf, sizeof(pathBuf),
                 "PATH=%s:%s/node_modules/npm/bin:%s/node_modules/.bin:/usr/bin:/usr/sbin:/bin:/sbin",
                 ldLibPath, ldLibPath, ldLibPath);

        char homeBuf[512];
        snprintf(homeBuf, sizeof(homeBuf), "HOME=%s", homePath);

        char ldBuf[512];
        snprintf(ldBuf, sizeof(ldBuf), "LD_LIBRARY_PATH=%s", ldLibPath);

        char shellBuf[512];
        snprintf(shellBuf, sizeof(shellBuf), "SHELL=%s", bashPath);

        /* LD_PRELOAD exec wrapper for linker64 redirection */
        char preloadBuf[1024];
        snprintf(preloadBuf, sizeof(preloadBuf),
                 "LD_PRELOAD=%s/libexec_wrapper.so", ldLibPath);

        char *envp[] = {
            pathBuf,
            homeBuf,
            (char *)"TERM=dumb",
            (char *)"LANG=en_US.UTF-8",
            ldBuf,
            shellBuf,
            preloadBuf,
            NULL
        };

        if (chdir(homePath) != 0) { /* non-fatal */ }

        /* execve: linker64 → bash -c "command" */
        char *argv[] = {
            (char *)linkerPath,
            (char *)bashPath,
            "-c",
            (char *)command,
            NULL
        };
        execve(linkerPath, argv, envp);

        /* If execve failed */
        _exit(127);
    }

    /* ============ PARENT ============ */
    close(stdout_pipe[1]);
    close(stderr_pipe[1]);

    LOGI("execSubprocess: child pid=%d, cmd=%.80s", (int)pid, command);

    /* Set non-blocking on read ends for timeout support */
    fcntl(stdout_pipe[0], F_SETFL, O_NONBLOCK);
    fcntl(stderr_pipe[0], F_SETFL, O_NONBLOCK);

    /* Read stdout and stderr with timeout */
    int timeout_sec = (timeoutMs > 0) ? (timeoutMs / 1000) : 120;
    if (timeout_sec < 1) timeout_sec = 1;

    /* Use select() with timeout to read both pipes */
    char *stdout_buf = NULL, *stderr_buf = NULL;
    size_t stdout_len = 0, stderr_len = 0;
    size_t stdout_cap = 4096, stderr_cap = 4096;
    stdout_buf = (char *)malloc(stdout_cap);
    stderr_buf = (char *)malloc(stderr_cap);

    time_t deadline = time(NULL) + timeout_sec;
    int stdout_eof = 0, stderr_eof = 0;
    /* bug #70 regression guard: count EAGAIN spurious-wake retries so
     * logcat can confirm the fix is live on real hardware. If we ever
     * see a stdout buffer come back empty again, the eagain counter
     * tells us whether the read loop was actually exercised or whether
     * select fired zero times. */
    int stdout_eagain = 0, stderr_eagain = 0;

    while (!stdout_eof || !stderr_eof) {
        fd_set rfds;
        FD_ZERO(&rfds);
        int maxfd = -1;
        if (!stdout_eof) { FD_SET(stdout_pipe[0], &rfds); if (stdout_pipe[0] > maxfd) maxfd = stdout_pipe[0]; }
        if (!stderr_eof) { FD_SET(stderr_pipe[0], &rfds); if (stderr_pipe[0] > maxfd) maxfd = stderr_pipe[0]; }
        if (maxfd < 0) break;

        struct timeval tv;
        time_t remaining = deadline - time(NULL);
        if (remaining <= 0) {
            LOGE("execSubprocess: timeout after %ds, killing pid %d", timeout_sec, (int)pid);
            kill(pid, SIGKILL);
            break;
        }
        tv.tv_sec = (remaining > 2) ? 2 : remaining;
        tv.tv_usec = 0;

        int ret = select(maxfd + 1, &rfds, NULL, NULL, &tv);
        if (ret < 0) {
            if (errno == EINTR) continue;
            break;
        }
        if (ret == 0) continue; /* timeout on select, loop will check deadline */

        /* Read stdout.
         *
         * bug #70: the previous version treated any `n <= 0` as EOF, which
         * misclassified EAGAIN/EWOULDBLOCK (transient empty-pipe state on a
         * non-blocking fd) as end-of-stream. On devices where the child
         * takes a beat to write before closing (common with bash + tiny
         * commands like `git status | wc -l`), the parent would read once,
         * see nothing, flag EOF, and return exitCode=0 + stdout="" while
         * the child was still mid-flight. The fix is to only flag EOF on
         * a genuine read=0 return; treat n<0 with EAGAIN/EWOULDBLOCK/EINTR
         * as "try again next select tick".
         */
        if (!stdout_eof && FD_ISSET(stdout_pipe[0], &rfds)) {
            if (stdout_len >= stdout_cap) {
                stdout_cap *= 2;
                if (stdout_cap > MAX_OUTPUT) stdout_cap = MAX_OUTPUT;
                stdout_buf = (char *)realloc(stdout_buf, stdout_cap);
            }
            ssize_t n = read(stdout_pipe[0], stdout_buf + stdout_len,
                           (stdout_cap - stdout_len > 4096) ? 4096 : stdout_cap - stdout_len);
            if (n == 0) {
                stdout_eof = 1;
            } else if (n < 0) {
                if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) {
                    LOGE("execSubprocess: stdout read error errno=%d (%s)",
                         errno, strerror(errno));
                    stdout_eof = 1;
                } else {
                    stdout_eagain++;
                }
                /* else: spurious wake, retry on next select tick */
            } else {
                stdout_len += n;
            }
        }

        /* Read stderr */
        if (!stderr_eof && FD_ISSET(stderr_pipe[0], &rfds)) {
            if (stderr_len >= stderr_cap) {
                stderr_cap *= 2;
                if (stderr_cap > MAX_OUTPUT) stderr_cap = MAX_OUTPUT;
                stderr_buf = (char *)realloc(stderr_buf, stderr_cap);
            }
            ssize_t n = read(stderr_pipe[0], stderr_buf + stderr_len,
                           (stderr_cap - stderr_len > 4096) ? 4096 : stderr_cap - stderr_len);
            if (n == 0) {
                stderr_eof = 1;
            } else if (n < 0) {
                if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) {
                    LOGE("execSubprocess: stderr read error errno=%d (%s)",
                         errno, strerror(errno));
                    stderr_eof = 1;
                } else {
                    stderr_eagain++;
                }
            } else {
                stderr_len += n;
            }
        }
    }

    close(stdout_pipe[0]);
    close(stderr_pipe[0]);

    /* Wait for child */
    int status;
    waitpid(pid, &status, 0);
    int exitCode = WIFEXITED(status) ? WEXITSTATUS(status) : (WIFSIGNALED(status) ? 128 + WTERMSIG(status) : -1);

    LOGI("execSubprocess: pid=%d exited with code %d, stdout=%zu bytes (eagain=%d), stderr=%zu bytes (eagain=%d)",
         (int)pid, exitCode, stdout_len, stdout_eagain, stderr_len, stderr_eagain);

    /* Build result array: [exitCodeStr, stdout, stderr] */
    jclass strClass = (*env)->FindClass(env, "java/lang/String");
    jobjectArray result = (*env)->NewObjectArray(env, 3, strClass, NULL);

    char exitStr[16];
    snprintf(exitStr, sizeof(exitStr), "%d", exitCode);
    (*env)->SetObjectArrayElement(env, result, 0, (*env)->NewStringUTF(env, exitStr));

    /* Null-terminate before handing to NewStringUTF. Must make room first:
     * if stdout_len == stdout_cap (capacity exactly filled, which happens at
     * the 4 MiB MAX_OUTPUT ceiling), writing buf[stdout_len] would be a
     * 1-byte heap OOB. realloc to +1 if needed. */
    if (stdout_buf && stdout_len == stdout_cap) {
        char *grown = (char *)realloc(stdout_buf, stdout_cap + 1);
        if (grown) stdout_buf = grown;
        else stdout_len = stdout_cap ? stdout_cap - 1 : 0; /* fall back to truncate */
    }
    if (stderr_buf && stderr_len == stderr_cap) {
        char *grown = (char *)realloc(stderr_buf, stderr_cap + 1);
        if (grown) stderr_buf = grown;
        else stderr_len = stderr_cap ? stderr_cap - 1 : 0;
    }

    /* Create Java strings from buffers */
    jstring stdoutJ = stdout_buf ? (*env)->NewStringUTF(env, stdout_len > 0 ? (stdout_buf[stdout_len] = '\0', stdout_buf) : "") : (*env)->NewStringUTF(env, "");
    jstring stderrJ = stderr_buf ? (*env)->NewStringUTF(env, stderr_len > 0 ? (stderr_buf[stderr_len] = '\0', stderr_buf) : "") : (*env)->NewStringUTF(env, "");

    (*env)->SetObjectArrayElement(env, result, 1, stdoutJ);
    (*env)->SetObjectArrayElement(env, result, 2, stderrJ);

    free(stdout_buf);
    free(stderr_buf);

    /* Release strings */
    (*env)->ReleaseStringUTFChars(env, linkerPathJ, linkerPath);
    (*env)->ReleaseStringUTFChars(env, bashPathJ,   bashPath);
    (*env)->ReleaseStringUTFChars(env, ldLibPathJ,   ldLibPath);
    (*env)->ReleaseStringUTFChars(env, homePathJ,    homePath);
    (*env)->ReleaseStringUTFChars(env, commandJ,     command);

    return result;

release_strings:
    if (linkerPath) (*env)->ReleaseStringUTFChars(env, linkerPathJ, linkerPath);
    if (bashPath)   (*env)->ReleaseStringUTFChars(env, bashPathJ,   bashPath);
    if (ldLibPath)  (*env)->ReleaseStringUTFChars(env, ldLibPathJ,  ldLibPath);
    if (homePath)   (*env)->ReleaseStringUTFChars(env, homePathJ,   homePath);
    if (command)    (*env)->ReleaseStringUTFChars(env, commandJ,    command);
    return NULL;
}

/*
 * readProcNetFile — read a small procfs file (e.g. /proc/net/tcp6) directly
 * via fopen in-process. Works around bug #36: shelling out to `cat` via
 * bash+LD_PRELOAD fails with exit=1 on some devices due to PATH/SELinux/
 * LD_LIBRARY_PATH interactions, but fopen() from the app process itself
 * has no such constraint — the app's own uid can read /proc/net/tcp{,6}
 * (the kernel filters rows by uid so we only see this app's sockets).
 *
 * Returns the file contents as a Java String, or an empty string on any
 * error (file missing, permission denied, etc.). Never throws.
 */
JNIEXPORT jstring JNICALL
Java_expo_modules_terminalemulator_ShellyJNI_readProcNetFile(
        JNIEnv *env,
        jclass  clazz __attribute__((unused)),
        jstring pathJ)
{
    if (!pathJ) return (*env)->NewStringUTF(env, "");
    const char *path = (*env)->GetStringUTFChars(env, pathJ, NULL);
    if (!path) return (*env)->NewStringUTF(env, "");

    FILE *f = fopen(path, "r");
    if (!f) {
        LOGE("readProcNetFile: fopen(%s) failed: %s", path, strerror(errno));
        (*env)->ReleaseStringUTFChars(env, pathJ, path);
        return (*env)->NewStringUTF(env, "");
    }

    /* /proc/net/tcp{,6} is typically well under 64 KiB; grow if needed. */
    size_t cap = 65536;
    size_t len = 0;
    char *buf = (char *)malloc(cap);
    if (!buf) {
        fclose(f);
        (*env)->ReleaseStringUTFChars(env, pathJ, path);
        return (*env)->NewStringUTF(env, "");
    }

    for (;;) {
        if (len + 1 >= cap) {
            size_t newCap = cap * 2;
            if (newCap > MAX_OUTPUT) newCap = MAX_OUTPUT;
            if (newCap <= cap) break; /* hit ceiling */
            char *tmp = (char *)realloc(buf, newCap);
            if (!tmp) break;
            buf = tmp;
            cap = newCap;
        }
        size_t want = cap - len - 1;
        size_t n = fread(buf + len, 1, want, f);
        len += n;
        if (n < want) break; /* EOF or error */
    }
    buf[len] = '\0';
    fclose(f);

    LOGI("readProcNetFile: %s -> %zu bytes", path, len);

    jstring result = (*env)->NewStringUTF(env, buf);
    free(buf);
    (*env)->ReleaseStringUTFChars(env, pathJ, path);
    return result;
}

/*
 * readDir(path) — list a directory directly via opendir/readdir/lstat in
 * the app process. Bug #70: shelling out to `ls` via bash+LD_PRELOAD/linker64
 * fails with exit=0 stdout=0chars on some devices (same root cause as bug
 * #36), breaking the Sidebar FILE TREE / FilesTab preview. Going through
 * plain libc syscalls from the app uid sidesteps PATH / SELinux / LD_*
 * interactions entirely.
 *
 * Output format: one line per entry, tab-delimited:
 *     NAME\tTYPE\tSIZE\n
 * where TYPE is 'd' (dir), 'f' (regular file), 'l' (symlink), '?' (other).
 * "." and ".." are skipped; callers re-add them if needed.
 *
 * Returns an empty string on any error (ENOENT, EACCES, OOM). Never throws.
 */
JNIEXPORT jstring JNICALL
Java_expo_modules_terminalemulator_ShellyJNI_readDir(
        JNIEnv *env,
        jclass  clazz __attribute__((unused)),
        jstring pathJ)
{
    if (!pathJ) return (*env)->NewStringUTF(env, "");
    const char *path = (*env)->GetStringUTFChars(env, pathJ, NULL);
    if (!path) return (*env)->NewStringUTF(env, "");

    DIR *dir = opendir(path);
    if (!dir) {
        LOGE("readDir: opendir(%s) failed: %s", path, strerror(errno));
        (*env)->ReleaseStringUTFChars(env, pathJ, path);
        return (*env)->NewStringUTF(env, "");
    }

    size_t cap = 65536;
    size_t used = 0;
    char *buf = (char *)malloc(cap);
    if (!buf) {
        closedir(dir);
        (*env)->ReleaseStringUTFChars(env, pathJ, path);
        return (*env)->NewStringUTF(env, "");
    }

    struct dirent *entry;
    char fullpath[4096];
    while ((entry = readdir(dir)) != NULL) {
        const char *name = entry->d_name;
        if (name[0] == '.' && (name[1] == '\0' || (name[1] == '.' && name[2] == '\0'))) {
            continue;  /* skip . and .. */
        }

        /* lstat for size + type (don't follow symlinks) */
        snprintf(fullpath, sizeof(fullpath), "%s/%s", path, name);
        struct stat st;
        char type = '?';
        long long size = 0;
        if (lstat(fullpath, &st) == 0) {
            if (S_ISDIR(st.st_mode)) type = 'd';
            else if (S_ISLNK(st.st_mode)) type = 'l';
            else if (S_ISREG(st.st_mode)) type = 'f';
            size = (long long)st.st_size;
        }

        /* Grow the buffer if this line might not fit (worst-case name ~256,
         * plus type+size+delims ~32; double until it does, cap at 4 MiB). */
        size_t need = strlen(name) + 48;
        while (used + need >= cap) {
            size_t newCap = cap * 2;
            if (newCap > MAX_OUTPUT) newCap = MAX_OUTPUT;
            if (newCap <= cap) { need = 0; break; } /* hit ceiling */
            char *tmp = (char *)realloc(buf, newCap);
            if (!tmp) { need = 0; break; }
            buf = tmp;
            cap = newCap;
        }
        if (need == 0) break;

        int written = snprintf(buf + used, cap - used,
                               "%s\t%c\t%lld\n", name, type, size);
        if (written <= 0 || (size_t)written >= cap - used) break;
        used += (size_t)written;
    }

    closedir(dir);
    buf[used] = '\0';

    LOGI("readDir: %s -> %zu bytes", path, used);

    jstring result = (*env)->NewStringUTF(env, buf);
    free(buf);
    (*env)->ReleaseStringUTFChars(env, pathJ, path);
    return result;
}

/*
 * queryListenSockets — enumerate the app's TCP listen sockets via
 * NETLINK_SOCK_DIAG. Works around bug #99: Android 10+ SELinux policy
 * denies untrusted_app reads of /proc/net/tcp{,6}, so the old fopen
 * path (readProcNetFile) returns EACCES and the Sidebar's Ports
 * section permanently reads "No listeners" even when node / python
 * are happily serving on localhost.
 *
 * The SOCK_DIAG netlink family is not blocked by the same SELinux
 * rule and the kernel auto-filters by calling-process credentials,
 * so we see only the sockets this app owns — exactly what the Sidebar
 * wants.
 *
 * Output format mimics /proc/net/tcp so the existing parseProcNetTcp
 * consumer can eat it verbatim. One header line (skipped by the
 * parser) + one socket line per listen:
 *
 *   "  sl  local_address rem_address   st ...\n"
 *   "   0: 00000000:0BB8 00000000:0000 0A ...\n"
 *
 * Both families (AF_INET and AF_INET6) are merged into a single
 * string; the caller tags entries by family via the /proc/net path
 * it was requested against (tcp vs tcp6) — we produce per-family
 * strings from two successive JNI calls to keep that shape.
 */
static int netlink_dump_listen(int family, char *out, size_t cap, size_t *pos) {
    int fd = socket(AF_NETLINK, SOCK_DGRAM, NETLINK_SOCK_DIAG);
    if (fd < 0) {
        LOGE("queryListenSockets: socket(AF_NETLINK) failed: %s", strerror(errno));
        return -1;
    }

    struct {
        struct nlmsghdr         nh;
        struct inet_diag_req_v2 req;
    } req;
    memset(&req, 0, sizeof(req));
    req.nh.nlmsg_len     = sizeof(req);
    req.nh.nlmsg_type    = SOCK_DIAG_BY_FAMILY;
    req.nh.nlmsg_flags   = NLM_F_REQUEST | NLM_F_DUMP;
    req.nh.nlmsg_seq     = 1;
    req.req.sdiag_family = (__u8)family;
    req.req.sdiag_protocol = IPPROTO_TCP;
    req.req.idiag_states = (__u32)(1U << TCP_LISTEN);

    if (send(fd, &req, sizeof(req), 0) < 0) {
        LOGE("queryListenSockets: send failed: %s", strerror(errno));
        close(fd);
        return -1;
    }

    char rbuf[8192];
    int slot = 0;
    for (;;) {
        ssize_t n = recv(fd, rbuf, sizeof(rbuf), 0);
        if (n <= 0) break;
        struct nlmsghdr *nh;
        for (nh = (struct nlmsghdr *)rbuf; NLMSG_OK(nh, n); nh = NLMSG_NEXT(nh, n)) {
            if (nh->nlmsg_type == NLMSG_DONE) { close(fd); return 0; }
            if (nh->nlmsg_type == NLMSG_ERROR) { close(fd); return -1; }
            struct inet_diag_msg *msg = (struct inet_diag_msg *)NLMSG_DATA(nh);
            uint16_t port = ntohs(msg->id.idiag_sport);

            /* Build the IP hex for /proc-format. v4 is 8 little-endian hex
             * chars, v6 is 32 hex chars (four 32-bit little-endian words). */
            char ip_hex[33] = {0};
            if (family == AF_INET) {
                /* idiag_src[0] holds network-order v4 address; reverse
                 * bytes to match /proc/net/tcp little-endian storage. */
                uint8_t *src = (uint8_t *)&msg->id.idiag_src[0];
                snprintf(ip_hex, sizeof(ip_hex), "%02X%02X%02X%02X",
                         src[3], src[2], src[1], src[0]);
            } else {
                uint8_t *src = (uint8_t *)msg->id.idiag_src;
                /* Group into four 32-bit little-endian words: reverse
                 * bytes within each word. */
                for (int w = 0; w < 4; w++) {
                    snprintf(ip_hex + w * 8, 9, "%02X%02X%02X%02X",
                             src[w * 4 + 3], src[w * 4 + 2],
                             src[w * 4 + 1], src[w * 4 + 0]);
                }
            }

            /* One line, /proc/net/tcp-compatible. UID is correct (we only
             * see our own sockets); inode slot zeros are fine — the parser
             * only looks at cols 0 (slot:), 1 (local_addr:port), 3 (state),
             * which are exactly the four we emit meaningfully here. */
            int written = snprintf(out + *pos, cap - *pos,
                "%4d: %s:%04X 00000000:0000 0A 00000000:00000000 00:00000000 00000000 %d 0 0 0\n",
                slot++, ip_hex, port, (int)msg->idiag_uid);
            if (written < 0 || (size_t)written >= cap - *pos) {
                /* Out of buffer space — return what we have. */
                close(fd);
                return 0;
            }
            *pos += written;
        }
    }

    close(fd);
    return 0;
}

JNIEXPORT jstring JNICALL
Java_expo_modules_terminalemulator_ShellyJNI_queryListenSockets(
        JNIEnv *env,
        jclass  clazz __attribute__((unused)),
        jint    familyJ)
{
    /* Header line so parseProcNetTcp's lines.slice(1) still lands on
     * real data; contents irrelevant since the parser throws it away. */
    char buf[16384];
    size_t pos = snprintf(buf, sizeof(buf),
        "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n");

    int family = (familyJ == 6) ? AF_INET6 : AF_INET;
    int rc = netlink_dump_listen(family, buf, sizeof(buf), &pos);
    if (rc < 0) {
        LOGE("queryListenSockets: netlink_dump_listen(%d) failed", family);
        return (*env)->NewStringUTF(env, "");
    }
    buf[pos] = '\0';
    LOGI("queryListenSockets: family=%d -> %zu bytes", family, pos);
    return (*env)->NewStringUTF(env, buf);
}
