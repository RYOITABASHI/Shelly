/**
 * `shelly closepaw "<goal>"` — request writer (generated shelly helper,
 * HomeInitializer.kt SHELLY_HELPER_SHIM v11), the reference validation spec
 * (lib/closepaw-queue.ts parseClosePawQueueLine, ported to native
 * ClosePawHandoff.kt) and RN's legacy forwarder. The shim's node body is
 * extracted from the real .kt source exactly like
 * __tests__/shelly-helper-shim-workflow.test.ts does, and run against a temp
 * $HOME with a simulated NATIVE owner draining the per-request files.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  CLOSEPAW_MSG_BACKGROUND_BLOCKED,
  CLOSEPAW_MSG_HANDED_OFF,
  CLOSEPAW_MSG_NOTIFIED,
  CLOSEPAW_MSG_NOT_INSTALLED,
  CLOSEPAW_NATIVE_QUEUE_FILE,
  CLOSEPAW_QUEUE_MAX_AGE_MS,
  CLOSEPAW_REQUEST_FILE_PREFIX,
  closePawRequestFileName,
  closePawResultFileName,
  encodeClosePawQueueLine,
  forwardLegacyClosePawLine,
  parseClosePawQueueLine,
  type ClosePawQueueResult,
} from '@/lib/closepaw-queue';

const ktPath = path.resolve(
  __dirname,
  '..',
  'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/HomeInitializer.kt',
);

function unescapeKotlin(lit: string): string {
  let out = '';
  for (let i = 0; i < lit.length; i++) {
    const ch = lit[i];
    if (ch === '\\' && i + 1 < lit.length) {
      const nx = lit[++i];
      out += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx;
      continue;
    }
    out += ch;
  }
  return out;
}

function extractShimJs(): string {
  const lines = fs.readFileSync(ktPath, 'utf8').split(/\r?\n/);
  const body: string[] = [];
  let on = false;
  for (const line of lines) {
    const m = line.match(/^\s*sb\.appendLine\("(.*)"\)\s*$/);
    if (!m) continue;
    if (!on && m[1] === "const fs = require('fs');") on = true;
    if (!on) continue;
    const text = unescapeKotlin(m[1]);
    if (text === 'SHELLY_HELPER_NODE') break;
    body.push(text);
  }
  return body.join('\n') + '\n';
}

const NOW = 1_760_000_000_000;
const REQ = `${NOW}-0123abcd`;

describe('parseClosePawQueueLine', () => {
  it('round-trips an encoded line and sanitizes the goal', () => {
    const line = encodeClosePawQueueLine(REQ, NOW, 'Open Chrome:\nsearch Tokyo weather 東京');
    expect(parseClosePawQueueLine(line, NOW + 1000)).toEqual({
      ok: true,
      reqId: REQ,
      goal: 'Open Chrome: search Tokyo weather 東京',
    });
  });

  it('drops entries older than 30s and far-future timestamps', () => {
    const line = encodeClosePawQueueLine(REQ, NOW, 'x');
    expect(parseClosePawQueueLine(line, NOW + CLOSEPAW_QUEUE_MAX_AGE_MS + 1)).toMatchObject({ ok: false, reason: 'stale', reqId: REQ });
    expect(parseClosePawQueueLine(line, NOW - 60_000)).toMatchObject({ ok: false, reason: 'stale' });
  });

  it('rejects malformed lines, extra fields and path-unsafe request ids', () => {
    expect(parseClosePawQueueLine('closepaw:../../x:1:goal', NOW)).toMatchObject({ ok: false, reqId: null });
    expect(parseClosePawQueueLine(`closepaw:${REQ}:${NOW}:a:extra`, NOW)).toMatchObject({ ok: false, reason: 'malformed' });
    expect(parseClosePawQueueLine(`closepaw:${REQ}:${NOW}:%E0%A4%A`, NOW)).toMatchObject({ ok: false, reason: 'malformed' });
    expect(parseClosePawQueueLine(`teach:${REQ}`, NOW)).toMatchObject({ ok: false, reqId: null });
    expect(parseClosePawQueueLine(`closepaw:${REQ}:${NOW}:${'a'.repeat(30_000)}`, NOW)).toMatchObject({ ok: false });
  });

  it('rejects an empty / control-only goal', () => {
    expect(parseClosePawQueueLine(encodeClosePawQueueLine(REQ, NOW, ' \n\t '), NOW)).toMatchObject({ ok: false, reason: 'empty-goal' });
  });

  it('result file names only accept validated request ids', () => {
    expect(closePawResultFileName(REQ)).toBe(`.shelly-closepaw-result-${REQ}.json`);
    expect(() => closePawResultFileName('../evil')).toThrow();
  });
});

describe('forwardLegacyClosePawLine (RN never fires; native is the single owner)', () => {
  it('hands a closepaw line to the native owner and returns its code', async () => {
    const handOff = jest.fn().mockResolvedValue('notified');
    const line = encodeClosePawQueueLine(REQ, NOW, 'x');
    await expect(forwardLegacyClosePawLine(line, handOff)).resolves.toBe('notified');
    expect(handOff).toHaveBeenCalledTimes(1);
    expect(handOff).toHaveBeenCalledWith(line);
  });

  it('ignores non-closepaw lines and builds without the native hook', async () => {
    const handOff = jest.fn();
    await expect(forwardLegacyClosePawLine('teach:x', handOff)).resolves.toBeNull();
    expect(handOff).not.toHaveBeenCalled();
    await expect(forwardLegacyClosePawLine(encodeClosePawQueueLine(REQ, NOW, 'x'), null)).resolves.toBeNull();
  });
});

type Outcome = 'launched' | 'notified' | 'not-installed' | 'background-blocked';

/**
 * Reference model of native ClosePawHandoff.handleLine/drain (validation spec
 * = parseClosePawQueueLine; 5s rate limit; per-reqId dedupe; atomic-rename
 * claim; launch outcome injected).
 */
