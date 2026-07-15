// BOOT-AUTOSTART (L1) — wiring seam.
//
// ⚠️ 新 Manifest 権限追加 = 要 rebuild・L1 grant. This floor adds two Android
// permissions (RECEIVE_BOOT_COMPLETED / REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
// and a BOOT_COMPLETED receiver. The permissions change the APK's declared
// permission surface, so a rebuild is required, and RECEIVE_BOOT_COMPLETED
// autostart plus battery-optimization exemption are L1 OS grants the user must
// approve on-device. Its real behavior (agent still fires after a reboot / after
// Doze) is verifiable ONLY on device — offline 緑 ≠ 実機緑.
//
// P0-2 (2026-07-15): production-default ON. The native BootCompletedReceiver
// checks AgentAlarmScheduler.bootAutostartEnabled(), which now defaults true
// (SharedPreferences override still possible, e.g. a test/debug build), and
// schedule()/cancel() persist/forget boot-rearm records on that same flag — so
// registering a schedule always persists it for boot recovery, no separate step.
// 2026-06-23 landed this dormant (flag OFF) pending on-device reboot/Doze/One UI
// verification; that verification remains the required device-side follow-up
// (tracked in DEFERRED.md), but the code path itself was independently reviewed
// and is not gated behind any known defect.
//
// This TS-side constant has no functional consumer (the real gate is the native
// SharedPreferences flag read by BootCompletedReceiver/AgentAlarmScheduler,
// which Kotlin code cannot import from here) — it exists purely as a readable,
// host-testable mirror of the native default so the two can't silently drift
// without a reviewer noticing (see __tests__/boot-autostart/parity.test.ts).
export const BOOT_AUTOSTART_ENABLED = true;
