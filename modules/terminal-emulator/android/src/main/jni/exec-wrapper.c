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

static int elf_type(const char *path) {
    int fd = open(path, O_RDONLY);
    if (fd < 0) return -1;
    unsigned char header[18];
    ssize_t n = read(fd, header, sizeof(header));
    close(fd);
    if (n != (ssize_t)sizeof(header)) return -1;
    if (header[0] != 0x7f || header[1] != 'E' || header[2] != 'L' || header[3] != 'F') return -1;
    if (header[4] != 2 || header[5] != 1) return -1;
    return (int)header[16] | ((int)header[17] << 8);
}

static const char *rewrite_path(const char *pathname) {
    if (!pathname) return NULL;
    if (strcmp(pathname, "/bin/sh") == 0) return "/system/bin/sh";
    if (strcmp(pathname, "sh") == 0) return "/system/bin/sh";
    if (strcmp(pathname, "/usr/bin/env") == 0) return "/system/bin/env";
    if (strcmp(pathname, "env") == 0) return "/system/bin/env";
    if (strcmp(pathname, "/bin/bash") == 0) {
        const char *shell = getenv("SHELL");
        if (shell && shell[0]) return shell;
    }
    if (strcmp(pathname, "bash") == 0) {
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

#ifndef __ANDROID__
static char **build_musl_argv(const char *pathname, char *const argv[]) {
    const char *trampoline = getenv("SHELLY_MUSL_EXEC");
    const char *ld_musl = getenv("SHELLY_MUSL_LD");
    if (!trampoline || !trampoline[0] || !ld_musl || !ld_musl[0]) return NULL;

    int argc = 0;
    if (argv) {
        while (argv[argc]) argc++;
    }

    char **new_argv = (char **)malloc((argc + 4) * sizeof(char *));
    if (!new_argv) return NULL;

    new_argv[0] = LINKER64;
    new_argv[1] = (char *)trampoline;
    new_argv[2] = (char *)ld_musl;
    new_argv[3] = (char *)pathname;
    for (int i = 1; i <= argc; i++) {
        new_argv[i + 3] = argv[i];
    }
    return new_argv;
}

static char **build_bionic_env(char *const envp[]) {
    const char *bionic_preload = getenv("SHELLY_BIONIC_LD_PRELOAD");
    int envc = 0;
    if (envp) {
        while (envp[envc]) envc++;
    }

    char **new_env = (char **)malloc((envc + 2) * sizeof(char *));
    if (!new_env) return NULL;

    int j = 0;
    for (int i = 0; i < envc; i++) {
        if (strncmp(envp[i], "LD_PRELOAD=", 11) == 0) continue;
        new_env[j++] = envp[i];
    }
    if (bionic_preload && bionic_preload[0]) {
        size_t n = strlen("LD_PRELOAD=") + strlen(bionic_preload) + 1;
        char *preload = (char *)malloc(n);
        if (!preload) {
            free(new_env);
            return NULL;
        }
        snprintf(preload, n, "LD_PRELOAD=%s", bionic_preload);
        new_env[j++] = preload;
    }
    new_env[j] = NULL;
    return new_env;
}

static void free_bionic_env(char **envp) {
    if (!envp) return;
    const char *bionic_preload = getenv("SHELLY_BIONIC_LD_PRELOAD");
    if (bionic_preload && bionic_preload[0]) {
        int i = 0;
        while (envp[i]) i++;
        if (i > 0 && strncmp(envp[i - 1], "LD_PRELOAD=", 11) == 0) {
            free(envp[i - 1]);
        }
    }
    free(envp);
}
#endif

/*
 * Intercept execve(). If the target is an ELF binary outside system paths,
 * redirect through linker64 so SELinux doesn't block it.
 */
int execve(const char *pathname, char *const argv[], char *const envp[]) {
    typedef int (*orig_t)(const char *, char *const [], char *const []);
    orig_t orig = (orig_t)dlsym(RTLD_NEXT, "execve");
    if (!orig) { errno = ENOSYS; return -1; }
    const char *rewritten = rewrite_path(pathname);
    if (!rewritten) return -1;

    if (rewritten != pathname) {
        LOGI("rewrite exec path=%s -> %s", pathname, rewritten);
#ifndef __ANDROID__
        char **bionic_env = build_bionic_env(envp);
        if (bionic_env) {
            int ret = orig(rewritten, argv, bionic_env);
            int saved = errno;
            free_bionic_env(bionic_env);
            errno = saved;
            LOGW("exec rewritten path=%s failed errno=%d", rewritten, errno);
            return ret;
        }
#endif
        int ret = orig(rewritten, argv, envp);
        LOGW("exec rewritten path=%s failed errno=%d", rewritten, errno);
        return ret;
    }

    /* Pass through for: null path, linker64 itself, system/vendor/apex binaries,
     * and non-ELF files (scripts, etc. -- those use shebang which the
     * interpreter handles) */
    if (!should_linker_exec(pathname)) {
        int ret = orig(pathname, argv, envp);
        if (ret == -1) {
            LOGW("exec pass-through failed path=%s errno=%d",
                 pathname ? pathname : "(null)", errno);
        }
        return ret;
    }

    /* Build new argv: ["linker64", pathname, original_argv[1], ..., NULL] */
    char **new_argv = build_linker_argv(pathname, argv);
    if (!new_argv) {
        return orig(pathname, argv, envp); /* OOM fallback */
    }

#ifndef __ANDROID__
    char **bionic_env = build_bionic_env(envp);
    char **exec_env = bionic_env ? bionic_env : (char **)envp;
    if (elf_type(pathname) == 2) {
        char **musl_argv = build_musl_argv(pathname, argv);
        if (musl_argv) {
            LOGI("musl trampoline exec path=%s", pathname);
            int ret = orig(LINKER64, musl_argv, exec_env);
            int saved = errno;
            LOGW("musl trampoline exec failed path=%s errno=%d", pathname, saved);
            free(musl_argv);
            free(new_argv);
            if (bionic_env) free_bionic_env(bionic_env);
            errno = saved;
            return ret;
        }
    }
#endif

    LOGI("linker exec path=%s", pathname);
    int ret = orig(LINKER64, new_argv,
#ifndef __ANDROID__
                   exec_env
#else
                   envp
#endif
    );
    int saved = errno;
    LOGW("linker exec failed path=%s errno=%d", pathname, saved);
    free(new_argv);
#ifndef __ANDROID__
    if (bionic_env) free_bionic_env(bionic_env);
#endif
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
#ifndef __ANDROID__
        char **bionic_env = build_bionic_env(envp);
        if (bionic_env) {
            int ret = orig(pid, rewritten, file_actions, attrp, argv, bionic_env);
            free_bionic_env(bionic_env);
            if (ret != 0) {
                LOGW("spawn rewritten path=%s failed ret=%d", rewritten, ret);
            }
            return ret;
        }
#endif
        int ret = orig(pid, rewritten, file_actions, attrp, argv, envp);
        if (ret != 0) {
            LOGW("spawn rewritten path=%s failed ret=%d", rewritten, ret);
        }
        return ret;
    }

    if (!should_linker_exec(path)) {
        int ret = orig(pid, path, file_actions, attrp, argv, envp);
        if (ret != 0) {
            LOGW("spawn pass-through failed path=%s ret=%d",
                 path ? path : "(null)", ret);
        }
        return ret;
    }

    char **new_argv = build_linker_argv(path, argv);
    if (!new_argv) return orig(pid, path, file_actions, attrp, argv, envp);

#ifndef __ANDROID__
    char **bionic_env = build_bionic_env(envp);
    char **spawn_env = bionic_env ? bionic_env : (char **)envp;
    if (elf_type(path) == 2) {
        char **musl_argv = build_musl_argv(path, argv);
        if (musl_argv) {
            LOGI("musl trampoline spawn path=%s", path);
            int ret = orig(pid, LINKER64, file_actions, attrp, musl_argv, spawn_env);
            if (ret != 0) {
                LOGW("musl trampoline spawn failed path=%s ret=%d", path, ret);
            }
            free(musl_argv);
            free(new_argv);
            if (bionic_env) free_bionic_env(bionic_env);
            return ret;
        }
    }
#endif

    LOGI("linker spawn path=%s", path);
    int ret = orig(pid, LINKER64, file_actions, attrp, new_argv,
#ifndef __ANDROID__
                   spawn_env
#else
                   envp
#endif
    );
    if (ret != 0) {
        LOGW("linker spawn failed path=%s ret=%d", path, ret);
    }
    free(new_argv);
#ifndef __ANDROID__
    if (bionic_env) free_bionic_env(bionic_env);
#endif
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
