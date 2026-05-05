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

    /* --- Configure termios on master (bug #90) -------------------
     *
     * The previous version only flipped IUTF8 on and inherited the rest
     * of the termios flags from whatever the kernel handed back. On some
     * Android builds that default state leaves ICRNL off and OPOST off,
     * so the very first \r written to the PTY from the input side gets
     * eaten by the line discipline before the child shell has had a
     * chance to call tcsetattr itself. The visible symptom is the bug
     * #12 "first Enter does nothing" on a cold session. Explicitly bring
     * the termios into the same state Termux uses (ICRNL, IXON, IUTF8,
     * OPOST|ONLCR, ISIG|ICANON|IEXTEN|ECHO|ECHOE|ECHOK|ECHOCTL|ECHOKE)
     * before fork() so both master and slave start from a known-good
     * cooked-mode baseline.
     */
    struct termios tios;
    if (tcgetattr(ptm, &tios) == 0) {
        tios.c_iflag |= (ICRNL | IXON | IUTF8);
        tios.c_iflag &= ~(IGNCR | INLCR);
        tios.c_oflag |= (OPOST | ONLCR);
        tios.c_lflag |= (ISIG | ICANON | IEXTEN | ECHO | ECHOE | ECHOK | ECHOCTL | ECHOKE);
        tios.c_cflag |= (CREAD | CS8 | HUPCL);
        tios.c_cc[VINTR]    = 0x03;  /* Ctrl-C */
        tios.c_cc[VQUIT]    = 0x1c;  /* Ctrl-\ */
        tios.c_cc[VERASE]   = 0x7f;  /* DEL    */
        tios.c_cc[VKILL]    = 0x15;  /* Ctrl-U */
        tios.c_cc[VEOF]     = 0x04;  /* Ctrl-D */
        tios.c_cc[VSTART]   = 0x11;  /* Ctrl-Q */
        tios.c_cc[VSTOP]    = 0x13;  /* Ctrl-S */
        tios.c_cc[VSUSP]    = 0x1a;  /* Ctrl-Z */
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

        /* Make the PTY slave this session's controlling terminal.  Some
         * Android builds will otherwise leave bash without a proper TTY
         * owner, which can suppress the initial interactive prompt even
         * though stdin/stdout are attached to the slave fd. */
        ioctl(pts, TIOCSCTTY, 0);

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
        /* LD_PRELOAD exec wrapper: intercepts execve() so that all child
         * processes (node, git, python, etc.) are automatically launched
         * via /system/bin/linker64, bypassing Android's SELinux noexec
         * restriction on app_data_file (targetSdk >= 29). */
        {
            char preloadPath[1024];
            snprintf(preloadPath, sizeof(preloadPath),
                     "%s/libexec_wrapper.so", ldLibPath);
            setenv("LD_PRELOAD", preloadPath, 1);
        }
        /* npm global install prefix — avoids writing to /apex or system paths */
        {
            char npmPrefix[1024];
            snprintf(npmPrefix, sizeof(npmPrefix), "%s/.npm-global", homePath);
            setenv("NPM_CONFIG_PREFIX", npmPrefix, 1);
        }
        /* PATH: include lib dir (bundled binaries) + npm global bin + npm bin + system fallbacks */
        {
            char pathBuf[2048];
            snprintf(pathBuf, sizeof(pathBuf),
                     "%s:%s/.npm-global/bin:%s/node_modules/npm/bin:%s/node_modules/.bin:/usr/bin:/usr/sbin:/bin:/sbin",
                     ldLibPath, homePath, ldLibPath, ldLibPath);
            setenv("PATH", pathBuf, 1);
        }

        /* chdir to home */
        if (chdir(homePath) != 0) {
            /* non-fatal, fall through */
        }

        /* .bashrc is generated by HomeInitializer.kt with tool functions
         * (git, node, coreutils, etc.), CLI aliases, and OSC 133 prompt.
         * Do NOT overwrite it here — HomeInitializer handles versioning
         * and regeneration. Only create a minimal fallback if missing. */
        {
            char bashrcPath[1024];
            snprintf(bashrcPath, sizeof(bashrcPath), "%s/.bashrc", homePath);

            /* Only write .bashrc if it doesn't exist yet (first launch
             * before HomeInitializer ran, or deleted by user). */
            if (access(bashrcPath, F_OK) != 0) {
                char pathVal[2048];
                char *pathEnv = getenv("PATH");
                if (pathEnv) {
                    snprintf(pathVal, sizeof(pathVal), "%s", pathEnv);
                }

                FILE *rc = fopen(bashrcPath, "w");
                if (rc) {
                    fprintf(rc, "# Shelly fallback .bashrc — regenerated by HomeInitializer on next launch\n");
                    fprintf(rc, "export PATH=\"%s\"\n", pathVal);
                    fprintf(rc, "export LD_LIBRARY_PATH=\"%s\"\n", ldLibPath);
                    fprintf(rc, "export PS1='shelly:~$ '\n");
                    fprintf(rc, "claude() { \"%s/node\" \"%s/node_modules/@anthropic-ai/claude-code/cli.js\" \"$@\"; }\n", ldLibPath, ldLibPath);
                    fprintf(rc, "gemini() { \"%s/node\" \"%s/node_modules/@google/gemini-cli/bundle/gemini.js\" \"$@\"; }\n", ldLibPath, ldLibPath);
                    fprintf(rc, "codex() { \"%s/node\" \"%s/node_modules/@openai/codex/bin/codex.js\" \"$@\"; }\n", ldLibPath, ldLibPath);
                    fprintf(rc, "export -f claude gemini codex\n");
                    fclose(rc);
                }
            }
        }

        /* execve via linker64 — no --login to avoid /etc/profile overwriting PATH */
        char *argv[] = {
            (char *)linkerPath,
            (char *)bashPath,
            "--rcfile",
            ".bashrc",
            "-i",
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
/*  interruptPty                                                       */
/* ------------------------------------------------------------------ */

JNIEXPORT jint JNICALL
Java_expo_modules_terminalemulator_ShellyJNI_interruptPty(
        JNIEnv *env  __attribute__((unused)),
        jclass  clazz __attribute__((unused)),
        jint    fd,
        jint    childPid)
{
    pid_t foreground_pgrp = -1;

#ifdef TIOCGPGRP
    if (ioctl(fd, TIOCGPGRP, &foreground_pgrp) < 0) {
        LOGE("TIOCGPGRP fd=%d: %s", fd, strerror(errno));
        foreground_pgrp = -1;
    }
#else
    foreground_pgrp = tcgetpgrp(fd);
    if (foreground_pgrp < 0) {
        LOGE("tcgetpgrp fd=%d: %s", fd, strerror(errno));
    }
#endif

    if (foreground_pgrp > 1) {
        if (kill(-foreground_pgrp, SIGINT) == 0) {
            return 1;
        }
        LOGE("kill foreground pgrp=%d SIGINT: %s", (int)foreground_pgrp, strerror(errno));
    }

    /* The interactive bash is a session leader after setsid(), so its pid
     * is also a useful fallback process group when foreground-pgrp lookup
     * fails on Android vendor kernels. */
    if (childPid > 1) {
        if (kill(-(pid_t)childPid, SIGINT) == 0) {
            return 2;
        }
        LOGE("kill child pgrp=%d SIGINT: %s", (int)childPid, strerror(errno));
    }

    /* Final fallback: inject VINTR into the PTY input stream. */
    const char ctrl_c = 0x03;
    if (write(fd, &ctrl_c, 1) == 1) {
        return 0;
    }
    LOGE("write Ctrl-C fd=%d: %s", fd, strerror(errno));
    return -1;
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
