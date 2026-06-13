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
#define SHELLY_EINTR 4
#define SHELLY_ENOSYS 38
#define DEFAULT_HOME "/data/user/0/dev.shelly.terminal/files/home"
#define DEFAULT_LIB_DIR "/data/user/0/dev.shelly.terminal/files/termux-libs"
#define DEFAULT_BASH DEFAULT_HOME "/bin/bash"
#define DEFAULT_EXEC_WRAPPER DEFAULT_LIB_DIR "/libexec_wrapper.so"
#define DEFAULT_PATH DEFAULT_HOME "/bin:" DEFAULT_LIB_DIR ":/system/bin:/vendor/bin:/apex/com.android.runtime/bin"

/* used+retain keeps this CI freshness marker past compiler dead-strip and
 * linker --gc-sections; `used` alone does not bind the linker. */
__attribute__((used, retain))
static const char shelly_exec_wrapper_build_marker[] =
    "shelly-exec-wrapper:v218:open-fallthrough-libc";

__attribute__((used, retain))
static const char shelly_codex_proc_exe_open_gate_marker[] =
    "SHELLY_CODEX_PROC_EXE_OPEN_SHIM";

static const char *const trace_env_keys[] = {
    "PATH=", "SHELL=", "BASH=", "HOME=", "TMPDIR=",
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

static char default_path_env[] = "PATH=" DEFAULT_PATH;
static char default_home_env[] = "HOME=" DEFAULT_HOME;
static char default_tmpdir_env[] = "TMPDIR=" DEFAULT_HOME "/tmp";
static char default_shell_env[] = "SHELL=" DEFAULT_BASH;
static char default_bash_env[] = "BASH=" DEFAULT_BASH;
static char default_shelly_lib_dir_env[] = "SHELLY_LIB_DIR=" DEFAULT_LIB_DIR;
static char default_ld_library_path_env[] = "LD_LIBRARY_PATH=" DEFAULT_LIB_DIR;
static char default_ld_preload_env[] = "LD_PRELOAD=" DEFAULT_EXEC_WRAPPER;
static char *const minimal_envp[] = {
    default_path_env,
    default_home_env,
    default_tmpdir_env,
    default_shell_env,
    default_bash_env,
    default_shelly_lib_dir_env,
    NULL
};
static char *const minimal_wrapper_envp[] = {
    default_path_env,
    default_home_env,
    default_tmpdir_env,
    default_shell_env,
    default_bash_env,
    default_shelly_lib_dir_env,
    default_ld_library_path_env,
    default_ld_preload_env,
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

static int proc_environ_value_copy(const char *name_eq, char *out, size_t out_size) {
    char buf[1024];
    size_t prefix_len = str_len(name_eq);
    size_t pos_in_entry = 0;
    size_t value_len = 0;
    int matching = 1;
    int in_value = 0;
    int found = 0;
    long nread;
    int fd;
    if (!name_eq || !out || out_size == 0 || prefix_len == 0) return -1;
    out[0] = '\0';
    fd = raw_open_readonly("/proc/self/environ");
    if (fd < 0) return -1;
    for (;;) {
        nread = raw_read_call(fd, buf, sizeof(buf));
        if (nread == -SHELLY_EINTR) continue;
        if (nread <= 0) break;
        for (long i = 0; i < nread; i++) {
            char c = buf[i];
            if (c == '\0') {
                if (found) {
                    raw_close_call(fd);
                    return 0;
                }
                pos_in_entry = 0;
                value_len = 0;
                matching = 1;
                in_value = 0;
                continue;
            }
            if (in_value) {
                if (value_len + 1 < out_size) {
                    out[value_len] = c;
                    out[value_len + 1] = '\0';
                }
                value_len++;
                pos_in_entry++;
                continue;
            }
            if (matching && pos_in_entry < prefix_len && c == name_eq[pos_in_entry]) {
                pos_in_entry++;
                if (pos_in_entry == prefix_len) {
                    found = 1;
                    in_value = 1;
                    value_len = 0;
                    out[0] = '\0';
                }
            } else {
                matching = 0;
                pos_in_entry++;
            }
        }
    }
    raw_close_call(fd);
    if (found) return 0;
    return -1;
}

static int trace_flag_enabled(char *const envp[], const char *name_eq) {
    char proc_value[8];
    const char *v = env_value_direct(envp, name_eq);
    if (!v && proc_environ_value_copy(name_eq, proc_value, sizeof(proc_value)) == 0) {
        v = proc_value;
    }
    return v && v[0] == '1' && v[1] == '\0';
}

static const char *trace_home_value(char *const envp[]) {
    const char *home = env_value_direct(envp, "HOME=");
    return home && home[0] ? home : DEFAULT_HOME;
}

static int native_trace_enabled(char *const envp[]) {
    /*
     * Keep native exec tracing off the normal hot path. Enable it explicitly
     * only while diagnosing subprocess launch issues.
     */
    return trace_flag_enabled(envp, "SHELLY_EXEC_WRAPPER_TRACE=");
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
    if (streq(base, "npm")) return "npm";
    if (streq(base, "timeout")) return "timeout";
    if (streq(base, "linker64")) return "linker64";
    return "other";
}

static int append_log_path(char *out, size_t out_size, const char *home) {
    size_t n = 0;
    if (!home || !home[0]) return -1;
    if (append_str(out, out_size, &n, home) != 0) return -1;
    if (append_str(out, out_size, &n, "/.shelly-exec-wrapper.log") != 0) return -1;
    return 0;
}

static void trace_write_line(char *const envp[], const char *line, size_t len) {
    char path[PATH_BUF_SIZE];
    const char *home;
    int fd;
    if (!native_trace_enabled(envp)) return;
    home = trace_home_value(envp);
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
    raw = trace_flag_enabled(envp, "SHELLY_EXEC_WRAPPER_TRACE_RAW=");
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

static int codex_mode_enabled(char *const envp[]);

static int trusted_shell_path(const char *path) {
    return path && path[0] == '/' &&
           (starts_with(path, "/data/user/0/dev.shelly.terminal/") ||
            starts_with(path, "/data/data/dev.shelly.terminal/") ||
            starts_with(path, "/system/bin/"));
}

static int should_keep_wrapper_for_shell_path(const char *path) {
    const char *base = base_name(path);
    return trusted_shell_path(path) &&
           (streq(path, DEFAULT_BASH) ||
            streq(base, "bash") ||
            streq(base, "libbash.so") ||
            streq(base, "sh"));
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
    if (streq(pathname, "/bin/sh") || streq(pathname, "sh")) {
        const char *shell = env_value(envp, "SHELL=");
        if (codex_mode_enabled(envp) && trusted_shell_path(shell)) return shell;
        return "/system/bin/sh";
    }
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
        out[n++] = default_shell_env;
        out[n++] = default_bash_env;
        out[n++] = default_shelly_lib_dir_env;
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
    return env_value_direct(envp, "SHELLY_CODEX_EXEC_PATH=") != NULL;
}

static int trusted_codex_path(const char *path) {
    /* regression-guard: these app-data paths are intentionally scoped to the
     * primary user profile. Work-profile package data needs a separate trust
     * decision before broadening this prefix list. */
    return path && path[0] == '/' &&
           (starts_with(path, "/data/user/0/dev.shelly.terminal/") ||
            starts_with(path, "/data/data/dev.shelly.terminal/"));
}

static const char *codex_exec_path_value(char *const envp[], char *buf, size_t buf_size) {
    const char *path = env_value_direct(envp, "SHELLY_CODEX_EXEC_PATH=");
    if (trusted_codex_path(path)) return path;
    if (proc_environ_value_copy("SHELLY_CODEX_EXEC_PATH=", buf, buf_size) == 0 &&
        trusted_codex_path(buf)) {
        return buf;
    }
    return NULL;
}

static const char *shelly_lib_dir_value(char *const envp[], char *buf, size_t buf_size) {
    const char *lib_dir = env_value_direct(envp, "SHELLY_LIB_DIR=");
    if (lib_dir && lib_dir[0]) return lib_dir;
    if (proc_environ_value_copy("SHELLY_LIB_DIR=", buf, buf_size) == 0 && buf[0]) return buf;
    return DEFAULT_LIB_DIR;
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
    char codex_self_buf[PATH_BUF_SIZE];
    const char *codex_self;
    size_t len;
    if (!proc_exe_path(path)) return -2;
    if (!trace_flag_enabled(NULL, "SHELLY_CODEX_PROC_EXE_SHIM=")) return -2;
    codex_self = codex_exec_path_value(NULL, codex_self_buf, sizeof(codex_self_buf));
    if (!codex_self) return -2;
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

static const char *codex_proc_exe_open_target(const char *path, int flags, char *target_buf, size_t target_buf_size) {
    if (!proc_exe_path(path)) return NULL;
    if (!read_only_open_flags(flags)) return NULL;
    if (!trace_flag_enabled(NULL, "SHELLY_CODEX_PROC_EXE_OPEN_SHIM=")) return NULL;
    return codex_exec_path_value(NULL, target_buf, target_buf_size);
}

static int scrub_codex_child_envp(char *const envp[], char **out, int keep_wrapper) {
    char *const *source = envp;
    int n = 0;
    int has_ld_preload = 0;
    int has_ld_library_path = 0;
    if (!source) {
        out[0] = NULL;
        return 0;
    }
    for (int i = 0; i < MAX_ENVP && source[i]; i++) {
        if (starts_with(source[i], "LD_PRELOAD=")) {
            if (!keep_wrapper) continue;
            if (n >= MAX_ENVP - 1) {
                return -1;
            }
            out[n++] = default_ld_preload_env;
            has_ld_preload = 1;
            continue;
        }
        if (starts_with(source[i], "LD_LIBRARY_PATH=") && source[i][16]) {
            has_ld_library_path = 1;
        }
        if (starts_with(source[i], "SHELLY_CODEX_EXEC_PATH=") ||
            starts_with(source[i], "SHELLY_CODEX_PROC_EXE_SHIM=") ||
            starts_with(source[i], "SHELLY_CODEX_PROC_EXE_OPEN_SHIM=")) {
            continue;
        }
        if (n >= MAX_ENVP - 1) {
            return -1;
        }
        out[n++] = source[i];
    }
    if (keep_wrapper && !has_ld_library_path) {
        if (n >= MAX_ENVP - 1) {
            return -1;
        }
        out[n++] = default_ld_library_path_env;
    }
    if (keep_wrapper && !has_ld_preload) {
        if (n >= MAX_ENVP - 1) {
            return -1;
        }
        out[n++] = default_ld_preload_env;
    }
    out[n] = NULL;
    return 0;
}

static int codex_fs_helper_marker_index(char *const argv[]) {
    if (!argv) return -1;
    for (int i = 1; i < MAX_ARGC && argv[i]; i++) {
        if (streq(argv[i], CODEX_FS_HELPER_ARG1)) return i;
    }
    return -1;
}

static int is_codex_fs_helper_self_exec(const char *pathname, char *const argv[], const char *codex_self) {
    return trusted_codex_path(codex_self) &&
           streq(pathname, codex_self) &&
           codex_fs_helper_marker_index(argv) >= 1;
}

static int add_app_loader_envp(char *const envp[], char **out, char *ld_buf, size_t ld_buf_size,
                               int include_wrapper) {
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
    if (include_wrapper) {
        if (n >= MAX_ENVP - 1) return -1;
        out[n++] = default_ld_preload_env;
    }
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

static int is_codex_fs_helper_linker_exec(const char *pathname, char *const argv[], const char *codex_self) {
    return streq(pathname, LINKER64) &&
           trusted_codex_path(codex_self) &&
           codex_fs_helper_marker_index(argv) >= 1;
}

static int build_codex_fs_helper_argv(char *const argv[], const char *codex_self, char **out) {
    int argc = 0;
    int first_arg = 1;
    int marker_index;
    int j = 0;

    if (!trusted_codex_path(codex_self) || !out) return -1;
    marker_index = codex_fs_helper_marker_index(argv);
    if (marker_index < 1) return -1;
    if (argv) {
        while (argc < MAX_ARGC && argv[argc]) argc++;
        if (argc >= MAX_ARGC) return -1;
        if (argc > 1 && streq(argv[1], codex_self)) {
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

static int add_codex_helper_envp(char *const envp[], char **out, char *ld_buf, size_t ld_buf_size,
                                 char *codex_buf, size_t codex_buf_size, const char *codex_self) {
    char *const *source = envp;
    char lib_dir_buf[PATH_BUF_SIZE];
    const char *lib_dir = shelly_lib_dir_value(envp, lib_dir_buf, sizeof(lib_dir_buf));
    size_t nbuf = 0;
    size_t cbuf = 0;
    int n = 0;

    if (!lib_dir || !lib_dir[0] || !trusted_codex_path(codex_self)) return -1;
    if (append_str(ld_buf, ld_buf_size, &nbuf, "LD_LIBRARY_PATH=") != 0) return -1;
    if (append_str(ld_buf, ld_buf_size, &nbuf, lib_dir) != 0) return -1;
    if (append_str(codex_buf, codex_buf_size, &cbuf, "SHELLY_CODEX_EXEC_PATH=") != 0) return -1;
    if (append_str(codex_buf, codex_buf_size, &cbuf, codex_self) != 0) return -1;

    if (source) {
        for (int i = 0; i < MAX_ENVP && source[i]; i++) {
            if (starts_with(source[i], "LD_LIBRARY_PATH=") ||
                starts_with(source[i], "LD_PRELOAD=") ||
                starts_with(source[i], "SHELLY_CODEX_EXEC_PATH=") ||
                starts_with(source[i], "SHELLY_CODEX_PROC_EXE_SHIM=") ||
                starts_with(source[i], "SHELLY_CODEX_PROC_EXE_OPEN_SHIM=")) {
                continue;
            }
            if (n >= MAX_ENVP - 3) return -1;
            out[n++] = source[i];
        }
    }
    if (n >= MAX_ENVP - 2) return -1;
    out[n++] = ld_buf;
    if (n >= MAX_ENVP - 1) return -1;
    /* regression-guard: keep the fs helper aware of the real Codex ELF even
     * when the spawn env was scrubbed. Do not re-add LD_PRELOAD here. */
    out[n++] = codex_buf;
    out[n] = NULL;
    return 0;
}

__attribute__((noinline, used))
static int shelly_execve_internal(const char *pathname, char *const argv[], char *const envp[]) {
    char rewrite_buf[PATH_BUF_SIZE];
    const char *rewritten = rewrite_path(pathname, envp, rewrite_buf, sizeof(rewrite_buf));
    char codex_self_buf[PATH_BUF_SIZE];
    const char *codex_self = codex_exec_path_value(envp, codex_self_buf, sizeof(codex_self_buf));
    char *codex_child_env[MAX_ENVP];
    int linker_exec;
    int keep_wrapper_for_shell;
    if (!rewritten) {
        if (envp) trace_exec_event("rewrite-null", pathname, NULL, argv, envp, 0);
        return -1;
    }
    linker_exec = should_linker_exec(rewritten);
    keep_wrapper_for_shell = should_keep_wrapper_for_shell_path(rewritten);
    if (envp) trace_exec_event("execve", pathname, rewritten, argv, envp, linker_exec);
    if (is_codex_fs_helper_linker_exec(rewritten, argv, codex_self)) {
        char *codex_argv[MAX_ARGC + 2];
        if (build_codex_fs_helper_argv(argv, codex_self, codex_argv) == 0) {
            char *codex_env[MAX_ENVP];
            char ld_buf[PATH_BUF_SIZE + 32];
            char codex_path_buf[PATH_BUF_SIZE + 32];
            trace_exec_event("codex-fs-helper", pathname, rewritten, codex_argv, envp, 0);
            if (add_codex_helper_envp(envp, codex_env, ld_buf, sizeof(ld_buf),
                                      codex_path_buf, sizeof(codex_path_buf), codex_self) == 0) {
                return raw_execve_call(LINKER64, codex_argv, codex_env);
            }
            return raw_execve_call(LINKER64, codex_argv, envp);
        }
    }
    if (is_codex_fs_helper_self_exec(rewritten, argv, codex_self)) {
        char *codex_argv[MAX_ARGC + 2];
        if (build_linker_argv(rewritten, argv, codex_argv) == 0) {
            char *codex_env[MAX_ENVP];
            char ld_buf[PATH_BUF_SIZE + 32];
            char codex_path_buf[PATH_BUF_SIZE + 32];
            trace_exec_event("codex-fs-helper-self", pathname, rewritten, codex_argv, envp, 1);
            if (add_codex_helper_envp(envp, codex_env, ld_buf, sizeof(ld_buf),
                                      codex_path_buf, sizeof(codex_path_buf), codex_self) == 0) {
                return raw_execve_call(LINKER64, codex_argv, codex_env);
            }
            return raw_execve_call(LINKER64, codex_argv, envp);
        }
    }
    if (codex_mode_enabled(envp) &&
        scrub_codex_child_envp(envp, codex_child_env, keep_wrapper_for_shell) == 0) {
        envp = codex_child_env;
    }
    if (!linker_exec) {
        char *scrubbed_env[MAX_ENVP];
        if (!envp && keep_wrapper_for_shell) {
            return raw_execve_call(rewritten, argv, minimal_wrapper_envp);
        }
        if (keep_wrapper_for_shell && should_scrub_system_env(rewritten)) {
            return raw_execve_call(rewritten, argv, envp);
        }
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
        if (add_app_loader_envp(envp, app_env, ld_buf, sizeof(ld_buf),
                                !envp && keep_wrapper_for_shell) == 0) {
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

/* v218: real libc open/openat resolved via RTLD_NEXT. The open/openat
 * interposers below exist only for the codex /proc/self/exe shim; for every
 * other open they used to issue a raw openat syscall, bypassing bionic's libc
 * open path. That broke node v24's internal ReadFileSync: every package.json
 * read aborted at `CHECK_EQ(0, uv_fs_close(...))` (util.cc) on-device, so the
 * Claude Code cli.js could not load any module under LD_PRELOAD. Falling
 * through to the real libc open/openat (only when no codex rewrite is needed)
 * keeps node's fd bookkeeping intact while preserving both the codex shim and
 * the execve/posix_spawn redirect. Confirmed root cause 2026-06-12. */
typedef int (*open_impl_t)(const char *, int, ...);
typedef int (*openat_impl_t)(int, const char *, int, ...);
static open_impl_t g_open_fn;
static openat_impl_t g_openat_fn;

__attribute__((constructor))
static void shelly_resolve_real_impls(void) {
    g_posix_spawn_fn = (posix_spawn_impl_t)dlsym(RTLD_NEXT, "posix_spawn");
    g_posix_spawnp_fn = (posix_spawn_impl_t)dlsym(RTLD_NEXT, "posix_spawnp");
    g_open_fn = (open_impl_t)dlsym(RTLD_NEXT, "open");
    g_openat_fn = (openat_impl_t)dlsym(RTLD_NEXT, "openat");
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
    char codex_self_buf[PATH_BUF_SIZE];
    const char *codex_self;
    int linker_exec;
    int keep_wrapper_for_shell;

    if (search_path && resolve_path_search(path, envp, resolved_buf, sizeof(resolved_buf),
                                           file_actions != NULL) == 0) {
        spawn_path = resolved_buf;
        search_path = 0;
    } else if (file_actions && path && path[0] != '/') {
        char *codex_child_env[MAX_ENVP];
        if (codex_mode_enabled(envp) &&
            scrub_codex_child_envp(envp, codex_child_env, 0) == 0) {
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
    keep_wrapper_for_shell = should_keep_wrapper_for_shell_path(rewritten);
    trace_exec_event(search_path ? "posix_spawnp" : "posix_spawn",
                     spawn_path, rewritten, argv, envp, linker_exec);

    codex_self = codex_exec_path_value(envp, codex_self_buf, sizeof(codex_self_buf));
    if (is_codex_fs_helper_linker_exec(rewritten, argv, codex_self)) {
        char *codex_argv[MAX_ARGC + 2];
        if (build_codex_fs_helper_argv(argv, codex_self, codex_argv) == 0) {
            char *codex_env[MAX_ENVP];
            char ld_buf[PATH_BUF_SIZE + 32];
            char codex_path_buf[PATH_BUF_SIZE + 32];
            if (add_codex_helper_envp(envp, codex_env, ld_buf, sizeof(ld_buf),
                                      codex_path_buf, sizeof(codex_path_buf), codex_self) == 0) {
                return call_real_posix_spawn(0, pid, LINKER64, file_actions, attrp, codex_argv, codex_env);
            }
            return call_real_posix_spawn(0, pid, LINKER64, file_actions, attrp, codex_argv, envp);
        }
    }
    if (is_codex_fs_helper_self_exec(rewritten, argv, codex_self)) {
        char *codex_argv[MAX_ARGC + 2];
        if (build_linker_argv(rewritten, argv, codex_argv) == 0) {
            char *codex_env[MAX_ENVP];
            char ld_buf[PATH_BUF_SIZE + 32];
            char codex_path_buf[PATH_BUF_SIZE + 32];
            if (add_codex_helper_envp(envp, codex_env, ld_buf, sizeof(ld_buf),
                                      codex_path_buf, sizeof(codex_path_buf), codex_self) == 0) {
                return call_real_posix_spawn(0, pid, LINKER64, file_actions, attrp, codex_argv, codex_env);
            }
            return call_real_posix_spawn(0, pid, LINKER64, file_actions, attrp, codex_argv, envp);
        }
    }

    if (codex_mode_enabled(envp)) {
        char *codex_child_env[MAX_ENVP];
        if (scrub_codex_child_envp(envp, codex_child_env, keep_wrapper_for_shell) == 0) {
            envp = codex_child_env;
        }
    }

    if (!linker_exec) {
        char *scrubbed_env[MAX_ENVP];
        if (!envp && keep_wrapper_for_shell) {
            return call_real_posix_spawn(search_path, pid, rewritten, file_actions, attrp, argv, minimal_wrapper_envp);
        }
        if (keep_wrapper_for_shell && should_scrub_system_env(rewritten)) {
            return call_real_posix_spawn(search_path, pid, rewritten, file_actions, attrp, argv, envp);
        }
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
        if (add_app_loader_envp(envp, app_env, ld_buf, sizeof(ld_buf),
                                !envp && keep_wrapper_for_shell) == 0) {
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
    char target_buf[PATH_BUF_SIZE];
    const char *target = codex_proc_exe_open_target(path, flags, target_buf, sizeof(target_buf));
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list ap;
        va_start(ap, flags);
        mode = (mode_t)va_arg(ap, int);
        va_end(ap);
    }
    if (target) {
        return finish_syscall(raw_syscall4(__NR_openat, AT_FDCWD, (long)target, flags, mode));
    }
    if (g_open_fn) {
        return g_open_fn(path, flags, mode);
    }
    return finish_syscall(raw_syscall4(__NR_openat, AT_FDCWD, (long)path, flags, mode));
}

int openat(int dirfd, const char *path, int flags, ...) {
    char target_buf[PATH_BUF_SIZE];
    const char *target = codex_proc_exe_open_target(path, flags, target_buf, sizeof(target_buf));
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list ap;
        va_start(ap, flags);
        mode = (mode_t)va_arg(ap, int);
        va_end(ap);
    }
    if (target) {
        return finish_syscall(raw_syscall4(__NR_openat, AT_FDCWD, (long)target, flags, mode));
    }
    if (g_openat_fn) {
        return g_openat_fn(dirfd, path, flags, mode);
    }
    return finish_syscall(raw_syscall4(__NR_openat, dirfd, (long)path, flags, mode));
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
