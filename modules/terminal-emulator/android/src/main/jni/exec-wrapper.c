/*
 * exec-wrapper.c -- LD_PRELOAD library for Android app-data binary execution.
 *
 * Keep the execve path independent of liblog/libc I/O. The posix_spawn path
 * resolves libc's real symbols at load time because Rust CLIs may surface
 * ENOSYS directly instead of falling back through execve, and worker threads
 * can race lazy symbol caches.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <spawn.h>
#include <stddef.h>
#include <stdarg.h>
#include <sys/types.h>
#include <unistd.h>

#define LINKER64 "/system/bin/linker64"
#define CODEX_FS_HELPER_ARG1 "--codex-run-as-fs-helper"
#define MAX_ARGC 4096
#define MAX_ENVP 4096
#define PATH_BUF_SIZE 4096
#define SHELLY_ENOENT 2
#define SHELLY_ENOSYS 38
#define DEFAULT_HOME "/data/user/0/dev.shelly.terminal/files/home"
#define DEFAULT_LIB_DIR "/data/user/0/dev.shelly.terminal/files/termux-libs"
#define DEFAULT_PATH DEFAULT_HOME "/bin:" DEFAULT_LIB_DIR ":/system/bin:/vendor/bin:/apex/com.android.runtime/bin"

/* used+retain keeps this CI freshness marker past compiler dead-strip and
 * linker --gc-sections; `used` alone does not bind the linker. */
__attribute__((used, retain))
static const char shelly_exec_wrapper_build_marker[] =
    "shelly-exec-wrapper:v207:scrub-helper-and-execvp-env";

__attribute__((used, retain))
static const char shelly_codex_proc_exe_open_gate_marker[] =
    "SHELLY_CODEX_PROC_EXE_OPEN_SHIM";

static const char *const trace_env_keys[] = {
    "PATH=", "SHELL=", "BASH=", "HOME=", "TMPDIR=", "CLAUDE_CODE_TMPDIR=",
    "SHELLY_LIB_DIR=", "LD_LIBRARY_PATH=", "LD_PRELOAD=", NULL
};

#ifndef AT_FDCWD
#define AT_FDCWD (-100)
#endif
#ifndef O_RDONLY
#define O_RDONLY 0
#endif
#ifndef O_WRONLY
#define O_WRONLY 1
#endif
#ifndef O_RDWR
#define O_RDWR 2
#endif
#ifndef O_ACCMODE
#define O_ACCMODE 3
#endif
#ifndef O_CREAT
#define O_CREAT 0100
#endif
#ifndef O_TRUNC
#define O_TRUNC 01000
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
#ifndef __NR_readlinkat
#define __NR_readlinkat 78
#endif
#ifndef __NR_execve
#define __NR_execve 221
#endif
#ifndef __NR_getpid
#define __NR_getpid 172
#endif

extern char **environ;
static char default_path_env[] = "PATH=" DEFAULT_PATH;
static char default_home_env[] = "HOME=" DEFAULT_HOME;
static char default_tmpdir_env[] = "TMPDIR=" DEFAULT_HOME "/tmp";
static char *const minimal_envp[] = {
    default_path_env,
    default_home_env,
    default_tmpdir_env,
    NULL
};

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

static ssize_t finish_syscall_ssize(long ret) {
    if (ret < 0) return -1;
    return (ssize_t)ret;
}

static int raw_getpid_call(void) {
    return finish_syscall(raw_syscall1(__NR_getpid, 0));
}

