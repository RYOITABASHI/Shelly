// BOOT-AUTOSTART (L1) — public surface.
//
// Phase 1 floor: re-arm scheduled agents after reboot + battery-optimization
// exemption. Production-default ON since P0-2, 2026-07-15 (see wiring.ts).
// ⚠️ adds Manifest permissions (RECEIVE_BOOT_COMPLETED /
// REQUEST_IGNORE_BATTERY_OPTIMIZATIONS) = requires an APK rebuild + L1 grant;
// real behavior is device-verify-only.

export { planBootRearm } from './plan';
export type { BootScheduleRecord, BootRearmEntry } from './plan';
export { BOOT_AUTOSTART_ENABLED } from './wiring';