function makeNativeOwner(home: string, outcome: () => Outcome) {
  let lastFireAt = -Infinity;
  const seen = new Set<string>();
  const launches: string[] = [];
  const handle = (line: string) => {
    const parsed = parseClosePawQueueLine(line, Date.now());
    if (!parsed.reqId || seen.has(parsed.reqId)) return;
    seen.add(parsed.reqId);
    let result: ClosePawQueueResult;
    if (parsed.ok === false) {
      result = { ok: false, code: parsed.reason === 'stale' ? 'stale' : 'invalid', message: 'rejected' };
    } else if (Date.now() - lastFireAt < 5000) {
      result = { ok: false, code: 'rate-limited', message: 'rate-limited' };
    } else {
      lastFireAt = Date.now();
      const o = outcome();
      if (o === 'launched' || o === 'notified') launches.push(parsed.goal);
      result =
        o === 'launched'
          ? { ok: true, code: 'handed-off', message: CLOSEPAW_MSG_HANDED_OFF }
          : o === 'notified'
            ? { ok: true, code: 'notified', message: CLOSEPAW_MSG_NOTIFIED }
            : o === 'not-installed'
              ? { ok: false, code: 'not-installed', message: CLOSEPAW_MSG_NOT_INSTALLED }
              : { ok: false, code: 'background-blocked', message: CLOSEPAW_MSG_BACKGROUND_BLOCKED };
    }
    fs.writeFileSync(path.join(home, closePawResultFileName(parsed.reqId)), JSON.stringify(result));
  };
  // Complete (newline-terminated) records only, like ClosePawHandoff.completeLines.
  const completeLines = (content: string) => {
    const end = content.lastIndexOf('\n');
    return end < 0 ? [] : content.slice(0, end).split('\n').filter((l) => l.trim());
  };
  const drain = () => {
    for (const name of fs.readdirSync(home).sort()) {
      if (!/^\.shelly-closepaw-req-[0-9]{10,16}-[0-9a-f]{8}$/.test(name)) continue;
      const f = path.join(home, name);
      const content = fs.readFileSync(f, 'utf8');
      fs.unlinkSync(f);
      const lines = completeLines(content);
      if (lines.length === 1) handle(lines[0]);
    }
    const q = path.join(home, CLOSEPAW_NATIVE_QUEUE_FILE);
    const claimed = q + '.draining';
    try {
      fs.renameSync(q, claimed);
    } catch {
      return;
    }
    const content = fs.readFileSync(claimed, 'utf8');
    fs.unlinkSync(claimed);
    for (const line of completeLines(content)) handle(line);
  };
  return { drain, launches };
}