static int raw_execve_call(const char *path, char *const argv[], char *const envp[]) {
    return finish_syscall(raw_syscall3(__NR_execve, (long)path, (long)argv, (long)(envp ? envp : minimal_envp)));
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

static long raw_readlinkat_call(int dirfd, const char *path, char *buf, size_t bufsiz) {
    return raw_syscall4(__NR_readlinkat, dirfd, (long)path, (long)buf, (long)bufsiz);
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

static int contains_char(const char *s, char needle) {
    if (!s) return 0;
    while (*s) {
        if (*s++ == needle) return 1;
    }
    return 0;
}

static const char *env_value_direct(char *const env[], const char *name_eq) {
    if (!env || !name_eq) return NULL;
    for (int i = 0; i < MAX_ENVP && env[i]; i++) {
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
    return env_value_direct(envp, name_eq);
}

static const char *env_value_parent_fallback(char *const envp[], const char *name_eq) {
    const char *v = env_value_direct(envp, name_eq);
    if (v) return v;
    return env_value_direct(environ, name_eq);
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
    int raw;
    unsigned int argc = 0;
    if (!envp) return;
    raw = trace_flag_enabled(envp, "SHELLY_CLAUDE_PATCH_RAW=");
    if (!native_trace_enabled(envp)) return;
    if (argv) {
        while (argc < MAX_ARGC && argv[argc]) argc++;
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

    for (int i = 0; trace_env_keys[i]; i++) {
        const char *value = env_value_direct(envp, trace_env_keys[i]);
        n = 0;
        append_str(line, sizeof(line), &n, envp ? "native exec targetEnv." : "native exec targetEnvNull.");
        append_str(line, sizeof(line), &n, trace_env_keys[i]);
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
    if (!out || !prefix || !suffix || out_size == 0) return -1;
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

static int copy_path_join(char *out, size_t out_size, const char *dir_start, size_t dir_len, const char *file) {
    size_t n = 0;
    if (!out || !file || out_size == 0) return -1;
    if (dir_len == 0) {
        if (append_char(out, out_size, &n, '.') != 0) return -1;
    } else {
        for (size_t i = 0; i < dir_len; i++) {
            if (append_char(out, out_size, &n, dir_start[i]) != 0) return -1;
        }
    }
    if (n > 0 && out[n - 1] != '/') {
        if (append_char(out, out_size, &n, '/') != 0) return -1;
    }
    return append_str(out, out_size, &n, file);
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

static int resolve_path_search(const char *file, char *const envp[], char *out, size_t out_size,
                               int absolute_dirs_only) {
    const char *path;
    const char *start;
    if (!file || !file[0] || contains_char(file, '/')) return -1;
    path = env_value_direct(envp, "PATH=");
    if (!path || !path[0]) path = DEFAULT_PATH;
    start = path;
    for (const char *p = path;; p++) {
        if (*p == ':' || *p == '\0') {
            size_t len = (size_t)(p - start);
            if (absolute_dirs_only && (len == 0 || start[0] != '/')) {
                if (*p == '\0') break;
                start = p + 1;
                continue;
            }
            if (copy_path_join(out, out_size, start, len, file) == 0) {
                int fd = raw_open_readonly(out);
                if (fd >= 0) {
                    raw_close_call(fd);
                    return 0;
                }
            }
            if (*p == '\0') break;
            start = p + 1;
        }
    }
    return -1;
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
    char *const *source = envp;
    int n = 0;
    if (!source) {
        out[n++] = default_path_env;
        out[n++] = default_home_env;
        out[n++] = default_tmpdir_env;
        out[n] = NULL;
        return 0;
    }
    for (int i = 0; i < MAX_ENVP && source[i]; i++) {
        if (starts_with(source[i], "LD_LIBRARY_PATH=") ||
            starts_with(source[i], "LD_PRELOAD=")) {
            continue;
        }
        if (n >= MAX_ENVP - 1) {
            return -1;
        }
        out[n++] = source[i];
    }
    out[n] = NULL;
    return 0;
}

static int codex_mode_enabled(char *const envp[]) {
    if (!envp) return 0;
    return env_value_parent_fallback(envp, "SHELLY_CODEX_EXEC_PATH=") != NULL;
}

static int trusted_codex_path(const char *path) {
    return path && path[0] == '/' &&
           (starts_with(path, "/data/user/0/dev.shelly.terminal/") ||
            starts_with(path, "/data/data/dev.shelly.terminal/"));
}

static int proc_exe_path_matches_pid(const char *path) {
    unsigned int pid = 0;
    const char *p;
    if (!starts_with(path, "/proc/")) return 0;
    p = path + 6;
    if (*p < '0' || *p > '9') return 0;
    while (*p >= '0' && *p <= '9') {
        pid = pid * 10U + (unsigned int)(*p - '0');
        p++;
    }
    if (!streq(p, "/exe")) return 0;
    return pid == (unsigned int)raw_getpid_call();
}

static int proc_exe_path(const char *path) {
    return streq(path, "/proc/self/exe") ||
           streq(path, "/proc/thread-self/exe") ||
           proc_exe_path_matches_pid(path);
}

static ssize_t readlink_codex_self(const char *path, char *buf, size_t bufsiz) {
    const char *codex_self;
    size_t len;
    if (!proc_exe_path(path)) return -2;
    if (!trace_flag_enabled(NULL, "SHELLY_CODEX_PROC_EXE_SHIM=")) return -2;
    codex_self = env_value_direct(environ, "SHELLY_CODEX_EXEC_PATH=");
    if (!trusted_codex_path(codex_self)) return -2;
    if (bufsiz == 0) {
        return -2;
    }
    if (!buf && bufsiz > 0) {
        return -2;
    }
    len = str_len(codex_self);
    if (bufsiz > 0) {
        size_t copy_len = len < bufsiz ? len : bufsiz;
        for (size_t i = 0; i < copy_len; i++) {
            buf[i] = codex_self[i];
        }
    }
    return (ssize_t)(len < bufsiz ? len : bufsiz);
}

static int read_only_open_flags(int flags) {
    return (flags & O_ACCMODE) == O_RDONLY &&
           (flags & (O_CREAT | O_TRUNC | O_APPEND | O_WRONLY | O_RDWR)) == 0;
}

static const char *codex_proc_exe_open_target(const char *path, int flags) {
    const char *codex_self;
    if (!proc_exe_path(path)) return NULL;
    if (!read_only_open_flags(flags)) return NULL;
    if (!trace_flag_enabled(NULL, "SHELLY_CODEX_PROC_EXE_OPEN_SHIM=")) return NULL;
    codex_self = env_value_direct(environ, "SHELLY_CODEX_EXEC_PATH=");
    return trusted_codex_path(codex_self) ? codex_self : NULL;
}

static int scrub_codex_child_envp(char *const envp[], char **out) {
    char *const *source = envp;
    int n = 0;
    if (!source) {
        out[0] = NULL;
        return 0;
    }
    for (int i = 0; i < MAX_ENVP && source[i]; i++) {
        if (starts_with(source[i], "LD_PRELOAD=") ||
            starts_with(source[i], "SHELLY_CODEX_EXEC_PATH=") ||
            starts_with(source[i], "SHELLY_CODEX_PROC_EXE_SHIM=") ||
            starts_with(source[i], "SHELLY_CODEX_PROC_EXE_OPEN_SHIM=")) {
            continue;
        }
        if (n >= MAX_ENVP - 1) {
            return -1;
        }
        out[n++] = source[i];
    }
    out[n] = NULL;
    return 0;
}

static int is_codex_fs_helper_self_exec(const char *pathname, char *const argv[], char *const envp[]) {
    const char *codex_self;
    if (!envp) return 0;
    codex_self = env_value_parent_fallback(envp, "SHELLY_CODEX_EXEC_PATH=");
    return trusted_codex_path(codex_self) &&
           streq(pathname, codex_self) &&
           argv &&
           argv[1] &&
           streq(argv[1], CODEX_FS_HELPER_ARG1);
}

static int add_app_loader_envp(char *const envp[], char **out, char *ld_buf, size_t ld_buf_size) {
    char *const *source = envp ? envp : minimal_envp;
    const char *lib_dir = envp ? env_value(envp, "SHELLY_LIB_DIR=") : DEFAULT_LIB_DIR;
    size_t nbuf = 0;
    int n = 0;

    if (!lib_dir || !lib_dir[0]) return -1;
    if (append_str(ld_buf, ld_buf_size, &nbuf, "LD_LIBRARY_PATH=") != 0) return -1;
    if (append_str(ld_buf, ld_buf_size, &nbuf, lib_dir) != 0) return -1;

    if (source) {
        for (int i = 0; i < MAX_ENVP && source[i]; i++) {
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
    if (!pathname || !out) return -1;

    if (argv) {
        while (argc < MAX_ARGC && argv[argc]) argc++;
        if (argc >= MAX_ARGC) return -1;
    }

    out[0] = (char *)LINKER64;
    out[1] = (char *)pathname;

    /* Copy argv[1..argc-1] after LINKER64+pathname, then always NULL-terminate.
     * Relying on the source argv's terminator left out[2] unset when argc==0. */
    int j = 2;
    for (int i = 1; i < argc; i++) {
        out[j++] = argv[i];
    }
    out[j] = NULL;
    return 0;
}

static int is_codex_fs_helper_linker_exec(const char *pathname, char *const argv[], char *const envp[]) {
    const char *codex_self;
    if (!envp) return 0;
    codex_self = env_value_parent_fallback(envp, "SHELLY_CODEX_EXEC_PATH=");
    if (!streq(pathname, LINKER64) || !trusted_codex_path(codex_self) || !argv) return 0;
    if (argv[1] && streq(argv[1], CODEX_FS_HELPER_ARG1)) return 1;
    return argv[1] && streq(argv[1], codex_self) &&
           argv[2] &&
           streq(argv[2], CODEX_FS_HELPER_ARG1);
}

static int build_codex_fs_helper_argv(char *const argv[], char *const envp[], char **out) {
    const char *codex_self = env_value_parent_fallback(envp, "SHELLY_CODEX_EXEC_PATH=");
    int argc = 0;
    int first_arg = 1;
    int j = 0;

    if (!trusted_codex_path(codex_self) || !out) return -1;
    if (argv) {
        while (argc < MAX_ARGC && argv[argc]) argc++;
        if (argc >= MAX_ARGC) return -1;
        if (argc > 2 && streq(argv[1], codex_self) && streq(argv[2], CODEX_FS_HELPER_ARG1)) {
            first_arg = 2;
        }
    }

    out[j++] = (char *)LINKER64;
    out[j++] = (char *)codex_self;
    for (int i = first_arg; i < argc && j < MAX_ARGC + 1; i++) {
        out[j++] = argv[i];
    }
    out[j] = NULL;
    return 0;
}

static int add_codex_helper_envp(char *const envp[], char **out, char *ld_buf, size_t ld_buf_size) {
    char *const *source = envp;
    const char *lib_dir = env_value_parent_fallback(envp, "SHELLY_LIB_DIR=");
    size_t nbuf = 0;
    int n = 0;

    if (!lib_dir || !lib_dir[0]) return -1;
    if (append_str(ld_buf, ld_buf_size, &nbuf, "LD_LIBRARY_PATH=") != 0) return -1;
    if (append_str(ld_buf, ld_buf_size, &nbuf, lib_dir) != 0) return -1;

    if (source) {
        for (int i = 0; i < MAX_ENVP && source[i]; i++) {
            if (starts_with(source[i], "LD_LIBRARY_PATH=") ||
                starts_with(source[i], "LD_PRELOAD=") ||
                starts_with(source[i], "SHELLY_CODEX_EXEC_PATH=") ||
                starts_with(source[i], "SHELLY_CODEX_PROC_EXE_SHIM=") ||
                starts_with(source[i], "SHELLY_CODEX_PROC_EXE_OPEN_SHIM=")) {
                continue;
            }
            if (n >= MAX_ENVP - 2) return -1;
            out[n++] = source[i];
        }
    }
    out[n++] = ld_buf;
    out[n] = NULL;
    return 0;
}

__attribute__((noinline, used))
static int shelly_execve_internal(const char *pathname, char *const argv[], char *const envp[]) {
    char rewrite_buf[PATH_BUF_SIZE];
    const char *rewritten = rewrite_path(pathname, envp, rewrite_buf, sizeof(rewrite_buf));
    char *codex_child_env[MAX_ENVP];
    int linker_exec;
    if (!rewritten) {
        if (envp) trace_exec_event("rewrite-null", pathname, NULL, argv, envp, 0);
        return -1;
    }
    linker_exec = should_linker_exec(rewritten);
    if (envp) trace_exec_event("execve", pathname, rewritten, argv, envp, linker_exec);
    if (is_codex_fs_helper_linker_exec(rewritten, argv, envp)) {
        char *codex_argv[MAX_ARGC + 2];
        if (build_codex_fs_helper_argv(argv, envp, codex_argv) == 0) {
            char *codex_env[MAX_ENVP];
            char ld_buf[PATH_BUF_SIZE + 32];
            trace_exec_event("codex-fs-helper", pathname, rewritten, codex_argv, envp, 0);
            if (add_codex_helper_envp(envp, codex_env, ld_buf, sizeof(ld_buf)) == 0) {
                return raw_execve_call(LINKER64, codex_argv, codex_env);
            }
            return raw_execve_call(LINKER64, codex_argv, envp);
        }
    }
    if (is_codex_fs_helper_self_exec(rewritten, argv, envp)) {
        char *codex_argv[MAX_ARGC + 2];
        if (build_linker_argv(rewritten, argv, codex_argv) == 0) {
            char *codex_env[MAX_ENVP];
            char ld_buf[PATH_BUF_SIZE + 32];
            trace_exec_event("codex-fs-helper-self", pathname, rewritten, codex_argv, envp, 1);
            if (add_codex_helper_envp(envp, codex_env, ld_buf, sizeof(ld_buf)) == 0) {
                return raw_execve_call(LINKER64, codex_argv, codex_env);
            }
            return raw_execve_call(LINKER64, codex_argv, envp);
        }
    }
    if (codex_mode_enabled(envp) &&
        scrub_codex_child_envp(envp, codex_child_env) == 0) {
        envp = codex_child_env;
    }
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
        if (envp) trace_exec_event("linker-argv-failed", pathname, rewritten, argv, envp, 0);
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

int execve(const char *pathname, char *const argv[], char *const envp[]) {
    return shelly_execve_internal(pathname, argv, envp);
}

typedef int (*posix_spawn_impl_t)(pid_t *, const char *,
                                  const posix_spawn_file_actions_t *,
                                  const posix_spawnattr_t *,
                                  char *const[], char *const[]);

static posix_spawn_impl_t g_posix_spawn_fn;
static posix_spawn_impl_t g_posix_spawnp_fn;

__attribute__((constructor))
static void shelly_resolve_real_impls(void) {
    g_posix_spawn_fn = (posix_spawn_impl_t)dlsym(RTLD_NEXT, "posix_spawn");
    g_posix_spawnp_fn = (posix_spawn_impl_t)dlsym(RTLD_NEXT, "posix_spawnp");
}

static posix_spawn_impl_t real_posix_spawn_impl(void) {
    return g_posix_spawn_fn;
}

static posix_spawn_impl_t real_posix_spawnp_impl(void) {
    return g_posix_spawnp_fn;
}

static int call_real_posix_spawn(int search_path, pid_t *pid, const char *path,
                                 const posix_spawn_file_actions_t *file_actions,
                                 const posix_spawnattr_t *attrp,
                                 char *const argv[], char *const envp[]) {
    posix_spawn_impl_t fn = search_path ? real_posix_spawnp_impl() : real_posix_spawn_impl();
    if (!fn) return SHELLY_ENOSYS;
    return fn(pid, path, file_actions, attrp, argv, envp);
}

static int shelly_posix_spawn_common(int search_path, pid_t *pid, const char *path,
                                     const posix_spawn_file_actions_t *file_actions,
                                     const posix_spawnattr_t *attrp,
                                     char *const argv[], char *const envp[]) {
    char resolved_buf[PATH_BUF_SIZE];
    char rewrite_buf[PATH_BUF_SIZE];
    const char *spawn_path = path;
    const char *rewritten;
    int linker_exec;

    if (search_path && resolve_path_search(path, envp, resolved_buf, sizeof(resolved_buf),
                                           file_actions != NULL) == 0) {
        spawn_path = resolved_buf;
        search_path = 0;
    } else if (file_actions && path && path[0] != '/') {
        char *codex_child_env[MAX_ENVP];
        if (codex_mode_enabled(envp) &&
            scrub_codex_child_envp(envp, codex_child_env) == 0) {
            envp = codex_child_env;
        }
        return call_real_posix_spawn(search_path, pid, path, file_actions, attrp, argv, envp);
    }
    rewritten = rewrite_path(spawn_path, envp, rewrite_buf, sizeof(rewrite_buf));

    if (!rewritten) {
        trace_exec_event(search_path ? "posix_spawnp-rewrite-null" : "posix_spawn-rewrite-null",
                         spawn_path, NULL, argv, envp, 0);
        return SHELLY_ENOENT;
    }
    linker_exec = should_linker_exec(rewritten);
    trace_exec_event(search_path ? "posix_spawnp" : "posix_spawn",
                     spawn_path, rewritten, argv, envp, linker_exec);

    if (is_codex_fs_helper_linker_exec(rewritten, argv, envp)) {
        char *codex_argv[MAX_ARGC + 2];
        if (build_codex_fs_helper_argv(argv, envp, codex_argv) == 0) {
            char *codex_env[MAX_ENVP];
            char ld_buf[PATH_BUF_SIZE + 32];
            if (add_codex_helper_envp(envp, codex_env, ld_buf, sizeof(ld_buf)) == 0) {
                return call_real_posix_spawn(0, pid, LINKER64, file_actions, attrp, codex_argv, codex_env);
            }
            return call_real_posix_spawn(0, pid, LINKER64, file_actions, attrp, codex_argv, envp);
        }
    }
    if (is_codex_fs_helper_self_exec(rewritten, argv, envp)) {
        char *codex_argv[MAX_ARGC + 2];
        if (build_linker_argv(rewritten, argv, codex_argv) == 0) {
            char *codex_env[MAX_ENVP];
            char ld_buf[PATH_BUF_SIZE + 32];
            if (add_codex_helper_envp(envp, codex_env, ld_buf, sizeof(ld_buf)) == 0) {
                return call_real_posix_spawn(0, pid, LINKER64, file_actions, attrp, codex_argv, codex_env);
            }
            return call_real_posix_spawn(0, pid, LINKER64, file_actions, attrp, codex_argv, envp);
        }
    }

    if (codex_mode_enabled(envp)) {
        char *codex_child_env[MAX_ENVP];
        if (scrub_codex_child_envp(envp, codex_child_env) == 0) {
            envp = codex_child_env;
        }
    }

    if (!linker_exec) {
        char *scrubbed_env[MAX_ENVP];
        if (should_scrub_system_env(rewritten) &&
            scrub_system_envp(envp, scrubbed_env) == 0) {
            return call_real_posix_spawn(search_path, pid, rewritten, file_actions, attrp, argv, scrubbed_env);
        }
        return call_real_posix_spawn(search_path, pid, rewritten, file_actions, attrp, argv, envp);
    }

    char *new_argv[MAX_ARGC + 2];
    if (build_linker_argv(rewritten, argv, new_argv) != 0) {
        return call_real_posix_spawn(search_path, pid, rewritten, file_actions, attrp, argv, envp);
    }
    if (!env_value(envp, "LD_LIBRARY_PATH=")) {
        char *app_env[MAX_ENVP];
        char ld_buf[PATH_BUF_SIZE + 32];
        if (add_app_loader_envp(envp, app_env, ld_buf, sizeof(ld_buf)) == 0) {
            return call_real_posix_spawn(0, pid, LINKER64, file_actions, attrp, new_argv, app_env);
        }
    }
    return call_real_posix_spawn(0, pid, LINKER64, file_actions, attrp, new_argv, envp);
}

int posix_spawn(pid_t *pid, const char *path,
                const posix_spawn_file_actions_t *file_actions,
                const posix_spawnattr_t *attrp,
                char *const argv[], char *const envp[]) {
    return shelly_posix_spawn_common(0, pid, path, file_actions, attrp, argv, envp);
}

int posix_spawnp(pid_t *pid, const char *file,
                 const posix_spawn_file_actions_t *file_actions,
                 const posix_spawnattr_t *attrp,
                 char *const argv[], char *const envp[]) {
    return shelly_posix_spawn_common(1, pid, file, file_actions, attrp, argv, envp);
}

int execvp(const char *file, char *const argv[]) {
    char resolved_buf[PATH_BUF_SIZE];
    const char *path = file;
    if (resolve_path_search(file, NULL, resolved_buf, sizeof(resolved_buf), 1) == 0) {
        path = resolved_buf;
    }
    return shelly_execve_internal(path, argv, NULL);
}

int execvpe(const char *file, char *const argv[], char *const envp[]) {
    return shelly_execve_internal(file, argv, envp);
}

int open(const char *path, int flags, ...) {
    const char *target = codex_proc_exe_open_target(path, flags);
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list ap;
        va_start(ap, flags);
        mode = (mode_t)va_arg(ap, int);
        va_end(ap);
    }
    return finish_syscall(raw_syscall4(__NR_openat, AT_FDCWD, (long)(target ? target : path), flags, mode));
}

int openat(int dirfd, const char *path, int flags, ...) {
    const char *target = codex_proc_exe_open_target(path, flags);
    mode_t mode = 0;
    if (target) dirfd = AT_FDCWD;
    if (flags & O_CREAT) {
        va_list ap;
        va_start(ap, flags);
        mode = (mode_t)va_arg(ap, int);
        va_end(ap);
    }
    return finish_syscall(raw_syscall4(__NR_openat, dirfd, (long)(target ? target : path), flags, mode));
}

ssize_t readlink(const char *path, char *buf, size_t bufsiz) {
    ssize_t codex = readlink_codex_self(path, buf, bufsiz);
    if (codex != -2) return codex;
    return finish_syscall_ssize(raw_readlinkat_call(AT_FDCWD, path, buf, bufsiz));
}

ssize_t readlinkat(int dirfd, const char *path, char *buf, size_t bufsiz) {
    if (path && path[0] == '/') {
        ssize_t codex = readlink_codex_self(path, buf, bufsiz);
        if (codex != -2) return codex;
    }
    return finish_syscall_ssize(raw_readlinkat_call(dirfd, path, buf, bufsiz));
}
