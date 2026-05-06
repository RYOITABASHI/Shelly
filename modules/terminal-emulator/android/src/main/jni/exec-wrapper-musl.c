/*
 * exec-wrapper-musl.c -- musl LD_PRELOAD shim for Claude Code's Bun SEA.
 *
 * The normal Shelly PTY preloads libexec_wrapper.so, which is built for
 * Android/bionic. The musl loader cannot relocate that library. This shim is
 * built against musl and injected by shelly_musl_exec after it strips the
 * PTY-wide bionic LD_PRELOAD.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stddef.h>
#include <unistd.h>

#define LINKER64 "/system/bin/linker64"
#define MAX_ARGC 4096
#define MAX_ENVP 8192
#define PATH_BUF_SIZE 4096

#ifndef AT_FDCWD
#define AT_FDCWD (-100)
#endif
#ifndef O_RDONLY
#define O_RDONLY 0
#endif

#ifndef __NR_openat
#define __NR_openat 56
#endif
#ifndef __NR_close
#define __NR_close 57
#endif
#ifndef __NR_read
#define __NR_read 63
#endif
#ifndef __NR_exit_group
#define __NR_exit_group 94
#endif
#ifndef __NR_clone
#define __NR_clone 220
#endif
#ifndef __NR_execve
#define __NR_execve 221
#endif

extern char **environ;

static long raw_syscall1(long nr, long a0) {
    register long x8 asm("x8") = nr;
    register long x0 asm("x0") = a0;
    asm volatile("svc #0" : "+r"(x0) : "r"(x8) : "memory");
    return x0;
}

static long raw_syscall3(long nr, long a0, long a1, long a2) {
    register long x8 asm("x8") = nr;
    register long x0 asm("x0") = a0;
    register long x1 asm("x1") = a1;
    register long x2 asm("x2") = a2;
    asm volatile("svc #0" : "+r"(x0) : "r"(x1), "r"(x2), "r"(x8) : "memory");
    return x0;
}

static long raw_syscall4(long nr, long a0, long a1, long a2, long a3) {
    register long x8 asm("x8") = nr;
    register long x0 asm("x0") = a0;
    register long x1 asm("x1") = a1;
    register long x2 asm("x2") = a2;
    register long x3 asm("x3") = a3;
    asm volatile("svc #0" : "+r"(x0) : "r"(x1), "r"(x2), "r"(x3), "r"(x8) : "memory");
    return x0;
}

static long raw_syscall5(long nr, long a0, long a1, long a2, long a3, long a4) {
    register long x8 asm("x8") = nr;
    register long x0 asm("x0") = a0;
    register long x1 asm("x1") = a1;
    register long x2 asm("x2") = a2;
    register long x3 asm("x3") = a3;
    register long x4 asm("x4") = a4;
    asm volatile("svc #0" : "+r"(x0) : "r"(x1), "r"(x2), "r"(x3), "r"(x4), "r"(x8) : "memory");
    return x0;
}

static int finish_syscall(long ret) {
    if (ret < 0) return -1;
    return (int)ret;
}

static int raw_execve_call(const char *path, char *const argv[], char *const envp[]) {
    return finish_syscall(raw_syscall3(__NR_execve, (long)path, (long)argv, (long)envp));
}

static int raw_open_readonly(const char *path) {
    return finish_syscall(raw_syscall4(__NR_openat, AT_FDCWD, (long)path, O_RDONLY, 0));
}

static long raw_read_call(int fd, void *buf, size_t count) {
    return raw_syscall3(__NR_read, fd, (long)buf, (long)count);
}

static void raw_close_call(int fd) {
    raw_syscall1(__NR_close, fd);
}

static void raw_exit_group(int status) {
    raw_syscall1(__NR_exit_group, status);
    for (;;) {}
}

static int streq(const char *a, const char *b) {
    if (!a || !b) return 0;
    while (*a && *a == *b) {
        a++;
        b++;
    }
    return *a == *b;
}

static int starts_with(const char *s, const char *prefix) {
    if (!s || !prefix) return 0;
    while (*prefix) {
        if (*s++ != *prefix++) return 0;
    }
    return 1;
}

static const char *env_value(char *const envp[], const char *name_eq) {
    char *const *env = envp ? envp : environ;
    if (!env) return NULL;
    for (int i = 0; env[i]; i++) {
        const char *s = env[i];
        const char *p = name_eq;
        while (*p && *s == *p) {
            s++;
            p++;
        }
        if (!*p) return s;
    }
    return NULL;
}

static int is_ld_preload(const char *s) {
    return starts_with(s, "LD_PRELOAD=");
}

static char *const *strip_ld_preload(char *const envp[], char **out) {
    char *const *src = envp ? envp : environ;
    int j = 0;
    if (!src) {
        out[0] = NULL;
        return out;
    }

    for (int i = 0; src[i]; i++) {
        if (is_ld_preload(src[i])) continue;
        if (j >= MAX_ENVP) {
            return NULL;
        }
        out[j++] = src[i];
    }
    out[j] = NULL;
    return out;
}

static int copy_rewrite(char *out, size_t out_size, const char *prefix, const char *suffix) {
    size_t n = 0;
    while (*prefix) {
        if (n + 1 >= out_size) {
            return -1;
        }
        out[n++] = *prefix++;
    }
    while (*suffix) {
        if (n + 1 >= out_size) {
            return -1;
        }
        out[n++] = *suffix++;
    }
    out[n] = '\0';
    return 0;
}

static int trusted_shell_path(const char *path) {
    return path && path[0] == '/' &&
           (starts_with(path, "/data/user/0/dev.shelly.terminal/") ||
            starts_with(path, "/data/data/dev.shelly.terminal/") ||
            starts_with(path, "/system/bin/"));
}

static int is_elf(const char *path) {
    unsigned char magic[4];
    int fd = raw_open_readonly(path);
    if (fd < 0) return 0;
    long n = raw_read_call(fd, magic, sizeof(magic));
    raw_close_call(fd);
    return n == 4 && magic[0] == 0x7f && magic[1] == 'E' &&
           magic[2] == 'L' && magic[3] == 'F';
}

static const char *rewrite_path(const char *pathname, char *const envp[], char *rewrite_buf, size_t rewrite_buf_size) {
    if (!pathname) return NULL;
    if (streq(pathname, "/bin/sh") || streq(pathname, "sh")) return "/system/bin/sh";
    if (streq(pathname, "/usr/bin/env") || streq(pathname, "env")) return "/system/bin/env";
    if (streq(pathname, "/bin/bash") || streq(pathname, "bash")) {
        const char *shell = env_value(envp, "SHELL=");
        if (trusted_shell_path(shell)) return shell;
    }
    if (starts_with(pathname, "/bin/")) {
        return copy_rewrite(rewrite_buf, rewrite_buf_size, "/system/bin/", pathname + 5) == 0
            ? rewrite_buf
            : NULL;
    }
    if (starts_with(pathname, "/usr/bin/")) {
        return copy_rewrite(rewrite_buf, rewrite_buf_size, "/system/bin/", pathname + 9) == 0
            ? rewrite_buf
            : NULL;
    }
    return pathname;
}

static int should_linker_exec(const char *pathname) {
    return pathname &&
           !streq(pathname, LINKER64) &&
           !starts_with(pathname, "/system/") &&
           !starts_with(pathname, "/vendor/") &&
           !starts_with(pathname, "/apex/") &&
           is_elf(pathname);
}

static int build_linker_argv(const char *pathname, char *const argv[], char **out) {
    int argc = 0;
    if (argv) {
        while (argv[argc]) {
            if (argc >= MAX_ARGC) {
                return -1;
            }
            argc++;
        }
    }

    out[0] = (char *)LINKER64;
    out[1] = (char *)pathname;
    for (int i = 1; i <= argc; i++) {
        out[i + 1] = argv[i];
    }
    return 0;
}

int execve(const char *pathname, char *const argv[], char *const envp[]) {
    char *clean_env[MAX_ENVP + 1];
    char *const *child_env = strip_ld_preload(envp, clean_env);
    if (!child_env) return -1;

    char rewrite_buf[PATH_BUF_SIZE];
    const char *rewritten = rewrite_path(pathname, (char *const *)child_env, rewrite_buf, sizeof(rewrite_buf));
    if (!rewritten) return -1;
    if (rewritten != pathname) {
        return raw_execve_call(rewritten, argv, (char *const *)child_env);
    }
    if (!should_linker_exec(pathname)) {
        return raw_execve_call(pathname, argv, (char *const *)child_env);
    }

    char *new_argv[MAX_ARGC + 2];
    if (build_linker_argv(pathname, argv, new_argv) != 0) {
        return raw_execve_call(pathname, argv, (char *const *)child_env);
    }
    return raw_execve_call(LINKER64, new_argv, (char *const *)child_env);
}

int posix_spawn(pid_t *pid, const char *path,
                const posix_spawn_file_actions_t *file_actions,
                const posix_spawnattr_t *attrp,
                char *const argv[], char *const envp[]) {
    if (file_actions || attrp) return ENOSYS;

    long child = raw_syscall5(__NR_clone, SIGCHLD, 0, 0, 0, 0);
    if (child < 0) return (int)-child;
    if (child == 0) {
        execve(path, argv, envp);
        raw_exit_group(127);
    }

    if (pid) *pid = (pid_t)child;
    return 0;
}

int posix_spawnp(pid_t *pid, const char *file,
                 const posix_spawn_file_actions_t *file_actions,
                 const posix_spawnattr_t *attrp,
                 char *const argv[], char *const envp[]) {
    return posix_spawn(pid, file, file_actions, attrp, argv, envp);
}

int execvp(const char *file, char *const argv[]) {
    return execve(file, argv, environ);
}

int execvpe(const char *file, char *const argv[], char *const envp[]) {
    return execve(file, argv, envp);
}
