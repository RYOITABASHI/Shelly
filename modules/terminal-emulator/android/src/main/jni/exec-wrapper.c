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
/* Kept modest: these size on-stack arrays in exec/spawn paths; 4096 each
 * ballooned forked-child stack frames enough to make subprocesses SIGSEGV. */
#define MAX_ARGC 1024
#define MAX_ENVP 512
#define PATH_BUF_SIZE 4096
#define SHELLY_ENOENT 2
#define SHELLY_EINTR 4
#define SHELLY_ENOSYS 38
#define DEFAULT_HOME "/data/user/0/dev.shelly.terminal/files/home"
#define DEFAULT_LIB_DIR "/data/user/0/dev.shelly.terminal/files/termux-libs"
#define DEFAULT_BASH DEFAULT_HOME "/bin/bash"
#define DEFAULT_EXEC_WRAPPER DEFAULT_LIB_DIR "/libexec_wrapper.so"
#define DEFAULT_PATH DEFAULT_HOME "/bin:" DEFAULT_LIB_DIR ":/system/bin:/vendor/bin:/apex/com.android.runtime/bin"
/* bug #151 (2026-07-16): terminfo dir for the hardcoded fallback envp
 * arrays below (minimal_envp / minimal_wrapper_envp). Matches the tree
 * LibExtractor.extractAll() extracts assets/terminfo.tar.gz into. */
#define DEFAULT_TERMINFO_DIR DEFAULT_LIB_DIR "/terminfo"

/* used+retain keeps this CI freshness marker past compiler dead-strip and
 * linker --gc-sections; `used` alone does not bind the linker. */
__attribute__((used, retain))
static const char shelly_exec_wrapper_build_marker[] =
    "shelly-exec-wrapper:v223:fd-pinned-linker-exec";

/* v223 (2026-10-13, build 2525 follow-up; replaces the reverted v222):
 * build 2525 showed Codex's `bash -lc` child loses LD_PRELOAD -- not in this
 * wrapper (the shell is exec'd with it and maps the wrapper; traced via
 * /proc/$PPID/{environ,maps}) but because the login shell sources ~/.bashrc,
 * whose `unset LD_PRELOAD` was unconditional. v222 tried to have the wrapper
 * re-inject LD_PRELOAD into every app-ELF/shell/helper child; that was
 * rejected in review because it overrides deliberate opt-outs that run
 * `unset LD_PRELOAD; linker64 X` / `delete env.LD_PRELOAD` from a
 * wrapper-loaded parent (llama-server: "libllama-server-impl.so not found";
 * the capability broker's OpenSSL BIO_new_file abort) and reverses v202/v207
 * (Codex non-shell children drop the wrapper so apply_patch subprocesses do
 * not inherit it). Decision: this wrapper NEVER adds LD_PRELOAD to a supplied
 * envp. Shells (keep_wrapper_for_shell) and exec-a-child helpers
 * (keep_wrapper_for_helper) only KEEP an LD_PRELOAD that is already there;
 * the legacy NULL-envp fallbacks (minimal_wrapper_envp) are the sole
 * injection path and are unchanged. The real fix is in ~/.bashrc
 * (HomeInitializer.kt BASHRC_VERSION 251): the unset now applies only to
 * interactive shells, so Codex's non-interactive login shell keeps the
 * LD_PRELOAD it inherited. */
__attribute__((used, retain))
static const char shelly_exec_wrapper_v223_marker[] =
    "shelly-exec-wrapper:v223:no-blanket-wrapper-reinjection";

/* v221 (2026-10-13, build 2524 follow-up): with v220 `$HOME/bin/env` resolved
 * to /system/bin/env and was exec'd with the /system env scrub, so toybox env
 * lost LD_PRELOAD and its own child exec of an app-data ELF (python3, node)
 * was denied by Knox: `coreutils: 'python3': Permission denied`. /system
 * "exec-a-child" helpers (env, nice, nohup, setsid, time, timeout, xargs) now
 * keep LD_PRELOAD like shells do (LD_LIBRARY_PATH is still dropped for them;
 * the wrapper re-adds it when the helper execs an app-data ELF). Also widened
 * the system-image prefix list to /system_ext, /product and /odm. */
__attribute__((used, retain))
static const char shelly_exec_wrapper_v221_marker[] =
    "shelly-exec-wrapper:v221:system-helpers-keep-wrapper";

/* v220 (2026-10-13): two on-device-verified exec regressions under Codex
 * (see docs/superpowers/DEFERRED.md "Codex shell commands / python3 env"):
 *  1. execvp() handed shelly_execve_internal() a NULL envp, so every
 *     `environ = env; execvp(...)` spawner (Rust std with pre_exec -- Codex;
 *     libuv/node) lost its environment and children ran with minimal_envp.
 *     execvp() now reads the caller's live `environ` through a dlsym'd
 *     pointer (no GLOB_DAT relocation; the CI audit forbids one).
 *  2. A symlink shim into the system image ($HOME/bin/env -> /system/bin/env)
 *     was exec'd as `linker64 /proc/self/fd/N`; linker64 cannot open an fd
 *     whose target lives in /system on this device ("unable to open file").
 *     The verified fd is now readlink'd and system-image targets are exec'd
 *     directly by their resolved path, like any other /system binary. */
__attribute__((used, retain))
static const char shelly_exec_wrapper_v220_marker[] =
    "shelly-exec-wrapper:v220:execvp-environ+system-target-direct";

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
/* bug #151 (2026-07-16): until v220, execvp() below passed NULL envp (not
 * the caller's environ) into shelly_execve_internal; since v220 it passes the
 * live environ and these arrays are only reached when a caller really hands
 * us a NULL envp (execvpe/posix_spawn with NULL, or dlsym("environ") having
 * failed). Two fallthrough paths land on these arrays when envp is NULL:
 * add_app_loader_envp()'s `source = envp ? envp : minimal_envp` (used for
 * the linker64/ELF-rewrite exec path, which is how bundled Termux ELF
 * binaries like less/nano/vim/tmux actually launch), and
 * raw_execve_call()'s own `envp ? envp : minimal_envp` substitution for
 * any non-ELF-rewrite exec with a NULL envp. Without TERM/TERMINFO here,
 * an ncurses-linked binary launched through either path lost the terminfo
 * database even after LibExtractor started bundling it and
 * HomeInitializer.kt started exporting it in .bashrc, since neither of
 * those cover an envp that never reached this file at all. (Note:
 * scrub_system_envp()'s separate NULL-source branch below builds its own
 * small literal list, not minimal_envp/minimal_wrapper_envp — it targets
 * /system,/vendor,/apex binaries only, which aren't Shelly-bundled
 * ncurses consumers, so it's intentionally left as-is here.) */
