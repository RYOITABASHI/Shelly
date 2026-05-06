/*
 * exec-wrapper.c -- LD_PRELOAD library for Android app-data binary execution.
 *
 * On Android 10+ with targetSdkVersion >= 29, SELinux blocks direct execve()
 * on files in app_data_file directories (the "W^X" / noexec policy).
 * The standard workaround is to invoke binaries via /system/bin/linker64,
 * which loads the ELF binary via mmap() (which IS allowed) rather than
 * relying on the kernel's execve() permission check.
 *
 * This LD_PRELOAD library intercepts every execve() call and, if the target
 * is an ELF binary in app-data (not a system/vendor/apex path), rewrites:
 *
 *   execve("/data/.../node", ["node", "script.js"], envp)
 *     --> execve("/system/bin/linker64", ["linker64", "/data/.../node", "script.js"], envp)
 *
 * Because LD_PRELOAD is inherited by child processes, this fix propagates
 * through the entire process tree: bash -> node -> git -> etc.
 *
 * Some Linux-native CLIs also hard-code /bin/sh for tool execution. Android
 * exposes the shell at /system/bin/sh instead, so we rewrite that path before
 * falling through. This keeps Codex's internal shell tool working without a
 * proot/chroot just to provide /bin/sh.
 *
 * Build: added to CMakeLists.txt as a SHARED library (libexec_wrapper.so).
 * At runtime, LibExtractor extracts it alongside other .so files, and
 * shelly-pty.c sets LD_PRELOAD before launching the bash PTY.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <stdlib.h>
#include <spawn.h>
#ifdef __ANDROID__
#include <android/log.h>
#endif

#define LINKER64 "/system/bin/linker64"
#define LOG_TAG "ShellyExecWrapper"

#ifdef __ANDROID__
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, LOG_TAG, __VA_ARGS__)
#else
/* Bug #117 Path A: same source compiled for musl Bun SEA. Logging
 * is no-op on musl so wrapper diagnostics don't pollute Claude's
 * Bash tool stderr. */
#define LOGI(...) ((void)0)
#define LOGW(...) ((void)0)
#endif

extern char **environ;

/* Check if file starts with ELF magic bytes (0x7f 'E' 'L' 'F') */
static int is_elf(const char *path) {
    int fd = open(path, O_RDONLY);
    if (fd < 0) return 0;
    unsigned char magic[4];
    ssize_t n = read(fd, magic, 4);
    close(fd);
    return (n == 4 && magic[0] == 0x7f && magic[1] == 'E'
                   && magic[2] == 'L'  && magic[3] == 'F');
}