describe('generated shim: shelly closepaw', () => {
  let tmp: string;
  let shimPath: string;
  let home: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-closepaw-'));
    shimPath = path.join(tmp, 'shim.js');
    fs.writeFileSync(shimPath, extractShimJs());
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(tmp, 'home-'));
  });

  function run(args: string[], owner?: { drain: () => void }) {
    return new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, [shimPath, ...args], { env: { ...process.env, HOME: home } });
      let out = '';
      child.stdout.on('data', (b) => (out += b));
      child.stderr.on('data', (b) => (out += b));
      const timer = owner ? setInterval(() => owner.drain(), 50) : null;
      child.on('close', (code) => {
        if (timer) clearInterval(timer);
        resolve({ code, out });
      });
    });
  }

  it('prints usage without a goal', async () => {
    const r = await run(['closepaw']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Usage: shelly closepaw [--wait [--timeout SEC]] "<goal>"');
  });

  it('queues to the native-owned file (never the RN command queue) and prints the direct hand-off', async () => {
    const owner = makeNativeOwner(home, () => 'launched');
    const r = await run(['closepaw', 'Open Chrome and search for Tokyo weather'], owner);
    expect(r.out.trim()).toBe(CLOSEPAW_MSG_HANDED_OFF);
    expect(r.code).toBe(0);
    expect(owner.launches).toEqual(['Open Chrome and search for Tokyo weather']);
    expect(fs.existsSync(path.join(home, '.shelly-command-queue'))).toBe(false);
    expect(fs.existsSync(path.join(home, CLOSEPAW_NATIVE_QUEUE_FILE))).toBe(false);
    // The per-request file (and its .tmp) were consumed.
    expect(fs.readdirSync(home).filter((n) => n.startsWith(CLOSEPAW_REQUEST_FILE_PREFIX))).toEqual([]);
  }, 20_000);

  it('writes one complete newline-terminated record per request file, via .tmp + rename', async () => {
    // No owner: inspect what the shim leaves behind, then let it time out.
    const child = spawn(process.execPath, [shimPath, 'closepaw', 'hello'], { env: { ...process.env, HOME: home } });
    let name: string | undefined;
    for (let i = 0; i < 100 && !name; i++) {
      await new Promise((r) => setTimeout(r, 50));
      name = fs.readdirSync(home).find((n) => n.startsWith(CLOSEPAW_REQUEST_FILE_PREFIX));
    }
    child.kill();
    expect(name).toBeDefined();
    expect(name!.endsWith('.tmp')).toBe(false);
    const reqId = name!.slice(CLOSEPAW_REQUEST_FILE_PREFIX.length);
    expect(name).toBe(closePawRequestFileName(reqId));
    const content = fs.readFileSync(path.join(home, name!), 'utf8');
    expect(content.endsWith('\n')).toBe(true);
    expect(content.trimEnd().split('\n')).toHaveLength(1);
    expect(content.startsWith(`closepaw:${reqId}:`)).toBe(true);
  }, 20_000);

  it('caps a long CJK goal by code points so the record still validates', async () => {
    const owner = makeNativeOwner(home, () => 'launched');
    const goal = '東'.repeat(5000);
    const r = await run(['closepaw', goal], owner);
    expect(r.out.trim()).toBe(CLOSEPAW_MSG_HANDED_OFF);
    expect(owner.launches).toHaveLength(1);
    expect(Array.from(owner.launches[0])).toHaveLength(2000);
  }, 20_000);

  it('prints the tap-the-notification message (exit 0) when Shelly is backgrounded', async () => {
    const owner = makeNativeOwner(home, () => 'notified');
    const r = await run(['closepaw', 'Open Chrome and search for Tokyo weather'], owner);
    expect(r.out.trim()).toBe(CLOSEPAW_MSG_NOTIFIED);
    expect(r.code).toBe(0);
  }, 20_000);

  it('prints "ClosePaw is not installed" and exits 1 when the intent cannot resolve', async () => {
    const r = await run(['closepaw', 'x'], makeNativeOwner(home, () => 'not-installed'));
    expect(r.out.trim()).toBe(CLOSEPAW_MSG_NOT_INSTALLED);
    expect(r.code).toBe(1);
  }, 20_000);

  it('exits 1 with the notifications-off message when no route exists', async () => {
    const r = await run(['closepaw', 'x'], makeNativeOwner(home, () => 'background-blocked'));
    expect(r.out.trim()).toBe(CLOSEPAW_MSG_BACKGROUND_BLOCKED);
    expect(r.code).toBe(1);
  }, 20_000);

  it('joins multiple unquoted words into one goal', async () => {
    const owner = makeNativeOwner(home, () => 'launched');
    await run(['closepaw', 'open', 'the', 'clock', 'app'], owner);
    expect(owner.launches).toEqual(['open the clock app']);
  }, 20_000);
});
