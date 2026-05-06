/*
 * exec-wrapper-musl.c -- musl LD_PRELOAD shim for Claude Code's Bun SEA.
 *
 * The normal Shelly PTY preloads libexec_wrapper.so, which is built for
 * Android/bionic. The musl loader cannot relocate that library. This shim is
 * built against musl and is injected only by shelly_musl_exec after it strips
 * the PTY-wide bionic LD_PRELOAD.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define LINKER64 "/system/bin/linker64"

extern char **environ;

static int debug_enabled(void) {
    const char *v = getenv("SHELLY_DEBUG_MUSL");
    return v && strcmp(v, "1") == 0;
}

static const char *safe_str(const char *s) {
    return s ? s : "(null)";
}

static void debug_log_argv(const char *fn, const char *path, const char *rewritten,
                           char *const argv[]) {
    if (!debug_enabled()) return;
    dprintf(2, "ShellyMuslExec: %s(%s)", fn, safe_str(path));
    if (rewritten && path && strcmp(rewritten, path) != 0) {
        dprintf(2, " -> %s", rewritten);
    }
    if (argv) {
        int i = 0;
        for (; argv[i] && i < 8; i++) {
            dprintf(2, " argv[%d]=%s", i, safe_str(argv[i]));
        }
        if (i == 8 && argv[i]) dprintf(2, " argv[8+]=...");
    }
    dprintf(2, "\n");
}

static void debug_log_result(const char *fn, const char *path, const char *action,
                             int rc, int err) {
    if (!debug_enabled()) return;
    dprintf(2, "ShellyMuslExec: %s(%s) %s rc=%d errno=%d\n",
            fn, safe_str(path), action, rc, err);
}

static char **strip_ld_preload(char *const envp[]) {
    char *const *src = envp ? envp : environ;
    int n = 0;
    while (src && src[n]) n++;

    char **out = (char **)malloc((size_t)(n + 1) * sizeof(char *));
    if (!out) return NULL;

    int j = 0;
    for (int i = 0; i < n; i++) {
        if (strncmp(src[i], "LD_PRELOAD=", 11) == 0) continue;
        out[j++] = src[i];
    }
    out[j] = NULL;

    if (debug_enabled() && j != n) {
        dprintf(2, "ShellyMuslExec: stripped LD_PRELOAD for child env\n");
    }
    return out;
}

static char *const *child_env(char **clean_envp, char *const envp[]) {
    if (clean_envp) return clean_envp;
    return envp ? envp : environ;
}

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
    if (strcmp(pathname, "sh") == 0) return "/system/bin/sh";
    if (strcmp(pathname, "/usr/bin/env") == 0) return "/system/bin/env";
    if (strcmp(pathname, "env") == 0) return "/system/bin/env";
    if (strcmp(pathname, "/bin/bash") == 0 || strcmp(pathname, "bash") == 0) {
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

int execve(const char *pathname, char *const argv[], char *const envp[]) {
    typedef int (*orig_t)(const char *, char *const [], char *const []);
    orig_t orig = (orig_t)dlsym(RTLD_NEXT, "execve");
    const char *rewritten = rewrite_path(pathname);

    if (rewritten != pathname) {
        debug_log_argv("execve", pathname, rewritten, argv);
        char **clean_envp = strip_ld_preload(envp);
        int ret = orig(rewritten, argv, child_env(clean_envp, envp));
        int saved = errno;
        free(clean_envp);
        errno = saved;
        debug_log_result("execve", rewritten, "rewrite-failed", ret, errno);
        return ret;
    }

    debug_log_argv("execve", pathname, rewritten, argv);
    char **clean_envp = strip_ld_preload(envp);
    if (!should_linker_exec(pathname)) {
        int ret = orig(pathname, argv, child_env(clean_envp, envp));
        int saved = errno;
        free(clean_envp);
        errno = saved;
        if (ret == -1) debug_log_result("execve", pathname, "pass-through-failed", ret, saved);
        return ret;
    }

    char **new_argv = build_linker_argv(pathname, argv);
    if (!new_argv) {
        int ret = orig(pathname, argv, child_env(clean_envp, envp));
        int saved = errno;
        free(clean_envp);
        errno = saved;
        return ret;
    }

    debug_log_result("execve", pathname, "linker64", 0, 0);
    int ret = orig(LINKER64, new_argv, child_env(clean_envp, envp));
    int saved = errno;
    debug_log_result("execve", pathname, "linker64-failed", ret, saved);
    free(new_argv);
    free(clean_envp);
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
        debug_log_argv("posix_spawn", path, rewritten, argv);
        char **clean_envp = strip_ld_preload(envp);
        int ret = orig(pid, rewritten, file_actions, attrp, argv, child_env(clean_envp, envp));
        free(clean_envp);
        if (ret != 0) debug_log_result("posix_spawn", rewritten, "rewrite-failed", ret, ret);
        return ret;
    }

    debug_log_argv("posix_spawn", path, rewritten, argv);
    char **clean_envp = strip_ld_preload(envp);
    if (!should_linker_exec(path)) {
        int ret = orig(pid, path, file_actions, attrp, argv, child_env(clean_envp, envp));
        free(clean_envp);
        if (ret != 0) debug_log_result("posix_spawn", path, "pass-through-failed", ret, ret);
        return ret;
    }

    char **new_argv = build_linker_argv(path, argv);
    if (!new_argv) {
        int ret = orig(pid, path, file_actions, attrp, argv, child_env(clean_envp, envp));
        free(clean_envp);
        return ret;
    }

    debug_log_result("posix_spawn", path, "linker64", 0, 0);
    int ret = orig(pid, LINKER64, file_actions, attrp, new_argv, child_env(clean_envp, envp));
    if (ret != 0) debug_log_result("posix_spawn", path, "linker64-failed", ret, ret);
    free(new_argv);
    free(clean_envp);
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
    const char *rewritten = rewrite_path(file);

    if (rewritten != file) {
        debug_log_argv("posix_spawnp", file, rewritten, argv);
        return posix_spawn(pid, rewritten, file_actions, attrp, argv, envp);
    }

    debug_log_argv("posix_spawnp", file, rewritten, argv);
    char **clean_envp = strip_ld_preload(envp);
    int ret = orig(pid, file, file_actions, attrp, argv, child_env(clean_envp, envp));
    free(clean_envp);
    if (ret != 0) debug_log_result("posix_spawnp", file, "pass-through-failed", ret, ret);
    return ret;
}

int execvp(const char *file, char *const argv[]) {
    const char *rewritten = rewrite_path(file);

    if (rewritten != file) {
        debug_log_argv("execvp", file, rewritten, argv);
        return execve(rewritten, argv, environ);
    }

    debug_log_argv("execvp", file, rewritten, argv);
    return execvpe(file, argv, environ);
}

int execvpe(const char *file, char *const argv[], char *const envp[]) {
    typedef int (*orig_t)(const char *, char *const [], char *const []);
    orig_t orig = (orig_t)dlsym(RTLD_NEXT, "execvpe");
    const char *rewritten = rewrite_path(file);

    if (rewritten != file) {
        debug_log_argv("execvpe", file, rewritten, argv);
        return execve(rewritten, argv, envp);
    }

    debug_log_argv("execvpe", file, rewritten, argv);
    char **clean_envp = strip_ld_preload(envp);
    int ret = orig(file, argv, child_env(clean_envp, envp));
    int saved = errno;
    free(clean_envp);
    errno = saved;
    if (ret == -1) debug_log_result("execvpe", file, "pass-through-failed", ret, saved);
    return ret;
}
