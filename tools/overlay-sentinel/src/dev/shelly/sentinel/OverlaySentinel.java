package dev.shelly.sentinel;

import android.content.ContentResolver;
import android.content.Context;
import android.database.ContentObserver;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;

import java.io.FileOutputStream;
import java.io.PrintStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Overlay sentinel (shelly-hayato-bridge #6, item 1).
 *
 * Runs as the shell uid through app_process, the way scrcpy and Shizuku start
 * their servers:
 *
 *   CLASSPATH=/data/local/tmp/overlay-sentinel.dex app_process / \
 *     dev.shelly.sentinel.OverlaySentinel [--key <global key>] [--log <file>]
 *
 * It watches one Settings.Global key (default overlay_display_devices) with a
 * ContentObserver (no polling) and deletes any value other than null / "" /
 * "none" as soon as it changes. The shell uid holds WRITE_SECURE_SETTINGS; the
 * delete runs the platform `settings` command, so no hidden write API is used.
 * It also checks once at start, because the value survives a reboot.
 *
 * Shelly itself never gets WRITE_SECURE_SETTINGS: that would let its agent
 * workers (same uid) change secure settings.
 *
 * --key exists for a self-test on a harmless key (e.g. shelly_sentinel_selftest)
 * without touching the owner's display.
 */
public final class OverlaySentinel {
    private static final String DEFAULT_KEY = "overlay_display_devices";
    private static PrintStream log = System.out;
    private static String key = DEFAULT_KEY;

    public static void main(String[] args) throws Exception {
        String logPath = null;
        for (int i = 0; i < args.length; i++) {
            if ("--key".equals(args[i]) && i + 1 < args.length) key = args[++i];
            else if ("--log".equals(args[i]) && i + 1 < args.length) logPath = args[++i];
        }
        if (!key.matches("[a-z0-9_]{1,64}")) throw new IllegalArgumentException("bad key");
        if (logPath != null) log = new PrintStream(new FileOutputStream(logPath, true), true, "UTF-8");

        Looper.prepareMainLooper();
        Context context = systemContext();
        final ContentResolver cr = context.getContentResolver();
        final Uri uri = Settings.Global.getUriFor(key);
        line("start key=" + key + " pid=" + android.os.Process.myPid() + " uid=" + android.os.Process.myUid());

        ContentObserver observer = new ContentObserver(new Handler(Looper.getMainLooper())) {
            @Override
            public void onChange(boolean selfChange) {
                check(cr, "change");
            }
        };
        cr.registerContentObserver(uri, false, observer);
        line("watching " + uri);
        check(cr, "start");
        Looper.loop();
    }

    private static void check(ContentResolver cr, String why) {
        long t0 = SystemClock.elapsedRealtime();
        String v = read(cr);
        if (isClear(v)) {
            if (!"change".equals(why)) line(why + " clear");
            return;
        }
        line(why + " detected len=" + v.length());
        boolean ok = delete();
        String after = read(cr);
        line("revert " + (ok && isClear(after) ? "ok" : "FAILED") + " ms=" + (SystemClock.elapsedRealtime() - t0)
            + " after=" + (after == null ? "null" : ("len=" + after.length())));
    }

    private static boolean isClear(String v) {
        return v == null || v.isEmpty() || "none".equals(v);
    }

    private static String read(ContentResolver cr) {
        try {
            return Settings.Global.getString(cr, key);
        } catch (Throwable t) {
            return exec(new String[] {"settings", "get", "global", key}).trim().replace("null", "");
        }
    }

    private static boolean delete() {
        String out = exec(new String[] {"settings", "delete", "global", key});
        return !out.startsWith("ERROR");
    }

    private static String exec(String[] cmd) {
        try {
            Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
            byte[] b = p.getInputStream().readAllBytes();
            p.waitFor();
            return new String(b, StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "ERROR " + e;
        }
    }

    /** The system context, as scrcpy's Workarounds obtains it for a shell-uid app_process. */
    private static Context systemContext() throws Exception {
        Class<?> at = Class.forName("android.app.ActivityThread");
        Constructor<?> ctor = at.getDeclaredConstructor();
        ctor.setAccessible(true);
        Object thread = ctor.newInstance();
        Field current = at.getDeclaredField("sCurrentActivityThread");
        current.setAccessible(true);
        current.set(null, thread);
        // Samsung's CompatSandbox reads ActivityThread.mConfigurationController
        // while the system context is created; a bare ActivityThread leaves it
        // null (NPE on device, 2026-11-28). Fill it as scrcpy's Workarounds do.
        try {
            Class<?> ccClass = Class.forName("android.app.ConfigurationController");
            Class<?> atiClass = Class.forName("android.app.ActivityThreadInternal");
            Constructor<?> ccCtor = ccClass.getDeclaredConstructor(atiClass);
            ccCtor.setAccessible(true);
            Object cc = ccCtor.newInstance(thread);
            Field ccField = at.getDeclaredField("mConfigurationController");
            ccField.setAccessible(true);
            ccField.set(thread, cc);
        } catch (Throwable t) {
            line("configuration controller not filled: " + t);
        }
        Method getSystemContext = at.getDeclaredMethod("getSystemContext");
        return (Context) getSystemContext.invoke(thread);
    }

    private static void line(String s) {
        String ts = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSZ", Locale.US).format(new Date());
        log.println(ts + " " + s);
        android.util.Log.i("OverlaySentinel", s);
    }

    private OverlaySentinel() {}
}
