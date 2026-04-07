/*
 * shelly-pty.c — JNI native layer for Shelly's direct PTY management.
 *
 * Opens /dev/ptmx, forks, and exec's bash via /system/bin/linker64
 * so that Shelly can own the PTY lifecycle without Termux mediation.
 *
 * JNI class: expo.modules.terminalemulator.ShellyJNI
 */

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <jni.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

#include <android/log.h>

#define TAG "ShellyPTY"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  TAG, __VA_ARGS__)

/* ------------------------------------------------------------------ */
/*  createSubprocess                                                   */
/* ------------------------------------------------------------------ */

JNIEXPORT jint JNICALL
Java_expo_modules_terminalemulator_ShellyJNI_createSubprocess(
        JNIEnv *env,
        jclass  clazz __attribute__((unused)),
        jstring linkerPathJ,
        jstring bashPathJ,
        jstring ldLibPathJ,
        jstring homePathJ,
        jint    rows,
        jint    cols,
        jintArray resultArrayJ)
{
    /* --- Extract Java strings ------------------------------------ */
    const char *linkerPath = (*env)->GetStringUTFChars(env, linkerPathJ, NULL);
    const char *bashPath   = (*env)->GetStringUTFChars(env, bashPathJ,   NULL);
    const char *ldLibPath  = (*env)->GetStringUTFChars(env, ldLibPathJ,  NULL);
    const char *homePath   = (*env)->GetStringUTFChars(env, homePathJ,   NULL);

    if (!linkerPath || !bashPath || !ldLibPath || !homePath) {
        LOGE("GetStringUTFChars failed");
        jclass ex = (*env)->FindClass(env, "java/lang/RuntimeException");
        (*env)->ThrowNew(env, ex, "GetStringUTFChars failed");
        return -1;
    }

    /* --- Open PTY master ----------------------------------------- */
    int ptm = open("/dev/ptmx", O_RDWR | O_CLOEXEC);
    if (ptm < 0) {
        LOGE("open /dev/ptmx: %s", strerror(errno));
        jclass ex = (*env)->FindClass(env, "java/lang/RuntimeException");
        (*env)->ThrowNew(env, ex, "Cannot open /dev/ptmx");
        goto release_strings;
    }

    if (grantpt(ptm) != 0) {
        LOGE("grantpt: %s", strerror(errno));
        close(ptm);
        jclass ex = (*env)->FindClass(env, "java/lang/RuntimeException");
        (*env)->ThrowNew(env, ex, "grantpt() failed");
        goto release_strings;
    }

    if (unlockpt(ptm) != 0) {
        LOGE("unlockpt: %s", strerror(errno));
        close(ptm);
        jclass ex = (*env)->FindClass(env, "java/lang/RuntimeException");
        (*env)->ThrowNew(env, ex, "unlockpt() failed");
        goto release_strings;
    }

    char devname[64];
    if (ptsname_r(ptm, devname, sizeof(devname)) != 0) {
        LOGE("ptsname_r: %s", strerror(errno));
        close(ptm);
        jclass ex = (*env)->FindClass(env, "java/lang/RuntimeException");
        (*env)->ThrowNew(env, ex, "ptsname_r() failed");
        goto release_strings;
    }

    /* --- Set initial window size --------------------------------- */
    struct winsize ws = {
        .ws_row = (unsigned short)rows,
        .ws_col = (unsigned short)cols,
        .ws_xpixel = 0,
        .ws_ypixel = 0
    };
    ioctl(ptm, TIOCSWINSZ, &ws);

    /* --- Enable UTF-8 on master ---------------------------------- */
    struct termios tios;
    if (tcgetattr(ptm, &tios) == 0) {
        tios.c_iflag |= IUTF8;
        tcsetattr(ptm, TCSANOW, &tios);
    }

    /* --- Fork ---------------------------------------------------- */
    pid_t pid = fork();

    if (pid < 0) {
        LOGE("fork: %s", strerror(errno));
        close(ptm);
        jclass ex = (*env)->FindClass(env, "java/lang/RuntimeException");
        (*env)->ThrowNew(env, ex, "fork() failed");
        goto release_strings;
    }

    if (pid == 0) {
        /* ============ CHILD ============ */
        close(ptm);

        /* New session */
        setsid();

        /* Open slave side */
        int pts = open(devname, O_RDWR);
        if (pts < 0) {
            _exit(127);
        }

        /* Redirect stdio */
        dup2(pts, STDIN_FILENO);
        dup2(pts, STDOUT_FILENO);
        dup2(pts, STDERR_FILENO);

        /* Close all FDs > 2, using /proc/self/fd for robustness */
        DIR *d = opendir("/proc/self/fd");
        if (d) {
            int dfd = dirfd(d);
            struct dirent *ent;
            while ((ent = readdir(d)) != NULL) {
                int fd = atoi(ent->d_name);
                if (fd > 2 && fd != dfd) close(fd);
            }
            closedir(d);
        } else {
            /* Fallback: close fds 3..63 */
            for (int fd = 3; fd < 64; fd++) close(fd);
        }

        /* Reset signals */
        sigset_t sigs;
        sigfillset(&sigs);
        sigprocmask(SIG_UNBLOCK, &sigs, NULL);

        struct sigaction sa;
        memset(&sa, 0, sizeof(sa));
        sa.sa_handler = SIG_DFL;
        for (int s = 1; s < NSIG; s++) {
            sigaction(s, &sa, NULL);
        }

        /* Build environment */
        clearenv();
        setenv("HOME",            homePath,                          1);
        setenv("TERM",            "xterm-256color",                  1);
        setenv("COLORTERM",       "truecolor",                       1);
        setenv("LANG",            "en_US.UTF-8",                     1);
        setenv("LD_LIBRARY_PATH", ldLibPath,                         1);
        setenv("SHELL",           bashPath,                          1);
        setenv("PATH",            "/usr/bin:/usr/sbin:/bin:/sbin",    1);

        /* chdir to home */
        if (chdir(homePath) != 0) {
            /* non-fatal, fall through */
        }

        /* execve via linker64 */
        char *argv[] = {
            (char *)linkerPath,
            (char *)bashPath,
            "--login",
            NULL
        };
        extern char **environ;
        execve(linkerPath, argv, environ);

        /* If we get here, execve failed */
        _exit(127);
    }

    /* ============ PARENT ============ */
    LOGI("forked child pid=%d, ptm fd=%d, pts=%s", (int)pid, ptm, devname);

    /* Write masterFd and pid into resultArray */
    jint result[2];
    result[0] = ptm;
    result[1] = (jint)pid;
    (*env)->SetIntArrayRegion(env, resultArrayJ, 0, 2, result);

    /* Release strings */
    (*env)->ReleaseStringUTFChars(env, linkerPathJ, linkerPath);
    (*env)->ReleaseStringUTFChars(env, bashPathJ,   bashPath);
    (*env)->ReleaseStringUTFChars(env, ldLibPathJ,   ldLibPath);
    (*env)->ReleaseStringUTFChars(env, homePathJ,    homePath);

    return ptm;

release_strings:
    if (linkerPath) (*env)->ReleaseStringUTFChars(env, linkerPathJ, linkerPath);
    if (bashPath)   (*env)->ReleaseStringUTFChars(env, bashPathJ,   bashPath);
    if (ldLibPath)  (*env)->ReleaseStringUTFChars(env, ldLibPathJ,  ldLibPath);
    if (homePath)   (*env)->ReleaseStringUTFChars(env, homePathJ,   homePath);
    return -1;
}

