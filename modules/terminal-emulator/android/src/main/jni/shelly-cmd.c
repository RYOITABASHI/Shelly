/*
 * shelly-cmd.c
 *
 * PATH-visible `shelly` command (BASHRC_VERSION 255). HomeInitializer.kt
 * symlinks `$HOME/bin/shelly` -> `$SHELLY_LIB_DIR/shelly_cmd` (this binary,
 * shipped as jniLibs libshelly_cmd.so and extracted by LibExtractor).
 *
 * Why a native binary: until v254 `$HOME/bin/shelly` was a generated
 * `#!/system/bin/sh` script. Only the interactive bash `shelly()` function
 * could use it (it reads the file as a bash script argument through
 * linker64). Every other caller -- `bash script.sh` / `bash -c` launched
 * from the PTY (non-interactive bash never sources ~/.bashrc), `sh -c`,
 * node child_process -- execve()d the script and Knox denied it:
 *   .../home/bin/shelly: /system/bin/sh: bad interpreter: Permission denied
 * (CLAUDE.md: "PATH-visible shim は native binary 必須 (#! script 不可)").
 *
 * The generated helper script itself still exists, out of PATH, at
 * `$HOME/.shelly/shelly-helper.sh`; this binary only replays the interactive
 * route for it:
 *   /system/bin/linker64 $SHELLY_LIB_DIR/libbash.so $HOME/.shelly/shelly-helper.sh "$@"
 *
 * Exec notes:
 *   - An app-data ELF is only directly executable through libexec_wrapper.so
 *     (which rewrites the execve to `linker64 /proc/self/fd/N`); the shell
 *     functions bash()/sh() in ~/.bashrc preload it for script/-c runs.
 *     Because of that rewrite argv[0] is `/proc/self/fd/N` and
 *     /proc/self/exe is linker64, so this program never relies on its own
 *     name and resolves the lib dir from env / the fd link / a fallback.
 *   - The final exec is a raw execve syscall so it never depends on (or is
 *     altered by) an LD_PRELOAD that happens to be loaded in this process.
 *     LD_PRELOAD is dropped from the helper's env, matching the interactive
 *     shelly() route (the PTY shell never exports it). The helper's node
 *     body spawns no children.
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
#define HELPER_REL "/.shelly/shelly-helper.sh"

__attribute__((used, retain))
static const char shelly_cmd_marker[] = "shelly-cmd:v1:native-path-shim";

static int has_bash(const char *lib_dir) {
    char p[PATH_MAX];
    if (!lib_dir || lib_dir[0] != '/') return 0;
    if (snprintf(p, sizeof(p), "%s/libbash.so", lib_dir) >= (int)sizeof(p)) return 0;
    return access(p, R_OK) == 0;
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

static const char *resolve_lib_dir(const char *argv0) {
    static char buf[PATH_MAX];
    const char *env = getenv("SHELLY_LIB_DIR");
    if (env && has_bash(env)) return env;

    /* Launched through libexec_wrapper.so: argv[0] is /proc/self/fd/N, which
     * still links to this binary inside $SHELLY_LIB_DIR. */
    if (argv0 && strncmp(argv0, "/proc/self/fd/", 14) == 0 &&
        dir_of_link(argv0, buf, sizeof(buf)) == 0 && has_bash(buf)) {
        return buf;
    }
    /* Direct exec (kernel followed the $HOME/bin/shelly symlink). */
    if (dir_of_link("/proc/self/exe", buf, sizeof(buf)) == 0 && has_bash(buf)) return buf;

    const char *home = getenv("HOME");
    if (home && home[0] == '/' &&
        snprintf(buf, sizeof(buf), "%s/../termux-libs", home) < (int)sizeof(buf) &&
        has_bash(buf)) {
        return buf;
    }
    if (has_bash(DEFAULT_LIB_DIR)) return DEFAULT_LIB_DIR;
    return NULL;
}

