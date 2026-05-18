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

    static char exe_dir[PATH_MAX];
    ssize_t len = readlink("/proc/self/exe", exe_dir, sizeof(exe_dir) - 1);
    if (len > 0) {
        exe_dir[len] = '\0';
        char *slash = strrchr(exe_dir, '/');
        if (slash && slash != exe_dir) {
            *slash = '\0';
            return exe_dir;
        }
    }

    const char *home = getenv("HOME");
    if (!home || !home[0]) return NULL;

    static char fallback[PATH_MAX];
    snprintf(fallback, sizeof(fallback), "%s/../termux-libs", home);
    return fallback;
}

static char **copy_env_with_preload(char *const envp[], const char *lib_dir, const char *home) {
    size_t count = 0;
    int need_preload = 1;
    int need_ld_library_path = 1;
    int need_shelly_lib_dir = 1;
    int need_path = 1;
    int need_shell = 1;
    int need_bash = 1;
    char home_bin[PATH_MAX + 8];
    char home_bash[PATH_MAX + 16];
    if (home && home[0]) {
        snprintf(home_bin, sizeof(home_bin), "%s/bin", home);
        snprintf(home_bash, sizeof(home_bash), "%s/bin/bash", home);
    } else {
        home_bin[0] = '\0';
        home_bash[0] = '\0';
    }
    for (; envp && envp[count]; count++) {
        if (strncmp(envp[count], "LD_PRELOAD=", 11) == 0) {
            char expected_preload[PATH_MAX + 32];
            snprintf(expected_preload, sizeof(expected_preload), "%s/libexec_wrapper.so", lib_dir);
            if (strcmp(envp[count] + 11, expected_preload) == 0) need_preload = 0;
        }
        if (strncmp(envp[count], "LD_LIBRARY_PATH=", 16) == 0 && envp[count][16]) need_ld_library_path = 0;
        if (strncmp(envp[count], "SHELLY_LIB_DIR=", 15) == 0 && strcmp(envp[count] + 15, lib_dir) == 0) need_shelly_lib_dir = 0;
        if (strncmp(envp[count], "SHELL=", 6) == 0 && home_bash[0] && strcmp(envp[count] + 6, home_bash) == 0) need_shell = 0;
        if (strncmp(envp[count], "BASH=", 5) == 0 && home_bash[0] && strcmp(envp[count] + 5, home_bash) == 0) need_bash = 0;
        if (strncmp(envp[count], "PATH=", 5) == 0 && envp[count][5]) {
            int has_system_bin = strstr(envp[count] + 5, "/system/bin") != NULL;
            int has_lib_dir = strstr(envp[count] + 5, lib_dir) != NULL;
            int has_home_bin = !home_bin[0] || strstr(envp[count] + 5, home_bin) != NULL;
            if (has_system_bin && has_lib_dir && has_home_bin) need_path = 0;
        }
    }

    char preload[PATH_MAX + 32];
    snprintf(preload, sizeof(preload), "LD_PRELOAD=%s/libexec_wrapper.so", lib_dir);
    char ld_library_path[PATH_MAX + 32];
    snprintf(ld_library_path, sizeof(ld_library_path), "LD_LIBRARY_PATH=%s", lib_dir);
    char shelly_lib_dir[PATH_MAX + 32];
    snprintf(shelly_lib_dir, sizeof(shelly_lib_dir), "SHELLY_LIB_DIR=%s", lib_dir);
    char shell_env[PATH_MAX + 32];
    if (home && home[0]) {
        snprintf(shell_env, sizeof(shell_env), "SHELL=%s/bin/bash", home);
    } else {
        snprintf(shell_env, sizeof(shell_env), "SHELL=%s/shelly_shell", lib_dir);
    }
    char bash_env[PATH_MAX + 32];
    if (home && home[0]) {
        snprintf(bash_env, sizeof(bash_env), "BASH=%s/bin/bash", home);
    } else {
        snprintf(bash_env, sizeof(bash_env), "BASH=%s/shelly_shell", lib_dir);
    }
    char path_env[(PATH_MAX * 2) + 64];
    if (home && home[0]) {
        snprintf(path_env, sizeof(path_env), "PATH=%s/bin:%s:/system/bin:/vendor/bin", home, lib_dir);
    } else {
        snprintf(path_env, sizeof(path_env), "PATH=%s:/system/bin:/vendor/bin", lib_dir);
    }

    size_t extra = (need_preload ? 1 : 0) +
        (need_ld_library_path ? 1 : 0) +
        (need_shelly_lib_dir ? 1 : 0) +
        (need_path ? 1 : 0) +
        (need_shell ? 1 : 0) +
        (need_bash ? 1 : 0);
    char **out = calloc(count + extra + 1, sizeof(char *));
    if (!out) return NULL;

    size_t j = 0;
    int added_preload = 0;
    int added_ld_library_path = 0;
    int added_shelly_lib_dir = 0;
    int added_path = 0;
    int added_shell = 0;
    int added_bash = 0;
    for (size_t i = 0; i < count; i++) {
        if (strncmp(envp[i], "LD_PRELOAD=", 11) == 0 && need_preload) {
            out[j++] = strdup(preload);
            added_preload = 1;
        } else if (strncmp(envp[i], "LD_LIBRARY_PATH=", 16) == 0 && need_ld_library_path) {
            out[j++] = strdup(ld_library_path);
            added_ld_library_path = 1;
        } else if (strncmp(envp[i], "SHELLY_LIB_DIR=", 15) == 0 && need_shelly_lib_dir) {
            out[j++] = strdup(shelly_lib_dir);
            added_shelly_lib_dir = 1;
        } else if (strncmp(envp[i], "SHELL=", 6) == 0 && need_shell) {
            out[j++] = strdup(shell_env);
            added_shell = 1;
        } else if (strncmp(envp[i], "BASH=", 5) == 0 && need_bash) {
            out[j++] = strdup(bash_env);
            added_bash = 1;
        } else if (strncmp(envp[i], "PATH=", 5) == 0 && need_path) {
            out[j++] = strdup(path_env);
            added_path = 1;
        } else {
            out[j++] = envp[i];
        }
    }
    if (need_preload && !added_preload) out[j++] = strdup(preload);
    if (need_ld_library_path && !added_ld_library_path) out[j++] = strdup(ld_library_path);
    if (need_shelly_lib_dir && !added_shelly_lib_dir) out[j++] = strdup(shelly_lib_dir);
    if (need_path && !added_path) out[j++] = strdup(path_env);
    if (need_shell && !added_shell) out[j++] = strdup(shell_env);
    if (need_bash && !added_bash) out[j++] = strdup(bash_env);
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

    char **new_env = copy_env_with_preload(envp, lib_dir, getenv("HOME"));
    if (!new_env) {
        perror("shelly-shell-launcher: calloc env");
        return 127;
    }

    execve(LINKER64, new_argv, new_env);
    fprintf(stderr, "shelly-shell-launcher: execve(%s): %s\n", LINKER64, strerror(errno));
    return 127;
}
