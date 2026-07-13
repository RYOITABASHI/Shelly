// BOOT-AUTOSTART (L1) — dormant wiring seam.
//
// ⚠️ 新 Manifest 権限追加 = 要 rebuild・L1 grant. This floor adds two Android
// permissions (RECEIVE_BOOT_COMPLETED / REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
// and a BOOT_COMPLETED receiver. The permissions change the APK's declared
// permission surface, so a rebuild is required, and RECEIVE_BOOT_COMPLETED
// autostart plus battery-optimization exemption are L1 OS grants the user must
// approve on-device. Its real behavior (agent still fires after a reboot / after
// Doze) is verifiable ONLY on device — offline 緑 ≠ 実機緑.
//
// Dormant: the native BootCompletedReceiver checks a persisted enable flag
// (default OFF) and no-ops when disabled, and AgentAlarmScheduler only persists
// schedules for boot re-arm when the flag is on — so with the flag OFF the live
// scheduling/boot behavior is byte-preserved (the receiver is registered but does
// nothing). "実装されるが有効化はされない."
//
// MIGRATION (deferred, flag-ON step): flip the native enable flag → schedule()
// persists {agentId, cron, intervalMs}; on BOOT_COMPLETED the receiver reads them
// and calls AgentAlarmScheduler.scheduleNext (planned by planBootRearm) to re-arm
// every scheduled agent. Battery-optimization exemption is requested via the
// already-present isIgnoringBatteryOptimizations / ACTION_REQUEST_IGNORE_BATTERY_
// OPTIMIZATIONS path (TerminalEmulatorModule), which the new permission unblocks.

// Master dormancy switch (TS side). The native side has its own SharedPreferences
// flag (default false); both must be flipped to enable boot autostart.
export const BOOT_AUTOSTART_ENABLED = false;