static const char *resolve_home(const char *lib_dir) {
    static char buf[PATH_MAX];
    const char *home = getenv("HOME");
    if (home && home[0] == '/') return home;
    /* $libDir is <filesDir>/termux-libs, $HOME is <filesDir>/home. */
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

int main(int argc, char **argv, char **envp) {
    (void)shelly_cmd_marker;
    const char *lib_dir = resolve_lib_dir(argc > 0 ? argv[0] : NULL);
    if (!lib_dir) {
        fprintf(stderr, "shelly: cannot locate Shelly's bundled bash (SHELLY_LIB_DIR); open a Shelly terminal tab once\n");
        return 127;
    }
    const char *home = resolve_home(lib_dir);
    if (!home) {
        fprintf(stderr, "shelly: cannot determine HOME\n");
        return 127;
    }

    char bash_path[PATH_MAX];
    char helper_path[PATH_MAX];
    if (snprintf(bash_path, sizeof(bash_path), "%s/libbash.so", lib_dir) >= (int)sizeof(bash_path) ||
        snprintf(helper_path, sizeof(helper_path), "%s%s", home, HELPER_REL) >= (int)sizeof(helper_path)) {
        fprintf(stderr, "shelly: path too long\n");
        return 127;
    }
    struct stat st;
    if (stat(helper_path, &st) != 0 || st.st_size == 0) {
        fprintf(stderr, "shelly: helper %s is missing; open a new Shelly terminal tab to regenerate it\n", helper_path);
        return 127;
    }

    size_t count = 0;
    while (envp && envp[count]) count++;
    /* + LD_LIBRARY_PATH, SHELLY_LIB_DIR, HOME, TMPDIR, PATH, SHELLY_CALLER_PID, NULL */
    char **env = calloc(count + 7, sizeof(char *));
    if (!env) {
        perror("shelly: calloc env");
        return 127;
    }
    size_t j = 0;
    int have_home = 0, have_tmpdir = 0, have_path = 0, have_caller = 0;
    for (size_t i = 0; i < count; i++) {
        const char *e = envp[i];
        if (env_is(e, "LD_PRELOAD") || env_is(e, "LD_LIBRARY_PATH") || env_is(e, "SHELLY_LIB_DIR")) continue;
        if (env_is(e, "HOME")) {
            if (strcmp(e + 5, home) != 0) continue; /* replaced below */
            have_home = 1;
        }
        if (env_is(e, "TMPDIR") && e[7]) have_tmpdir = 1;
        if (env_is(e, "PATH") && e[5]) have_path = 1;
        if (env_is(e, "SHELLY_CALLER_PID") && e[18]) have_caller = 1;
        env[j++] = envp[i];
    }
    env[j++] = make_kv("LD_LIBRARY_PATH", lib_dir);
    env[j++] = make_kv("SHELLY_LIB_DIR", lib_dir);
    if (!have_home) env[j++] = make_kv("HOME", home);
    if (!have_tmpdir) {
        char tmp[PATH_MAX];
        snprintf(tmp, sizeof(tmp), "%s/.tmp", home);
        mkdir(tmp, 0700);
        env[j++] = make_kv("TMPDIR", tmp);
    }
    if (!have_path) {
        char path[PATH_MAX * 2 + 64];
        snprintf(path, sizeof(path), "%s/bin:%s:/system/bin:/vendor/bin", home, lib_dir);
        env[j++] = make_kv("PATH", path);
    }
    if (!have_caller) {
        /* `shelly teach` records the calling shell's PID; the interactive
         * shelly() function passes $$, here the parent is that shell. */
        char pid[32];
        snprintf(pid, sizeof(pid), "%d", (int)getppid());
        env[j++] = make_kv("SHELLY_CALLER_PID", pid);
    }
    env[j] = NULL;
    for (size_t i = 0; i < j; i++) {
        if (!env[i]) {
            perror("shelly: malloc env");
            return 127;
        }
    }

    char **args = calloc((size_t)(argc > 0 ? argc : 1) + 3, sizeof(char *));
    if (!args) {
        perror("shelly: calloc argv");
        return 127;
    }
    size_t k = 0;
    args[k++] = (char *)LINKER64;
    args[k++] = bash_path;
    args[k++] = helper_path;
    for (int i = 1; i < argc; i++) args[k++] = argv[i];
    args[k] = NULL;

    syscall(SYS_execve, LINKER64, args, env);
    fprintf(stderr, "shelly: execve(%s): %s\n", LINKER64, strerror(errno));
    return 127;
}
