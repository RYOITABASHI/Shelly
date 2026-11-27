/*
 * shelly-claude-exec.c
 *
 * `claude_exec`: the Claude Code counterpart of codex_exec. A native entry
 * point for callers that spawn Claude Code without a shell -- above all
 * council-facade, whose node process spawns COUNCIL_CLAUDE_COMMAND=claude_exec
 * directly (child_process.spawn, no shell; council-tool's claude preset adds
 * `-p`). Shipped as jniLibs libshelly_claude_exec.so and extracted by
 * LibExtractor as `$SHELLY_LIB_DIR/claude_exec` (ALWAYS_REFRESH; the
 * supervisor puts that dir first on the facade's PATH).
 *
 * Which Claude Code: the musl build staged in `$SHELLY_LIB_DIR/claude-musl/`
 * (`claude` = the official, UNMODIFIED @anthropic-ai/claude-code-linux-arm64-musl
 * binary, `ld-musl-aarch64.so.1` = Alpine's musl loader; Step 1 of the
 * on-device Claude Code bundle, shelly-hayato-bridge #6). Never a
 * caller-supplied path.
 *
 * How: it does not start claude itself. It runs the generated non-interactive
 * runner `$HOME/.shelly-claude-musl-run.sh` (HomeInitializer.claudeMuslRunnerScript,
 * rewritten on every start from the same generator as the glibc runner), in
 * Shelly's bash, so the private proxy, token, TMPDIR, CLAUDE_CODE_SHELL /
 * CLAUDE_ENV_FILE (Bash-tool re-exec) and Grep/Glob recipe is exactly the
 * one `shelly-claude-glibc()` uses. The runner ends in
 *   linker64 $lib/shelly_glibc_exec $lib/claude-musl/ld-musl-aarch64.so.1 \
 *     --library-path $lib/claude-musl $lib/claude-musl/claude "$@"
 * (a raw execve of an app_data_file is denied, and bionic's linker64 cannot
 * load musl's ld.so -- "Could not find a PHDR" -- so the ulexec loader maps it).
 *
 *   LD_PRELOAD=$lib/libexec_wrapper.so LD_LIBRARY_PATH=$lib
 *   /system/bin/linker64 $lib/libbash.so --noprofile --norc <runner> "$@"
 *
 * The final exec is a raw execve syscall so it never depends on (or is
 * altered by) an LD_PRELOAD loaded in this process.
 *
 * Exec notes (as codex_exec): an app-data ELF is only directly executable
 * through libexec_wrapper.so (which rewrites the execve to
 * `linker64 /proc/self/fd/N`), so argv[0] may be `/proc/self/fd/N` and
 * /proc/self/exe may be linker64. The lib dir comes only from this binary's
 * own location (the wrapper's /proc/self/fd/N, else /proc/self/exe, else the
 * fixed package path), and only when its real path is an app's
 * files/termux-libs holding this launcher (claude_exec) and libbash.so; HOME
 * is derived as its sibling. The caller's SHELLY_LIB_DIR / HOME are never
 * read, and the variables that would change what bash or the runner does
 * (BASH_ENV, ENV, the runner's own switches, CLAUDE_CODE_SHELL /
 * CLAUDE_ENV_FILE) are dropped, so the environment cannot choose the runner,
 * the binary or the recipe.
 */

#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#define LINKER64 "/system/bin/linker64"
#define DEFAULT_LIB_DIR "/data/user/0/dev.shelly.terminal/files/termux-libs"
#define RUNNER_REL "/.shelly-claude-musl-run.sh"

__attribute__((used, retain))
static const char shelly_claude_exec_marker[] = "shelly-claude-exec:v1:musl-runner";

static int is_file(const char *p) {
    struct stat st;
    return p && stat(p, &st) == 0 && S_ISREG(st.st_mode);
}

/* Strip the last path component in place; returns 0 on success. */
static int to_dirname(char *path) {
    char *slash = strrchr(path, '/');
    if (!slash || slash == path) return -1;
    *slash = '\0';
    return 0;
}

static int dir_of_link(const char *link, char *out, size_t out_size) {
    ssize_t len = readlink(link, out, out_size - 1);
    if (len <= 0 || (size_t)len >= out_size - 1) return -1;
    out[len] = '\0';
    return to_dirname(out);
}

/*
 * True only for the real path of an app's own lib dir:
 * /data/data/<pkg>/files/termux-libs or /data/user/<n>/<pkg>/files/termux-libs,
 * holding this launcher itself and libbash.so.
 */