static const char *rewrite_path(const char *pathname) {
    if (!pathname) return NULL;

    /* bash / sh / env: route to the Shelly-controlled $SHELL or toybox.
     * These are matched first so they take precedence over the generic
     * /bin/... -> /system/bin/... prefix rewrite below (bash in particular
     * must reach $libDir/shelly_shell, not a non-existent /system/bin/bash).
     */
    if (strcmp(pathname, "/bin/sh") == 0) return "/system/bin/sh";
    if (strcmp(pathname, "sh") == 0) return "/system/bin/sh";
    if (strcmp(pathname, "/usr/bin/env") == 0) return "/system/bin/env";
    if (strcmp(pathname, "env") == 0) return "/system/bin/env";
    if (strcmp(pathname, "/bin/bash") == 0 || strcmp(pathname, "bash") == 0) {
        /* MEDIUM per Codex audit 2026-04-25: SHELL env is attacker-
         * controllable in theory (inherited from parent). Only accept
         * absolute paths inside trusted prefixes to prevent a rewrite
         * to an arbitrary binary. /data/user/0/dev.shelly.terminal is
         * Shelly's own app-data directory, /system/bin holds toybox
         * shells. Anything else falls through to the generic prefix
         * rewrite (or the unchanged pathname if no rewrite applies).
         */
        const char *shell = getenv("SHELL");
        if (shell && shell[0] == '/' &&
            (strncmp(shell, "/data/user/0/dev.shelly.terminal/", 33) == 0 ||
             strncmp(shell, "/data/data/dev.shelly.terminal/", 31) == 0 ||
             strncmp(shell, "/system/bin/", 12) == 0)) {
            return shell;
        }
    }

    /* Generic prefix rewrite for /bin/... and /usr/bin/.... Android has no
     * /bin or /usr/bin, but many CLIs (Codex's sandbox exec, GNU make,
     * misc POSIX tools) hard-code those paths for whoami/uname/id/
     * getprop/cat/ls/etc. Android's toybox exposes them at /system/bin/.
     * Rewriting here is safe because on Android those prefixes never
     * resolve to anything else, so any caller using /bin/X is either
     * assuming Linux layout or a typo — both are better served by the
     * toybox equivalent than an ENOENT.
     *
     * Buffer is thread-local so concurrent execve() calls on different
     * threads don't trample each other. The returned pointer is valid
     * until the next rewrite_path() call on the same thread, which is
     * long enough because the caller feeds it straight to execve().
     */
    /* LOW per Codex audit 2026-04-25: check snprintf return so a
     * pathological long path doesn't silently truncate into an
     * unrelated executable name. If the rewritten form would overflow
     * PATH_MAX, surface ENAMETOOLONG by returning NULL (callers treat
     * NULL as a non-rewrite + pass through, which will then fail with
     * ENOENT and the caller gets a proper error). */
    static __thread char rewrite_buf[PATH_MAX];
    if (strncmp(pathname, "/bin/", 5) == 0) {
        int n = snprintf(rewrite_buf, sizeof(rewrite_buf), "/system/bin/%s", pathname + 5);
        if (n < 0 || (size_t)n >= sizeof(rewrite_buf)) { errno = ENAMETOOLONG; return NULL; }
        return rewrite_buf;
    }
    if (strncmp(pathname, "/usr/bin/", 9) == 0) {
        int n = snprintf(rewrite_buf, sizeof(rewrite_buf), "/system/bin/%s", pathname + 9);
        if (n < 0 || (size_t)n >= sizeof(rewrite_buf)) { errno = ENAMETOOLONG; return NULL; }
        return rewrite_buf;
    }

    return pathname;
}

static int should_linker_exec(const char *pathname) {
    return pathname &&
        strcmp(pathname, LINKER64) != 0 &&
        strncmp(pathname, "/system/", 8) != 0 &&
        strncmp(pathname, "/vendor/", 8) != 0 &&
        strncmp(pathname, "/apex/",   6) != 0 &&
        is_elf(pathname);
}

static char **build_linker_argv(const char *pathname, char *const argv[]) {
    int argc = 0;
    if (argv) {
        while (argv[argc]) argc++;
    }

    char **new_argv = (char **)malloc((argc + 2) * sizeof(char *));
    if (!new_argv) return NULL;

    new_argv[0] = LINKER64;
    new_argv[1] = (char *)pathname;
    for (int i = 1; i <= argc; i++) {
        new_argv[i + 1] = argv[i];
    }
    return new_argv;
}

/*
 * Intercept execve(). If the target is an ELF binary outside system paths,
 * redirect through linker64 so SELinux doesn't block it.
 */
int execve(const char *pathname, char *const argv[], char *const envp[]) {
    typedef int (*orig_t)(const char *, char *const [], char *const []);
    orig_t orig = (orig_t)dlsym(RTLD_NEXT, "execve");
    /* MEDIUM per Codex audit: guard against dlsym RTLD_NEXT failure
     * (dynamic linker hasn't finished wiring libc yet, or the symbol
     * was stripped). Surface ENOSYS rather than segfaulting on the
     * null function pointer. */
    if (!orig) { errno = ENOSYS; return -1; }
    const char *rewritten = rewrite_path(pathname);
    if (!rewritten) return -1; /* errno already set by rewrite_path (ENAMETOOLONG) */

    /* v74 (2026-05-06): always re-evaluate should_linker_exec on the
     * (possibly rewritten) target. Previous flow short-circuited the
     * linker prefix whenever rewrite_path returned a different pointer,
     * which broke `bash`/`sh` rewrites that point at app-data shared
     * objects (libbash.so) — a direct execve of a .so file is rejected
     * by Android's loader, surfacing as Claude Code Bash tool exit 1. */
    if (rewritten != pathname) {
        LOGI("rewrite exec path=%s -> %s", pathname, rewritten);
    }

    /* Pass through for: null path, linker64 itself, system/vendor/apex
     * binaries, and non-ELF files (scripts, etc. -- those use shebang
     * which the interpreter handles). */
    if (!should_linker_exec(rewritten)) {
        int ret = orig(rewritten, argv, envp);
        if (ret == -1) {
            LOGW("exec pass-through failed path=%s errno=%d",
                                rewritten ? rewritten : "(null)", errno);
        }
        return ret;
    }

    /* Build new argv: ["linker64", rewritten, original_argv[1], ..., NULL] */
    char **new_argv = build_linker_argv(rewritten, argv);
    if (!new_argv) {
        return orig(rewritten, argv, envp); /* OOM fallback */
    }

    LOGI("linker exec path=%s", rewritten);
    int ret = orig(LINKER64, new_argv, envp);
    int saved = errno;
    LOGW("linker exec failed path=%s errno=%d", rewritten, saved);
    free(new_argv);
    errno = saved;
    return ret;
}

