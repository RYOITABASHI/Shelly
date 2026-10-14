/**
 * Source invariants for the native ClosePaw hand-off owner
 * (ClosePawHandoff.kt, fix/closepaw-background). The Kotlin cannot run under
 * Jest, so this pins (1) parity of every validation constant / message with
 * the TS reference spec in lib/closepaw-queue.ts + lib/agent-intent-review.ts,
 * (2) the single-owner / at-most-once wiring, and (3) the background
 * activity-start (BAL) handling: direct start only when provably allowed,
 * else a tap-to-continue notification with an immutable one-shot
 * PendingIntent and no creator-side BAL opt-in.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  CLOSEPAW_ACTIVITY,
  CLOSEPAW_BACKGROUND_BLOCKED_MARKER,
  CLOSEPAW_GOAL_MAX_CHARS,
  CLOSEPAW_NOT_INSTALLED_MARKER,
  CLOSEPAW_PACKAGE,
  CLOSEPAW_GOAL_PREFIX,
  closePawReviewLine,
  closePawTaskText,
  closePawWireGoal,
  fireReviewedAgentIntent,
} from '@/lib/agent-intent-review';
import {
  CLOSEPAW_MSG_BACKGROUND_BLOCKED,
  CLOSEPAW_MSG_HANDED_OFF,
  CLOSEPAW_MSG_NOTIFIED,
  CLOSEPAW_MSG_NOT_INSTALLED,
  CLOSEPAW_NATIVE_QUEUE_FILE,
  CLOSEPAW_QUEUE_MAX_AGE_MS,
  CLOSEPAW_QUEUE_MAX_ENCODED_CHARS,
  CLOSEPAW_QUEUE_MAX_FUTURE_MS,
  CLOSEPAW_QUEUE_MIN_INTERVAL_MS,
  CLOSEPAW_QUEUE_PREFIX,
  CLOSEPAW_REQUEST_FILE_PREFIX,
} from '@/lib/closepaw-queue';

const root = path.resolve(__dirname, '..');
const ktDir = path.join(root, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator');
const read = (p: string) => fs.readFileSync(p, 'utf8');
const handoff = read(path.join(ktDir, 'ClosePawHandoff.kt'));
const moduleKt = read(path.join(ktDir, 'TerminalEmulatorModule.kt'));
const serviceKt = read(path.join(ktDir, 'TerminalSessionService.kt'));
const homeKt = read(path.join(ktDir, 'HomeInitializer.kt'));
const layout = read(path.join(root, 'app/_layout.tsx'));
const queueTs = read(path.join(root, 'lib/closepaw-queue.ts'));

function ktConst(name: string): string {
  const m = handoff.match(new RegExp(`const val ${name} = (.+)$`, 'm'));
  if (!m) throw new Error(`missing const ${name}`);
  return m[1].trim();
}
const ktString = (name: string) => JSON.parse(ktConst(name)) as string;
const ktNumber = (name: string) => Number(ktConst(name).replace(/_/g, '').replace(/L$/, ''));

describe('ClosePawHandoff.kt parity with the TS reference spec', () => {
  it('uses the same component, markers and queue file', () => {
    expect(ktString('PACKAGE')).toBe(CLOSEPAW_PACKAGE);
    expect(ktString('ACTIVITY')).toBe(CLOSEPAW_ACTIVITY);
    expect(ktString('EXTRA_GOAL')).toBe('goal');
    expect(ktString('NOT_INSTALLED_MARKER')).toBe(CLOSEPAW_NOT_INSTALLED_MARKER);
    expect(ktString('BACKGROUND_BLOCKED_MARKER')).toBe(CLOSEPAW_BACKGROUND_BLOCKED_MARKER);
    expect(ktString('QUEUE_FILE')).toBe(CLOSEPAW_NATIVE_QUEUE_FILE);
    expect(ktString('QUEUE_PREFIX')).toBe(CLOSEPAW_QUEUE_PREFIX);
  });

  it('uses the same staleness / skew / rate-limit / size limits', () => {
    expect(ktNumber('QUEUE_MAX_AGE_MS')).toBe(CLOSEPAW_QUEUE_MAX_AGE_MS);
    expect(ktNumber('QUEUE_MAX_FUTURE_MS')).toBe(CLOSEPAW_QUEUE_MAX_FUTURE_MS);
    expect(ktNumber('QUEUE_MIN_INTERVAL_MS')).toBe(CLOSEPAW_QUEUE_MIN_INTERVAL_MS);
    expect(ktNumber('QUEUE_MAX_ENCODED_CHARS')).toBe(CLOSEPAW_QUEUE_MAX_ENCODED_CHARS);
    expect(ktNumber('GOAL_MAX_CODE_POINTS')).toBe(CLOSEPAW_GOAL_MAX_CHARS);
  });

  it('uses the same request-id / timestamp grammar', () => {
    const tsReq = queueTs.match(/const REQ_ID_RE = \/(.+)\/;/)![1];
    const tsTs = queueTs.match(/const TS_RE = \/(.+)\/;/)![1];
    expect(handoff).toContain(`REQ_ID_RE = Regex("${tsReq}")`);
    expect(handoff).toContain(`TS_RE = Regex("${tsTs}")`);
  });

  it('writes the exact messages the shim prints', () => {
    expect(ktString('MSG_HANDED_OFF')).toBe(CLOSEPAW_MSG_HANDED_OFF);
    expect(ktString('MSG_NOTIFIED')).toBe(CLOSEPAW_MSG_NOTIFIED);
    expect(ktString('MSG_NOT_INSTALLED')).toBe(CLOSEPAW_MSG_NOT_INSTALLED);
    expect(ktString('MSG_BACKGROUND_BLOCKED')).toBe(CLOSEPAW_MSG_BACKGROUND_BLOCKED);
    expect(CLOSEPAW_MSG_HANDED_OFF).toBe('Handed off to ClosePaw — confirm Run in ClosePaw');
    expect(CLOSEPAW_MSG_NOTIFIED).toBe('Shelly is in the background — tap the ClosePaw notification to continue');
    expect(CLOSEPAW_MSG_NOT_INSTALLED).toBe('ClosePaw is not installed');
  });

  it('prepends the same constant open_app instruction, after sanitization, within the cap', () => {
    expect(ktString('GOAL_PREFIX')).toBe(CLOSEPAW_GOAL_PREFIX);
    expect(CLOSEPAW_GOAL_PREFIX).toBe('Use the open_app tool to open apps (do not tap launcher icons). Task: ');
    expect(handoff).toContain('putExtra(EXTRA_GOAL, wireGoal(goal))');
    const wire = handoff.slice(handoff.indexOf('fun wireGoal('), handoff.indexOf('fun buildIntent('));
    expect(wire).toContain('val clean = sanitizeGoal(goal)');
    expect(wire).toContain('GOAL_MAX_CODE_POINTS - GOAL_PREFIX.codePointCount(0, GOAL_PREFIX.length)');
    expect(wire).toContain('return GOAL_PREFIX + fitted');
  });

  it('TS reference: wire goal = prefix + task text, capped at CLOSEPAW_GOAL_MAX_CHARS code points', () => {
    expect(closePawWireGoal('  open\tChrome  ')).toBe(`${CLOSEPAW_GOAL_PREFIX}open Chrome`);
    const long = '東'.repeat(3000);
    const wire = closePawWireGoal(long);
    expect(Array.from(wire)).toHaveLength(CLOSEPAW_GOAL_MAX_CHARS);
    expect(wire.startsWith(CLOSEPAW_GOAL_PREFIX)).toBe(true);
    expect(closePawTaskText(closePawTaskText(long))).toBe(closePawTaskText(long));
    expect(wire).toBe(CLOSEPAW_GOAL_PREFIX + closePawTaskText(long));
  });

  it('the review line and the fired text are the exact task text that is sent', async () => {
    const long = 'a'.repeat(1990) + ' tail';
    const t = (_k: string, p?: Record<string, string | number>) => String(p?.goal);
    expect(closePawReviewLine({ intentMode: 'closepaw', intentShareText: long }, t)).toBe(closePawTaskText(long));
    const fired: unknown[] = [];
    await fireReviewedAgentIntent({ intentMode: 'closepaw', intentShareText: long }, async (...a) => fired.push(a));
    expect(fired).toEqual([['closepaw', '', closePawTaskText(long)]]);
    expect(CLOSEPAW_GOAL_PREFIX + fired.map((a) => (a as string[])[2])[0]).toBe(closePawWireGoal(long));
  });

  it('decodes percent-escapes strictly (no "+" → space, invalid UTF-8 rejected)', () => {
    expect(handoff).toContain('CodingErrorAction.REPORT');
    expect(handoff).not.toContain('URLDecoder');
  });
});

describe('single owner, at most once', () => {
  it('claims the queue file with an atomic rename before reading it', () => {
    expect(handoff).toMatch(/queue\.renameTo\(claimed\)/);
    expect(handoff).toContain('readAndDelete(claimed)');
    expect(handoff).toMatch(/\} finally \{\s*file\.delete\(\)/);
  });

  it('dedupes request ids and serializes handling', () => {
    expect(handoff).toMatch(/if \(!recentReqIds\.add\(reqId\)\) return null/);
    expect(handoff.match(/@Synchronized\s+fun (handleLine|drain|ensureWatching)/g)?.length).toBe(3);
  });

  it('is started by the foreground service and the Expo Module', () => {
    expect(serviceKt).toContain('ClosePawHandoff.ensureWatching(applicationContext)');
    expect(moduleKt).toContain('ClosePawHandoff.ensureWatching(context)');
  });

  it('the shim writes one complete request file per hand-off (tmp + rename), never a shared queue', () => {
    expect(homeKt).toContain("const reqFile = path.join(home, '.shelly-closepaw-req-' + reqId);");
    expect(homeKt).toContain("fs.writeFileSync(reqFile + '.tmp', 'closepaw:'");
    expect(homeKt).toContain("fs.renameSync(reqFile + '.tmp', reqFile);");
    expect(homeKt).not.toMatch(/fs\.appendFileSync\(path\.join\(home, '\.shelly-(closepaw|command)-queue'\), 'closepaw:'/);
    expect(homeKt).toMatch(/# SHELLY_HELPER_SHIM v(1[1-9]) /);
    expect(ktString('REQUEST_FILE_PREFIX')).toBe(CLOSEPAW_REQUEST_FILE_PREFIX);
  });

  it('caps the goal by code points before encoding (fits QUEUE_MAX_ENCODED_CHARS)', () => {
    expect(homeKt).toContain('encodeURIComponent(Array.from(goal).slice(0, 2000).join(\'\'))');
    expect(homeKt).not.toContain('goal.slice(0, 8000)');
    expect(CLOSEPAW_GOAL_MAX_CHARS * 12).toBeLessThanOrEqual(CLOSEPAW_QUEUE_MAX_ENCODED_CHARS);
  });

  it('drains per-request files and only complete (newline-terminated) records', () => {
    expect(handoff).toContain('val end = content.lastIndexOf(\'\\n\')');
    expect(handoff).toMatch(/if \(lines\.size == 1\) handleAll\(context, lines\)/);
    expect(handoff).toContain('handleAll(context, completeLines(readAndDelete(claimed)))');
    expect(handoff).toMatch(/fun relevant\(path: String\?\) = path == QUEUE_FILE \|\| isRequestFileName\(path\)/);
  });

  it('polls every 1s only when the FileObserver failed, else every 5s', () => {
    expect(ktNumber('FALLBACK_POLL_MS')).toBe(1000);
    expect(ktNumber('OBSERVED_POLL_MS')).toBe(5000);
    expect(handoff).toContain('val pollMs = if (observer == null) FALLBACK_POLL_MS else OBSERVED_POLL_MS');
  });

  it('RN never fires a queue line itself — it forwards to native', () => {
    expect(layout).toContain('forwardLegacyClosePawLine(');
    expect(layout).toContain('TerminalEmulator.handOffClosePawQueueLine');
    expect(layout).not.toContain('processClosePawQueueLine');
    expect(moduleKt).toContain('AsyncFunction("handOffClosePawQueueLine")');
    expect(moduleKt).toContain('ClosePawHandoff.handleLine(context, line)');
  });

  it('agent hand-offs (fireAgentIntent closepaw) share the same launcher', () => {
    expect(moduleKt).toContain('ClosePawHandoff.launch(context, shareText.orEmpty()).wire');
    expect(moduleKt).not.toContain('ComponentName(CLOSEPAW_PACKAGE');
  });
});

describe('background activity start handling', () => {
  const canStart = handoff.slice(handoff.indexOf('fun canStartActivityNow'), handoff.indexOf('private fun postHandoffNotification'));

  it('starts directly only as the foreground app or with the overlay grant (VISIBLE is not trusted)', () => {
    expect(canStart).toContain('if (state.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND) return true');
    expect(canStart).not.toMatch(/importance == ActivityManager\.RunningAppProcessInfo\.IMPORTANCE_VISIBLE/);
    expect(canStart).toContain('Settings.canDrawOverlays(context)');
    // A foreground service alone does NOT grant BAL.
    expect(canStart).not.toContain('IMPORTANCE_FOREGROUND_SERVICE');
  });

  it('falls back to a notification, and reports background-blocked when that is impossible', () => {
    const launch = handoff.slice(handoff.indexOf('fun launch('), handoff.indexOf('internal fun canStartActivityNow'));
    expect(launch).toMatch(/if \(canStartActivityNow\(context\)\)/);
    expect(launch).toContain('postHandoffNotification(context, clean, tapIntent)');
    expect(launch).toContain('throw IllegalStateException(BACKGROUND_BLOCKED_MARKER)');
    expect(launch).toContain('throw ActivityNotFoundException(NOT_INSTALLED_MARKER)');
    expect(handoff).toContain('areNotificationsEnabled()');
  });

  it('uses an immutable one-shot content PendingIntent with no creator BAL opt-in', () => {
    expect(handoff).toMatch(/PendingIntent\.getActivity\([\s\S]*?FLAG_IMMUTABLE or PendingIntent\.FLAG_ONE_SHOT/);
    expect(handoff).toContain('.setContentIntent(tap)');
    expect(handoff).not.toMatch(/setPendingIntentCreatorBackgroundActivityStartMode\(/);
    expect(handoff).not.toContain('MODE_BACKGROUND_ACTIVITY_START_ALLOWED');
    expect(handoff).toContain('NotificationManager.IMPORTANCE_HIGH');
  });

  it('keeps the goal text off the lock screen', () => {
    expect(handoff).toContain('.setVisibility(Notification.VISIBILITY_PRIVATE)');
    expect(handoff).toContain('.setPublicVersion(publicVersion)');
    const pub = handoff.slice(handoff.indexOf('val publicVersion = publicBuilder'), handoff.indexOf('.build()', handoff.indexOf('val publicVersion = publicBuilder')));
    expect(pub).not.toMatch(/shown|goal|setContentText|BigTextStyle/);
  });

  it('never logs the goal text', () => {
    for (const line of handoff.split('\n').filter((l) => /Log\.[iwed]\(/.test(l))) {
      expect(line).not.toMatch(/\$\{?(goal|clean|line)\b(?!\.length)/);
    }
  });

  it('has en + ja notification strings', () => {
    const res = path.join(root, 'modules/terminal-emulator/android/src/main/res');
    for (const dir of ['values', 'values-ja']) {
      const xml = read(path.join(res, dir, 'closepaw_strings.xml'));
      for (const key of ['closepaw_channel_name', 'closepaw_channel_description', 'closepaw_notification_title', 'closepaw_notification_body']) {
        expect(xml).toContain(`name="${key}"`);
      }
    }
  });
});
