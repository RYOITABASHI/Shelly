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
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define LINKER64 "/system/bin/linker64"

extern char **environ;

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
        return orig(rewritten, argv, envp);
    }

    if (!should_linker_exec(pathname)) {
        return orig(pathname, argv, envp);
    }

    char **new_argv = build_linker_argv(pathname, argv);
    if (!new_argv) return orig(pathname, argv, envp);

    int ret = orig(LINKER64, new_argv, envp);
    int saved = errno;
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
        return orig(pid, rewritten, file_actions, attrp, argv, envp);
    }

    if (!should_linker_exec(path)) {
        return orig(pid, path, file_actions, attrp, argv, envp);
    }

    char **new_argv = build_linker_argv(path, argv);
    if (!new_argv) return orig(pid, path, file_actions, attrp, argv, envp);

    int ret = orig(pid, LINKER64, file_actions, attrp, new_argv, envp);
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
    const char *rewritten = rewrite_path(file);

    if (rewritten != file) {
        return posix_spawn(pid, rewritten, file_actions, attrp, argv, envp);
    }

    return orig(pid, file, file_actions, attrp, argv, envp);
}

int execvp(const char *file, char *const argv[]) {
    typedef int (*orig_t)(const char *, char *const []);
    orig_t orig = (orig_t)dlsym(RTLD_NEXT, "execvp");
    const char *rewritten = rewrite_path(file);

    if (rewritten != file) {
        return execve(rewritten, argv, environ);
    }

    return orig(file, argv);
}

int execvpe(const char *file, char *const argv[], char *const envp[]) {
    typedef int (*orig_t)(const char *, char *const [], char *const []);
    orig_t orig = (orig_t)dlsym(RTLD_NEXT, "execvpe");
    const char *rewritten = rewrite_path(file);

    if (rewritten != file) {
        return execve(rewritten, argv, envp);
    }

    return orig(file, argv, envp);
}
