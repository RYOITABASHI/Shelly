/*
 * shelly-exec.c — Non-interactive command execution via fork+exec+pipe.
 *
 * Unlike shelly-pty.c (which creates a PTY for interactive terminal use),
 * this uses plain pipes to capture stdout/stderr and return them as strings.
 * Used for programmatic command execution (AI dispatch, file ops, diagnostics).
 *
 * JNI class: expo.modules.terminalemulator.ShellyJNI
 */

#include <errno.h>
#include <fcntl.h>
#include <jni.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include <android/log.h>

#define TAG "ShellyExec"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  TAG, __VA_ARGS__)

/* Max output buffer: 4 MB per stream */
#define MAX_OUTPUT (4 * 1024 * 1024)

/* Read all data from fd into a malloc'd buffer. Returns length, -1 on error. */
static ssize_t read_all(int fd, char **out) {
    size_t capacity = 4096;
    size_t len = 0;
    char *buf = (char *)malloc(capacity);
    if (!buf) return -1;

    while (len < MAX_OUTPUT) {
        ssize_t n = read(fd, buf + len, capacity - len);
        if (n < 0) {
            if (errno == EINTR) continue;
            free(buf);
            return -1;
        }
        if (n == 0) break;
        len += n;
        if (len >= capacity) {
            capacity *= 2;
            if (capacity > MAX_OUTPUT) capacity = MAX_OUTPUT;
            char *tmp = (char *)realloc(buf, capacity);
            if (!tmp) { free(buf); return -1; }
            buf = tmp;
        }
    }
    *out = buf;
    return (ssize_t)len;
}

