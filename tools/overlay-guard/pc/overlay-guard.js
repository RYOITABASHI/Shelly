#!/usr/bin/env node
// PreToolUse hook (shelly-hayato-bridge #6, item 1): refuse any command that
// would write the phone's Settings.Global overlay_display_devices. Writing it
// puts an overlay display on the owner's screen (display 0). Reads pass, and
// so does prose that only names the key (reports, issue comments).
// Exit 2 = block; the message goes back to the model.
'use strict';
const fs = require('fs');
const path = require('path');

let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  let ev;
  try { ev = JSON.parse(input); } catch { process.exit(0); }
  const tool = String(ev.tool_name || '');
  if (!/^(Bash|PowerShell|mcp__)/.test(tool)) process.exit(0);
  const text = JSON.stringify(ev.tool_input || {});
  if (!isOverlayWrite(text)) process.exit(0);
  try {
    fs.appendFileSync(path.join(__dirname, '..', 'overlay-guard.log'),
      `${new Date().toISOString()} hook blocked tool=${tool} session=${ev.session_id || '-'}\n`);
  } catch { /* logging never decides */ }
  process.stderr.write(
    'Blocked by overlay-guard: writing overlay_display_devices on the phone is forbidden ' +
    '(it shows an overlay on the owner\'s screen). For a background virtual display use ' +
    '`shelly-vd open` / `shelly-vd close` (scrcpy --new-display) or the ClosePaw VD.\n');
  process.exit(2);
});

// Exported for the self-test below.
function isOverlayWrite(text) {
  const t = text.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const K = 'overlay_display_devices';
  const verb = String.raw`(?:put|delete|reset)`;
  const pats = [
    // settings / cmd settings put|delete|reset [--user N] global overlay_display_devices
    new RegExp(String.raw`settings\s+${verb}\s+(?:--user\s+\S+\s+)?global\s+["']?${K}`, 'i'),
    // settings reset global <anything> wipes it too
    new RegExp(String.raw`settings\s+reset\s+(?:--user\s+\S+\s+)?global\b`, 'i'),
    // content insert|update|delete on settings/global with this name
    new RegExp(String.raw`content\s+(?:insert|update|delete)\b[^\n]*settings/global[^\n]*${K}`, 'i'),
    // a write with the key in a variable or command substitution
    new RegExp(String.raw`settings\s+(?:put|delete)\s+(?:--user\s+\S+\s+)?global\s+["']?(?:\$|\x60)`, 'i'),
    // Settings.Global.putString(..., "overlay_display_devices", ...)
    new RegExp(String.raw`putString\s*\([^)]*${K}`, 'i'),
  ];
  return pats.some((re) => re.test(t));
}
module.exports = { isOverlayWrite };
