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
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <stdlib.h>
#include <android/log.h>
#include <spawn.h>

#define LINKER64 "/system/bin/linker64"
#define LOG_TAG "ShellyExecWrapper"

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
    if (strcmp(pathname, "/bin/sh") == 0) return "/system/bin/sh";
    if (strcmp(pathname, "/usr/bin/env") == 0) return "/system/bin/env";
    if (strcmp(pathname, "/bin/bash") == 0) {
        const char *shell = getenv("SHELL");
        if (shell && shell[0]) return shell;
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
    const char *rewritten = rewrite_path(pathname);

    if (rewritten != pathname) {
        __android_log_print(ANDROID_LOG_INFO, LOG_TAG,
                            "rewrite exec path=%s -> %s", pathname, rewritten);
        int ret = orig(rewritten, argv, envp);
        __android_log_print(ANDROID_LOG_WARN, LOG_TAG,
                            "exec rewritten path=%s failed errno=%d", rewritten, errno);
        return ret;
    }

    /* Pass through for: null path, linker64 itself, system/vendor/apex binaries,
     * and non-ELF files (scripts, etc. -- those use shebang which the
     * interpreter handles) */
    if (!should_linker_exec(pathname)) {
        int ret = orig(pathname, argv, envp);
        if (ret == -1) {
            __android_log_print(ANDROID_LOG_WARN, LOG_TAG,
                                "exec pass-through failed path=%s errno=%d",
                                pathname ? pathname : "(null)", errno);
        }
        return ret;
    }

    /* Build new argv: ["linker64", pathname, original_argv[1], ..., NULL] */
    char **new_argv = build_linker_argv(pathname, argv);
    if (!new_argv) {
        return orig(pathname, argv, envp); /* OOM fallback */
    }

    __android_log_print(ANDROID_LOG_INFO, LOG_TAG,
                        "linker exec path=%s", pathname);
    int ret = orig(LINKER64, new_argv, envp);
    int saved = errno;
    __android_log_print(ANDROID_LOG_WARN, LOG_TAG,
                        "linker exec failed path=%s errno=%d", pathname, saved);
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
    const char *rewritten = rewrite_path(path);

    if (rewritten != path) {
        __android_log_print(ANDROID_LOG_INFO, LOG_TAG,
                            "rewrite spawn path=%s -> %s", path, rewritten);
        int ret = orig(pid, rewritten, file_actions, attrp, argv, envp);
        if (ret != 0) {
            __android_log_print(ANDROID_LOG_WARN, LOG_TAG,
                                "spawn rewritten path=%s failed ret=%d", rewritten, ret);
        }
        return ret;
    }

    if (!should_linker_exec(path)) {
        int ret = orig(pid, path, file_actions, attrp, argv, envp);
        if (ret != 0) {
            __android_log_print(ANDROID_LOG_WARN, LOG_TAG,
                                "spawn pass-through failed path=%s ret=%d",
                                path ? path : "(null)", ret);
        }
        return ret;
    }

    char **new_argv = build_linker_argv(path, argv);
    if (!new_argv) return orig(pid, path, file_actions, attrp, argv, envp);

    __android_log_print(ANDROID_LOG_INFO, LOG_TAG, "linker spawn path=%s", path);
    int ret = orig(pid, LINKER64, file_actions, attrp, new_argv, envp);
    if (ret != 0) {
        __android_log_print(ANDROID_LOG_WARN, LOG_TAG,
                            "linker spawn failed path=%s ret=%d", path, ret);
    }
    free(new_argv);
    return ret;
}