/* ------------------------------------------------------------------ */
/*  setPtyWindowSize                                                   */
/* ------------------------------------------------------------------ */

JNIEXPORT void JNICALL
Java_expo_modules_terminalemulator_ShellyJNI_setPtyWindowSize(
        JNIEnv *env  __attribute__((unused)),
        jclass  clazz __attribute__((unused)),
        jint    fd,
        jint    rows,
        jint    cols)
{
    struct winsize ws = {
        .ws_row = (unsigned short)rows,
        .ws_col = (unsigned short)cols,
        .ws_xpixel = 0,
        .ws_ypixel = 0
    };
    if (ioctl(fd, TIOCSWINSZ, &ws) < 0) {
        LOGE("TIOCSWINSZ fd=%d: %s", fd, strerror(errno));
    }
}

/* ------------------------------------------------------------------ */
/*  waitFor                                                            */
/* ------------------------------------------------------------------ */

JNIEXPORT jint JNICALL
Java_expo_modules_terminalemulator_ShellyJNI_waitFor(
        JNIEnv *env  __attribute__((unused)),
        jclass  clazz __attribute__((unused)),
        jint    pid)
{
    int status;
    if (waitpid((pid_t)pid, &status, 0) < 0) {
        LOGE("waitpid(%d): %s", pid, strerror(errno));
        return -1;
    }

    if (WIFEXITED(status)) {
        return WEXITSTATUS(status);
    } else if (WIFSIGNALED(status)) {
        return -WTERMSIG(status);
    }
    return 0;
}

/* ------------------------------------------------------------------ */
/*  close                                                              */
/* ------------------------------------------------------------------ */

JNIEXPORT void JNICALL
Java_expo_modules_terminalemulator_ShellyJNI_close(
        JNIEnv *env  __attribute__((unused)),
        jclass  clazz __attribute__((unused)),
        jint    fd)
{
    if (close(fd) < 0) {
        LOGE("close(%d): %s", fd, strerror(errno));
    }
}
