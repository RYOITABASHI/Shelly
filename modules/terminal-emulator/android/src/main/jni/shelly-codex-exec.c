/*
 * shelly-codex-exec.c
 *
 * `codex_exec`: a native entry point that runs `codex exec "$@"` for callers
 * that cannot use the interactive codex() bash function -- above all
 * council-facade, whose node process spawns COUNCIL_CODEX_COMMAND=codex_exec
 * directly (child_process.spawn, no shell). Shipped as jniLibs
 * libshelly_codex_exec.so and extracted by LibExtractor as
 * `$SHELLY_LIB_DIR/codex_exec` (ALWAYS_REFRESH; the supervisor puts that dir
 * first on the facade's PATH). The name was the separate pre-0.142.2 Codex
 * `exec` binary; the refresh overwrites any stale copy of it with this
 * launcher, which runs the unified `codex_tui exec`.
 *
 * Which Codex: the same rule as the agent driver (scripts/shelly-agent-driver.js
 * resolveAndroidCodexTui / runtimeCodexTuiPath): the reviewed app-data runtime
 * `$HOME/.shelly-runtime/codex/agent-current` when it is healthy (`.healthy`,
 * `manifest.json` and `codex_tui` all present), else the APK-bundled
 * `$SHELLY_LIB_DIR/codex_tui`. Never `current` (the TUI channel), never a
 * caller-supplied path (no SHELLY_CODEX_TUI_PATH override here).
 *
 * How: the same recipe as the driver's codexAppServerSpawnSpec and
 * HomeInitializer's __shelly_codex_run_tui --
 *   SHELLY_CODEX_EXEC_PATH=<codex_tui> SHELLY_CODEX_PROC_EXE_SHIM=1
 *   SHELLY_CODEX_PROC_EXE_OPEN_SHIM=1 LD_PRELOAD=$lib/libexec_wrapper.so
 *   LD_LIBRARY_PATH=<codex dir>:$lib
 *   /system/bin/linker64 <codex_tui> [-c policy...] -c features.shell_snapshot=false exec "$@"
 * The final exec is a raw execve syscall so it never depends on (or is
 * altered by) an LD_PRELOAD loaded in this process.
 *
 * Exec notes (as shelly-cmd.c): an app-data ELF is only directly executable
 * through libexec_wrapper.so (which rewrites the execve to
 * `linker64 /proc/self/fd/N`), so argv[0] may be `/proc/self/fd/N` and
 * /proc/self/exe may be linker64. The lib dir comes only from this binary's
 * own location (the wrapper's /proc/self/fd/N, else /proc/self/exe, else the
 * fixed package path), and only when its real path is an app's
 * files/termux-libs holding this launcher (codex_exec) and codex_tui; HOME is derived as
 * its sibling. The caller's SHELLY_LIB_DIR / HOME are never read, so the
 * environment cannot choose codex_tui, libexec_wrapper.so or agent-current.
 * SHELLY_DISABLE_APP_DATA_CODEX_RUNTIME=1 (as in the driver) can only fall
 * back to the APK-bundled codex_tui.
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
#define AGENT_CURRENT_REL "/.shelly-runtime/codex/agent-current"

__attribute__((used, retain))
static const char shelly_codex_exec_marker[] = "shelly-codex-exec:v1:agent-current-or-bundled";

static int is_file(const char *p) {
    struct stat st;
    return p && stat(p, &st) == 0 && S_ISREG(st.st_mode);
}

static int has_codex(const char *lib_dir) {
    char p[PATH_MAX];
    if (!lib_dir || lib_dir[0] != '/') return 0;
    if (snprintf(p, sizeof(p), "%s/codex_tui", lib_dir) >= (int)sizeof(p)) return 0;
    return is_file(p) && access(p, R_OK) == 0;
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
 * holding this launcher itself and codex_tui. The caller's environment never
 * chooses it (no SHELLY_LIB_DIR / HOME lookup): what runs is decided only by
 * where this binary is, so the env cannot steer codex_tui, libexec_wrapper.so
 * or agent-current to another file.
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
    char self[PATH_MAX];
    if (snprintf(self, sizeof(self), "%s/codex_exec", dir) >= (int)sizeof(self)) return 0;
    return is_file(self) && has_codex(dir);
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
    /* Launched through libexec_wrapper.so: argv[0] is /proc/self/fd/N, an fd
     * the wrapper opened on this binary inside $libDir. */
    if (argv0 && strncmp(argv0, "/proc/self/fd/", 14) == 0 &&
        lib_dir_from_link(argv0, buf, sizeof(buf)) == 0) {
        return buf;
    }
    /* Direct exec: the kernel's own record of this executable. */
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