static int is_app_lib_dir(const char *dir) {
    const char *rest;
    if (strncmp(dir, "/data/data/", 11) == 0) {
        rest = dir + 11;
    } else if (strncmp(dir, "/data/user/", 11) == 0) {
        rest = dir + 11;
        if (*rest < '0' || *rest > '9') return 0;
        while (*rest >= '0' && *rest <= '9') rest++;
        if (*rest++ != '/') return 0;
    } else {
        return 0;
    }
    const char *pkg = rest;
    while (*rest && *rest != '/') {
        char ch = *rest;
        if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '.' || ch == '_')) return 0;
        rest++;
    }
    if (rest == pkg || strcmp(rest, "/files/termux-libs") != 0) return 0;
    char self[PATH_MAX], bash[PATH_MAX];
    if (snprintf(self, sizeof(self), "%s/claude_exec", dir) >= (int)sizeof(self)) return 0;
    if (snprintf(bash, sizeof(bash), "%s/libbash.so", dir) >= (int)sizeof(bash)) return 0;
    return is_file(self) && is_file(bash);
}

/* realpath(dirname(link target)) into out when it is an app lib dir. */
static int lib_dir_from_link(const char *link, char *out, size_t out_size) {
    char dir[PATH_MAX];
    if (dir_of_link(link, dir, sizeof(dir)) != 0) return -1;
    char real[PATH_MAX];
    if (!realpath(dir, real) || !is_app_lib_dir(real)) return -1;
    if (snprintf(out, out_size, "%s", real) >= (int)out_size) return -1;
    return 0;
}

static const char *resolve_lib_dir(const char *argv0) {
    static char buf[PATH_MAX];
    if (argv0 && strncmp(argv0, "/proc/self/fd/", 14) == 0 &&
        lib_dir_from_link(argv0, buf, sizeof(buf)) == 0) {
        return buf;
    }
    if (lib_dir_from_link("/proc/self/exe", buf, sizeof(buf)) == 0) return buf;
    char real[PATH_MAX];
    if (realpath(DEFAULT_LIB_DIR, real) && is_app_lib_dir(real) &&
        snprintf(buf, sizeof(buf), "%s", real) < (int)sizeof(buf)) {
        return buf;
    }
    return NULL;
}

/* $libDir is <filesDir>/termux-libs, $HOME is <filesDir>/home (never the caller's HOME). */
static const char *resolve_home(const char *lib_dir) {
    static char buf[PATH_MAX];
    if (snprintf(buf, sizeof(buf), "%s", lib_dir) >= (int)sizeof(buf) || to_dirname(buf) != 0) return NULL;
    size_t n = strlen(buf);
    if (snprintf(buf + n, sizeof(buf) - n, "/home") >= (int)(sizeof(buf) - n)) return NULL;
    return buf;
}

static char *make_kv(const char *key, const char *value) {
    size_t n = strlen(key) + strlen(value) + 2;
    char *s = malloc(n);
    if (s) snprintf(s, n, "%s=%s", key, value);
    return s;
}

static int env_is(const char *entry, const char *key) {
    size_t n = strlen(key);
    return strncmp(entry, key, n) == 0 && entry[n] == '=';
}

/* Never passed through: they pick the loader / lib dir / HOME, make bash run
 * other code (BASH_ENV, ENV, SHELLOPTS, BASHOPTS), or switch the runner's
 * recipe (agent mode, settings override, Bash-tool shell and env file). */
static const char *const DROP_KEYS[] = {
    "LD_PRELOAD", "LD_LIBRARY_PATH", "SHELLY_LIB_DIR", "SHELLY_LD_LIBRARY_PATH", "HOME",
    "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "CDPATH", "PROMPT_COMMAND",
    "__SHELLY_CLAUDE_AGENT_RUN", "SHELLY_CLAUDE_AGENT_DIR", "SHELLY_CLAUDE_SETTINGS_JSON",
    "CLAUDE_CODE_SHELL", "CLAUDE_ENV_FILE",
};
#define DROP_KEY_COUNT (sizeof(DROP_KEYS) / sizeof(DROP_KEYS[0]))

static int dropped(const char *entry) {
    if (strncmp(entry, "BASH_FUNC_", 10) == 0) return 1; /* exported bash functions */
    for (size_t i = 0; i < DROP_KEY_COUNT; i++) {
        if (env_is(entry, DROP_KEYS[i])) return 1;
    }
    return 0;
}