JNIEXPORT jobjectArray JNICALL
Java_expo_modules_terminalemulator_ShellyJNI_execSubprocess(
        JNIEnv *env,
        jclass  clazz __attribute__((unused)),
        jstring linkerPathJ,
        jstring bashPathJ,
        jstring ldLibPathJ,
        jstring homePathJ,
        jstring commandJ,
        jint    timeoutMs)
{
    const char *linkerPath = (*env)->GetStringUTFChars(env, linkerPathJ, NULL);
    const char *bashPath   = (*env)->GetStringUTFChars(env, bashPathJ,   NULL);
    const char *ldLibPath  = (*env)->GetStringUTFChars(env, ldLibPathJ,  NULL);
    const char *homePath   = (*env)->GetStringUTFChars(env, homePathJ,   NULL);
    const char *command    = (*env)->GetStringUTFChars(env, commandJ,    NULL);

    if (!linkerPath || !bashPath || !ldLibPath || !homePath || !command) {
        LOGE("GetStringUTFChars failed");
        jclass ex = (*env)->FindClass(env, "java/lang/RuntimeException");
        (*env)->ThrowNew(env, ex, "GetStringUTFChars failed");
        return NULL;
    }

    /* Create pipes for stdout and stderr */
    int stdout_pipe[2], stderr_pipe[2];
    if (pipe(stdout_pipe) < 0 || pipe(stderr_pipe) < 0) {
        LOGE("pipe: %s", strerror(errno));
        jclass ex = (*env)->FindClass(env, "java/lang/RuntimeException");
        (*env)->ThrowNew(env, ex, "pipe() failed");
        goto release_strings;
    }

    pid_t pid = fork();

    if (pid < 0) {
        LOGE("fork: %s", strerror(errno));
        close(stdout_pipe[0]); close(stdout_pipe[1]);
        close(stderr_pipe[0]); close(stderr_pipe[1]);
        jclass ex = (*env)->FindClass(env, "java/lang/RuntimeException");
        (*env)->ThrowNew(env, ex, "fork() failed");
        goto release_strings;
    }

    if (pid == 0) {
        /* ============ CHILD ============ */

        /* Redirect stdout/stderr to pipes */
        close(stdout_pipe[0]);
        close(stderr_pipe[0]);
        dup2(stdout_pipe[1], STDOUT_FILENO);
        dup2(stderr_pipe[1], STDERR_FILENO);
        close(stdout_pipe[1]);
        close(stderr_pipe[1]);

        /* Close stdin (not interactive) */
        close(STDIN_FILENO);
        open("/dev/null", O_RDONLY);

        /* Reset signals */
        struct sigaction sa;
        memset(&sa, 0, sizeof(sa));
        sa.sa_handler = SIG_DFL;
        for (int s = 1; s < 32; s++) {
            sigaction(s, &sa, NULL);
        }
        sigset_t sigs;
        sigfillset(&sigs);
        sigprocmask(SIG_UNBLOCK, &sigs, NULL);

        /* Build environment */
        clearenv();
        setenv("HOME",            homePath,                          1);
        setenv("TERM",            "dumb",                            1);
        setenv("LANG",            "en_US.UTF-8",                     1);
        setenv("LD_LIBRARY_PATH", ldLibPath,                         1);
        setenv("SHELL",           bashPath,                          1);
        setenv("PATH",            "/usr/bin:/usr/sbin:/bin:/sbin",    1);

        if (chdir(homePath) != 0) { /* non-fatal */ }

        /* execve: linker64 → bash -c "command" */
        char *argv[] = {
            (char *)linkerPath,
            (char *)bashPath,
            "-c",
            (char *)command,
            NULL
        };
        extern char **environ;
        execve(linkerPath, argv, environ);

        /* If execve failed */
        _exit(127);
    }

    /* ============ PARENT ============ */
    close(stdout_pipe[1]);
    close(stderr_pipe[1]);

    LOGI("execSubprocess: child pid=%d, cmd=%.80s", (int)pid, command);

    /* Set non-blocking on read ends for timeout support */
    fcntl(stdout_pipe[0], F_SETFL, O_NONBLOCK);
    fcntl(stderr_pipe[0], F_SETFL, O_NONBLOCK);

    /* Read stdout and stderr with timeout */
    int timeout_sec = (timeoutMs > 0) ? (timeoutMs / 1000) : 120;
    if (timeout_sec < 1) timeout_sec = 1;

    /* Use select() with timeout to read both pipes */
    char *stdout_buf = NULL, *stderr_buf = NULL;
    size_t stdout_len = 0, stderr_len = 0;
    size_t stdout_cap = 4096, stderr_cap = 4096;
    stdout_buf = (char *)malloc(stdout_cap);
    stderr_buf = (char *)malloc(stderr_cap);

    time_t deadline = time(NULL) + timeout_sec;
    int stdout_eof = 0, stderr_eof = 0;

    while (!stdout_eof || !stderr_eof) {
        fd_set rfds;
        FD_ZERO(&rfds);
        int maxfd = -1;
        if (!stdout_eof) { FD_SET(stdout_pipe[0], &rfds); if (stdout_pipe[0] > maxfd) maxfd = stdout_pipe[0]; }
        if (!stderr_eof) { FD_SET(stderr_pipe[0], &rfds); if (stderr_pipe[0] > maxfd) maxfd = stderr_pipe[0]; }
        if (maxfd < 0) break;

        struct timeval tv;
        time_t remaining = deadline - time(NULL);
        if (remaining <= 0) {
            LOGE("execSubprocess: timeout after %ds, killing pid %d", timeout_sec, (int)pid);
            kill(pid, SIGKILL);
            break;
        }
        tv.tv_sec = (remaining > 2) ? 2 : remaining;
        tv.tv_usec = 0;

        int ret = select(maxfd + 1, &rfds, NULL, NULL, &tv);
        if (ret < 0) {
            if (errno == EINTR) continue;
            break;
        }
        if (ret == 0) continue; /* timeout on select, loop will check deadline */

        /* Read stdout */
        if (!stdout_eof && FD_ISSET(stdout_pipe[0], &rfds)) {
            if (stdout_len >= stdout_cap) {
                stdout_cap *= 2;
                if (stdout_cap > MAX_OUTPUT) stdout_cap = MAX_OUTPUT;
                stdout_buf = (char *)realloc(stdout_buf, stdout_cap);
            }
            ssize_t n = read(stdout_pipe[0], stdout_buf + stdout_len,
                           (stdout_cap - stdout_len > 4096) ? 4096 : stdout_cap - stdout_len);
            if (n <= 0) stdout_eof = 1;
            else stdout_len += n;
        }

        /* Read stderr */
        if (!stderr_eof && FD_ISSET(stderr_pipe[0], &rfds)) {
            if (stderr_len >= stderr_cap) {
                stderr_cap *= 2;
                if (stderr_cap > MAX_OUTPUT) stderr_cap = MAX_OUTPUT;
                stderr_buf = (char *)realloc(stderr_buf, stderr_cap);
            }
            ssize_t n = read(stderr_pipe[0], stderr_buf + stderr_len,
                           (stderr_cap - stderr_len > 4096) ? 4096 : stderr_cap - stderr_len);
            if (n <= 0) stderr_eof = 1;
            else stderr_len += n;
        }
    }

    close(stdout_pipe[0]);
    close(stderr_pipe[0]);

    /* Wait for child */
    int status;
    waitpid(pid, &status, 0);
    int exitCode = WIFEXITED(status) ? WEXITSTATUS(status) : (WIFSIGNALED(status) ? 128 + WTERMSIG(status) : -1);

    LOGI("execSubprocess: pid=%d exited with code %d, stdout=%zu bytes, stderr=%zu bytes",
         (int)pid, exitCode, stdout_len, stderr_len);

    /* Build result array: [exitCodeStr, stdout, stderr] */
    jclass strClass = (*env)->FindClass(env, "java/lang/String");
    jobjectArray result = (*env)->NewObjectArray(env, 3, strClass, NULL);

    char exitStr[16];
    snprintf(exitStr, sizeof(exitStr), "%d", exitCode);
    (*env)->SetObjectArrayElement(env, result, 0, (*env)->NewStringUTF(env, exitStr));

    /* Create Java strings from buffers */
    jstring stdoutJ = stdout_buf ? (*env)->NewStringUTF(env, stdout_len > 0 ? (stdout_buf[stdout_len] = '\0', stdout_buf) : "") : (*env)->NewStringUTF(env, "");
    jstring stderrJ = stderr_buf ? (*env)->NewStringUTF(env, stderr_len > 0 ? (stderr_buf[stderr_len] = '\0', stderr_buf) : "") : (*env)->NewStringUTF(env, "");

    (*env)->SetObjectArrayElement(env, result, 1, stdoutJ);
    (*env)->SetObjectArrayElement(env, result, 2, stderrJ);

    free(stdout_buf);
    free(stderr_buf);

    /* Release strings */
    (*env)->ReleaseStringUTFChars(env, linkerPathJ, linkerPath);
    (*env)->ReleaseStringUTFChars(env, bashPathJ,   bashPath);
    (*env)->ReleaseStringUTFChars(env, ldLibPathJ,   ldLibPath);
    (*env)->ReleaseStringUTFChars(env, homePathJ,    homePath);
    (*env)->ReleaseStringUTFChars(env, commandJ,     command);

    return result;

release_strings:
    if (linkerPath) (*env)->ReleaseStringUTFChars(env, linkerPathJ, linkerPath);
    if (bashPath)   (*env)->ReleaseStringUTFChars(env, bashPathJ,   bashPath);
    if (ldLibPath)  (*env)->ReleaseStringUTFChars(env, ldLibPathJ,  ldLibPath);
    if (homePath)   (*env)->ReleaseStringUTFChars(env, homePathJ,   homePath);
    if (command)    (*env)->ReleaseStringUTFChars(env, commandJ,    command);
    return NULL;
}
