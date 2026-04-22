/*
 * shelly-shell-launcher.c
 *
 * Small executable launcher used as $SHELL for tools that spawn their own
 * shell outside Shelly's interactive bash functions, notably Claude Code's
 * Bash tool. It lives in the APK nativeLibraryDir, which Android allows to
 * execute directly, then jumps through linker64 to the extracted bash binary
 * in app files and injects Shelly's bionic exec wrapper for bash children.
 */

#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define LINKER64 "/system/bin/linker64"

static const char *lib_dir_from_env(void) {
    const char *from_env = getenv("SHELLY_LIB_DIR");
    if (from_env && from_env[0]) return from_env;

    const char *home = getenv("HOME");
    if (!home || !home[0]) return NULL;

    static char fallback[PATH_MAX];
    snprintf(fallback, sizeof(fallback), "%s/../termux-libs", home);
    return fallback;
}

static char **copy_env_with_preload(char *const envp[], const char *lib_dir) {
    size_t count = 0;
    int saw_preload = 0;
    for (; envp && envp[count]; count++) {
        if (strncmp(envp[count], "LD_PRELOAD=", 11) == 0) saw_preload = 1;
    }

    char preload[PATH_MAX + 32];
    snprintf(preload, sizeof(preload), "LD_PRELOAD=%s/libexec_wrapper.so", lib_dir);

    char **out = calloc(count + (saw_preload ? 1 : 2), sizeof(char *));
    if (!out) return NULL;

    size_t j = 0;
    for (size_t i = 0; i < count; i++) {
        if (strncmp(envp[i], "LD_PRELOAD=", 11) == 0) {
            out[j++] = strdup(preload);
        } else {
            out[j++] = envp[i];
        }
    }
    if (!saw_preload) out[j++] = strdup(preload);
    out[j] = NULL;
    return out;
}

int main(int argc, char **argv, char **envp) {
    const char *lib_dir = lib_dir_from_env();
    if (!lib_dir) {
        fprintf(stderr, "shelly-shell-launcher: SHELLY_LIB_DIR/HOME missing\n");
        return 127;
    }

    char bash_path[PATH_MAX];
    snprintf(bash_path, sizeof(bash_path), "%s/libbash.so", lib_dir);

    char **new_argv = calloc((size_t)argc + 2, sizeof(char *));
    if (!new_argv) {
        perror("shelly-shell-launcher: calloc argv");
        return 127;
    }

    new_argv[0] = (char *)LINKER64;
    new_argv[1] = bash_path;
    for (int i = 1; i < argc; i++) {
        new_argv[i + 1] = argv[i];
    }
    new_argv[argc + 1] = NULL;

    char **new_env = copy_env_with_preload(envp, lib_dir);
    if (!new_env) {
        perror("shelly-shell-launcher: calloc env");
        return 127;
    }

    execve(LINKER64, new_argv, new_env);
    fprintf(stderr, "shelly-shell-launcher: execve(%s): %s\n", LINKER64, strerror(errno));
    return 127;
}