static char default_term_env[] = "TERM=xterm-256color";
static char default_terminfo_env[] = "TERMINFO=" DEFAULT_TERMINFO_DIR;
static char *const minimal_envp[] = {
    default_path_env,
    default_home_env,
    default_tmpdir_env,
    default_shell_env,
    default_bash_env,
    default_shelly_lib_dir_env,
    default_term_env,
    default_terminfo_env,
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
    default_term_env,
    default_terminfo_env,
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

/* errno publication for the raw-syscall interposers.
 *
 * The interposers below reach the kernel via raw `svc #0` syscalls (no libc
 * PLT on the hot path -- the CI jump-slot audit forbids __errno/open/etc.
 * relocations), so a failing syscall returns -errno to us but bionic's
 * TLS errno slot is never updated. Callers that inspect errno then read a
 * stale value. Concretely: Rust std maps every failed libc call through
 * io::Error::last_os_error(), so under this wrapper a plain ENOENT from
 * open("/etc/codex/requirements.toml") surfaced as "Success (os error 0)",
 * which codex's config loader treats as a fatal non-NotFound error --
 * bare `codex` aborted at startup (2026-07-09, codex-cli 0.142.0).
 *
 * Fix: resolve bionic's __errno() once in the load-time constructor via
 * dlsym (the same eager pattern used for posix_spawn below; dlsym is the
 * one allowlisted PLT slot) and store the failure code into the calling
 * thread's errno slot. If resolution failed we degrade to the previous
 * stale-errno behavior rather than crash.
 */
typedef int *(*errno_slot_fn_t)(void);
static errno_slot_fn_t g_errno_slot_fn;

static void publish_syscall_errno(long ret) {
    errno_slot_fn_t fn = g_errno_slot_fn;
    int *slot;
    if (ret >= 0) return;
    /* v224: an interposer can run before our constructor (another library's
     * initializer); resolve lazily so its errno is not dropped. */
    if (!fn) {
        fn = (errno_slot_fn_t)dlsym(RTLD_NEXT, "__errno");
        g_errno_slot_fn = fn;
    }
    if (!fn) return;
    slot = fn();
    if (slot) *slot = (int)-ret;
}

static int finish_syscall(long ret) {
    if (ret < 0) {
        publish_syscall_errno(ret);
        return -1;
    }
    return (int)ret;
}

static ssize_t finish_syscall_ssize(long ret) {
    if (ret < 0) {
        publish_syscall_errno(ret);
        return -1;
    }
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

/* v221: /system (toybox) helpers whose whole job is to exec a child command.
 * Without the wrapper preloaded, their execve() of an app-data ELF (python3,
 * node, anything in $HOME/bin or termux-libs) is denied by Knox:
 * `env python3 ...`, `#!/usr/bin/env python3`, `timeout 10 node ...`.
 * Keep LD_PRELOAD for them (LD_LIBRARY_PATH is still dropped; the wrapper
 * re-adds it on the child's linker64 exec via add_app_loader_envp). The
 * list is deliberately short and only matches trusted /system or app-data
 * paths (rewrite_path/system-target resolution already mapped
 * `env`, `/usr/bin/env` and `$HOME/bin/env` to /system/bin/env). */
static int should_keep_wrapper_for_helper_path(const char *path) {
    const char *base = base_name(path);
    return trusted_shell_path(path) &&
           (streq(base, "env") ||
            streq(base, "nice") ||
            streq(base, "nohup") ||
            streq(base, "setsid") ||
            streq(base, "time") ||
            streq(base, "timeout") ||
            streq(base, "xargs"));
}

/* v221/v223: env for a /system exec-a-child helper: drop LD_LIBRARY_PATH
 * (system binaries must not resolve DSOs from the app-private lib dir) and
 * KEEP an LD_PRELOAD that is already in envp so the helper's own exec is
 * laundered. v223: never adds LD_PRELOAD to a supplied envp -- a caller that
 * deliberately removed it (`unset LD_PRELOAD; ...`, `delete env.LD_PRELOAD`)
 * gets an un-wrapped helper, exactly like an un-wrapped shell. Only the
 * legacy NULL-envp case starts from minimal_wrapper_envp (same rule as the
 * shell fallback). */
static int scrub_system_helper_envp(char *const envp[], char **out) {
    char *const *source = envp ? envp : minimal_wrapper_envp;
    int n = 0;
    int i = 0;
    for (; i < MAX_ENVP && source[i]; i++) {
        if (starts_with(source[i], "LD_LIBRARY_PATH=")) continue;
        if (n >= MAX_ENVP - 1) return -1;
        out[n++] = source[i];
    }
    // i == MAX_ENVP after the loop happens both when source had exactly
    // MAX_ENVP entries (not truncated) and when it had more (truncated) --
    // the loop condition can't tell them apart. Peek at source[i] itself:
    // NULL means the array legitimately ended right at the cap.
    if (i == MAX_ENVP && source[i] != NULL) return -1;
    out[n] = NULL;
    return 0;
}

/* bug #119 (TOCTOU): the old is_elf() checked the ELF magic by path and the
 * exec then re-resolved the same path, so the target could be swapped between
 * check and use. Instead, keep the fd the magic was verified on and exec
 * `linker64 /proc/self/fd/N ...` -- the fd pins the verified inode, so no
 * path mutation after the check can change what runs.
 *
 * Deliberate flag choices:
 * - no O_NOFOLLOW: $HOME/bin shims are symlinks into $libDir by design;
 *   execve would follow them too, and the held fd pins the final inode, so
 *   following symlinks at open time is safe here.
 * - no O_CLOEXEC: the fd must survive execve so linker64 in the new image
 *   can open /proc/self/fd/N. The exec'd program inherits one read-only fd
 *   to its own binary (same information the kernel already exposes). */
#ifndef __NR_fcntl
#define __NR_fcntl 25
#endif
#ifndef F_DUPFD
#define F_DUPFD 0
#endif
#define PROC_FD_PATH_SIZE 32
#define ELF_FD_MIN 100

static int raw_fcntl_dupfd(int fd, int min_fd) {
    return finish_syscall(raw_syscall3(__NR_fcntl, fd, F_DUPFD, min_fd));
}

static void close_elf_fd(int fd) {
    if (fd >= 0) raw_close_call(fd);
}

static int open_verified_elf_fd(const char *path) {
    unsigned char magic[4];
    long n;
    int fd = raw_open_readonly(path);
    if (fd < 0) return -1;
    do {
        n = raw_read_call(fd, magic, sizeof(magic));
    } while (n == -SHELLY_EINTR);
    if (n != 4 || magic[0] != 0x7f || magic[1] != 'E' ||
        magic[2] != 'L' || magic[3] != 'F') {
        raw_close_call(fd);
        return -1;
    }
    /* Move above the caller's likely dup2 targets so posix_spawn file_actions
     * running in the child cannot clobber the verified fd before exec. If the
     * dup fails, keep the original fd rather than dropping linker routing. */
    int high_fd = raw_fcntl_dupfd(fd, ELF_FD_MIN);
    if (high_fd >= 0) {
        raw_close_call(fd);
        return high_fd;
    }
    return fd;
}

static int format_proc_fd_path(char *out, size_t out_size, int fd) {
    size_t n = 0;
    if (fd < 0) return -1;
    if (append_str(out, out_size, &n, "/proc/self/fd/") != 0) return -1;
    return append_uint(out, out_size, &n, (unsigned int)fd);
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

static int system_image_path(const char *path) {
    return path &&
           (starts_with(path, "/system/") ||
            starts_with(path, "/vendor/") ||
            starts_with(path, "/apex/") ||
            starts_with(path, "/system_ext/") ||
            starts_with(path, "/product/") ||
            starts_with(path, "/odm/"));
}

/* v220: resolve the open file description behind `fd` (readlink of
 * /proc/self/fd/N -- the same magic link the exec would hand linker64) and
 * report whether it lives in the system image. Symlink shims such as
 * $HOME/bin/env -> /system/bin/env pass the ELF-magic check by path, but
 * `linker64 /proc/self/fd/N` fails to open a /system-backed fd on device
 * (bug: `error: unable to open file "/proc/self/fd/102"` from every mksh/bash
 * child of a wrapper-loaded process that ran `env`), while the kernel execs
 * the resolved /system path fine. On success `resolved` holds the target. */
static int fd_targets_system_image(int fd, char *resolved, size_t resolved_size) {
    char proc_path[PROC_FD_PATH_SIZE];
    long n;
    if (!resolved || resolved_size == 0) return 0;
    resolved[0] = '\0';
    if (format_proc_fd_path(proc_path, sizeof(proc_path), fd) != 0) return 0;
    do {
        n = raw_readlinkat_call(AT_FDCWD, proc_path, resolved, resolved_size - 1);
    } while (n == -SHELLY_EINTR);
    if (n <= 0 || (size_t)n >= resolved_size - 1) {
        resolved[0] = '\0';
        return 0;
    }
    resolved[n] = '\0';
    if (system_image_path(resolved)) return 1;
    resolved[0] = '\0';
    return 0;
}

/* Returns a verified ELF fd (>= 0) when pathname should be exec'd through
 * linker64, or -1 for direct exec. The caller owns the fd and must close it
 * on every path that does not exec through it (see close_elf_fd).
 * When the verified fd turns out to be backed by the system image, the fd is
 * closed, -1 is returned and `system_target` (if given) receives the resolved
 * /system path the caller should exec directly instead of `pathname`. */
static int linker_exec_elf_fd(const char *pathname, char *system_target, size_t system_target_size) {
    int fd;
    if (system_target && system_target_size) system_target[0] = '\0';
    if (!pathname ||
        streq(pathname, LINKER64) ||
        system_image_path(pathname)) {
        return -1;
    }
    fd = open_verified_elf_fd(pathname);
    if (fd < 0) return -1;
    if (system_target && fd_targets_system_image(fd, system_target, system_target_size)) {
        raw_close_call(fd);
        return -1;
    }
    return fd;
}

static int should_scrub_system_env(const char *pathname) {
    return pathname &&
           !streq(pathname, LINKER64) &&
           system_image_path(pathname);
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
    int i = 0;
    for (; i < MAX_ENVP && source[i]; i++) {
        if (starts_with(source[i], "LD_LIBRARY_PATH=") ||
            starts_with(source[i], "LD_PRELOAD=")) {
            continue;
        }
        if (n >= MAX_ENVP - 1) {
            return -1;
        }
        out[n++] = source[i];
    }
    // i == MAX_ENVP after the loop happens both when source had exactly
    // MAX_ENVP entries (not truncated) and when it had more (truncated) --
    // the loop condition can't tell them apart. Peek at source[i] itself:
    // NULL means the array legitimately ended right at the cap.
    if (i == MAX_ENVP && source[i] != NULL) return -1;
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
    int i = 0;
    for (; i < MAX_ENVP && source[i]; i++) {
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
    // i == MAX_ENVP after the loop happens both when source had exactly
    // MAX_ENVP entries (not truncated) and when it had more (truncated) --
    // the loop condition can't tell them apart. Peek at source[i] itself:
    // NULL means the array legitimately ended right at the cap.
    if (i == MAX_ENVP && source[i] != NULL) return -1;
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
        int i = 0;
        for (; i < MAX_ENVP && source[i]; i++) {
            if (n >= MAX_ENVP - 2) return -1;
            out[n++] = source[i];
        }
        // i == MAX_ENVP after the loop happens both when source had exactly
    // MAX_ENVP entries (not truncated) and when it had more (truncated) --
    // the loop condition can't tell them apart. Peek at source[i] itself:
    // NULL means the array legitimately ended right at the cap.
    if (i == MAX_ENVP && source[i] != NULL) return -1;
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
        int i = 0;
        for (; i < MAX_ENVP && source[i]; i++) {
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
        // i == MAX_ENVP after the loop happens both when source had exactly
    // MAX_ENVP entries (not truncated) and when it had more (truncated) --
    // the loop condition can't tell them apart. Peek at source[i] itself:
    // NULL means the array legitimately ended right at the cap.
    if (i == MAX_ENVP && source[i] != NULL) return -1;
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
    char elf_fd_path[PROC_FD_PATH_SIZE];
    char system_target[PATH_BUF_SIZE];
    int elf_fd;
    int linker_exec;
    int keep_wrapper_for_shell;
    int keep_wrapper_for_helper;
    if (!rewritten) {
        if (envp) trace_exec_event("rewrite-null", pathname, NULL, argv, envp, 0);
        return -1;
    }
    elf_fd = linker_exec_elf_fd(rewritten, system_target, sizeof(system_target));
    if (elf_fd < 0 && system_target[0]) {
        /* v220: symlink shim into the system image -- exec the resolved
         * /system path directly (kernel-resolved, no linker64/fd detour). */
        if (envp) trace_exec_event("system-target-direct", pathname, system_target, argv, envp, 0);
        rewritten = system_target;
    }
    linker_exec = elf_fd >= 0;
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
            /* This branch execs by path (unchanged codex-helper argv contract);
             * drop the verified fd so it does not leak into the child. */
            close_elf_fd(elf_fd);
            if (add_codex_helper_envp(envp, codex_env, ld_buf, sizeof(ld_buf),
                                      codex_path_buf, sizeof(codex_path_buf), codex_self) == 0) {
                return raw_execve_call(LINKER64, codex_argv, codex_env);
            }
            return raw_execve_call(LINKER64, codex_argv, envp);
        }
    }
    keep_wrapper_for_helper = should_keep_wrapper_for_helper_path(rewritten);
    if (codex_mode_enabled(envp) &&
        scrub_codex_child_envp(envp, codex_child_env,
                               keep_wrapper_for_shell || keep_wrapper_for_helper) == 0) {
        envp = codex_child_env;
    }
    if (!linker_exec) {
        char *scrubbed_env[MAX_ENVP];
        if (keep_wrapper_for_helper && should_scrub_system_env(rewritten)) {
            /* v221: toybox env/nice/timeout/... must keep the wrapper so the
             * command they exec (python3, node, ...) is laundered too. */
            if (scrub_system_helper_envp(envp, scrubbed_env) == 0) {
                if (envp) trace_exec_event("system-helper-keep-wrapper", pathname, rewritten, argv, envp, 0);
                return raw_execve_call(rewritten, argv, scrubbed_env);
            }
        }
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
    if (format_proc_fd_path(elf_fd_path, sizeof(elf_fd_path), elf_fd) != 0 ||
        build_linker_argv(elf_fd_path, argv, new_argv) != 0) {
        if (envp) trace_exec_event("linker-argv-failed", pathname, rewritten, argv, envp, 0);
        close_elf_fd(elf_fd);
        return raw_execve_call(rewritten, argv, envp);
    }
    if (!env_value(envp, "LD_LIBRARY_PATH=")) {
        char *app_env[MAX_ENVP];
        char ld_buf[PATH_BUF_SIZE + 32];
        if (add_app_loader_envp(envp, app_env, ld_buf, sizeof(ld_buf),
                                !envp && keep_wrapper_for_shell) == 0) {
            int exec_ret = raw_execve_call(LINKER64, new_argv, app_env);
            close_elf_fd(elf_fd);
            return exec_ret;
        }
    }
    int exec_ret = raw_execve_call(LINKER64, new_argv, envp);
    close_elf_fd(elf_fd);
    return exec_ret;
}

int execve(const char *pathname, char *const argv[], char *const envp[]) {
    return shelly_execve_internal(pathname, argv, envp);
}

/* v224 (2026-10-13): Termux socket-root redirect for `codex remote-control`.
 *
 * codex-termux (DioNanos/codex-termux, codex-rs/uds/src/daemon_directory.rs)
 * hardcodes the app-server socket rendezvous root on Android as
 * /data/data/com.termux/cdx-termux-<euid>, deliberately independent of HOME,
 * TMPDIR and CODEX_HOME. Every app-server unix-socket listener -- including
 * the `codex remote-control --no-daemon` foreground host -- calls
 * fs::canonicalize("/data/data/com.termux") and creates its physical socket
 * there. Shelly runs as dev.shelly.terminal and can never write (or, without
 * Termux installed, even resolve) that path, so remote control fails before
 * it reaches the network.
 *
 * Fix without patching the binary: this preload maps exactly that virtual
 * directory onto an app-private one, <app data dir>/cdx (HOME with its
 * trailing /files/home stripped -> /data/user/0/dev.shelly.terminal/cdx).
 * The real directory is kept short on purpose: a physical socket is
 * <dir>/<64-hex sha256>, and sockaddr_un.sun_path holds 107 bytes.
 *   - realpath() of the root (or anything under the virtual dir) returns the
 *     path unchanged, so canonicalize() succeeds and Codex keeps working in
 *     virtual paths;
 *   - the filesystem calls Codex makes on those paths (mkdir, stat/lstat,
 *     chmod, unlink, open of the startup lock, symlink) and AF_UNIX
 *     bind()/connect() get the mapped path;
 *   - symlink() targets are mapped too: Codex publishes the socket as a
 *     rendezvous symlink pointing INTO the virtual dir, and clients connect
 *     through it, which the kernel resolves without us -- so the stored
 *     target must be real. readlink() maps it back so Codex's own
 *     "is this my alias?" comparison still matches.
 * Only paths under /data/data/com.termux/cdx-termux-<this process's euid>
 * (plus the bare root in realpath) are touched; every other call is handed
 * to libc unchanged. Upstream proposal:
 * docs/superpowers/specs/2026-10-13-codex-remote-control-socket-root.md. */
__attribute__((used, retain))
static const char shelly_exec_wrapper_v224_marker[] =
    "shelly-exec-wrapper:v224:termux-socket-root-redirect";

#define TERMUX_SOCKET_ROOT "/data/data/com.termux"
#define TERMUX_SOCKET_DIR_PREFIX TERMUX_SOCKET_ROOT "/cdx-termux-"
#define SHELLY_SOCKET_DIR_NAME "/cdx"
#define SHELLY_FILES_HOME_SUFFIX "/files/home"
#define SOCKET_MAP_BUF_SIZE 512
#define SHELLY_SUN_PATH_SIZE 108
#define SHELLY_AF_UNIX 1
#define SHELLY_ENOMEM 12
#define SHELLY_ENAMETOOLONG 36
#define SHELLY_REALPATH_MAX 4096
#ifndef __NR_geteuid
#define __NR_geteuid 175
#endif

struct shelly_sockaddr_un {
    unsigned short sun_family;
    char sun_path[SHELLY_SUN_PATH_SIZE];
};

/* libc implementations of the interposed calls, resolved eagerly in the
 * constructor and lazily on first use (a hook can run before our constructor,
 * e.g. from another library's initializer). */
static void *g_real_realpath_fn;
static void *g_real_malloc_fn;
static void *g_real_stat_fn;
static void *g_real_lstat_fn;
static void *g_real_stat64_fn;
static void *g_real_lstat64_fn;
static void *g_real_fstatat_fn;
static void *g_real_fstatat64_fn;
static void *g_real_mkdir_fn;
static void *g_real_mkdirat_fn;
static void *g_real_unlink_fn;
static void *g_real_unlinkat_fn;
static void *g_real_rmdir_fn;
static void *g_real_chmod_fn;
static void *g_real_fchmodat_fn;
static void *g_real_symlink_fn;
static void *g_real_symlinkat_fn;
static void *g_real_bind_fn;
static void *g_real_connect_fn;
static void *g_real_gethostname_fn; /* v225 */

static void *real_sym(void **slot, const char *name) {
    void *fn = *slot;
    if (!fn) {
        fn = dlsym(RTLD_NEXT, name);
        *slot = fn;
    }
    return fn;
}

static void resolve_socket_root_impls(void) {
    real_sym(&g_real_realpath_fn, "realpath");
    /* RTLD_DEFAULT: realpath(NULL buffer) results are freed by the caller's
     * free(), which binds through the global scope, not RTLD_NEXT. */
    if (!g_real_malloc_fn) g_real_malloc_fn = dlsym(RTLD_DEFAULT, "malloc");
    real_sym(&g_real_stat64_fn, "stat64");
    real_sym(&g_real_lstat64_fn, "lstat64");
    real_sym(&g_real_stat_fn, "stat");
    real_sym(&g_real_lstat_fn, "lstat");
    real_sym(&g_real_fstatat_fn, "fstatat");
    real_sym(&g_real_fstatat64_fn, "fstatat64");
    real_sym(&g_real_mkdir_fn, "mkdir");
    real_sym(&g_real_mkdirat_fn, "mkdirat");
    real_sym(&g_real_unlink_fn, "unlink");
    real_sym(&g_real_unlinkat_fn, "unlinkat");
    real_sym(&g_real_rmdir_fn, "rmdir");
    real_sym(&g_real_chmod_fn, "chmod");
    real_sym(&g_real_fchmodat_fn, "fchmodat");
    real_sym(&g_real_symlink_fn, "symlink");
    real_sym(&g_real_symlinkat_fn, "symlinkat");
    real_sym(&g_real_bind_fn, "bind");
    real_sym(&g_real_connect_fn, "connect");
    real_sym(&g_real_gethostname_fn, "gethostname");
}

/* Writes /data/data/com.termux/cdx-termux-<euid> into out; returns its length
 * or -1. */
static int termux_socket_virtual_dir(char *out, size_t out_size) {
    size_t n = 0;
    long uid = raw_syscall1(__NR_geteuid, 0);
    if (uid < 0 || !out || out_size == 0) return -1;
    out[0] = '\0';
    if (append_str(out, out_size, &n, TERMUX_SOCKET_DIR_PREFIX) != 0 ||
        append_uint(out, out_size, &n, (unsigned int)uid) != 0) {
        return -1;
    }
    return (int)n;
}

/* Length of the virtual directory prefix when `path` is that directory or
 * lies inside it; 0 otherwise. */
static size_t termux_socket_virtual_match(const char *path) {
    char vdir[64];
    int n;
    if (!path || !starts_with(path, TERMUX_SOCKET_DIR_PREFIX)) return 0;
    n = termux_socket_virtual_dir(vdir, sizeof(vdir));
    if (n <= 0 || !starts_with(path, vdir)) return 0;
    if (path[n] != '\0' && path[n] != '/') return 0;
    return (size_t)n;
}

/* Writes the real, app-private socket directory into out; returns its length
 * or -1. HOME comes from /proc/self/environ (this file never reads the live
 * environ outside execvp). Server and client processes must agree on this
 * directory, so only a HOME of the app's own shape (<app dir>/files/home)
 * is honoured; anything else (a user-overridden HOME, a scrubbed env)
 * falls back to the DEFAULT_HOME-derived app dir. */
static int shelly_socket_real_dir(char *out, size_t out_size) {
    char home[SOCKET_MAP_BUF_SIZE];
    size_t len;
    size_t n = 0;
    const size_t suffix_len = sizeof(SHELLY_FILES_HOME_SUFFIX) - 1;
    if (!out || out_size == 0) return -1;
    if (proc_environ_value_copy("HOME=", home, sizeof(home)) != 0 || home[0] != '/' ||
        str_len(home) + 1 >= sizeof(home)) {
        home[0] = '\0';
    }
    len = str_len(home);
    while (len > 1 && home[len - 1] == '/') home[--len] = '\0';
    if (!(len > suffix_len && streq(home + len - suffix_len, SHELLY_FILES_HOME_SUFFIX))) {
        n = 0;
        home[0] = '\0';
        if (append_str(home, sizeof(home), &n, DEFAULT_HOME) != 0) return -1;
        len = n;
    }
    home[len - suffix_len] = '\0';
    n = 0;
    out[0] = '\0';
    if (append_str(out, out_size, &n, home) != 0 ||
        append_str(out, out_size, &n, SHELLY_SOCKET_DIR_NAME) != 0) {
        return -1;
    }
    return (int)n;
}

/* 1: `path` is a virtual Termux socket path and `out` holds the real one;
 * 0: unrelated path; -1: virtual but cannot be mapped. */
static int map_termux_socket_path(const char *path, char *out, size_t out_size) {
    size_t vlen = termux_socket_virtual_match(path);
    size_t pos;
    int n;
    if (!vlen) return 0;
    n = shelly_socket_real_dir(out, out_size);
    if (n < 0) return -1;
    pos = (size_t)n;
    if (append_str(out, out_size, &pos, path + vlen) != 0) return -1;
    return 1;
}

/* The path a filesystem hook hands to libc: `path` itself, `buf` holding its
 * mapping, or NULL (errno published) when a virtual path cannot be mapped. */
static const char *socket_root_path_arg(const char *path, char *buf, size_t buf_size) {
    int m;
    if (!path || !starts_with(path, TERMUX_SOCKET_DIR_PREFIX)) return path;
    m = map_termux_socket_path(path, buf, buf_size);
    if (m == 0) return path;
    if (m < 0) {
        publish_syscall_errno(-SHELLY_ENAMETOOLONG);
        return NULL;
    }
    return buf;
}

/* Cheap precheck for readlink results: does the buffer contain a "/cdx"
 * component (end of string or followed by '/')? */
static int link_mentions_socket_dir(const char *buf, long len) {
    const char *name = SHELLY_SOCKET_DIR_NAME;
    const long name_len = (long)(sizeof(SHELLY_SOCKET_DIR_NAME) - 1);
    for (long i = 0; i + name_len <= len; i++) {
        long j = 0;
        while (j < name_len && buf[i + j] == name[j]) j++;
        if (j == name_len && (i + name_len == len || buf[i + name_len] == '/')) return 1;
    }
    return 0;
}

/* readlink() post-processing: a link target inside the real socket directory
 * is reported as its virtual path. Returns the (possibly new) length. */
static long unmap_termux_socket_link(char *buf, size_t bufsiz, long len) {
    char real_dir[SOCKET_MAP_BUF_SIZE];
    char virt[SOCKET_MAP_BUF_SIZE];
    size_t n = 0;
    int rlen;
    int vlen;
    long i;
    /* A result that filled the whole buffer may be truncated; leave it. */
    if (!buf || len <= 0 || (size_t)len >= bufsiz || (size_t)len >= sizeof(virt)) return len;
    if (buf[0] != '/' || !link_mentions_socket_dir(buf, len)) return len;
    rlen = shelly_socket_real_dir(real_dir, sizeof(real_dir));
    if (rlen <= 0 || len < rlen) return len;
    for (i = 0; i < rlen; i++) {
        if (buf[i] != real_dir[i]) return len;
    }
    if (len > rlen && buf[rlen] != '/') return len;
    vlen = termux_socket_virtual_dir(virt, sizeof(virt));
    if (vlen <= 0) return len;
    n = (size_t)vlen;
    for (i = rlen; i < len; i++) {
        if (append_char(virt, sizeof(virt), &n, buf[i]) != 0) return len;
    }
    for (i = 0; (size_t)i < n && (size_t)i < bufsiz; i++) buf[i] = virt[i];
    return i;
}

/* AF_UNIX bind()/connect() address rewrite. 1: `out` holds the mapped
 * address; 0: unrelated address; -1: virtual but unmappable (errno set). */
static int map_unix_sockaddr(const void *addr, int len, struct shelly_sockaddr_un *out, int *out_len) {
    const struct shelly_sockaddr_un *in = (const struct shelly_sockaddr_un *)addr;
    char path[SHELLY_SUN_PATH_SIZE + 1];
    char mapped[SOCKET_MAP_BUF_SIZE];
    long path_len;
    size_t mapped_len;
    int m;
    if (!addr || len <= (int)sizeof(unsigned short) || len > (int)sizeof(struct shelly_sockaddr_un)) return 0;
    if (in->sun_family != SHELLY_AF_UNIX || in->sun_path[0] != '/') return 0;
    path_len = len - (long)sizeof(unsigned short);
    for (long i = 0; i < path_len; i++) {
        path[i] = in->sun_path[i];
        if (!path[i]) break;
    }
    path[path_len] = '\0';
    if (!starts_with(path, TERMUX_SOCKET_DIR_PREFIX)) return 0;
    m = map_termux_socket_path(path, mapped, sizeof(mapped));
    if (m <= 0) {
        if (m < 0) publish_syscall_errno(-SHELLY_ENAMETOOLONG);
        return m;
    }
    mapped_len = str_len(mapped);
    if (mapped_len >= SHELLY_SUN_PATH_SIZE) {
        publish_syscall_errno(-SHELLY_ENAMETOOLONG);
        return -1;
    }
    out->sun_family = SHELLY_AF_UNIX;
    for (size_t i = 0; i < SHELLY_SUN_PATH_SIZE; i++) out->sun_path[i] = '\0';
    for (size_t i = 0; i < mapped_len; i++) out->sun_path[i] = mapped[i];
    *out_len = (int)(sizeof(unsigned short) + mapped_len + 1);
    return 1;
}

typedef int (*posix_spawn_impl_t)(pid_t *, const char *,
                                  const posix_spawn_file_actions_t *,
                                  const posix_spawnattr_t *,
                                  char *const[], char *const[]);

static posix_spawn_impl_t g_posix_spawn_fn;
static posix_spawn_impl_t g_posix_spawnp_fn;
/* v220: the process's `environ` variable, resolved by name so this library
 * carries no R_AARCH64_GLOB_DAT relocation against it (the CI audit forbids
 * one; an earlier `extern char **environ` was removed in 2b5204037).
 *
 * Contract: ONLY execvp() may read this, because execvp(3) is defined as
 * "execve with environ". Every other entry point receives an explicit envp
 * and must use exactly that -- never merge parent environ values into a
 * supplied envp (2b5204037 removed env_value_parent_fallback for that reason:
 * a scrubbed Codex child env was being re-polluted from the parent).
 * execvp() has to read it LIVE because Rust std (Command with pre_exec --
 * Codex) and libuv (node) implement spawn as `environ = child_env;
 * execvp(file, argv)` in the forked child: the child env exists only in that
 * variable.
 *
 * Lookup order: RTLD_DEFAULT first so a main executable that carries its own
 * copy-relocated `environ` (the one its code actually writes to) wins over
 * libc's; RTLD_NEXT as the fallback. For PIE binaries both resolve to libc's
 * object. */
static char ***g_environ_ptr;

__attribute__((constructor))
static void shelly_resolve_real_impls(void) {
    g_posix_spawn_fn = (posix_spawn_impl_t)dlsym(RTLD_NEXT, "posix_spawn");
    g_posix_spawnp_fn = (posix_spawn_impl_t)dlsym(RTLD_NEXT, "posix_spawnp");
    /* bionic's errno TLS accessor; used by publish_syscall_errno so the
     * raw-syscall interposers report failures through errno like libc. */
    g_errno_slot_fn = (errno_slot_fn_t)dlsym(RTLD_NEXT, "__errno");
    g_environ_ptr = (char ***)dlsym(RTLD_DEFAULT, "environ");
    if (!g_environ_ptr) g_environ_ptr = (char ***)dlsym(RTLD_NEXT, "environ");
    resolve_socket_root_impls();
}

/* The caller's current environment as execvp(3) would pass it to execve(2),
 * or NULL when libc's environ could not be resolved (legacy minimal_envp
 * behaviour). An empty environment is still returned as-is: callers that
 * deliberately cleared the env must not get the defaults re-injected. */
static char *const *caller_environ(void) {
    if (!g_environ_ptr) return NULL;
    return (char *const *)*g_environ_ptr;
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
    char elf_fd_path[PROC_FD_PATH_SIZE];
    char system_target[PATH_BUF_SIZE];
    int elf_fd;
    int linker_exec;
    int keep_wrapper_for_shell;
    int keep_wrapper_for_helper;

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
    elf_fd = linker_exec_elf_fd(rewritten, system_target, sizeof(system_target));
    if (elf_fd < 0 && system_target[0]) {
        /* v220: see shelly_execve_internal -- system-image symlink shim. */
        trace_exec_event("system-target-direct", spawn_path, system_target, argv, envp, 0);
        rewritten = system_target;
    }
    linker_exec = elf_fd >= 0;
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
            /* This branch spawns by path (unchanged codex-helper argv contract);
             * close the verified fd pre-fork so the child never inherits it. */
            close_elf_fd(elf_fd);
            if (add_codex_helper_envp(envp, codex_env, ld_buf, sizeof(ld_buf),
                                      codex_path_buf, sizeof(codex_path_buf), codex_self) == 0) {
                return call_real_posix_spawn(0, pid, LINKER64, file_actions, attrp, codex_argv, codex_env);
            }
            return call_real_posix_spawn(0, pid, LINKER64, file_actions, attrp, codex_argv, envp);
        }
    }

    keep_wrapper_for_helper = should_keep_wrapper_for_helper_path(rewritten);
    if (codex_mode_enabled(envp)) {
        char *codex_child_env[MAX_ENVP];
        if (scrub_codex_child_envp(envp, codex_child_env,
                                   keep_wrapper_for_shell || keep_wrapper_for_helper) == 0) {
            envp = codex_child_env;
        }
    }

    if (!linker_exec) {
        char *scrubbed_env[MAX_ENVP];
        if (keep_wrapper_for_helper && should_scrub_system_env(rewritten)) {
            /* v221: see shelly_execve_internal -- exec-a-child helper. */
            if (scrub_system_helper_envp(envp, scrubbed_env) == 0) {
                trace_exec_event("system-helper-keep-wrapper", spawn_path, rewritten, argv, envp, 0);
                return call_real_posix_spawn(search_path, pid, rewritten, file_actions, attrp, argv, scrubbed_env);
            }
        }
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
    if (format_proc_fd_path(elf_fd_path, sizeof(elf_fd_path), elf_fd) != 0 ||
        build_linker_argv(elf_fd_path, argv, new_argv) != 0) {
        close_elf_fd(elf_fd);
        return call_real_posix_spawn(search_path, pid, rewritten, file_actions, attrp, argv, envp);
    }
    /* The verified fd is intentionally left open across the spawn: the child
     * inherits it so linker64 can load /proc/self/fd/N. The parent's copy is
     * closed once the spawn call returns (bionic posix_spawn has vfork-style
     * semantics, so the child has already exec'd or died by then; with plain
     * fork semantics the child holds its own fd-table copy either way). */
    if (!env_value(envp, "LD_LIBRARY_PATH=")) {
        char *app_env[MAX_ENVP];
        char ld_buf[PATH_BUF_SIZE + 32];
        if (add_app_loader_envp(envp, app_env, ld_buf, sizeof(ld_buf),
                                !envp && keep_wrapper_for_shell) == 0) {
            int spawn_ret = call_real_posix_spawn(0, pid, LINKER64, file_actions, attrp, new_argv, app_env);
            close_elf_fd(elf_fd);
            return spawn_ret;
        }
    }
    int spawn_ret = call_real_posix_spawn(0, pid, LINKER64, file_actions, attrp, new_argv, envp);
    close_elf_fd(elf_fd);
    return spawn_ret;
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
    /* v220: execvp(3) semantics -- the child runs with the caller's CURRENT
     * environ (which Rust std / libuv have just pointed at the child env),
     * and PATH lookup uses that environ's PATH. Passing NULL here made every
     * execvp spawn fall through to minimal_envp / minimal_wrapper_envp, which
     * is how Codex-exec'd python3 lost PYTHONHOME/PYTHONPATH (and TZ, and the
     * SHELLY_CODEX_* markers that route /bin/sh to $SHELL). */
    char *const *envp = caller_environ();
    if (resolve_path_search(file, envp, resolved_buf, sizeof(resolved_buf), 1) == 0) {
        path = resolved_buf;
    }
    if (envp) trace_exec_event("execvp", file, path, argv, envp, 0);
    return shelly_execve_internal(path, argv, envp);
}

int execvpe(const char *file, char *const argv[], char *const envp[]) {
    return shelly_execve_internal(file, argv, envp);
}

int open(const char *path, int flags, ...) {
    char target_buf[PATH_BUF_SIZE];
    char socket_buf[SOCKET_MAP_BUF_SIZE];
    const char *target = codex_proc_exe_open_target(path, flags, target_buf, sizeof(target_buf));
    mode_t mode = 0;
    if (!target) {
        target = socket_root_path_arg(path, socket_buf, sizeof(socket_buf));
        if (path && !target) return -1;
        if (target == path) target = NULL;
    }
    if (flags & O_CREAT) {
        va_list ap;
        va_start(ap, flags);
        mode = (mode_t)va_arg(ap, int);
        va_end(ap);
    }
    return finish_syscall(raw_syscall4(__NR_openat, AT_FDCWD, (long)(target ? target : path), flags, mode));
}

static int shelly_openat_impl(int dirfd, const char *path, int flags, mode_t mode) {
    char target_buf[PATH_BUF_SIZE];
    char socket_buf[SOCKET_MAP_BUF_SIZE];
    const char *target = codex_proc_exe_open_target(path, flags, target_buf, sizeof(target_buf));
    if (!target) {
        target = socket_root_path_arg(path, socket_buf, sizeof(socket_buf));
        if (path && !target) return -1;
        if (target == path) target = NULL;
    }
    if (target) dirfd = AT_FDCWD;
    return finish_syscall(raw_syscall4(__NR_openat, dirfd, (long)(target ? target : path), flags, mode));
}

int openat(int dirfd, const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list ap;
        va_start(ap, flags);
        mode = (mode_t)va_arg(ap, int);
        va_end(ap);
    }
    return shelly_openat_impl(dirfd, path, flags, mode);
}

/* v224: codex-termux imports openat64 as well as openat (bionic aliases them;
 * arm64 has no separate large-file flag), so the socket-root mapping must see
 * both names. */
int openat64(int dirfd, const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list ap;
        va_start(ap, flags);
        mode = (mode_t)va_arg(ap, int);
        va_end(ap);
    }
    return shelly_openat_impl(dirfd, path, flags, mode);
}

ssize_t readlink(const char *path, char *buf, size_t bufsiz) {
    char socket_buf[SOCKET_MAP_BUF_SIZE];
    const char *p;
    long n;
    ssize_t codex = readlink_codex_self(path, buf, bufsiz);
    if (codex != -2) return codex;
    p = socket_root_path_arg(path, socket_buf, sizeof(socket_buf));
    if (path && !p) return -1;
    n = raw_readlinkat_call(AT_FDCWD, p, buf, bufsiz);
    if (n > 0 && !starts_with(path, "/proc/")) n = unmap_termux_socket_link(buf, bufsiz, n);
    return finish_syscall_ssize(n);
}

ssize_t readlinkat(int dirfd, const char *path, char *buf, size_t bufsiz) {
    char socket_buf[SOCKET_MAP_BUF_SIZE];
    const char *p = path;
    long n;
    if (path && path[0] == '/') {
        ssize_t codex = readlink_codex_self(path, buf, bufsiz);
        if (codex != -2) return codex;
        p = socket_root_path_arg(path, socket_buf, sizeof(socket_buf));
        if (!p) return -1;
    }
    n = raw_readlinkat_call(dirfd, p, buf, bufsiz);
    if (n > 0 && !starts_with(path, "/proc/")) n = unmap_termux_socket_link(buf, bufsiz, n);
    return finish_syscall_ssize(n);
}

/* ---- v224 Termux socket-root redirect: libc interposers (see above) ----
 * The stat-buffer / sockaddr parameters are declared `void *` on purpose:
 * this file does not include <sys/stat.h>, <sys/socket.h>, <fcntl.h> or
 * <stdlib.h>, so there is no header prototype to match. Adding one of those
 * includes later will make these definitions conflict; keep them out. */

typedef char *(*realpath_fn_t)(const char *, char *);
typedef void *(*malloc_fn_t)(size_t);
typedef int (*path_buf_fn_t)(const char *, void *);
typedef int (*dirfd_path_buf_flags_fn_t)(int, const char *, void *, int);
typedef int (*path_mode_fn_t)(const char *, mode_t);
typedef int (*dirfd_path_mode_fn_t)(int, const char *, mode_t);
typedef int (*dirfd_path_mode_flags_fn_t)(int, const char *, mode_t, int);
typedef int (*path_fn_t)(const char *);
typedef int (*dirfd_path_flags_fn_t)(int, const char *, int);
typedef int (*path_path_fn_t)(const char *, const char *);
typedef int (*path_dirfd_path_fn_t)(const char *, int, const char *);
typedef int (*sock_addr_fn_t)(int, const void *, int);

/* Copies a realpath() answer into the caller's buffer, or into memory from
 * the allocator the caller's free() binds to (RTLD_DEFAULT, so a main
 * executable that exports its own malloc/free gets its own allocator). */
static char *realpath_result(const char *s, char *resolved) {
    size_t n = str_len(s);
    char *out = resolved;
    if (n + 1 > SHELLY_REALPATH_MAX) {
        publish_syscall_errno(-SHELLY_ENAMETOOLONG);
        return NULL;
    }
    if (!out) {
        malloc_fn_t alloc = (malloc_fn_t)g_real_malloc_fn;
        if (!alloc) {
            alloc = (malloc_fn_t)dlsym(RTLD_DEFAULT, "malloc");
            g_real_malloc_fn = (void *)alloc;
        }
        out = alloc ? (char *)alloc(n + 1) : NULL;
        if (!out) {
            publish_syscall_errno(-SHELLY_ENOMEM);
            return NULL;
        }
    }
    for (size_t i = 0; i <= n; i++) out[i] = s[i];
    return out;
}

/* Under the virtual dir: resolve the mapped path for real (existence and
 * symlink semantics preserved), then report it virtually. Kept out of
 * realpath() itself so the ~13 KB of buffers only land on the stack for
 * the rare virtual path. */
__attribute__((noinline))
static char *realpath_virtual(const char *path, char *resolved, realpath_fn_t fn) {
    {
        char mapped[SOCKET_MAP_BUF_SIZE];
        char real_dir[SOCKET_MAP_BUF_SIZE];
        char canon_dir[SHELLY_REALPATH_MAX];
        char canon[SHELLY_REALPATH_MAX];
        char virt[SHELLY_REALPATH_MAX];
        size_t dlen;
        size_t n = 0;
        int vlen;
        if (map_termux_socket_path(path, mapped, sizeof(mapped)) <= 0 ||
            shelly_socket_real_dir(real_dir, sizeof(real_dir)) <= 0) {
            publish_syscall_errno(-SHELLY_ENAMETOOLONG);
            return NULL;
        }
        if (!fn) {
            publish_syscall_errno(-SHELLY_ENOSYS);
            return NULL;
        }
        if (!fn(mapped, canon)) return NULL;
        if (!fn(real_dir, canon_dir)) return NULL;
        dlen = str_len(canon_dir);
        if (!starts_with(canon, canon_dir) || (canon[dlen] != '\0' && canon[dlen] != '/')) {
            /* Resolved outside the socket dir (a symlink pointing away). */
            return realpath_result(canon, resolved);
        }
        vlen = termux_socket_virtual_dir(virt, sizeof(virt));
        if (vlen <= 0) {
            publish_syscall_errno(-SHELLY_ENAMETOOLONG);
            return NULL;
        }
        n = (size_t)vlen;
        if (append_str(virt, sizeof(virt), &n, canon + dlen) != 0) {
            publish_syscall_errno(-SHELLY_ENAMETOOLONG);
            return NULL;
        }
        return realpath_result(virt, resolved);
    }
}

char *realpath(const char *path, char *resolved) {
    realpath_fn_t fn = (realpath_fn_t)real_sym(&g_real_realpath_fn, "realpath");
    if (path && streq(path, TERMUX_SOCKET_ROOT)) {
        /* The bare root: answered as-is so fs::canonicalize() succeeds and
         * Codex keeps building virtual paths under it. */
        return realpath_result(path, resolved);
    }
    if (path && termux_socket_virtual_match(path)) return realpath_virtual(path, resolved, fn);
    if (!fn) {
        publish_syscall_errno(-SHELLY_ENOSYS);
        return NULL;
    }
    return fn(path, resolved);
}

int stat(const char *path, void *st) {
    char buf[SOCKET_MAP_BUF_SIZE];
    const char *p = socket_root_path_arg(path, buf, sizeof(buf));
    path_buf_fn_t fn = (path_buf_fn_t)real_sym(&g_real_stat_fn, "stat");
    if (path && !p) return -1;
    if (!fn) return finish_syscall(-SHELLY_ENOSYS);
    return fn(p, st);
}

int lstat(const char *path, void *st) {
    char buf[SOCKET_MAP_BUF_SIZE];
    const char *p = socket_root_path_arg(path, buf, sizeof(buf));
    path_buf_fn_t fn = (path_buf_fn_t)real_sym(&g_real_lstat_fn, "lstat");
    if (path && !p) return -1;
    if (!fn) return finish_syscall(-SHELLY_ENOSYS);
    return fn(p, st);
}

int fstatat(int dirfd, const char *path, void *st, int flags) {
    char buf[SOCKET_MAP_BUF_SIZE];
    const char *p = socket_root_path_arg(path, buf, sizeof(buf));
    dirfd_path_buf_flags_fn_t fn = (dirfd_path_buf_flags_fn_t)real_sym(&g_real_fstatat_fn, "fstatat");
    if (path && !p) return -1;
    if (!fn) return finish_syscall(-SHELLY_ENOSYS);
    return fn(dirfd, p, st, flags);
}

/* stat64/lstat64: bionic exports these as separate alias symbols; codex-termux
 * 0.162.1 imports the plain names, but other Rust/NDK builds use these. */
int stat64(const char *path, void *st) {
    char buf[SOCKET_MAP_BUF_SIZE];
    const char *p = socket_root_path_arg(path, buf, sizeof(buf));
    path_buf_fn_t fn = (path_buf_fn_t)real_sym(&g_real_stat64_fn, "stat64");
    if (!fn) fn = (path_buf_fn_t)real_sym(&g_real_stat_fn, "stat");
    if (path && !p) return -1;
    if (!fn) return finish_syscall(-SHELLY_ENOSYS);
    return fn(p, st);
}

int lstat64(const char *path, void *st) {
    char buf[SOCKET_MAP_BUF_SIZE];
    const char *p = socket_root_path_arg(path, buf, sizeof(buf));
    path_buf_fn_t fn = (path_buf_fn_t)real_sym(&g_real_lstat64_fn, "lstat64");
    if (!fn) fn = (path_buf_fn_t)real_sym(&g_real_lstat_fn, "lstat");
    if (path && !p) return -1;
    if (!fn) return finish_syscall(-SHELLY_ENOSYS);
    return fn(p, st);
}

int fstatat64(int dirfd, const char *path, void *st, int flags) {
    char buf[SOCKET_MAP_BUF_SIZE];
    const char *p = socket_root_path_arg(path, buf, sizeof(buf));
    dirfd_path_buf_flags_fn_t fn = (dirfd_path_buf_flags_fn_t)real_sym(&g_real_fstatat64_fn, "fstatat64");
    if (!fn) fn = (dirfd_path_buf_flags_fn_t)real_sym(&g_real_fstatat_fn, "fstatat");
    if (path && !p) return -1;
    if (!fn) return finish_syscall(-SHELLY_ENOSYS);
    return fn(dirfd, p, st, flags);
}

int mkdir(const char *path, mode_t mode) {
    char buf[SOCKET_MAP_BUF_SIZE];
    const char *p = socket_root_path_arg(path, buf, sizeof(buf));
    path_mode_fn_t fn = (path_mode_fn_t)real_sym(&g_real_mkdir_fn, "mkdir");
    if (path && !p) return -1;
    if (!fn) return finish_syscall(-SHELLY_ENOSYS);
    return fn(p, mode);
}

int mkdirat(int dirfd, const char *path, mode_t mode) {
    char buf[SOCKET_MAP_BUF_SIZE];
    const char *p = socket_root_path_arg(path, buf, sizeof(buf));
    dirfd_path_mode_fn_t fn = (dirfd_path_mode_fn_t)real_sym(&g_real_mkdirat_fn, "mkdirat");
    if (path && !p) return -1;
    if (!fn) return finish_syscall(-SHELLY_ENOSYS);
    return fn(dirfd, p, mode);
}

int unlink(const char *path) {
    char buf[SOCKET_MAP_BUF_SIZE];
    const char *p = socket_root_path_arg(path, buf, sizeof(buf));
    path_fn_t fn = (path_fn_t)real_sym(&g_real_unlink_fn, "unlink");
    if (path && !p) return -1;
    if (!fn) return finish_syscall(-SHELLY_ENOSYS);
    return fn(p);
}

int unlinkat(int dirfd, const char *path, int flags) {
    char buf[SOCKET_MAP_BUF_SIZE];
    const char *p = socket_root_path_arg(path, buf, sizeof(buf));
    dirfd_path_flags_fn_t fn = (dirfd_path_flags_fn_t)real_sym(&g_real_unlinkat_fn, "unlinkat");
    if (path && !p) return -1;
    if (!fn) return finish_syscall(-SHELLY_ENOSYS);
    return fn(dirfd, p, flags);
}

int rmdir(const char *path) {
    char buf[SOCKET_MAP_BUF_SIZE];
    const char *p = socket_root_path_arg(path, buf, sizeof(buf));
    path_fn_t fn = (path_fn_t)real_sym(&g_real_rmdir_fn, "rmdir");
    if (path && !p) return -1;
    if (!fn) return finish_syscall(-SHELLY_ENOSYS);
    return fn(p);
}

int chmod(const char *path, mode_t mode) {
    char buf[SOCKET_MAP_BUF_SIZE];
    const char *p = socket_root_path_arg(path, buf, sizeof(buf));
    path_mode_fn_t fn = (path_mode_fn_t)real_sym(&g_real_chmod_fn, "chmod");
    if (path && !p) return -1;
    if (!fn) return finish_syscall(-SHELLY_ENOSYS);
    return fn(p, mode);
}

int fchmodat(int dirfd, const char *path, mode_t mode, int flags) {
    char buf[SOCKET_MAP_BUF_SIZE];
    const char *p = socket_root_path_arg(path, buf, sizeof(buf));
    dirfd_path_mode_flags_fn_t fn = (dirfd_path_mode_flags_fn_t)real_sym(&g_real_fchmodat_fn, "fchmodat");
    if (path && !p) return -1;
    if (!fn) return finish_syscall(-SHELLY_ENOSYS);
    return fn(dirfd, p, mode, flags);
}

int symlink(const char *target, const char *linkpath) {
    char target_buf[SOCKET_MAP_BUF_SIZE];
    char link_buf[SOCKET_MAP_BUF_SIZE];
    const char *t = socket_root_path_arg(target, target_buf, sizeof(target_buf));
    const char *l = socket_root_path_arg(linkpath, link_buf, sizeof(link_buf));
    path_path_fn_t fn = (path_path_fn_t)real_sym(&g_real_symlink_fn, "symlink");
    if ((target && !t) || (linkpath && !l)) return -1;
    if (!fn) return finish_syscall(-SHELLY_ENOSYS);
    return fn(t, l);
}

int symlinkat(const char *target, int dirfd, const char *linkpath) {
    char target_buf[SOCKET_MAP_BUF_SIZE];
    char link_buf[SOCKET_MAP_BUF_SIZE];
    const char *t = socket_root_path_arg(target, target_buf, sizeof(target_buf));
    const char *l = socket_root_path_arg(linkpath, link_buf, sizeof(link_buf));
    path_dirfd_path_fn_t fn = (path_dirfd_path_fn_t)real_sym(&g_real_symlinkat_fn, "symlinkat");
    if ((target && !t) || (linkpath && !l)) return -1;
    if (!fn) return finish_syscall(-SHELLY_ENOSYS);
    return fn(t, dirfd, l);
}

int bind(int fd, const void *addr, int len) {
    struct shelly_sockaddr_un mapped;
    int mapped_len = 0;
    sock_addr_fn_t fn = (sock_addr_fn_t)real_sym(&g_real_bind_fn, "bind");
    int m = map_unix_sockaddr(addr, len, &mapped, &mapped_len);
    if (m < 0) return -1;
    if (!fn) return finish_syscall(-SHELLY_ENOSYS);
    if (m > 0) return fn(fd, &mapped, mapped_len);
    return fn(fd, addr, len);
}

int connect(int fd, const void *addr, int len) {
    struct shelly_sockaddr_un mapped;
    int mapped_len = 0;
    sock_addr_fn_t fn = (sock_addr_fn_t)real_sym(&g_real_connect_fn, "connect");
    int m = map_unix_sockaddr(addr, len, &mapped, &mapped_len);
    if (m < 0) return -1;
    if (!fn) return finish_syscall(-SHELLY_ENOSYS);
    if (m > 0) return fn(fd, &mapped, mapped_len);
    return fn(fd, addr, len);
}

/* v225 (2026-10-13): a readable host name for `codex remote-control`.
 *
 * The ChatGPT app lists a remote-control host under the name Codex enrolls it
 * with, and Codex has no option for it: codex-rs/app-server-transport
 * (remote_control/controller.rs) uses gethostname() verbatim, sends it at
 * enrollment and again (base64, x-codex-name) on every websocket connect.
 * Android's kernel hostname is "localhost", and an app cannot sethostname().
 *
 * `shelly codex pair` exports SHELLY_CODEX_HOST_NAME (e.g. "Shelly (SM-F956Q)")
 * for the remote-control launch only. When that variable is present in the
 * process's exec-time environment (/proc/self/environ -- never the live
 * environ) and is 1..63 printable bytes, AND the process is the Codex binary
 * itself (self_is_codex), gethostname() returns it; otherwise, or when it does
 * not fit the caller's buffer, the call goes to libc unchanged. The tool
 * commands Codex runs (bash, git, node, ssh) inherit the variable but are not
 * Codex, so they keep the real host name. codex-termux 0.162.1 imports gethostname from
 * libc.so (checked against the release binary's dynamic symbol table). */
__attribute__((used, retain))
static const char shelly_exec_wrapper_v225_marker[] =
    "shelly-exec-wrapper:v225:codex-remote-host-name";

#define SHELLY_CODEX_HOST_NAME_ENV "SHELLY_CODEX_HOST_NAME="
#define SHELLY_CODEX_HOST_NAME_MAX 64

typedef int (*gethostname_fn_t)(char *, size_t);

/* 1: a usable override is in out; 0: none (absent, empty, too long, or
 * containing control bytes). */
static int codex_host_name_override(char *out, size_t out_size) {
    size_t n;
    if (proc_environ_value_copy(SHELLY_CODEX_HOST_NAME_ENV, out, out_size) != 0) return 0;
    n = str_len(out);
    /* proc_environ_value_copy truncates to out_size - 1; a value that long
     * is treated as too long rather than silently cut. */
    if (n == 0 || n >= SHELLY_CODEX_HOST_NAME_MAX || n + 1 >= out_size) return 0;
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)out[i];
        if (c < 0x20 || c == 0x7f) return 0;
    }
    return 1;
}