/* The agent driver's choice: healthy agent-current, else the bundled codex_tui. */
static int resolve_codex(const char *home, const char *lib_dir, char *out, size_t out_size) {
    const char *disable = getenv("SHELLY_DISABLE_APP_DATA_CODEX_RUNTIME");
    if (!(disable && strcmp(disable, "1") == 0)) {
        char link[PATH_MAX];
        char real[PATH_MAX];
        if (snprintf(link, sizeof(link), "%s%s", home, AGENT_CURRENT_REL) < (int)sizeof(link) &&
            realpath(link, real) != NULL) {
            char healthy[PATH_MAX], manifest[PATH_MAX], tui[PATH_MAX];
            if (snprintf(healthy, sizeof(healthy), "%s/.healthy", real) < (int)sizeof(healthy) &&
                snprintf(manifest, sizeof(manifest), "%s/manifest.json", real) < (int)sizeof(manifest) &&
                snprintf(tui, sizeof(tui), "%s/codex_tui", real) < (int)sizeof(tui) &&
                access(healthy, F_OK) == 0 && access(manifest, F_OK) == 0 && is_file(tui)) {
                if (snprintf(out, out_size, "%s", tui) < (int)out_size) return 0;
            }
        }
    }
    if (snprintf(out, out_size, "%s/codex_tui", lib_dir) >= (int)out_size) return -1;
    return 0;
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

/* Same filter as the driver's codexPolicyEnvArgs: no quote, backslash or control byte. */
static int policy_value_ok(const char *v) {
    if (!v || !*v) return 0;
    for (const unsigned char *p = (const unsigned char *)v; *p; p++) {
        if (*p == '"' || *p == '\\' || *p < 0x20 || *p == 0x7f) return 0;
    }
    return 1;
}

static const char *const POLICY_KEYS[] = { "PYTHONHOME", "PYTHONPATH", "TZ", "ANDROID_ROOT", "ANDROID_DATA" };
#define POLICY_KEY_COUNT (sizeof(POLICY_KEYS) / sizeof(POLICY_KEYS[0]))

/* Value of key in the env array being built (NULL if absent). */
static const char *env_get(char **env, size_t n, const char *key) {
    size_t k = strlen(key);
    for (size_t i = 0; i < n; i++) {
        if (env[i] && strncmp(env[i], key, k) == 0 && env[i][k] == '=') return env[i] + k + 1;
    }
    return NULL;
}

int main(int argc, char **argv, char **envp) {
    (void)shelly_codex_exec_marker;
    const char *lib_dir = resolve_lib_dir(argc > 0 ? argv[0] : NULL);
    if (!lib_dir) {
        fprintf(stderr, "codex_exec: cannot locate Shelly's bundled codex_tui (SHELLY_LIB_DIR); open a Shelly terminal tab once\n");
        return 127;
    }
    const char *home = resolve_home(lib_dir);
    if (!home) {
        fprintf(stderr, "codex_exec: cannot determine HOME\n");
        return 127;
    }
    char codex[PATH_MAX];
    char codex_dir[PATH_MAX];
    char preload[PATH_MAX];
    char ld_path[PATH_MAX * 2 + 2];
    if (resolve_codex(home, lib_dir, codex, sizeof(codex)) != 0 ||
        snprintf(codex_dir, sizeof(codex_dir), "%s", codex) >= (int)sizeof(codex_dir) ||
        to_dirname(codex_dir) != 0 ||
        snprintf(preload, sizeof(preload), "%s/libexec_wrapper.so", lib_dir) >= (int)sizeof(preload) ||
        snprintf(ld_path, sizeof(ld_path), "%s:%s", codex_dir, lib_dir) >= (int)sizeof(ld_path)) {
        fprintf(stderr, "codex_exec: path too long\n");
        return 127;
    }
    if (!is_file(codex)) {
        fprintf(stderr, "codex_exec: %s is missing\n", codex);
        return 127;
    }

    size_t count = 0;
    while (envp && envp[count]) count++;
    /* + 6 codex vars, HOME, TMPDIR, PATH, ANDROID_ROOT, ANDROID_DATA, NULL */
    char **env = calloc(count + 12, sizeof(char *));
    if (!env) {
        perror("codex_exec: calloc env");
        return 127;
    }
    size_t j = 0;
    int have_tmpdir = 0, have_path = 0, have_root = 0, have_data = 0;
    for (size_t i = 0; i < count; i++) {
        const char *e = envp[i];
        if (env_is(e, "LD_PRELOAD") || env_is(e, "LD_LIBRARY_PATH") || env_is(e, "SHELLY_LIB_DIR") ||
            env_is(e, "SHELLY_CODEX_EXEC_PATH") || env_is(e, "SHELLY_CODEX_PROC_EXE_SHIM") ||
            env_is(e, "SHELLY_CODEX_PROC_EXE_OPEN_SHIM")) {
            continue;
        }
        if (env_is(e, "HOME")) continue; /* always the derived home, set below */
        if (env_is(e, "TMPDIR") && e[7]) have_tmpdir = 1;
        if (env_is(e, "PATH") && e[5]) have_path = 1;
        if (env_is(e, "ANDROID_ROOT") && e[13]) have_root = 1;
        if (env_is(e, "ANDROID_DATA") && e[13]) have_data = 1;
        env[j++] = envp[i];
    }
    env[j++] = make_kv("SHELLY_LIB_DIR", lib_dir);
    env[j++] = make_kv("SHELLY_CODEX_EXEC_PATH", codex);
    env[j++] = make_kv("SHELLY_CODEX_PROC_EXE_SHIM", "1");
    env[j++] = make_kv("SHELLY_CODEX_PROC_EXE_OPEN_SHIM", "1");
    env[j++] = make_kv("LD_PRELOAD", preload);
    env[j++] = make_kv("LD_LIBRARY_PATH", ld_path);
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
    /* chrono (Codex's clock) finds Android tzdata only via these (BASHRC_VERSION 247). */
    if (!have_root) env[j++] = make_kv("ANDROID_ROOT", "/system");
    if (!have_data) env[j++] = make_kv("ANDROID_DATA", "/data");
    env[j] = NULL;
    for (size_t i = 0; i < j; i++) {
        if (!env[i]) {
            perror("codex_exec: malloc env");
            return 127;
        }
    }

    /* linker64 codex [-c policy]* [-c features.shell_snapshot=false] exec args... NULL */
    char **args = calloc((size_t)(argc > 0 ? argc : 1) + 2 * POLICY_KEY_COUNT + 6, sizeof(char *));
    if (!args) {
        perror("codex_exec: calloc argv");
        return 127;
    }
    size_t k = 0;
    args[k++] = (char *)LINKER64;
    args[k++] = codex;
    for (size_t p = 0; p < POLICY_KEY_COUNT; p++) {
        const char *v = env_get(env, j, POLICY_KEYS[p]);
        if (!policy_value_ok(v)) continue;
        size_t n = strlen(POLICY_KEYS[p]) + strlen(v) + 40;
        char *c = malloc(n);
        if (!c) {
            perror("codex_exec: malloc policy");
            return 127;
        }
        snprintf(c, n, "shell_environment_policy.set.%s=\"%s\"", POLICY_KEYS[p], v);
        args[k++] = (char *)"-c";
        args[k++] = c;
    }
    /* Codex's shell snapshot does not work under the linker64/libexec_wrapper
     * exec chain on Android (BASHRC_VERSION 249); same default as the driver. */
    const char *snap = env_get(env, j, "SHELLY_CODEX_SHELL_SNAPSHOT");
    if (!(snap && strcmp(snap, "1") == 0)) {
        args[k++] = (char *)"-c";
        args[k++] = (char *)"features.shell_snapshot=false";
    }
    args[k++] = (char *)"exec";
    for (int i = 1; i < argc; i++) args[k++] = argv[i];
    args[k] = NULL;

    syscall(SYS_execve, LINKER64, args, env);
    fprintf(stderr, "codex_exec: execve(%s): %s\n", LINKER64, strerror(errno));
    return 127;
}
