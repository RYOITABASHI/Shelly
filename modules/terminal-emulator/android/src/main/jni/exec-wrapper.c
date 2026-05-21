/*
 * exec-wrapper.c -- LD_PRELOAD library for Android app-data binary execution.
 *
 * Keep this shim independent of libdl/liblog/libc I/O. It can run very early
 * during startup, before other DSOs' PLT state is worth depending on.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <spawn.h>
#include <stddef.h>
#include <unistd.h>

#define LINKER64 "/system/bin/linker64"
#define MAX_ARGC 4096
#define MAX_ENVP 4096
#define PATH_BUF_SIZE 4096

/* used+retain keeps this CI freshness marker past compiler dead-strip and
 * linker --gc-sections; `used` alone does not bind the linker. */
__attribute__((used, retain))
static const char shelly_exec_wrapper_build_marker[] =
    "shelly-exec-wrapper:v182:raw-syscall";

#ifndef AT_FDCWD
#define AT_FDCWD (-100)
#endif
#ifndef O_RDONLY
#define O_RDONLY 0
#endif
#ifndef O_WRONLY
#define O_WRONLY 1
#endif
#ifndef O_CREAT
#define O_CREAT 0100
#endif
#ifndef O_APPEND
#define O_APPEND 02000
#endif

#ifndef __NR_openat
#define __NR_openat 56
#endif
#ifndef __NR_close
#define __NR_close 57
#endif
#ifndef __NR_write
#define __NR_write 64
#endif
#ifndef __NR_read
#define __NR_read 63
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

static int raw_open_append(const char *path) {
    return finish_syscall(raw_syscall4(__NR_openat, AT_FDCWD, (long)path, O_WRONLY | O_CREAT | O_APPEND, 0600));
}

static long raw_read_call(int fd, void *buf, size_t count) {
    return raw_syscall3(__NR_read, fd, (long)buf, (long)count);
}

static long raw_write_call(int fd, const void *buf, size_t count) {
    return raw_syscall3(__NR_write, fd, (long)buf, (long)count);
}

static void raw_close_call(int fd) {
    raw_syscall1(__NR_close, fd);
}

static size_t str_len(const char *s) {
    size_t n = 0;
    if (!s) return 0;
    while (s[n]) n++;
    return n;
}

static int append_char(char *out, size_t out_size, size_t *n, char c) {
    if (*n + 1 >= out_size) return -1;
    out[(*n)++] = c;
    out[*n] = '\0';
    return 0;
}

static int append_str(char *out, size_t out_size, size_t *n, const char *s) {
    if (!s) s = "(null)";
    while (*s) {
        if (append_char(out, out_size, n, *s++) != 0) return -1;
    }
    return 0;
}

static int append_uint(char *out, size_t out_size, size_t *n, unsigned int value) {
    char tmp[16];
    size_t len = 0;
    do {
        tmp[len++] = (char)('0' + (value % 10));
        value /= 10;
    } while (value && len < sizeof(tmp));
    while (len > 0) {
        if (append_char(out, out_size, n, tmp[--len]) != 0) return -1;
    }
    return 0;
}