int main(int argc, char **argv, char **envp) {
    (void)shelly_claude_exec_marker;
    const char *lib_dir = resolve_lib_dir(argc > 0 ? argv[0] : NULL);
    if (!lib_dir) {
        fprintf(stderr, "claude_exec: cannot locate Shelly's lib dir (SHELLY_LIB_DIR); open a Shelly terminal tab once\n");
        return 127;
    }
    const char *home = resolve_home(lib_dir);
    if (!home) {
        fprintf(stderr, "claude_exec: cannot determine HOME\n");
        return 127;
    }
    char bash[PATH_MAX];
    char runner[PATH_MAX];
    char claude[PATH_MAX];
    char preload[PATH_MAX];
    if (snprintf(bash, sizeof(bash), "%s/libbash.so", lib_dir) >= (int)sizeof(bash) ||
        snprintf(runner, sizeof(runner), "%s%s", home, RUNNER_REL) >= (int)sizeof(runner) ||
        snprintf(claude, sizeof(claude), "%s/claude-musl/claude", lib_dir) >= (int)sizeof(claude) ||
        snprintf(preload, sizeof(preload), "%s/libexec_wrapper.so", lib_dir) >= (int)sizeof(preload)) {
        fprintf(stderr, "claude_exec: path too long\n");
        return 127;
    }
    if (!is_file(runner)) {
        fprintf(stderr, "claude_exec: %s is missing (restart Shelly to regenerate it)\n", runner);
        return 127;
    }
    if (!is_file(claude)) {
        fprintf(stderr, "claude_exec: %s is missing (Claude Code musl is not staged)\n", claude);
        return 127;
    }

    size_t count = 0;
    while (envp && envp[count]) count++;
    /* + LD_PRELOAD, LD_LIBRARY_PATH, HOME, TMPDIR, PATH, ANDROID_ROOT, ANDROID_DATA, NULL */
    char **env = calloc(count + 8, sizeof(char *));
    if (!env) {
        perror("claude_exec: calloc env");
        return 127;
    }
    size_t j = 0;
    int have_tmpdir = 0, have_path = 0, have_root = 0, have_data = 0;
    for (size_t i = 0; i < count; i++) {
        const char *e = envp[i];
        if (dropped(e)) continue;
        if (env_is(e, "TMPDIR") && e[7]) have_tmpdir = 1;
        if (env_is(e, "PATH") && e[5]) have_path = 1;
        if (env_is(e, "ANDROID_ROOT") && e[13]) have_root = 1;
        if (env_is(e, "ANDROID_DATA") && e[13]) have_data = 1;
        env[j++] = envp[i];
    }
    env[j++] = make_kv("LD_PRELOAD", preload);
    env[j++] = make_kv("LD_LIBRARY_PATH", lib_dir);
    env[j++] = make_kv("HOME", home);
    if (!have_tmpdir) {
        char tmp[PATH_MAX];
        snprintf(tmp, sizeof(tmp), "%s/tmp", home);
        mkdir(tmp, 0700);
        env[j++] = make_kv("TMPDIR", tmp);
    }
    if (!have_path) {
        char path[PATH_MAX * 2 + 64];
        snprintf(path, sizeof(path), "%s/bin:%s:/system/bin:/vendor/bin", home, lib_dir);
        env[j++] = make_kv("PATH", path);
    }
    if (!have_root) env[j++] = make_kv("ANDROID_ROOT", "/system");
    if (!have_data) env[j++] = make_kv("ANDROID_DATA", "/data");
    env[j] = NULL;
    for (size_t i = 0; i < j; i++) {
        if (!env[i]) {
            perror("claude_exec: malloc env");
            return 127;
        }
    }

    /* linker64 libbash.so --noprofile --norc <runner> args... NULL */
    char **args = calloc((size_t)(argc > 0 ? argc : 1) + 6, sizeof(char *));
    if (!args) {
        perror("claude_exec: calloc argv");
        return 127;
    }
    size_t k = 0;
    args[k++] = (char *)LINKER64;
    args[k++] = bash;
    args[k++] = (char *)"--noprofile";
    args[k++] = (char *)"--norc";
    args[k++] = runner;
    for (int i = 1; i < argc; i++) args[k++] = argv[i];
    args[k] = NULL;

    syscall(SYS_execve, LINKER64, args, env);
    fprintf(stderr, "claude_exec: execve(%s): %s\n", LINKER64, strerror(errno));
    return 127;
}