static const char *path_basename(const char *p) {
    const char *b = p;
    for (; *p; p++) {
        if (*p == '/') b = p + 1;
    }
    return b;
}

/* 1 only in the Codex process itself, never in the bash/git/node/ssh
 * children it runs (which inherit SHELLY_CODEX_HOST_NAME too and must keep
 * the real host name: git's gc.pid host check, user@host fallback email...).
 * The program is argv[0], or argv[1] when argv[0] is the linker (`linker64
 * <app-data ELF>`, how Shelly launches everything); it is Codex when it is
 * SHELLY_CODEX_EXEC_PATH or named codex_tui. Reads /proc/self/cmdline and
 * /proc/self/environ with raw syscalls only. */
static int self_is_codex(void) {
    char cmd[1024];
    char exec_path[SOCKET_MAP_BUF_SIZE];
    const char *prog;
    const char *base;
    long n = 0;
    long r;
    int fd = raw_open_readonly("/proc/self/cmdline");
    if (fd < 0) return 0;
    while (n < (long)sizeof(cmd) - 1) {
        r = raw_read_call(fd, cmd + n, sizeof(cmd) - 1 - (size_t)n);
        if (r == -SHELLY_EINTR) continue;
        if (r <= 0) break;
        n += r;
    }
    raw_close_call(fd);
    if (n <= 0) return 0;
    cmd[n] = '\0';
    prog = cmd;
    base = path_basename(prog);
    if (streq(base, "linker64") || streq(base, "linker")) {
        long first = (long)str_len(cmd) + 1;
        if (first >= n) return 0;
        prog = cmd + first;
        base = path_basename(prog);
    }
    if (streq(base, "codex_tui")) return 1;
    return proc_environ_value_copy("SHELLY_CODEX_EXEC_PATH=", exec_path, sizeof(exec_path)) == 0 &&
           exec_path[0] == '/' && streq(prog, exec_path);
}

int gethostname(char *name, size_t len) {
    char override[SHELLY_CODEX_HOST_NAME_MAX + 1];
    gethostname_fn_t fn = (gethostname_fn_t)real_sym(&g_real_gethostname_fn, "gethostname");
    if (name && codex_host_name_override(override, sizeof(override)) && self_is_codex()) {
        size_t n = str_len(override);
        if (n < len) {
            for (size_t i = 0; i <= n; i++) name[i] = override[i];
            return 0;
        }
    }
    if (!fn) return finish_syscall(-SHELLY_ENOSYS);
    return fn(name, len);
}