static int append_trunc_escaped(char *out, size_t out_size, size_t *n, const char *s, size_t limit) {
    size_t i = 0;
    if (!s) return append_str(out, out_size, n, "(null)");
    if (append_char(out, out_size, n, '"') != 0) return -1;
    while (s[i] && i < limit) {
        unsigned char c = (unsigned char)s[i++];
        if (c == '"' || c == '\\') {
            if (append_char(out, out_size, n, '\\') != 0) return -1;
            if (append_char(out, out_size, n, (char)c) != 0) return -1;
        } else if (c == '\n') {
            if (append_str(out, out_size, n, "\\n") != 0) return -1;
        } else if (c == '\r') {
            if (append_str(out, out_size, n, "\\r") != 0) return -1;
        } else if (c == '\t') {
            if (append_str(out, out_size, n, "\\t") != 0) return -1;
        } else if (c < 32 || c >= 127) {
            if (append_char(out, out_size, n, '?') != 0) return -1;
        } else {
            if (append_char(out, out_size, n, (char)c) != 0) return -1;
        }
    }
    if (s[i]) {
        if (append_str(out, out_size, n, "...") != 0) return -1;
    }
    return append_char(out, out_size, n, '"');
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

static const char *env_value_direct(char *const env[], const char *name_eq) {
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

static const char *env_value(char *const envp[], const char *name_eq) {
    const char *v = env_value_direct(envp, name_eq);
    if (v) return v;
    return envp ? NULL : env_value_direct(environ, name_eq);
}

static const char *trace_env_value(char *const envp[], const char *name_eq) {
    const char *v = env_value_direct(environ, name_eq);
    if (v) return v;
    return env_value_direct(envp, name_eq);
}

static int trace_flag_enabled(char *const envp[], const char *name_eq) {
    const char *v = trace_env_value(envp, name_eq);
    return v && v[0] == '1' && v[1] == '\0';
}

static int native_trace_enabled(char *const envp[]) {
    /*
     * Keep native exec tracing off the normal hot path. It is enabled only by
     * Shelly's explicit Claude Bash canary so regular terminals, Codex, Gemini,
     * and Claude TUI sessions never inherit diagnostic I/O.
     *
     * Require three gates so stale user env such as SHELLY_CLAUDE_NATIVE_TRACE=1
     * cannot accidentally turn this back on.
     */
    return trace_flag_enabled(envp, "SHELLY_CLAUDE_PATCH_TRACE=") &&
           trace_flag_enabled(envp, "SHELLY_CLAUDE_NATIVE_TRACE=") &&
           trace_flag_enabled(envp, "SHELLY_CLAUDE_CANARY_TRACE=");
}

static const char *base_name(const char *path) {
    const char *base = path;
    if (!path) return NULL;
    for (const char *p = path; *p; p++) {
        if (*p == '/') base = p + 1;
    }
    return base;
}

static const char *path_kind(const char *path) {
    const char *base = base_name(path);
    if (!base) return "null";
    if (streq(base, "bash") || streq(base, "libbash.so")) return "bash";
    if (streq(base, "sh")) return "sh";
    if (streq(base, "env")) return "env";
    if (streq(base, "node")) return "node";
    if (streq(base, "claude")) return "claude";
    if (streq(base, "npm")) return "npm";
    if (streq(base, "timeout")) return "timeout";
    if (streq(base, "linker64")) return "linker64";
    return "other";
}

static int append_log_path(char *out, size_t out_size, const char *home) {
    size_t n = 0;
    if (!home || !home[0]) return -1;
    if (append_str(out, out_size, &n, home) != 0) return -1;
    if (append_str(out, out_size, &n, "/.shelly-claude-patch.log") != 0) return -1;
    return 0;
}

static void trace_write_line(char *const envp[], const char *line, size_t len) {
    char path[PATH_BUF_SIZE];
    const char *home;
    int fd;
    if (!native_trace_enabled(envp)) return;
    home = trace_env_value(envp, "HOME=");
    if (append_log_path(path, sizeof(path), home) != 0) return;
    fd = raw_open_append(path);
    if (fd < 0) return;
    raw_write_call(fd, line, len);
    raw_close_call(fd);
}

static void trace_exec_event(const char *stage, const char *pathname, const char *rewritten,
                             char *const argv[], char *const envp[], int linker_exec) {
    char line[4096];
    size_t n = 0;
    int raw = trace_flag_enabled(envp, "SHELLY_CLAUDE_PATCH_RAW=");
    unsigned int argc = 0;
    if (!native_trace_enabled(envp)) return;
    if (argv) {
        while (argv[argc] && argc < MAX_ARGC) argc++;
    }

    append_str(line, sizeof(line), &n, "native exec stage=");
    append_str(line, sizeof(line), &n, stage);
    append_str(line, sizeof(line), &n, " kind=");
    append_str(line, sizeof(line), &n, path_kind(pathname));
    append_str(line, sizeof(line), &n, " rewrittenKind=");
    append_str(line, sizeof(line), &n, path_kind(rewritten));
    append_str(line, sizeof(line), &n, " argc=");
    append_uint(line, sizeof(line), &n, argc);
    append_str(line, sizeof(line), &n, " linker=");
    append_uint(line, sizeof(line), &n, linker_exec ? 1U : 0U);
    if (argv && argv[0]) {
        append_str(line, sizeof(line), &n, " arg0Kind=");
        append_str(line, sizeof(line), &n, path_kind(argv[0]));
    }
    if (raw) {
        append_str(line, sizeof(line), &n, " path=");
        append_trunc_escaped(line, sizeof(line), &n, pathname, 240);
        append_str(line, sizeof(line), &n, " rewritten=");
        append_trunc_escaped(line, sizeof(line), &n, rewritten, 240);
    }
    append_char(line, sizeof(line), &n, '\n');
    trace_write_line(envp, line, n);

    if (!raw) return;
    for (unsigned int i = 0; argv && argv[i] && i < 8; i++) {
        n = 0;
        append_str(line, sizeof(line), &n, "native exec argv[");
        append_uint(line, sizeof(line), &n, i);
        append_str(line, sizeof(line), &n, "] len=");
        append_uint(line, sizeof(line), &n, (unsigned int)str_len(argv[i]));
        append_str(line, sizeof(line), &n, " value=");
        append_trunc_escaped(line, sizeof(line), &n, argv[i], 300);
        append_char(line, sizeof(line), &n, '\n');
        trace_write_line(envp, line, n);
    }

    const char *keys[] = {
        "PATH=", "SHELL=", "BASH=", "HOME=", "TMPDIR=", "CLAUDE_CODE_TMPDIR=",
        "SHELLY_LIB_DIR=", "LD_LIBRARY_PATH=", "LD_PRELOAD=", NULL
    };
    for (int i = 0; keys[i]; i++) {
        const char *value = env_value_direct(envp, keys[i]);
        n = 0;
        append_str(line, sizeof(line), &n, envp ? "native exec targetEnv." : "native exec targetEnvNull.");
        append_str(line, sizeof(line), &n, keys[i]);
        if (n > 0 && line[n - 1] == '=') {
            n--;
            line[n] = '\0';
        }
        append_char(line, sizeof(line), &n, '=');
        append_trunc_escaped(line, sizeof(line), &n, value, 300);
        append_char(line, sizeof(line), &n, '\n');
        trace_write_line(envp, line, n);
    }
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
    if (streq(pathname, "/bin/bash") || streq(pathname, "/usr/bin/bash") ||
        streq(pathname, "/usr/bin/sh") || streq(pathname, "bash")) {
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

static int should_scrub_system_env(const char *pathname) {
    return pathname &&
           !streq(pathname, LINKER64) &&
           (starts_with(pathname, "/system/") ||
            starts_with(pathname, "/vendor/") ||
            starts_with(pathname, "/apex/"));
}

static int scrub_system_envp(char *const envp[], char **out) {
    int n = 0;
    if (!envp) {
        out[0] = NULL;
        return 0;
    }
    for (int i = 0; envp[i]; i++) {
        if (starts_with(envp[i], "LD_LIBRARY_PATH=") ||
            starts_with(envp[i], "LD_PRELOAD=")) {
            continue;
        }
        if (n >= MAX_ENVP - 1) {
            return -1;
        }
        out[n++] = envp[i];
    }
    out[n] = NULL;
    return 0;
}

static int add_app_loader_envp(char *const envp[], char **out, char *ld_buf, size_t ld_buf_size) {
    char *const *source = envp ? envp : environ;
    const char *lib_dir = env_value(envp, "SHELLY_LIB_DIR=");
    size_t nbuf = 0;
    int n = 0;

    if (!lib_dir || !lib_dir[0]) return -1;
    if (append_str(ld_buf, ld_buf_size, &nbuf, "LD_LIBRARY_PATH=") != 0) return -1;
    if (append_str(ld_buf, ld_buf_size, &nbuf, lib_dir) != 0) return -1;

    if (source) {
        for (int i = 0; source[i]; i++) {
            if (n >= MAX_ENVP - 2) return -1;
            out[n++] = source[i];
        }
    }
    out[n++] = ld_buf;
    out[n] = NULL;
    return 0;
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
    char rewrite_buf[PATH_BUF_SIZE];
    const char *rewritten = rewrite_path(pathname, envp, rewrite_buf, sizeof(rewrite_buf));
    int linker_exec;
    if (!rewritten) {
        trace_exec_event("rewrite-null", pathname, NULL, argv, envp, 0);
        return -1;
    }
    linker_exec = should_linker_exec(rewritten);
    trace_exec_event("execve", pathname, rewritten, argv, envp, linker_exec);
    if (!linker_exec) {
        char *scrubbed_env[MAX_ENVP];
        if (should_scrub_system_env(rewritten) &&
            scrub_system_envp(envp, scrubbed_env) == 0) {
            return raw_execve_call(rewritten, argv, scrubbed_env);
        }
        return raw_execve_call(rewritten, argv, envp);
    }

    char *new_argv[MAX_ARGC + 2];
    if (build_linker_argv(rewritten, argv, new_argv) != 0) {
        trace_exec_event("linker-argv-failed", pathname, rewritten, argv, envp, 0);
        return raw_execve_call(rewritten, argv, envp);
    }
    if (!env_value(envp, "LD_LIBRARY_PATH=")) {
        char *app_env[MAX_ENVP];
        char ld_buf[PATH_BUF_SIZE + 32];
        if (add_app_loader_envp(envp, app_env, ld_buf, sizeof(ld_buf)) == 0) {
            return raw_execve_call(LINKER64, new_argv, app_env);
        }
    }
    return raw_execve_call(LINKER64, new_argv, envp);
}

int posix_spawn(pid_t *pid, const char *path,
                const posix_spawn_file_actions_t *file_actions,
                const posix_spawnattr_t *attrp,
                char *const argv[], char *const envp[]) {
    (void)pid;
    (void)file_actions;
    (void)attrp;
    trace_exec_event("posix_spawn-enosys", path, NULL, argv, envp, 0);
    /*
     * Do not emulate posix_spawn here. The previous fast path used
     * clone(SIGCHLD, NULL stack, ...), which is not a valid fork substitute on
     * Android/aarch64 and can crash callers that pass NULL actions/attrs.
     * Returning ENOSYS lets bionic/libuv use its normal fork+exec fallback,
     * where the execve hook above still performs the linker64 redirection.
     */
    return ENOSYS;
}

int posix_spawnp(pid_t *pid, const char *file,
                 const posix_spawn_file_actions_t *file_actions,
                 const posix_spawnattr_t *attrp,
                 char *const argv[], char *const envp[]) {
    (void)pid;
    (void)file_actions;
    (void)attrp;
    trace_exec_event("posix_spawnp-enosys", file, NULL, argv, envp, 0);
    return ENOSYS;
}

int execvp(const char *file, char *const argv[]) {
    return execve(file, argv, environ);
}

int execvpe(const char *file, char *const argv[], char *const envp[]) {
    return execve(file, argv, envp);
}