int posix_spawn(pid_t *pid, const char *path,
                const posix_spawn_file_actions_t *file_actions,
                const posix_spawnattr_t *attrp,
                char *const argv[], char *const envp[]) {
    typedef int (*orig_t)(pid_t *, const char *,
                          const posix_spawn_file_actions_t *,
                          const posix_spawnattr_t *,
                          char *const [], char *const []);
    orig_t orig = (orig_t)dlsym(RTLD_NEXT, "posix_spawn");
    if (!orig) return ENOSYS;
    const char *rewritten = rewrite_path(path);
    if (!rewritten) return errno ? errno : ENAMETOOLONG;

    if (rewritten != path) {
        LOGI("rewrite spawn path=%s -> %s", path, rewritten);
    }

    if (!should_linker_exec(rewritten)) {
        int ret = orig(pid, rewritten, file_actions, attrp, argv, envp);
        if (ret != 0) {
            LOGW("spawn pass-through failed path=%s ret=%d",
                                rewritten ? rewritten : "(null)", ret);
        }
        return ret;
    }

    char **new_argv = build_linker_argv(rewritten, argv);
    if (!new_argv) return orig(pid, rewritten, file_actions, attrp, argv, envp);

    LOGI("linker spawn path=%s", rewritten);
    int ret = orig(pid, LINKER64, file_actions, attrp, new_argv, envp);
    if (ret != 0) {
        LOGW("linker spawn failed path=%s ret=%d", rewritten, ret);
    }
    free(new_argv);
    return ret;
}

int posix_spawnp(pid_t *pid, const char *file,
                 const posix_spawn_file_actions_t *file_actions,
                 const posix_spawnattr_t *attrp,
                 char *const argv[], char *const envp[]) {
    typedef int (*orig_t)(pid_t *, const char *,
                          const posix_spawn_file_actions_t *,
                          const posix_spawnattr_t *,
                          char *const [], char *const []);
    orig_t orig = (orig_t)dlsym(RTLD_NEXT, "posix_spawnp");
    if (!orig) return ENOSYS;
    const char *rewritten = rewrite_path(file);
    if (!rewritten) return errno ? errno : ENAMETOOLONG;

    if (rewritten != file) {
        LOGI("rewrite spawnp path=%s -> %s", file, rewritten);
        return posix_spawn(pid, rewritten, file_actions, attrp, argv, envp);
    }

    return orig(pid, file, file_actions, attrp, argv, envp);
}

int execvp(const char *file, char *const argv[]) {
    typedef int (*orig_t)(const char *, char *const []);
    orig_t orig = (orig_t)dlsym(RTLD_NEXT, "execvp");
    if (!orig) { errno = ENOSYS; return -1; }
    const char *rewritten = rewrite_path(file);
    if (!rewritten) return -1;

    if (rewritten != file) {
        LOGI("rewrite execvp path=%s -> %s", file, rewritten);
        return execve(rewritten, argv, environ);
    }

    return orig(file, argv);
}

int execvpe(const char *file, char *const argv[], char *const envp[]) {
    typedef int (*orig_t)(const char *, char *const [], char *const []);
    orig_t orig = (orig_t)dlsym(RTLD_NEXT, "execvpe");
    if (!orig) { errno = ENOSYS; return -1; }
    const char *rewritten = rewrite_path(file);
    if (!rewritten) return -1;

    if (rewritten != file) {
        LOGI("rewrite execvpe path=%s -> %s", file, rewritten);
        return execve(rewritten, argv, envp);
    }

    return orig(file, argv, envp);
}
