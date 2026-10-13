/**
 * `shelly closepaw "<goal>"` — queue writer (generated $HOME/bin/shelly shim,
 * HomeInitializer.kt SHELLY_HELPER_SHIM v7) and RN drainer validation
 * (lib/closepaw-queue.ts). The shim's node body is extracted from the real
 * .kt source exactly like __tests__/shelly-helper-shim-workflow.test.ts does,
 * and run against a temp $HOME with a simulated RN drainer.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  CLOSEPAW_MSG_HANDED_OFF,
  CLOSEPAW_MSG_NOT_INSTALLED,
  CLOSEPAW_QUEUE_MAX_AGE_MS,
  closePawResultFileName,
  createClosePawRateLimiter,
  encodeClosePawQueueLine,
  parseClosePawQueueLine,
  processClosePawQueueLine,
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

describe('processClosePawQueueLine', () => {
  function deps(over: Partial<Parameters<typeof processClosePawQueueLine>[1]> = {}) {
    const results: Array<[string, ClosePawQueueResult]> = [];
    const fire = jest.fn().mockResolvedValue(undefined);
    let now = NOW;
    const d = {
      now: () => now,
      limiter: createClosePawRateLimiter(5000),
      fire,
      writeResult: async (id: string, r: ClosePawQueueResult) => {
        results.push([id, r]);
      },
      ...over,
    };
    return { d, results, fire, advance: (ms: number) => (now += ms) };
  }

  it('fires only the sanitized goal through the closepaw intent mode', async () => {
    const { d, results, fire } = deps();
    const r = await processClosePawQueueLine(encodeClosePawQueueLine(REQ, NOW, 'Open Chrome\nand search'), d);
    expect(fire).toHaveBeenCalledWith('closepaw', '', 'Open Chrome and search');
    expect(r).toEqual({ ok: true, code: 'handed-off', message: CLOSEPAW_MSG_HANDED_OFF });
    expect(results).toEqual([[REQ, r]]);
  });

  it('rate-limits to one hand-off per 5 seconds', async () => {
    const { d, fire, advance } = deps();
    const id2 = `${NOW}-0123abce`;
    const id3 = `${NOW}-0123abcf`;
    await processClosePawQueueLine(encodeClosePawQueueLine(REQ, NOW, 'a'), d);
    const second = await processClosePawQueueLine(encodeClosePawQueueLine(id2, NOW, 'b'), d);
    expect(second?.code).toBe('rate-limited');
    advance(5001);
    const third = await processClosePawQueueLine(encodeClosePawQueueLine(id3, NOW + 5001, 'c'), d);
    expect(third?.code).toBe('handed-off');
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it('never fires a stale entry, and reports it', async () => {
    const { d, fire, results, advance } = deps();
    advance(CLOSEPAW_QUEUE_MAX_AGE_MS + 1);
    const r = await processClosePawQueueLine(encodeClosePawQueueLine(REQ, NOW, 'a'), d);
    expect(fire).not.toHaveBeenCalled();
    expect(r?.code).toBe('stale');
    expect(results).toHaveLength(1);
  });

  it('maps the native not-installed error to "ClosePaw is not installed"', async () => {
    const { d } = deps({ fire: jest.fn().mockRejectedValue(new Error('CLOSEPAW_NOT_INSTALLED')) });
    const r = await processClosePawQueueLine(encodeClosePawQueueLine(REQ, NOW, 'a'), d);
    expect(r).toEqual({ ok: false, code: 'not-installed', message: CLOSEPAW_MSG_NOT_INSTALLED });
  });

  it('does not answer (or fire) a line without a valid request id', async () => {
    const { d, fire, results } = deps();
    expect(await processClosePawQueueLine('closepaw:bad:1:a', d)).toBeNull();
    expect(fire).not.toHaveBeenCalled();
    expect(results).toHaveLength(0);
  });
});

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

  function run(args: string[], drain?: (line: string) => Promise<void>) {
    return new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, [shimPath, ...args], { env: { ...process.env, HOME: home } });
      let out = '';
      child.stdout.on('data', (b) => (out += b));
      child.stderr.on('data', (b) => (out += b));
      const queue = path.join(home, '.shelly-command-queue');
      const timer = drain
        ? setInterval(() => {
            if (!fs.existsSync(queue)) return;
            const content = fs.readFileSync(queue, 'utf8');
            fs.unlinkSync(queue);
            for (const line of content.split('\n').filter(Boolean)) void drain(line);
          }, 50)
        : null;
      child.on('close', (code) => {
        if (timer) clearInterval(timer);
        resolve({ code, out });
      });
    });
  }

  const rnDrainer = (fire: jest.Mock) => (line: string) =>
    processClosePawQueueLine(line, {
      now: Date.now,
      limiter: createClosePawRateLimiter(),
      fire,
      writeResult: async (reqId, result) => {
        fs.writeFileSync(path.join(home, closePawResultFileName(reqId)), JSON.stringify(result));
      },
    }).then(() => undefined);

  it('prints usage without a goal', async () => {
    const r = await run(['closepaw']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Usage: shelly closepaw "<goal>"');
  });

  it('queues the goal, and prints the hand-off message once RN fires it', async () => {
    const fire = jest.fn().mockResolvedValue(undefined);
    const r = await run(['closepaw', 'Open Chrome and search for Tokyo weather'], rnDrainer(fire));
    expect(r.out.trim()).toBe(CLOSEPAW_MSG_HANDED_OFF);
    expect(r.code).toBe(0);
    expect(fire).toHaveBeenCalledWith('closepaw', '', 'Open Chrome and search for Tokyo weather');
    expect(fs.existsSync(path.join(home, '.shelly-command-queue'))).toBe(false);
  }, 20_000);

  it('prints "ClosePaw is not installed" and exits 1 when the intent cannot resolve', async () => {
    const fire = jest.fn().mockRejectedValue(new Error('CLOSEPAW_NOT_INSTALLED'));
    const r = await run(['closepaw', 'x'], rnDrainer(fire));
    expect(r.out.trim()).toBe(CLOSEPAW_MSG_NOT_INSTALLED);
    expect(r.code).toBe(1);
  }, 20_000);

  it('joins multiple unquoted words into one goal', async () => {
    const fire = jest.fn().mockResolvedValue(undefined);
    await run(['closepaw', 'open', 'the', 'clock', 'app'], rnDrainer(fire));
    expect(fire).toHaveBeenCalledWith('closepaw', '', 'open the clock app');
  }, 20_000);
});
